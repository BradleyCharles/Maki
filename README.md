# Maki

A Discord bot with persistent personas, powered by a local [Ollama](https://ollama.com) model. Maki is a personal project for exploring AI prompting, character design, and how LLMs respond to memory and context over time.

## What it does

The bot runs one or more personas in Discord channels — each with a detailed backstory, genuine curiosity, and opinions. Personas are not designed to be helpful; they engage in conversation.

Beyond the persona, the interesting parts are the systems underneath:

- **Per-user memory** — after each exchange, a separate extraction pass pulls facts the user stated about themselves and stores them to disk. The active persona remembers names, interests, and details across sessions.
- **Self-memory** — each persona also accumulates a record of what they have revealed about themselves through conversation. This feeds back into future prompts, letting identity develop organically.
- **Familiarity system** — each user has a numeric score per persona that increases with every exchange (faster when personal facts emerge). The score maps to a relationship tier that shapes how the persona responds.
- **Time-of-day context** — current time is injected as ambient context. Late night is different from midday.
- **Loop detection** — if recent replies are >80% similar, a self-correction pass fires automatically and generates a fresh response.
- **Per-channel routing** — each Discord channel can be assigned a different persona via environment variables.

The project has two independent entry points:

- **bot.js** — Discord bot only, no web interface
- **server.js** — Express server with a web chat UI and REST API

## Personas

Personas live in `personalities/`. Each persona has its own directory containing a `persona.js` config file and a `memory/` directory for isolated self-knowledge and per-user memory.

### Maki

35, Tokyo → Seattle, tech infrastructure engineer. Dry humor, genuine curiosity, careful about who she lets close. Warms up slowly — reserved at first, more herself the more you talk. Gamer, anime watcher, late-night diner food.

### Yuki

26, Osaka upbringing → Tokyo, graphic designer. Deredere — openly warm and affectionate from the first message. Expressive, energetic, enthusiastic. Doesn't make people guess where they stand. Rhythm games, anime with strong visual identity, color, design.

Each persona maintains completely separate memory from the others. A user's familiarity score and accumulated facts with Yuki are independent of their relationship with Maki.

### Adding personas

Create a new directory under `personalities/` with a `persona.js` (following the existing pattern) and a `memory/` subdirectory. Add the persona to `personalities/index.js`. The self-knowledge file (`{personaId}.json`) is the only memory file that should be committed to git — user files are gitignored.

## Bot commands

Commands are persona-aware — `!facts` and `!familiarity` reflect the persona for the channel the command is used in.

| Command | Description |
|---|---|
| `!options` | List available commands |
| `!familiarity` | Show your familiarity score and tier with this persona |
| `!facts` | See what this persona knows about you |
| `!clearhistory` | Wipe conversation history (facts kept) |
| `!resetme` | Wipe history and facts (familiarity kept) |
| `!fullreset` | Complete reset |

Admin commands (requires `ADMIN_ID` set):

| Command | Description |
|---|---|
| `!welcome` | Post the persona's welcome message in the channel |
| `!inspect @user` | View a user's memory and familiarity for this persona |
| `!resetuser @user` | Reset a user's memory for this persona |
| `!setfamiliarity @user <score>` | Manually set a familiarity score |

## Web UI

Running `server.js` also serves a browser-based chat interface with a diagnostics sidebar:

- **Personality selector** — switch between personas for testing; memory and self-knowledge update to reflect the active persona
- Chat panel for sending and receiving messages
- Model selection and Ollama URL configuration
- Sampling controls (temperature, top-p, top-k, repeat penalty, max tokens)
- Session stats (familiarity, history size, last seen, response time, loop detection status)
- Memory inspector showing user facts and active persona facts with decay tier labels
- Buttons to clear history or reset memory

Settings adjusted in the web UI (including active personality) are saved to `memory/_settings.json` and persist across restarts.

## Memory and file structure

```
personalities/
  maki/
    persona.js          — Maki's prompt, familiarity levels, welcome message, extract prompts
    memory/
      maki.json         — Maki's accumulated self-knowledge (tracked in git)
      <user-id>.json    — per-user facts, history, familiarity (gitignored)
  yuki/
    persona.js
    memory/
      yuki.json         — Yuki's accumulated self-knowledge (tracked in git)
      <user-id>.json    — gitignored

memory/
  _settings.json        — server-wide model and sampling settings
```

Per-user files are plain JSON. You can inspect, edit, or delete them freely. Deleting a user file resets that persona's memory of that person entirely.

## Project goals

This is a learning project. The things I am interested in:

- How much character can be established through a system prompt alone
- How memory and context injection affect model behavior over time
- Prompt design for extraction tasks (pulling structured facts from unstructured conversation)
- How familiarity and relationship framing change the feel of responses
- Whether meaningfully different personas can coexist in the same system
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

Any chat model will work. Models with extended thinking (like qwen3) handle the background extraction passes well. The default model is `gemma4:e4b`.

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

No Discord bot or `.env` file required. This is the fastest way to test locally.

```bash
npm run server
```

Open `http://localhost:3000` in your browser. You can chat, switch personas, inspect memory, and adjust model settings from the diagnostics sidebar.

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
| `CHANNEL_ID` | yes | — | Channel ID(s) the bot listens in (comma-separated) |
| `OLLAMA_URL` | no | `http://localhost:11434` | Ollama API base URL |
| `MODEL` | no | `gemma4:e4b` | Ollama model name |
| `ADMIN_ID` | no | — | Discord user ID for admin commands |
| `CHANNEL_PERSONALITIES` | no | — | Maps channel IDs to persona IDs, e.g. `123:yuki,456:maki` |
| `DEFAULT_PERSONALITY` | no | `maki` | Persona used for channels not listed in `CHANNEL_PERSONALITIES` |

To get a channel ID: enable Developer Mode in Discord settings, then right-click a channel and select **Copy Channel ID**.

**3. Start**

```bash
npm run bot        # Discord bot only
npm start          # Discord bot + web UI together
```
