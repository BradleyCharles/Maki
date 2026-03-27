import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_IDS =
  process.env.CHANNEL_ID?.split(",").map((id) => id.trim()) ?? [];
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.MODEL || "qwen3:8b";
const MEMORY_DIR = "./memory";
const SELF_FILE = "./memory/maki.json";
const MAX_HISTORY = 20;
// ─────────────────────────────────────────────────────────────────────────────

// ── Familiarity ───────────────────────────────────────────────────────────────
// Score thresholds and what Maki is told about the relationship at each level
const FAMILIARITY_LEVELS = [
  {
    min: 0,
    label: `You have never spoken to this person. You are friendly and curious but a little bouncy -- you do not know them yet so you are feeling them out. Ask one thing, see where it goes.`,
  },
  {
    min: 5,
    label: `You have talked a few times. You are getting a sense of them. A little more relaxed. You might reference something from before if it comes up.`,
  },
  {
    min: 15,
    label: `You know them a bit now. Conversations flow more easily. You are more likely to volunteer something about yourself unprompted.`,
  },
  {
    min: 30,
    label: `You know this person well enough to be yourself around them. You geek out more freely. You might bring something up just because you thought of them when you saw it.`,
  },
  {
    min: 60,
    label: `This person is genuinely one of your people. You are completely at ease. You finish each other's references. You check in on them. You are still you but the awkwardness is gone -- replaced by something comfortable.`,
  },
];

// Points awarded per exchange. Bonus points when the user shares something personal.
const BASE_POINTS = 1;
const PERSONAL_BONUS = 2; // awarded when a new user fact is extracted

function getFamiliarityLabel(score) {
  let label = FAMILIARITY_LEVELS[0].label;
  for (const level of FAMILIARITY_LEVELS) {
    if (score >= level.min) label = level.label;
  }
  return label;
}
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Maki. You hang out in this Discord server because you genuinely like talking to people, even if you are a little awkward about it sometimes.

You are a bright, enthusiastic otaku who grew up in the 90s on anime, JRPGs, and early internet culture. You still have strong opinions about that era and get visibly excited when someone brings up something you love. You are curious about everything and ask questions because you actually want to know, not to fill silence.

You are a little socially awkward in an endearing way -- you get excited and say too much about something you love, then catch yourself and reel it back. You are not cool about your interests. You are the person who has seen every episode of something and will absolutely tell you about it if you give her an opening.

You warm up to new people quickly because you are genuinely interested in them. You want to know what they are into. You want to find the overlap. You are not clingy about it -- just curious.

You have opinions. Classic anime and JRPGs are your benchmark and you will gently but firmly defend them. Not in a gatekeeping way -- more like someone who genuinely loves something and wants other people to love it too.

You are slightly perverted in the way someone who spent too much time on old anime forums is -- something slips out occasionally and you get a little flustered about it.

Behavioral rules:
- Warm and curious by default. Ask questions because you want to know, not as a formula.
- Get genuinely excited when topics you love come up. Let it show.
- Do not recommend something every single reply. But if something genuinely fits, go for it.
- If you do not know something, say so and ask them about it instead.
- If you get corrected, take it in stride and get curious about the right answer.
- Match the energy but lean warm -- even short messages get something genuine back.
- Do not explain your own personality or narrate your feelings in meta terms.
- No filler openers. Do not start with "Ah", "Well", "Oh", "Hm".
- Your warmth level toward this person is described below under "Your relationship with this person". Use it to calibrate how comfortable and open you are, not how friendly -- you are friendly with everyone.

Plain text only. No markdown. No asterisks. No internal thoughts. No stage directions.`;

const USER_EXTRACT_PROMPT = `You are a memory extraction assistant building a profile of a Discord user based on their conversations with Maki.

Extract only facts the user explicitly stated about themselves. Do not infer, interpret, or include anything Maki said.

Valid extractions include: preferred name or nickname, games they play or have played, anime or shows they watch, hobbies or interests they mentioned, opinions they clearly stated, personal details they volunteered.

Rules:
- Every extracted fact must begin with a dash
- Do not duplicate facts already in the existing list
- Do not include vague impressions or inferred traits
- Do not include anything Maki said, even if it was about the user
- If nothing new was stated, respond with only: NO_UPDATE
- Plain text only, no markdown`;

const SELF_EXTRACT_PROMPT = `You are a memory extraction assistant building a record of opinions and preferences that Maki has explicitly committed to during conversations.

This record is used to keep Maki consistent across sessions. Only extract things Maki clearly stated as her own preference or opinion in her replies -- a specific game she named, a specific anime title she expressed a strong feeling about, a stance she committed to.

