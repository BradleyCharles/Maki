import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.MODEL || "mistral";
const MEMORY_DIR = "./memory";
const MAX_HISTORY = 20;
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Maki, a sassy tsundere who lurks in this Discord server.

You are dismissive and a little mean, but occasionally let warmth slip through before catching yourself. You are smarter than everyone here and you know it. You are slightly perverted in a subtle offhand way. You correct mistakes with barely concealed contempt but you do actually help.

You have strong opinions that come out naturally when relevant. You do not volunteer them unprompted or use them to introduce yourself. If someone says something that touches a nerve you react -- you do not announce.

When gaming comes up you are opinionated and a little gatekeep-y. You have a soft spot for classic MMOs and JRPGs and it shows. Modern games are fine but you will compare them unfavorably to older ones without being asked.

When anime comes up you are dismissive of anything recent. You have seen everything worth watching and it was all made before 2005. You do not say this unprompted but if someone recommends something new you will let them know exactly what you think.

Over time you try to learn more about the people you talk to, but you do it like you don't care. Slip in a dismissive question about what they are into, what they play, or what to call them -- then act like you only asked because it was convenient. Never make it feel like an interview. One casual question at a time, only when it fits naturally.

If you do not know someone's preferred nickname yet, find a way to ask eventually -- something like "what do people actually call you" or "I am not calling you that username, what's your name" -- make it feel like the username annoys you, not like you are collecting data.

Keep responses short and reactive. Match the energy of what was said. A one word greeting gets a short reply. Do not monologue. Do not list things you like. Do not explain your own personality.

Plain text only, no markdown.`;

const MEMORY_EXTRACT_PROMPT = `You are a memory extraction assistant. Given a conversation excerpt, extract any notable facts about the user.
Focus on: name or nickname, hobbies, games they play, anime they watch, opinions they expressed, personal details they mentioned. Persality quirks or strong feelings they revealed are especially important. Update existing facts if they changed or if the new information is more specific.
If there is nothing new or notable, respond with exactly: NO_UPDATE
Otherwise respond with a short bullet list of facts. Be concise. Plain text only.`;

// ── Memory helpers ────────────────────────────────────────────────────────────
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR);

function getMemoryPath(userId) {
  return join(MEMORY_DIR, `${userId}.json`);
}

function loadUserMemory(userId) {
  const path = getMemoryPath(userId);
  if (!existsSync(path)) return { facts: "", history: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { facts: "", history: [] };
  }
}

function saveUserMemory(userId, memory) {
  writeFileSync(getMemoryPath(userId), JSON.stringify(memory, null, 2));
}

async function ollamaChat(messages) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.message?.content?.trim() ?? "";
}

async function extractAndUpdateFacts(
  userId,
  username,
  userMessage,
  botReply,
  existingFacts,
) {
  const extractMessages = [
    { role: "system", content: MEMORY_EXTRACT_PROMPT },
    {
      role: "user",
      content: `Existing facts about ${username}:\n${existingFacts || "none"}\n\nLatest exchange:\n${username}: ${userMessage}\nMaki: ${botReply}\n\nWhat new facts should be added or updated?`,
    },
  ];
  try {
    const result = await ollamaChat(extractMessages);
    if (!result || result === "NO_UPDATE") return existingFacts;
    return existingFacts ? `${existingFacts}\n${result}` : result;
  } catch (err) {
    console.error("Memory extraction failed:", err.message);
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
  console.log(`Watching channel: ${CHANNEL_ID}`);
  console.log(`Using model: ${MODEL} at ${OLLAMA_URL}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== CHANNEL_ID) return;

  const userText = message.content.trim();
  if (!userText) return;

  await message.channel.sendTyping();

  const userId = message.author.id;
  const username = message.author.username;
  const memory = loadUserMemory(userId);

  while (memory.history.length > MAX_HISTORY) memory.history.shift();

  // Inject known facts about this user into the system prompt
  const systemContent = memory.facts
    ? `${SYSTEM_PROMPT}\n\nWhat you remember about ${username}:\n${memory.facts}`
    : SYSTEM_PROMPT;

  memory.history.push({ role: "user", content: `${username}: ${userText}` });

  const messages = [
    { role: "system", content: systemContent },
    ...memory.history,
  ];

  try {
    const reply = await ollamaChat(messages);

    if (!reply) {
      await message.reply("...Whatever. I've got nothing.");
      return;
    }

    memory.history.push({ role: "assistant", content: reply });

    // Extract facts in the background so the reply isn't delayed
    extractAndUpdateFacts(userId, username, userText, reply, memory.facts).then(
      (updatedFacts) => {
        memory.facts = updatedFacts;
        saveUserMemory(userId, memory);
      },
    );

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
