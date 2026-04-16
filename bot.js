import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { personaMap, defaultPersona } from "./personalities/index.js";

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_IDS   = process.env.CHANNEL_ID?.split(",").map(id => id.trim()) ?? [];
const OLLAMA_URL    = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL         = process.env.MODEL      || "gemma4:e4b";
const MAX_HISTORY   = 20;

// Maps channel IDs to persona IDs: CHANNEL_PERSONALITIES=id1:maki,id2:yuki
const CHANNEL_PERSONALITIES = Object.fromEntries(
  (process.env.CHANNEL_PERSONALITIES ?? "")
    .split(",")
    .filter(Boolean)
    .map(s => s.trim().split(":"))
    .filter(([c, p]) => c && p)
);

function getPersonaForChannel(channelId) {
  const personaId = CHANNEL_PERSONALITIES[channelId] ?? defaultPersona.id;
  return personaMap[personaId] ?? defaultPersona;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Model capabilities ────────────────────────────────────────────────────────
function modelSupportsThinking(model) {
  return model.startsWith("qwen3");
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Familiarity ───────────────────────────────────────────────────────────────
const BASE_POINTS    = 1;
const PERSONAL_BONUS = 2;

const FAMILIARITY_TIERS = [
  { threshold: 60, label: "Close" },
  { threshold: 30, label: "Genuine" },
  { threshold: 15, label: "Comfortable" },
  { threshold: 5,  label: "Acquaintance" },
  { threshold: 0,  label: "New" },
];

function getFamiliarityTier(score) {
  return FAMILIARITY_TIERS.find(t => score >= t.threshold)?.label ?? "New";
}

function getFamiliarityLabel(score, persona) {
  const levels = persona.familiarityLevels;
  let label = levels[0].label;
  for (const level of levels) {
    if (score >= level.min) label = level.label;
  }
  return label;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Time context ──────────────────────────────────────────────────────────────
function getTimeContext(lastSeen) {
  const now  = new Date();
  const hour = now.getHours();

  const timeOfDay =
    hour < 6  ? "very late at night -- you are tired and a little slow, thoughts come out less filtered" :
    hour < 11 ? "morning -- you are not fully awake yet, a little groggy and terse" :
    hour < 14 ? "midday -- you are alert and present" :
    hour < 18 ? "afternoon -- relaxed, in the middle of your day" :
    hour < 22 ? "evening -- you have settled in for the night, this is your prime time, you are at your most yourself" :
                "late night -- quiet, a little more honest than usual, the filter is lower";

  let sinceLastSeen = "";
  if (lastSeen) {
    const diffMs    = now - new Date(lastSeen);
    const diffMins  = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays  = Math.floor(diffHours / 24);

    if (diffMins < 5)        sinceLastSeen = "You just spoke moments ago, still in the same thread of conversation.";
    else if (diffMins < 60)  sinceLastSeen = "You spoke to them earlier today, the conversation is still fresh.";
    else if (diffHours < 24) sinceLastSeen = "You have not spoken since earlier today.";
    else if (diffDays === 1) sinceLastSeen = "It has been about a day since you last talked.";
    else if (diffDays < 7)   sinceLastSeen = `It has been ${diffDays} days since you last talked.`;
    else                     sinceLastSeen = "It has been a while since you last talked.";
  } else {
    sinceLastSeen = "You have never spoken to this person before. At some point find a natural way to ask what they would like to be called.";
  }

  return { timeOfDay, sinceLastSeen };
}
// ─────────────────────────────────────────────────────────────────────────────

// Prompts live in each persona file. See personalities/*/persona.js.
// ─────────────────────────────────────────────────────────────────────────────

// ── Fact decay system ─────────────────────────────────────────────────────────
// Facts are stored as objects with text, addedAt timestamp, and weight tier.
// Weight tiers: core (stable), recent (time-sensitive), stale (expired recent).
// Recent facts decay to stale after RECENT_TTL_DAYS days.
const RECENT_TTL_DAYS = 30;

// Parse facts from either the new array format or legacy string format.
// Legacy migration happens automatically on first load of an old file.
function parseFacts(facts) {
  if (!facts) return [];
  if (Array.isArray(facts)) return facts;

  // Migrate legacy plain-string format
  return facts
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("-"))
    .map(line => ({
      text:    line.replace(/\s*\[(core|recent|stale)\]\s*$/i, "").trim(),
      addedAt: new Date().toISOString(),
      weight:  line.match(/\[(core|recent)\]/i)?.[1]?.toLowerCase() ?? "core",
    }));
}

// Promote recent facts to stale when they exceed the TTL.
function decayFacts(facts) {
  const now = new Date();
  return facts.map(fact => {
    if (fact.weight !== "recent") return fact;
    const ageDays = (now - new Date(fact.addedAt)) / (1000 * 60 * 60 * 24);
    return ageDays > RECENT_TTL_DAYS ? { ...fact, weight: "stale" } : fact;
  });
}

// Deduplicate, sanitize, and decay a facts array before writing.
function cleanFacts(facts) {
  if (!facts) return [];
  const parsed  = parseFacts(facts);
  const decayed = decayFacts(parsed);
  const seen    = new Set();
  return decayed.filter(fact => {
    const key = fact.text.toLowerCase();
    if (!fact.text.startsWith("-")) return false;
    if (fact.text.includes("*"))    return false;
    if (fact.text.includes("NO_UPDATE")) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Build a string for system prompt injection, grouping by tier.
// Stale facts are labelled so Maki treats them as possibly outdated.
function factsToString(facts) {
  if (!facts?.length) return "";
  const core   = facts.filter(f => f.weight === "core").map(f => f.text).join("\n");
  const recent = facts.filter(f => f.weight === "recent").map(f => f.text).join("\n");
  const stale  = facts.filter(f => f.weight === "stale").map(f => f.text).join("\n");

  let out = "";
  if (core)   out += core + "\n";
  if (recent) out += recent + "\n";
  if (stale)  out += `The following may no longer be current -- treat as background only:\n${stale}\n`;
  return out.trim();
}

// Parse extraction output lines into fact objects.
function parseExtractedLines(result) {
  return result
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("-"))
    .map(line => ({
      text:    line.replace(/\s*\[(core|recent|stale)\]\s*$/i, "").trim(),
      addedAt: new Date().toISOString(),
      weight:  line.match(/\[(core|recent)\]/i)?.[1]?.toLowerCase() ?? "core",
    }));
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Memory helpers ────────────────────────────────────────────────────────────

// One-time migration: copy existing ./memory/ files into personalities/maki/memory/.
// Runs silently on first startup; safe to re-run (only copies missing files).
function migrateMemoryToPersonas() {
  const oldDir = "./memory";
  const newDir = "./personalities/maki/memory";
  if (!existsSync(oldDir)) return;
  const skip = new Set(["_settings.json"]);
  for (const file of readdirSync(oldDir)) {
    if (!file.endsWith(".json") || skip.has(file)) continue;
    const dst = join(newDir, file);
    if (!existsSync(dst)) writeFileSync(dst, readFileSync(join(oldDir, file)));
  }
}

// Ensure all persona memory dirs exist, then migrate legacy files.
for (const persona of Object.values(personaMap)) {
  if (!existsSync(persona.memoryDir)) mkdirSync(persona.memoryDir, { recursive: true });
}
migrateMemoryToPersonas();

function loadUserMemory(userId, persona) {
  const path = join(persona.memoryDir, `${userId}.json`);
  if (!existsSync(path)) return { facts: [], history: [], familiarity: 0, lastSeen: null };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data.familiarity !== "number") data.familiarity = 0;
    if (!data.lastSeen) data.lastSeen = null;
    if (typeof data.facts === "string") data.facts = parseFacts(data.facts);
    if (!Array.isArray(data.facts)) data.facts = [];
    return data;
  } catch {
    return { facts: [], history: [], familiarity: 0, lastSeen: null };
  }
}

function saveUserMemory(userId, memory, persona) {
  memory.facts    = cleanFacts(memory.facts);
  memory.lastSeen = new Date().toISOString();
  writeFileSync(join(persona.memoryDir, `${userId}.json`), JSON.stringify(memory, null, 2));
}

function loadSelfMemory(persona) {
  if (!existsSync(persona.selfFile)) return { facts: [] };
  try {
    const data = JSON.parse(readFileSync(persona.selfFile, "utf8"));
    if (typeof data.facts === "string") data.facts = parseFacts(data.facts);
    if (!Array.isArray(data.facts)) data.facts = [];
    return data;
  } catch {
    return { facts: [] };
  }
}

function saveSelfMemory(memory, persona) {
  memory.facts = cleanFacts(memory.facts);
  writeFileSync(persona.selfFile, JSON.stringify(memory, null, 2));
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Loop detection ────────────────────────────────────────────────────────────
function detectLoop(history) {
  const recentReplies = history
    .filter(m => m.role === "assistant")
    .slice(-3)
    .map(m => m.content.toLowerCase().trim());

  if (recentReplies.length < 2) return false;

  const last     = recentReplies[recentReplies.length - 1];
  const previous = recentReplies.slice(0, -1);

  return previous.some(prev => {
    if (prev === last) return true;
    const lastWords  = new Set(last.split(/\s+/));
    const prevWords  = prev.split(/\s+/);
    const overlap    = prevWords.filter(w => lastWords.has(w)).length;
    const similarity = overlap / Math.max(prevWords.length, lastWords.size);
    return similarity > 0.8;
  });
}

async function correctLoop(messages, loopedReply) {
  const correctionMessages = [
    ...messages,
    {
      role: "user",
      content: `[System note: Your last reply was too similar to something you already said recently. The repeated reply was: "${loopedReply}". Please respond differently. Do not repeat that reply or anything close to it. Pick up the conversation naturally from where it is now.]`,
    },
  ];
  try {
    return await ollamaChat(correctionMessages);
  } catch (err) {
    console.error("Loop correction failed:", err.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Ollama interface ──────────────────────────────────────────────────────────
async function ollamaChat(messages) {
  const body = {
    model:   MODEL,
    messages,
    stream:  false,
    options: {
      num_predict:    400,
      temperature:    0.7,
      top_p:          0.8,
      top_k:          20,
      min_p:          0,
      repeat_penalty: 1.4,
    },
  };
  if (modelSupportsThinking(MODEL)) body.think = false;

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const raw  = data.message?.content?.trim() ?? "";
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[\u0400-\u04FF]+/g, "")
    .replace(/[\u0600-\u06FF]+/g, "")
    .replace(/[\u3040-\u30FF]+/g, "")
    .replace(/[\uAC00-\uD7AF]+/g, "")
    .replace(/[\u4E00-\u9FFF]+/g, "")
    .replace(/[\uD800-\uDFFF]./g, "")
    .trim();
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Extraction helpers ────────────────────────────────────────────────────────
async function extractUserFacts(username, userMessage, botReply, existingFacts, persona) {
  const existingText = existingFacts?.length
    ? existingFacts.map(f => `${f.text} [${f.weight}]`).join("\n")
    : "none";

  const messages = [
    { role: "system", content: persona.userExtractPrompt },
    {
      role: "user",
      content: `Existing facts about ${username}:\n${existingText}\n\nLatest exchange:\n${username}: ${userMessage}\n${persona.displayName}: ${botReply}\n\nWhat new facts should be added?`,
    },
  ];
  try {
    const result = await ollamaChat(messages);
    if (!result || result === "NO_UPDATE") return { facts: existingFacts, newFacts: false };
    const newFacts = parseExtractedLines(result);
    return { facts: [...(existingFacts || []), ...newFacts], newFacts: true };
  } catch (err) {
    console.error("User memory extraction failed:", err.message);
    return { facts: existingFacts, newFacts: false };
  }
}

async function extractSelfFacts(username, userMessage, botReply, existingFacts, persona) {
  const existingText = existingFacts?.length
    ? existingFacts.map(f => `${f.text} [${f.weight}]`).join("\n")
    : "none";

  const messages = [
    { role: "system", content: persona.selfExtractPrompt },
    {
      role: "user",
      content: `What ${persona.displayName} already knows about herself:\n${existingText}\n\nLatest exchange:\n${username}: ${userMessage}\n${persona.displayName}: ${botReply}\n\nWhat new facts about ${persona.displayName} should be added?`,
    },
  ];
  try {
    const result = await ollamaChat(messages);
    if (!result || result === "NO_UPDATE") return existingFacts;
    const newFacts = parseExtractedLines(result);
    return [...(existingFacts || []), ...newFacts];
  } catch (err) {
    console.error("Self memory extraction failed:", err.message);
    return existingFacts;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Command handler ───────────────────────────────────────────────────────────
async function handleCommand(message, persona) {
  const args    = message.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();
  const isAdmin = message.author.id === process.env.ADMIN_ID;
  const userId  = message.author.id;

  switch (command) {

    // ── !options ──────────────────────────────────────────────────────────────
    case "!options": {
      const lines = [
        "**Available commands:**",
        "",
        "`!options` — show this list",
        "`!familiarity` — see your current familiarity score and relationship tier",
        "`!facts` — see what Maki knows about you",
        "`!clearhistory` — wipe your conversation history (facts kept)",
        "`!resetme` — wipe your history and facts (familiarity kept)",
        "`!fullreset` — wipe everything, start completely fresh",
      ];
      if (isAdmin) {
        lines.push(
          "",
          "**Admin only:**",
          "`!welcome` — post the welcome message in this channel",
          "`!inspect @user` — view a user's facts and familiarity score",
          "`!resetuser @user` — fully reset a user's memory",
          "`!setfamiliarity @user <score>` — manually set a user's familiarity score",
        );
      }
      await message.channel.send(lines.join("\n"));
      return true;
    }

    // ── !familiarity ──────────────────────────────────────────────────────────
    case "!familiarity": {
      const memory = loadUserMemory(userId, persona);
      const score  = memory.familiarity ?? 0;
      const tier   = getFamiliarityTier(score);
      await message.channel.send(`Your familiarity with ${persona.displayName} is **${score}** — tier: **${tier}**`);
      return true;
    }

    // ── !facts ────────────────────────────────────────────────────────────────
    case "!facts": {
      const memory = loadUserMemory(userId, persona);
      const facts  = memory.facts ?? [];
      if (facts.length === 0) {
        await message.channel.send("Nothing stored yet.");
        return true;
      }
      const core   = facts.filter(f => f.weight === "core");
      const recent = facts.filter(f => f.weight === "recent");
      const stale  = facts.filter(f => f.weight === "stale");
      const lines  = [`**What ${persona.displayName} knows about you:**`];
      if (core.length)   lines.push("", "**Core**",   ...core.map(f => `• ${f.text}`));
      if (recent.length) lines.push("", "**Recent**", ...recent.map(f => `• ${f.text}`));
      if (stale.length)  lines.push("", "**Stale** *(may no longer apply)*", ...stale.map(f => `• ${f.text}`));
      await message.channel.send(lines.join("\n"));
      return true;
    }

    // ── !clearhistory ─────────────────────────────────────────────────────────
    case "!clearhistory": {
      const memory  = loadUserMemory(userId, persona);
      memory.history = [];
      saveUserMemory(userId, memory, persona);
      await message.channel.send("Conversation history cleared. Facts and familiarity are still intact.");
      return true;
    }

    // ── !resetme ──────────────────────────────────────────────────────────────
    case "!resetme": {
      const memory  = loadUserMemory(userId, persona);
      memory.history = [];
      memory.facts   = [];
      saveUserMemory(userId, memory, persona);
      await message.channel.send("History and facts cleared. Familiarity score kept.");
      return true;
    }

    // ── !fullreset ────────────────────────────────────────────────────────────
    case "!fullreset": {
      saveUserMemory(userId, { history: [], facts: [], familiarity: 0, lastSeen: null }, persona);
      await message.channel.send("Full reset done. Clean slate.");
      return true;
    }

    // ── !welcome (admin) ──────────────────────────────────────────────────────
    case "!welcome": {
      if (!isAdmin) return false;
      await message.channel.send(persona.welcomeMessage);
      return true;
    }

    // ── !inspect (admin) ──────────────────────────────────────────────────────
    case "!inspect": {
      if (!isAdmin) return false;
      const target = message.mentions.users.first();
      if (!target) {
        await message.channel.send("Usage: `!inspect @user`");
        return true;
      }
      const memory = loadUserMemory(target.id, persona);
      const score  = memory.familiarity ?? 0;
      const tier   = getFamiliarityTier(score);
      const facts  = memory.facts ?? [];
      const core   = facts.filter(f => f.weight === "core");
      const recent = facts.filter(f => f.weight === "recent");
      const stale  = facts.filter(f => f.weight === "stale");
      const lines  = [
        `**${persona.displayName}'s memory report for ${target.username}**`,
        `Familiarity: **${score}** (${tier})`,
        `History entries: **${(memory.history ?? []).length}**`,
      ];
      if (core.length)   lines.push("", "**Core facts**",   ...core.map(f => `• ${f.text}`));
      if (recent.length) lines.push("", "**Recent facts**", ...recent.map(f => `• ${f.text}`));
      if (stale.length)  lines.push("", "**Stale facts**",  ...stale.map(f => `• ${f.text}`));
      if (facts.length === 0) lines.push("", "No facts stored yet.");
      await message.channel.send(lines.join("\n"));
      return true;
    }

    // ── !resetuser (admin) ────────────────────────────────────────────────────
    case "!resetuser": {
      if (!isAdmin) return false;
      const target = message.mentions.users.first();
      if (!target) {
        await message.channel.send("Usage: `!resetuser @user`");
        return true;
      }
      saveUserMemory(target.id, { history: [], facts: [], familiarity: 0, lastSeen: null }, persona);
      await message.channel.send(`Memory reset for ${target.username}.`);
      return true;
    }

    // ── !setfamiliarity (admin) ───────────────────────────────────────────────
    case "!setfamiliarity": {
      if (!isAdmin) return false;
      const target = message.mentions.users.first();
      const score  = parseInt(args[2]);
      if (!target || isNaN(score)) {
        await message.channel.send("Usage: `!setfamiliarity @user <score>`");
        return true;
      }
      const memory      = loadUserMemory(target.id, persona);
      memory.familiarity = score;
      saveUserMemory(target.id, memory, persona);
      await message.channel.send(`Familiarity for ${target.username} set to **${score}** (${getFamiliarityTier(score)}).`);
      return true;
    }

    default:
      return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Watching channels: ${CHANNEL_IDS.join(", ")}`);
  console.log(`Using model: ${MODEL} at ${OLLAMA_URL}`);
  console.log(`Thinking mode: ${modelSupportsThinking(MODEL) ? "supported" : "not supported (omitted)"}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!CHANNEL_IDS.includes(message.channel.id)) return;

  const userText = message.content.trim();
  if (!userText) return;

  const persona = getPersonaForChannel(message.channel.id);

  if (userText.startsWith("!")) {
    try {
      const handled = await handleCommand(message, persona);
      if (handled) return;
    } catch (err) {
      if (err.code === 50013) {
        console.error(`Missing Permissions in channel ${message.channel.id} — skipping`);
        return;
      }
      throw err;
    }
  }

  await message.channel.sendTyping();

  const userId   = message.author.id;
  const username = message.author.username;
  const memory   = loadUserMemory(userId, persona);
  const self     = loadSelfMemory(persona);

  while (memory.history.length > MAX_HISTORY) memory.history.shift();

  // ── Build dynamic system prompt ──────────────────────────────────────────
  const familiarityLabel             = getFamiliarityLabel(memory.familiarity, persona);
  const { timeOfDay, sinceLastSeen } = getTimeContext(memory.lastSeen);

  let systemContent = persona.systemPrompt;
  systemContent += `\n\nYour relationship with ${username}: ${familiarityLabel}`;
  systemContent += `\n\nTime context: It is currently ${timeOfDay}. ${sinceLastSeen} Let this subtly color your mood and energy -- do not reference it directly or announce it.`;

  const selfStr = factsToString(self.facts);
  if (selfStr) {
    systemContent += `\n\nBackground self-knowledge -- this is who you are, not a list of things to announce. Let it shape what you gravitate toward, what you react to, and what you avoid. Do not quote these facts back directly:\n${selfStr}`;
  }

  const userStr = factsToString(memory.facts);
  if (userStr) {
    systemContent += `\n\nWhat you remember about ${username}:\n${userStr}`;
  }
  // ─────────────────────────────────────────────────────────────────────────

  memory.history.push({ role: "user", content: `${username}: ${userText}` });

  const messages = [
    { role: "system", content: systemContent },
    ...memory.history,
  ];

  try {
    let reply = await ollamaChat(messages);

    if (!reply) {
      await message.reply("...");
      return;
    }

    // ── Loop detection and self-correction ──────────────────────────────────
    memory.history.push({ role: "assistant", content: reply });

    if (detectLoop(memory.history)) {
      console.log(`[Loop detected] Attempting self-correction for ${username}`);
      memory.history.pop();
      const corrected = await correctLoop(messages, reply);
      if (corrected) {
        reply = corrected;
        console.log(`[Loop corrected] New reply generated`);
      }
      memory.history.push({ role: "assistant", content: reply });
    }
    // ─────────────────────────────────────────────────────────────────────────

    Promise.all([
      extractUserFacts(username, userText, reply, memory.facts, persona),
      extractSelfFacts(username, userText, reply, self.facts, persona),
    ]).then(([userResult, updatedSelfFacts]) => {
      memory.facts        = userResult.facts;
      memory.familiarity += BASE_POINTS;
      if (userResult.newFacts) memory.familiarity += PERSONAL_BONUS;
      saveUserMemory(userId, memory, persona);
      self.facts = updatedSelfFacts;
      saveSelfMemory(self, persona);
    });

    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,2000}/g) || [];
      for (const chunk of chunks) await message.channel.send(chunk);
    }
  } catch (err) {
    if (err.code === 50013) {
      console.error(`Missing Permissions in channel ${message.channel.id} — skipping`);
      return;
    }
    console.error("Error:", err.message);
    try { await message.reply("Something broke. Is Ollama still running?"); } catch {}
  }
});

client.login(DISCORD_TOKEN);