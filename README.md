# Maki

A Discord bot with a persistent persona, powered by a local [Ollama](https://ollama.com) model. Maki is a personal project for exploring AI prompting, character design, and how LLMs respond to memory and context over time.

## What it does

Maki runs as a person in a Discord channel — She has a detailed backstory (35, Tokyo → Seattle, tech infrastructure, dry humor, gamer), genuine curiosity, and opinions. She is not designed to be helpful; but engage in conversation. 

Beyond the persona, the interesting parts are the systems underneath:

- **Per-user memory** — after each exchange, a separate extraction pass pulls facts the user stated about themselves and stores them to disk. Maki remembers names, interests, and details across sessions.
- **Self-memory** — Maki also accumulates a record of what she has revealed about herself through conversation. This feeds back into future prompts, letting her identity develop organically.
- **Familiarity system** — each user has a numeric score that increases with every exchange (faster when personal facts emerge). The score maps to a relationship tier (Stranger → Acquaintance → Comfortable → Genuine → Close) that shapes how Maki responds.
- **Time-of-day context** — current time is injected as ambient context. Late night Maki is different from midday Maki.
- **Loop detection** — if recent replies are >80% similar, a self-correction pass fires automatically and generates a fresh response.

The project has two independent entry points:

- **bot.js** — Discord bot only, no web interface
- **server.js** — Express server with a web chat UI and REST API

## Bot commands

Commands available in Discord:

| Command | Description |
|---|---|
| `!options` | List available commands |
| `!familiarity` | Show your familiarity score and relationship tier |
| `!facts` | See what Maki knows about you |
| `!clearhistory` | Wipe conversation history (facts kept) |
| `!resetme` | Wipe history and facts (familiarity kept) |
| `!fullreset` | Complete reset |

Admin commands (requires `ADMIN_ID` set):

| Command | Description |
|---|---|
| `!inspect @user` | View a user's memory and familiarity |
| `!resetuser @user` | Reset a user's memory |
| `!setfamiliarity @user <score>` | Manually set a familiarity score |

## Web UI

Running `server.js` also serves a browser-based chat interface with a diagnostics sidebar:

- Chat panel for sending and receiving messages
- Model selection and Ollama URL configuration
- Sampling controls (temperature, top-p, top-k, repeat penalty, max tokens)
- Session stats (familiarity, history size, last seen, response time, loop detection status)
- Memory inspector showing user and Maki facts with decay tier labels
- Buttons to clear history or reset memory

Settings adjusted in the web UI are saved to `memory/_settings.json` and persist across restarts.

## Memory files

Maki stores state in the `./memory/` directory:

- `memory/<discord-user-id>.json` — per-user facts, conversation history, familiarity score, and last-seen timestamp
- `memory/maki.json` — Maki's accumulated self-knowledge
- `memory/_settings.json` — server-wide model and sampling settings

These are plain JSON files. You can inspect, edit, or delete them freely. Deleting a user file resets Maki's memory of that person entirely.

## Project goals

This is a learning project. The things I am interested in:

- How much character can be established through a system prompt alone
- How memory and context injection affect model behavior over time
- Prompt design for extraction tasks (pulling structured facts from unstructured conversation)
- How familiarity and relationship framing change the feel of responses
- The practical limits of local models for this kind of work

---

## Building Maki yourself

### Requirements

- [Node.js](https://nodejs.org) v18+
- [Ollama](https://ollama.com) running locally with a model pulled

### Setup

**1. Clone and install dependencies**

```bash
git clone https://github.com/BradleyCharles/Maki
cd maki
npm install
```

**2. Pull a model in Ollama**

```bash
ollama pull gemma4:e4b
```

Any chat model will work. Models with extended thinking (like qwen3) handle the background extraction passes well. The default model for both entry points is `gemma4:e4b`.

---

### Start scripts

| Command | What it runs |
|---|---|
| `npm start` | Both the web server and the Discord bot |
| `npm run server` | Web server only (offline testing, no Discord required) |
| `npm run bot` | Discord bot only |
| `npm run dev` | Web server with nodemon (auto-restart on changes) |

---

### Option A — Run offline with the web UI

No Discord bot or `.env` file required. This is the fastest way to test Maki locally.

```bash
npm run server
```

Open `http://localhost:3000` in your browser. You can chat with Maki, inspect memory, and adjust model settings from the diagnostics sidebar.

---

### Option B — Run as a Discord bot

Requires a Discord bot token and a server to add it to.

**1. Create a Discord bot**

- Go to the [Discord Developer Portal](https://discord.com/developers/applications)
- Create a new application and add a Bot
- Under **Privileged Gateway Intents**, enable **Message Content Intent**
- Copy the bot token
- Invite the bot to your server with the `bot` scope and `Send Messages` / `Read Message History` permissions

**2. Configure environment variables**

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Your Discord bot token |
| `CHANNEL_ID` | yes | — | Channel ID(s) Maki listens in (comma-separated for multiple) |
| `OLLAMA_URL` | no | `http://localhost:11434` | Ollama API base URL |
| `MODEL` | no | `gemma4:e4b` | Ollama model name |
| `ADMIN_ID` | no | — | Discord user ID for admin commands |

To get a channel ID: enable Developer Mode in Discord settings, then right-click a channel and select **Copy Channel ID**.

**3. Start**

```bash
npm run bot        # Discord bot only
npm start          # Discord bot + web UI together
```
