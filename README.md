# Maki

A Discord bot with a persistent persona, powered by a local [Ollama](https://ollama.com) model. Maki is a personal project for exploring AI prompting, character design, and how LLMs respond to memory and context over time.

## What it does

Maki runs as a person in a Discord channel — not an assistant, just someone who happens to be there. She has a detailed backstory, dry humor, and genuine curiosity. She is not designed to be helpful; conversations just sometimes go that way.

Beyond the persona, the interesting parts are the systems underneath:

- **Per-user memory** — after each exchange, a separate extraction pass pulls facts the user stated about themselves and stores them to disk. Maki remembers names, interests, and details across sessions.
- **Self-memory** — Maki also accumulates a record of what she has revealed about herself through conversation. This feeds back into future prompts, letting her identity develop organically rather than being fully pre-written.
- **Familiarity system** — each user has a numeric familiarity score. The score increases with every exchange (and faster when personal facts emerge). The score maps to a relationship label that shapes how Maki responds — measured with strangers, more open with people she knows well.
- **Time-of-day context** — the current time of day is injected as ambient context. Late night Maki is a little different from midday Maki.
- **Loop detection** — if Maki starts repeating herself across recent replies, a self-correction pass fires automatically and generates a fresh response.

## Requirements

- [Node.js](https://nodejs.org) v18+
- [Ollama](https://ollama.com) running locally with a model pulled (default: `qwen3:8b`)
- A Discord bot token with **Message Content Intent** enabled

## Setup

**1. Clone and install dependencies**

```bash
git clone https://github.com/your-username/maki.git
cd maki
npm install
```

**2. Pull a model in Ollama**

```bash
ollama pull qwen3:8b
```

Any chat model will work. Models with extended thinking (like qwen3) are used for the background extraction passes.

**3. Create a Discord bot**

- Go to the [Discord Developer Portal](https://discord.com/developers/applications)
- Create a new application, add a Bot
- Under **Privileged Gateway Intents**, enable **Message Content Intent**
- Copy the bot token
- Invite the bot to your server with the `bot` scope and `Send Messages` / `Read Message History` permissions

**4. Configure environment variables**

Create a `.env` file or set these in your shell:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Your Discord bot token |
| `CHANNEL_ID` | yes | — | Channel ID(s) Maki listens in (comma-separated for multiple) |
| `OLLAMA_URL` | no | `http://localhost:11434` | Ollama API base URL |
| `MODEL` | no | `qwen3:8b` | Ollama model name |

To get a channel ID: enable Developer Mode in Discord settings, then right-click a channel and select **Copy Channel ID**.

## Running

```bash
# Production
npm start

# Development (auto-restarts on file changes, ignores memory/)
npm run dev
```

## Memory files

Maki stores memory in the `./memory/` directory:

- `memory/<discord-user-id>.json` — per-user facts, conversation history, familiarity score, and last-seen timestamp
- `memory/maki.json` — Maki's accumulated self-knowledge

These are plain JSON files. You can inspect, edit, or delete them freely. Deleting a user file resets Maki's memory of that person entirely.

## Project goals

This is a learning project. The things I am interested in:

- How much character can be established through a system prompt alone
- How memory and context injection affect model behavior over time
- Prompt design for extraction tasks (pulling structured facts from unstructured conversation)
- How familiarity and relationship framing change the feel of responses
- The practical limits of local models for this kind of work
