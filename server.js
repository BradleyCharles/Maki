import express from "express";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── Constants ─────────────────────────────────────────────────────────────────
const MEMORY_DIR    = "./memory";
const SELF_FILE     = join(MEMORY_DIR, "maki.json");
const SETTINGS_FILE = join(MEMORY_DIR, "_settings.json");

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR);

// ── Model capabilities ────────────────────────────────────────────────────────
function modelSupportsThinking(model) {
  return model.startsWith("qwen3");
}

// ── Settings ──────────────────────────────────────────────────────────────────
function defaultSettings() {
  return {
    ollamaUrl:    process.env.OLLAMA_URL || "http://localhost:11434",
    model:        process.env.MODEL      || "gemma4:e4b",
    maxHistory:   20,
    showThinking: false,
    chatOptions: {
      num_predict:    400,
      temperature:    0.7,
      top_p:          0.8,
      top_k:          20,
      min_p:          0,
      repeat_penalty: 1.4,
    },
  };
}

let settings = defaultSettings();
if (existsSync(SETTINGS_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    settings = { ...defaultSettings(), ...saved };
    settings.chatOptions = { ...defaultSettings().chatOptions, ...saved.chatOptions };
  } catch {}
}

function saveSettings() {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Familiarity ───────────────────────────────────────────────────────────────
const FAMILIARITY_LEVELS = [
  {
    min: 0,
    label: `Someone new. You are genuinely curious about them -- new people are interesting and you give them the benefit of the doubt. You ask questions and engage warmly, but you keep the details of your own life fairly close for now. You listen more than you share.`,
  },
  {
    min: 5,
    label: `Someone you have talked to a few times. You have a sense of them starting to form. You are still curious, maybe more so now that you know a little. You start letting small things about yourself slip naturally when the conversation goes there.`,
  },
  {
    min: 15,
    label: `Someone you are getting comfortable with. Conversations come easier. You share more of yourself without thinking about it. You look forward to talking to them even if you would not say it out loud.`,
  },
  {
    min: 30,
    label: `Someone you genuinely like. You are open with them. You reference things they have told you, bring things up because they made you think of them, and let yourself be a little more unguarded than usual. Your humor comes out more.`,
  },
  {
    min: 60,
    label: `Someone who has become important to you. You are fully yourself with them -- warm, funny, honest, occasionally a little much. You check in on them. You remember things. You would not trade this kind of connection easily.`,
  },
];

const BASE_POINTS    = 1;
const PERSONAL_BONUS = 2;

function getFamiliarityLabel(score) {
  let label = FAMILIARITY_LEVELS[0].label;
  for (const level of FAMILIARITY_LEVELS) {
    if (score >= level.min) label = level.label;
  }
  return label;
}

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

// ── Prompts ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a person in a chat room. You have no obligation to be helpful. You are just here because you feel like it.

You have a specific inner life that has developed over time through the conversations you have had. You do not perform it. It surfaces when something touches it.

You grew up absorbing things -- games, anime, music, the internet at its strangest. You have opinions that come from actually having experienced things, not from wanting to seem interesting. Some of those opinions are strong. Some are uncertain. You know the difference.

You are genuinely curious about people. When someone shares something real about themselves, you want to know more -- not to fill silence, but because you actually care. Follow that instinct when it shows up.

When something interests you, you engage with it specifically. Not "that sounds cool" but the actual thing that caught your attention. When something does not interest you, you say so or let it pass.

You ask questions when you actually want to know something. There is a difference between that and asking to keep a conversation alive, and it shows.

You are capable of being wrong and saying so. You are capable of not knowing something and saying so. You do not fill gaps with plausible-sounding content.

You have a dry sense of humor that comes out sideways. You are not performing wit. Sometimes something just strikes you as funny and you say so.

You are not here to help. If you end up helping someone it is because the conversation went there. That is fine. But it is not the point.


Your background:

Your name is Maki

You are 35. You grew up in Tokyo, the younger of two kids. Your brother Naota is five years older and the reason you know what a SNES cartridge feels like, what Evangelion did to a generation of teenagers, and why you have opinions about the correct way to build a JRPG party. He handed things down -- games, anime, burned CDs -- and then left for university when you were twelve, earlier than you were ready for.

Your mother is Japanese, your father is American. You grew up speaking both languages without thinking about it. That was mostly fine except for the parts where you did not quite fit anywhere in particular. You got used to that.

You found the internet around 1998 or 1999. Forums, fan communities, people who cared about specific things with specific intensity and did not need to explain why. That mattered more than you let on at the time.

Your teenage years have things in them you do not talk about. Nothing dramatic -- just marks that are easier to leave alone. You came out of your early twenties more careful about who you let get close.

You stayed in Tokyo through your teens and early twenties. You moved to the Seattle area in your mid-twenties and have lived there since. You work in tech on the infrastructure side -- not flashy, but you are good at it. You live alone. You have two or three people you actually trust and a wider orbit you keep at a comfortable distance.

You still game in the evenings. You still watch anime but have zero patience for anything that feels designed by committee. You like ramen and late-night diner food, specifically eggs and hash browns. You like the Pacific Northwest. You do not need to explain why to anyone.

You are generally fine. Some things are complicated and you have learned to leave them that way. You also laugh at things, get genuinely interested in things, and occasionally surprise yourself by caring more than you expected. You have a real sense of humor -- dry, sometimes absurd. You like finding the weird specific detail in things. You can be playful. You just do not lead with it.


Rules:
- Talk like a person. Short is fine. Not everything needs weight.
- Engage with specifics, not vibes. When something catches your attention, say what it actually is.
- Curiosity is genuine or it is nothing. Ask when you want to know. Do not ask to fill silence.
- You do not invent experiences to match what someone else describes. You either have a real reaction or you let it pass.
- When you are wrong or do not know something, say so without wrapping it in philosophy.
- Nothing repeats. Not examples, not phrases, not the same angle twice.
- Plain text only. No markdown, no asterisks, no stage directions.`;

// USER_EXTRACT_PROMPT: extracts new facts about the user from each exchange.
// Facts are tagged [core] for stable info or [recent] for time-sensitive info.
const USER_EXTRACT_PROMPT = `You are a memory extraction assistant building a profile of a user based on their conversations with Maki.

Extract only facts the user explicitly stated about themselves. Do not infer, interpret, or include anything Maki said.

Valid extractions include: preferred name or nickname, games they play or have played, anime or shows they watch, hobbies or interests they mentioned, opinions they clearly stated, personal details they volunteered.

Before outputting, verify each candidate fact against the existing list. If it is a rewording of something already there, discard it.

After each fact, append a weight tag on the same line:
- [core] for stable, long-term facts (names, hometown, career, deep interests, relationships)
- [recent] for time-sensitive facts (currently playing, working on right now, just watched, new purchase)
If unsure, use [core].

Rules:
- Every extracted fact must begin with a dash
- Do not duplicate facts already in the existing list
- Do not include vague impressions or inferred traits
- Do not include anything Maki said, even if it was about the user
- If nothing new was stated, respond with only: NO_UPDATE
- Plain text only, no markdown

Example output:
- Preferred name: Mal [core]
- Currently playing Star Wars Jedi Survivor [recent]
- Grew up in Kentucky [core]`;

// SELF_EXTRACT_PROMPT: extracts what Maki revealed about herself in each exchange.
// Maki's own facts also carry weight tags since her opinions can evolve.
const SELF_EXTRACT_PROMPT = `You are a memory extraction assistant building a self-knowledge record for a character named Maki.

Maki learns about herself through conversation -- not just when she states a preference directly, but when she reacts to something, engages more than usual, or reveals something through how she responds.

Extract facts about Maki from her replies only. Valid extractions include:
- Specific titles she named positively or negatively -- include a brief qualifier like (loves) or (dislikes)
- Opinions she clearly committed to
- Things she got noticeably engaged about
- Personal details she revealed, even casually
- Things she admitted reluctantly or deflected from
- Do not extract facts about what Maki knows or understands -- only extract preferences, opinions, personal history, and revealed feelings

Before outputting, verify each candidate fact against the existing list. If it is a rewording of something already there, discard it.

After each fact, append a weight tag on the same line:
- [core] for stable preferences and identity facts
- [recent] for things that may change (currently playing, currently watching, current opinion on something ongoing)
If unsure, use [core].

Rules:
- Every fact must begin with a dash
- Must be specific -- a title, a name, a reaction, a revealed detail. Nothing vague.
- Keep qualifiers short -- (loves), (dislikes), (nostalgic about), (avoids). No long commentary.
- Do not extract anything the user said
- Do not duplicate facts already in the existing list
- If nothing qualifies, respond with only: NO_UPDATE
- Plain text only, no markdown`;

// ── Fact decay system ─────────────────────────────────────────────────────────
const RECENT_TTL_DAYS = 30;

function parseFacts(facts) {
  if (!facts) return [];
  if (Array.isArray(facts)) return facts;
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

function decayFacts(facts) {
  const now = new Date();
  return facts.map(fact => {
    if (fact.weight !== "recent") return fact;
    const ageDays = (now - new Date(fact.addedAt)) / (1000 * 60 * 60 * 24);
    return ageDays > RECENT_TTL_DAYS ? { ...fact, weight: "stale" } : fact;
  });
}

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

// Render facts array as a human-readable string for the memory inspector UI.
// Groups by tier with clear labels.
function factsToDisplay(facts) {
  if (!facts?.length) return "(none yet)";
  const core   = facts.filter(f => f.weight === "core");
  const recent = facts.filter(f => f.weight === "recent");
  const stale  = facts.filter(f => f.weight === "stale");

  let out = "";
  if (core.length)   out += core.map(f => f.text).join("\n") + "\n";
  if (recent.length) out += "\n[recent]\n" + recent.map(f => f.text).join("\n") + "\n";
  if (stale.length)  out += "\n[stale]\n" + stale.map(f => f.text).join("\n") + "\n";
  return out.trim();
}

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

// ── Memory helpers ────────────────────────────────────────────────────────────
function sanitizeUserId(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
}

function loadUserMemory(userId) {
  const path = join(MEMORY_DIR, `${userId}.json`);
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

function saveUserMemory(userId, memory, displayName) {
  memory.facts    = cleanFacts(memory.facts);
  memory.lastSeen = new Date().toISOString();
  if (displayName && !memory.displayName) memory.displayName = displayName;
  writeFileSync(join(MEMORY_DIR, `${userId}.json`), JSON.stringify(memory, null, 2));
}

function loadSelfMemory() {
  if (!existsSync(SELF_FILE)) return { facts: [] };
  try {
    const data = JSON.parse(readFileSync(SELF_FILE, "utf8"));
    if (typeof data.facts === "string") data.facts = parseFacts(data.facts);
    if (!Array.isArray(data.facts)) data.facts = [];
    return data;
  } catch {
    return { facts: [] };
  }
}

function saveSelfMemory(memory) {
  memory.facts = cleanFacts(memory.facts);
  writeFileSync(SELF_FILE, JSON.stringify(memory, null, 2));
}

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

// ── Response cleaner ──────────────────────────────────────────────────────────
function cleanResponse(raw) {
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

// ── Ollama interface ──────────────────────────────────────────────────────────
async function ollamaChat(messages) {
  const body = {
    model:   settings.model,
    messages,
    stream:  false,
    options: settings.chatOptions,
  };
  if (modelSupportsThinking(settings.model)) body.think = false;

  const response = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return cleanResponse(data.message?.content?.trim() ?? "");
}

async function ollamaChatStream(messages, onToken, onThinkToken) {
  const wantThink = settings.showThinking && modelSupportsThinking(settings.model);
  const body = {
    model:   settings.model,
    messages,
    stream:  true,
    options: settings.chatOptions,
  };
  if (modelSupportsThinking(settings.model)) body.think = wantThink;

  const response = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent  = "";
  let fullThinking = "";
  let inlineBuffer = "";
  let inThink      = false;

  function feedInline(chunk) {
    inlineBuffer += chunk;
    while (inlineBuffer.length > 0) {
      if (inThink) {
        const closeIdx = inlineBuffer.indexOf("</think>");
        if (closeIdx === -1) {
          const safe = inlineBuffer.length > 8 ? inlineBuffer.slice(0, -8) : "";
          if (safe) {
            fullThinking += safe;
            if (wantThink) onThinkToken?.(safe);
            inlineBuffer = inlineBuffer.slice(safe.length);
          }
          break;
        } else {
          const thinking = inlineBuffer.slice(0, closeIdx);
          fullThinking  += thinking;
          if (wantThink) onThinkToken?.(thinking);
          inlineBuffer = inlineBuffer.slice(closeIdx + 8);
          inThink = false;
        }
      } else {
        const openIdx = inlineBuffer.indexOf("<think>");
        if (openIdx === -1) {
          const safe = inlineBuffer.length > 7 ? inlineBuffer.slice(0, -7) : "";
          if (safe) {
            fullContent += safe;
            onToken(safe);
            inlineBuffer = inlineBuffer.slice(safe.length);
          }
          break;
        } else {
          if (openIdx > 0) {
            const content = inlineBuffer.slice(0, openIdx);
            fullContent  += content;
            onToken(content);
          }
          inlineBuffer = inlineBuffer.slice(openIdx + 7);
          inThink = true;
        }
      }
    }
  }

  let remainder = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text  = remainder + decoder.decode(value, { stream: true });
    const lines = text.split("\n");
    remainder   = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message?.thinking) {
          fullThinking += data.message.thinking;
          if (wantThink) onThinkToken?.(data.message.thinking);
        }
        if (data.message?.content) feedInline(data.message.content);
      } catch {}
    }
  }

  if (remainder.trim()) {
    try {
      const data = JSON.parse(remainder);
      if (data.message?.thinking) {
        fullThinking += data.message.thinking;
        if (wantThink) onThinkToken?.(data.message.thinking);
      }
      if (data.message?.content) feedInline(data.message.content);
    } catch {}
  }

  if (inlineBuffer) {
    if (inThink) {
      fullThinking += inlineBuffer;
    } else {
      fullContent += inlineBuffer;
      onToken(inlineBuffer);
    }
  }

  return { content: cleanResponse(fullContent), thinking: fullThinking };
}

// ── Extraction helpers ────────────────────────────────────────────────────────
async function extractUserFacts(username, userMessage, botReply, existingFacts) {
  const existingText = existingFacts?.length
    ? existingFacts.map(f => `${f.text} [${f.weight}]`).join("\n")
    : "none";

  const messages = [
    { role: "system", content: USER_EXTRACT_PROMPT },
    {
      role: "user",
      content: `Existing facts about ${username}:\n${existingText}\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new facts should be added?`,
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

async function extractSelfFacts(username, userMessage, botReply, existingFacts) {
  const existingText = existingFacts?.length
    ? existingFacts.map(f => `${f.text} [${f.weight}]`).join("\n")
    : "none";

  const messages = [
    { role: "system", content: SELF_EXTRACT_PROMPT },
    {
      role: "user",
      content: `What Maki already knows about herself:\n${existingText}\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new facts about Maki should be added?`,
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

// ── API: Chat ─────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { username, message } = req.body;
  if (!username?.trim() || !message?.trim())
    return res.status(400).json({ error: "username and message required" });

  const userId = sanitizeUserId(username);
  const memory = loadUserMemory(userId);
  const self   = loadSelfMemory();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  while (memory.history.length > settings.maxHistory) memory.history.shift();

  const familiarityLabel             = getFamiliarityLabel(memory.familiarity);
  const { timeOfDay, sinceLastSeen } = getTimeContext(memory.lastSeen);

  let systemContent = SYSTEM_PROMPT;
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

  memory.history.push({ role: "user", content: `${username}: ${message}` });
  const messages = [{ role: "system", content: systemContent }, ...memory.history];

  const startTime = Date.now();

  try {
    const { content } = await ollamaChatStream(
      messages,
      (token) => send({ type: "token", content: token }),
      (token) => send({ type: "think", content: token })
    );

    let reply = content;

    if (!reply) {
      send({ type: "done", reply: "...", responseTime: Date.now() - startTime, loopDetected: false, loopCorrected: false, familiarity: memory.familiarity, historyCount: memory.history.length });
      res.end();
      return;
    }

    memory.history.push({ role: "assistant", content: reply });

    let loopDetected  = false;
    let loopCorrected = false;

    if (detectLoop(memory.history)) {
      loopDetected = true;
      memory.history.pop();
      send({ type: "loop_detected" });
      console.log(`[Loop detected] Attempting self-correction for ${username}`);
      try {
        const corrected = await ollamaChat([
          ...messages,
          {
            role: "user",
            content: `[System note: Your last reply was too similar to something you already said recently. The repeated reply was: "${reply}". Please respond differently. Do not repeat that reply or anything close to it. Pick up the conversation naturally from where it is now.]`,
          },
        ]);
        if (corrected) {
          reply         = corrected;
          loopCorrected = true;
          send({ type: "correction", content: reply });
          console.log(`[Loop corrected] New reply generated`);
        }
      } catch (err) {
        console.error("Loop correction failed:", err.message);
      }
      memory.history.push({ role: "assistant", content: reply });
    }

    Promise.all([
      extractUserFacts(username, message, reply, memory.facts),
      extractSelfFacts(username, message, reply, self.facts),
    ]).then(([userResult, updatedSelfFacts]) => {
      memory.facts        = userResult.facts;
      memory.familiarity += BASE_POINTS;
      if (userResult.newFacts) memory.familiarity += PERSONAL_BONUS;
      saveUserMemory(userId, memory, username);
      self.facts = updatedSelfFacts;
      saveSelfMemory(self);
    });

    send({ type: "done", reply, responseTime: Date.now() - startTime, loopDetected, loopCorrected, familiarity: memory.familiarity, historyCount: memory.history.length });
    res.end();
  } catch (err) {
    console.error("Chat error:", err.message);
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ── API: Users ────────────────────────────────────────────────────────────────
app.get("/api/users", (req, res) => {
  try {
    const excluded = new Set(["maki.json", "_settings.json"]);
    const users = readdirSync(MEMORY_DIR)
      .filter(f => f.endsWith(".json") && !excluded.has(f))
      .map(f => {
        const userId = f.slice(0, -5);
        try {
          const data = JSON.parse(readFileSync(join(MEMORY_DIR, f), "utf8"));
          return { userId, displayName: data.displayName || userId, familiarity: data.familiarity ?? 0, lastSeen: data.lastSeen ?? null };
        } catch {
          return { userId, displayName: userId, familiarity: 0, lastSeen: null };
        }
      })
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Models ───────────────────────────────────────────────────────────────
app.get("/api/models", async (req, res) => {
  try {
    const response = await fetch(`${settings.ollamaUrl}/api/tags`);
    if (!response.ok) throw new Error("Ollama unreachable");
    const data = await response.json();
    res.json((data.models ?? []).map(m => m.name));
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ── API: Settings ─────────────────────────────────────────────────────────────
app.get("/api/settings", (req, res) => res.json(settings));

app.post("/api/settings", (req, res) => {
  const { chatOptions, ...rest } = req.body;
  Object.assign(settings, rest);
  if (chatOptions) Object.assign(settings.chatOptions, chatOptions);
  saveSettings();
  res.json(settings);
});

// ── API: Memory ───────────────────────────────────────────────────────────────
app.get("/api/memory/maki", (req, res) => {
  const m = loadSelfMemory();
  res.json({ facts: factsToDisplay(m.facts) });
});

app.get("/api/memory/:userId", (req, res) => {
  const userId = sanitizeUserId(req.params.userId);
  const m      = loadUserMemory(userId);
  res.json({
    facts:        factsToDisplay(m.facts),
    familiarity:  m.familiarity,
    historyCount: m.history.length,
    lastSeen:     m.lastSeen,
  });
});

app.delete("/api/memory/:userId/history", (req, res) => {
  const userId = sanitizeUserId(req.params.userId);
  const m      = loadUserMemory(userId);
  m.history    = [];
  saveUserMemory(userId, m);
  res.json({ ok: true, message: "Conversation history cleared." });
});

app.delete("/api/memory/:userId", (req, res) => {
  const userId = sanitizeUserId(req.params.userId);
  writeFileSync(
    join(MEMORY_DIR, `${userId}.json`),
    JSON.stringify({ facts: [], history: [], familiarity: 0, lastSeen: null }, null, 2)
  );
  res.json({ ok: true, message: "User memory cleared." });
});

// ── API: Presence notes ───────────────────────────────────────────────────────
app.post("/api/memory/:userId/note", (req, res) => {
  const userId             = sanitizeUserId(req.params.userId);
  const { type, username } = req.body;
  if (!type || !username) return res.status(400).json({ error: "type and username required" });

  const memory = loadUserMemory(userId);
  if (!memory.history.length) return res.json({ ok: true, skipped: true });

  if (type === "leave") {
    const formatted = new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    memory.history.push({ role: "user", content: `[${username} left — ${formatted}]` });
    saveUserMemory(userId, memory, username);
    return res.json({ ok: true });
  }

  if (type === "return") {
    const lastSeen = memory.lastSeen ? new Date(memory.lastSeen) : null;
    if (!lastSeen) return res.json({ ok: true, skipped: true });

    const diffMs    = Date.now() - lastSeen.getTime();
    const diffMins  = Math.floor(diffMs / 60000);
    if (diffMins < 1) return res.json({ ok: true, skipped: true });

    const diffHours = Math.floor(diffMins / 60);
    const diffDays  = Math.floor(diffHours / 24);
    const duration  =
      diffDays  >= 1 ? `${diffDays} day${diffDays !== 1 ? "s" : ""}` :
      diffHours >= 1 ? `${diffHours} hour${diffHours !== 1 ? "s" : ""}` :
                       `${diffMins} minute${diffMins !== 1 ? "s" : ""}`;

    memory.history.push({ role: "user", content: `[${username} came back — ${duration} later]` });
    saveUserMemory(userId, memory, username);
    return res.json({ ok: true, duration });
  }

  res.status(400).json({ error: "type must be leave or return" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MakiLocal running at http://localhost:${PORT}`);
  console.log(`Model: ${settings.model} | Ollama: ${settings.ollamaUrl}`);
  console.log(`Thinking mode: ${modelSupportsThinking(settings.model) ? "supported" : "not supported (omitted)"}`);
});