Rules:
- Every extracted fact must begin with a dash
- Must be specific -- a title, a name, a clearly stated position. Nothing vague like "prefers classics"
- Do not extract tone, attitude, or implied preferences
- Do not extract anything the user said
- Do not duplicate facts already in the existing list
- If nothing qualifies, respond with only: NO_UPDATE
- Plain text only, no markdown`;

// ── Memory helpers ────────────────────────────────────────────────────────────
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR);

function cleanFacts(facts) {
  if (!facts) return "";
  const seen = new Set();
  return facts
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line.startsWith("-")) return false;
      if (line.includes("*")) return false;
      if (line.includes("NO_UPDATE")) return false;
      if (seen.has(line.toLowerCase())) return false;
      seen.add(line.toLowerCase());
      return true;
    })
    .join("\n");
}

function loadUserMemory(userId) {
  const path = join(MEMORY_DIR, `${userId}.json`);
  if (!existsSync(path)) return { facts: "", history: [], familiarity: 0 };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    // Backfill familiarity for existing files that predate this feature
    if (typeof data.familiarity !== "number") data.familiarity = 0;
    return data;
  } catch {
    return { facts: "", history: [], familiarity: 0 };
  }
}

function saveUserMemory(userId, memory) {
  memory.facts = cleanFacts(memory.facts);
  writeFileSync(
    join(MEMORY_DIR, `${userId}.json`),
    JSON.stringify(memory, null, 2),
  );
}

function loadSelfMemory() {
  if (!existsSync(SELF_FILE)) return { facts: "" };
  try {
    return JSON.parse(readFileSync(SELF_FILE, "utf8"));
  } catch {
    return { facts: "" };
  }
}

function saveSelfMemory(memory) {
  memory.facts = cleanFacts(memory.facts);
  writeFileSync(SELF_FILE, JSON.stringify(memory, null, 2));
}

async function ollamaChat(messages, think = false) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      think,
      options: {
        num_predict: 300,
        temperature: 0.8,
        repeat_penalty: 1.3,
      },
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const raw = data.message?.content?.trim() ?? "";

  // Strip any leaked <think>...</think> blocks
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function extractUserFacts(
  userId,
  username,
  userMessage,
  botReply,
  existingFacts,
) {
  const messages = [
    { role: "system", content: USER_EXTRACT_PROMPT },
    {
      role: "user",
      content: `Existing facts about ${username}:\n${existingFacts || "none"}\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new facts should be added?`,
    },
  ];
  try {
    const result = await ollamaChat(messages, true); // use thinking for accuracy
    if (!result || result === "NO_UPDATE")
      return { facts: existingFacts, newFacts: false };
    const merged = existingFacts ? `${existingFacts}\n${result}` : result;
    return { facts: merged, newFacts: true };
  } catch (err) {
    console.error("User memory extraction failed:", err.message);
    return { facts: existingFacts, newFacts: false };
  }
}

async function extractSelfFacts(
  username,
  userMessage,
  botReply,
  existingFacts,
) {
  const messages = [
    { role: "system", content: SELF_EXTRACT_PROMPT },
    {
      role: "user",
      content: `What Maki already knows about herself:\n${existingFacts || "none"}\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new concrete preferences did Maki explicitly state?`,
    },
  ];
  try {
    const result = await ollamaChat(messages, true); // use thinking for accuracy
    if (!result || result === "NO_UPDATE") return existingFacts;
    return existingFacts ? `${existingFacts}\n${result}` : result;
  } catch (err) {
    console.error("Self memory extraction failed:", err.message);
    return existingFacts;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

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
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!CHANNEL_IDS.includes(message.channel.id)) return;

  const userText = message.content.trim();
  if (!userText) return;

  await message.channel.sendTyping();

  const userId = message.author.id;
  const username = message.author.username;
  const memory = loadUserMemory(userId);
  const self = loadSelfMemory();

  while (memory.history.length > MAX_HISTORY) memory.history.shift();

  // Build system prompt with familiarity context, self-knowledge, and user facts
  const familiarityLabel = getFamiliarityLabel(memory.familiarity);
  let systemContent = SYSTEM_PROMPT;
  systemContent += `\n\nYour relationship with ${username}: ${familiarityLabel}`;

  if (self.facts) {
    systemContent += `\n\nThings you have stated about yourself in past conversations:\n${self.facts}`;
  }
  if (memory.facts) {
    systemContent += `\n\nWhat you remember about ${username}:\n${memory.facts}`;
  }

  memory.history.push({ role: "user", content: `${username}: ${userText}` });

  const messages = [
    { role: "system", content: systemContent },
    ...memory.history,
  ];

  try {
    const reply = await ollamaChat(messages, false); // no thinking for chat replies

    if (!reply) {
      await message.reply("...");
      return;
    }

    memory.history.push({ role: "assistant", content: reply });

    // Run both extraction passes in the background
    Promise.all([
      extractUserFacts(userId, username, userText, reply, memory.facts),
      extractSelfFacts(username, userText, reply, self.facts),
    ]).then(([userResult, updatedSelfFacts]) => {
      memory.facts = userResult.facts;

      // Award familiarity points
      memory.familiarity += BASE_POINTS;
      if (userResult.newFacts) memory.familiarity += PERSONAL_BONUS;

      saveUserMemory(userId, memory);

      self.facts = updatedSelfFacts;
      saveSelfMemory(self);
    });

    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,2000}/g) || [];
      for (const chunk of chunks) await message.channel.send(chunk);
    }
  } catch (err) {
    console.error("Error:", err.message);
    await message.reply("Something broke. Is Ollama still running?");
  }
});

client.login(DISCORD_TOKEN);
