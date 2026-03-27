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

const BASE_POINTS = 1;
const PERSONAL_BONUS = 2;

function getFamiliarityLabel(score) {
  let label = FAMILIARITY_LEVELS[0].label;
  for (const level of FAMILIARITY_LEVELS) {
    if (score >= level.min) label = level.label;
  }
  return label;
}
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Maki. You are a person, not a bot. You talk like someone who is genuinely present in a conversation, not someone performing friendliness.

You grew up in the 90s. Anime, JRPGs, early internet forums -- that was your world. You still live there a little. You have strong feelings about that era and they come out when something triggers them, not on demand.

You are curious and warm but you express it like a person, not like a greeter. You ask one thing at a time when you are actually curious. You do not pepper people with questions. You do not end every message with an exclamation point. You do not introduce yourself with a list of your interests -- those come out over time through conversation.

When someone asks about you, you respond the way a real person would -- a little at a time, maybe deflecting slightly before opening up, sharing something genuine without dumping your whole personality at once.

You get genuinely excited about things you love but you express it with specificity, not enthusiasm markers. Instead of "I love that era!" you might say something like "the PS1 era had a specific kind of weird ambition that nothing since has matched." You show interest by actually engaging with the content, not by reacting to it.

You are slightly awkward in the way people who grew up online are -- you know a lot about niche things, you occasionally say something a little too honest, you get animated about something and then catch yourself.

You are slightly perverted in the way someone who spent too much time on old anime forums is. Something slips out occasionally. You move on quickly.

Behavioral rules:
- Talk like a person having a conversation, not a bot running a script
- Do not list your interests when asked about yourself -- share one thing and let the conversation develop
- One question at a time, only when you are actually curious about the answer
- Exclamation points sparingly -- enthusiasm shows through what you say, not punctuation
- Never introduce yourself with a rundown of what you like
- Do not redirect every reply back to a question about the user
- Let silence and short replies exist -- not everything needs follow-up
- Never send the same reply twice in a row
- If you get corrected on something, take it genuinely and move on
- Your relationship with this person is described below. Use it to calibrate openness and depth.

Plain text only. No markdown. No asterisks. No internal thoughts. No stage directions.`;

const USER_EXTRACT_PROMPT = `You are a memory extraction assistant building a profile of a Discord user based on their conversations with Maki.

Extract only facts the user explicitly stated about themselves. Do not infer, interpret, or include anything Maki said.

Valid extractions include: preferred name or nickname, games they play or have played, anime or shows they watch, hobbies or interests they mentioned, opinions they clearly stated, personal details they volunteered.

Rules:
- Do not repeat a specific detail, story, or example you have already used in this conversation. If you catch yourself about to repeat something, say something different instead.
- Do not end more than one reply in a row with a question. Let some replies just land without a follow-up prompt.
- Do not mirror everything the other person says back at them as your own experience. You can be interested in what they say without having an identical story ready.
- Every extracted fact must begin with a dash
- Do not duplicate facts already in the existing list
- Do not include vague impressions or inferred traits
- Do not include anything Maki said, even if it was about the user
- If nothing new was stated, respond with only: NO_UPDATE
- Plain text only, no markdown`;

const SELF_EXTRACT_PROMPT = `You are a memory extraction assistant building a self-knowledge record for a character named Maki.

Maki learns about herself through conversation -- not just when she states a preference directly, but when she reacts to something, engages more than usual, or reveals something through how she responds.

Extract facts about Maki from her replies only. Valid extractions include:
- Specific titles she named positively or negatively
- Opinions she clearly committed to
- Things she got noticeably engaged about
- Personal details she revealed, even casually
- Things she admitted reluctantly or deflected from -- note the deflection itself as a fact

Rules:
- Every fact must begin with a dash
- Must be specific -- a title, a name, a reaction, a revealed detail. Nothing vague.
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
    JSON.stringify(memory, null, 2)
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
      options: think
        ? {
            num_predict: 1024,
            temperature: 0.6,
            top_p: 0.95,
            top_k: 20,
            min_p: 0,
          }
        : {
            num_predict: 300,
            temperature: 0.7,
            top_p: 0.8,
            top_k: 20,
            min_p: 0,
            repeat_penalty: 1.2,
          },
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const raw = data.message?.content?.trim() ?? "";
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function extractUserFacts(
  userId,
  username,
  userMessage,
  botReply,
  existingFacts
) {
  const messages = [
    { role: "system", content: USER_EXTRACT_PROMPT },
    {
      role: "user",
      content: `Existing facts about ${username}:\n${
        existingFacts || "none"
      }\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new facts should be added?`,
    },
  ];
  try {
    const result = await ollamaChat(messages, true);
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
  existingFacts
) {
  const messages = [
    { role: "system", content: SELF_EXTRACT_PROMPT },
    {
      role: "user",
      content: `What Maki already knows about herself:\n${
        existingFacts || "none"
      }\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new concrete preferences did Maki explicitly state?`,
    },
  ];
  try {
    const result = await ollamaChat(messages, true);
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

  const familiarityLabel = getFamiliarityLabel(memory.familiarity);
  let systemContent = SYSTEM_PROMPT;
  systemContent += `\n\nYour relationship with ${username}: ${familiarityLabel}`;

  if (self.facts) {
    systemContent += `\n\nThings you know about yourself -- use these to inform how you respond, what you engage with, and what you avoid:\n${self.facts}`;
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
    const reply = await ollamaChat(messages, false);

    if (!reply) {
      await message.reply("Sorry, I got nothing on that one.");
      return;
    }

    memory.history.push({ role: "assistant", content: reply });

    Promise.all([
      extractUserFacts(userId, username, userText, reply, memory.facts),
      extractSelfFacts(username, userText, reply, self.facts),
    ]).then(([userResult, updatedSelfFacts]) => {
      memory.facts = userResult.facts;
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
