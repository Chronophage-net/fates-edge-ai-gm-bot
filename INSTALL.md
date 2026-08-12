# Installing the AI GM Bot

Think of this the same way you'd think about installing a plugin or an
NPC-bot onto a dedicated game server: it's optional, it connects to a
server that's already running, and it needs its own small config file.
The "server" it connects to is the **[Fate's Edge Socket
Server](../fates-edge-socket-server/INSTALL.md)** — set that up first if
you haven't. This bot then joins a room on it, claims the Game Master
seat, and runs the game.

---

## Before You Start

- [ ] **Your Socket Server's address and a room code** — the same
      address/room your players use in the Web Client. If it's running
      on the same machine, that's `ws://localhost:10000` by default.
- [ ] **Node.js 18+**, or **Docker** if you'd rather containerize it
      (same choice as the other two guides).
- [ ] **An AI "brain" for it to use** — pick one before you start the
      setup wizard, since it'll ask:
  - **OpenAI or DeepSeek** — easiest to set up (just an API key from
    their website), costs a small amount per message (typically
    fractions of a cent), runs in the cloud.
  - **Ollama** — free and fully private (runs on your own hardware), but
    you install [Ollama](https://ollama.com) separately first and pull
    a model (`ollama pull mistral`, or similar). Needs a reasonably
    capable machine/GPU for good response times.
- [ ] **The Socket Server's `API_KEY`** — needed so the bot can save/load
      campaign data. Whoever set up the Socket Server has this (see that
      guide's config step).

---

## The Fast Way: Setup Wizard + Node.js

This is genuinely the easiest path even if you're not a developer — the
wizard asks plain questions and writes your config file for you. No
manual editing required (though you can, later).

**1. Install [Node.js](https://nodejs.org/) 18 or newer.**

**2. Get the files:**
```bash
git clone https://github.com/Chronophage-net/fates-edge-ai-gm-bot.git
cd fates-edge-ai-gm-bot
npm install
```

**3. Run the setup wizard:**
```bash
npm run configure
```
It'll ask you to:
- Pick an AI driver (OpenAI / DeepSeek / Ollama) from a numbered list.
- Enter that driver's API key (or a path to a file containing it, if you
  keep secrets in files rather than pasting them into a terminal).
- Enter your Socket Server's address (`WS_URL`) and room code (`ROOM`).
- Enter the Socket Server's `API_KEY`.

This writes a `.env` file — your bot's config file, same idea as the
other two guides' `.env`. You can hand-edit it later; see the
[Configuration Reference](#configuration-reference) below.

**4. Start it:**
```bash
npm start
```
You'll see it connect, claim the GM seat, and start listening in the
room's chat. Leave this terminal window open, or see [Keeping It
Running](#keeping-it-running) below to run it in the background.

**5. Check it's alive:** open `http://localhost:4141` in a browser — a
live status dashboard showing recent activity, the loaded adventure,
session token usage, and connection status. This is the fastest way to
confirm the bot is actually doing something without reading raw
terminal output.

---

## The Docker Way

**1. Get the files** (same as step 2 above, or download as a ZIP).

**2. Configure it.** Docker doesn't run the interactive wizard for you
   (it needs a real terminal to ask questions) — either:
   - Run the wizard once outside Docker first (`npm install && npm run
     configure`, from the Fast Way above) to generate `.env`, then use
     Docker from here on, **or**
   - Or write `.env` by hand — `env-deepseek.md` in this folder is a
     working example for the DeepSeek driver; see the [Configuration
     Reference](#configuration-reference) below, or README.md's "Manual
     Configuration" section, for OpenAI/Ollama examples.

**3. Start it:**
```bash
docker compose up -d
```
This starts just the bot. `http://localhost:4141` for the status
dashboard, same as above. (This `docker-compose.yml` can *also* start a
local Elasticsearch alongside the bot for the optional "Long-Term
Memory" feature — see the README section of that name — but you don't
need it for a normal game; leave it alone.)

**Running more than one bot** (e.g. two separate tables/campaigns)? Give
each its own folder + `.env` + a distinct `STATUS_PORT`, so their
dashboards don't collide on port `4141`.

---

## Configuration Reference

Your `.env` file is plain `KEY=value` lines. The wizard writes the
essentials; here's what each one does if you want to hand-edit later
(full list, including every driver-specific variable, in `README.md`'s
"Environment Variables Reference"):

| Setting | What it means |
|---|---|
| `AI_PROVIDER` | `openai`, `deepseek`, or `ollama` — which brain to use. |
| `WS_URL` | Your Socket Server's address, e.g. `ws://localhost:10000` or `ws://your-server-ip:10000`. |
| `ROOM` | The room code the bot joins — same code your players use. |
| `BOT_NAME` | What players see it as in chat. Defaults to `AI_GM`. |
| `API_KEY` | The Socket Server's admin key — required for the bot to save/load campaign progress. |
| `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` | Your key from that provider, if you chose it. |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | Where Ollama is running (default `http://localhost:11434`) and which model to use, if you chose Ollama. |
| `HEADLESS` | Set to `true` when running unattended (Docker, a background service) — skips interactive prompts that would otherwise hang forever waiting for a terminal that isn't there. |
| `LOG_LEVEL` | `info` (default) or `debug`. Leave at `info` unless you're troubleshooting — `debug` also shows raw background chatter (sync ticks, wire traffic) that's normally hidden. |
| `STATUS_PORT` | Port for the status dashboard (default `4141`). |
| `STATUS_SERVER` | Set to `false` to turn the dashboard off entirely. |
| `STATUS_HOST` | Binds to `127.0.0.1` (this machine only) by default — the dashboard has no login. Set to `0.0.0.0` only if you deliberately want it reachable from other devices on your LAN. Docker's own `docker-compose.yml` already sets this for you (containers need it to make their published port work at all). |

---

## Keeping It Running

**Docker:** already handled — `docker-compose.yml` sets `restart:
unless-stopped`, so it survives crashes and comes back after a reboot
(as long as Docker itself is set to start on boot).

**Manual/Node:** same situation as the Socket Server — closing the
terminal stops the bot. Use [pm2](https://pm2.keymetrics.io/):
```bash
npm install -g pm2
pm2 start ai-gm-bot.js --name fates-edge-gm-bot
pm2 save
pm2 startup     # prints one command to run so it survives a reboot too
```
`pm2 logs fates-edge-gm-bot` to check on it. Also set `HEADLESS=true` in
your `.env` first — running unattended under pm2 is exactly the
situation that flag is for.

---

## Updating to a New Version

**Docker:**
```bash
git pull
docker compose up -d --build
```

**Manual/Node:**
```bash
git pull
npm install
# restart however you started it: `npm start`, or `pm2 restart fates-edge-gm-bot`
```

Your `.env` isn't touched by updates — nothing to reconfigure. The bot
itself doesn't hold campaign data (the Socket Server does — see that
guide's backup section); the only thing local to the bot worth knowing
about is the optional Elasticsearch long-term-memory index, if you
turned that on (see README's "Long-Term Memory" section).

---

## Troubleshooting

**The bot connects but nobody sees it in chat.**
Double-check `ROOM` in `.env` matches the exact room code your players
are using — a mismatched code means you're technically running two
separate, empty rooms.

**"AI error" messages instead of real responses.**
Almost always a bad or missing API key for your chosen provider — check
`OPENAI_API_KEY`/`DEEPSEEK_API_KEY`, or that Ollama is actually running
(`OLLAMA_BASE_URL` reachable) if you chose that route.

**"Failed to auto-save campaign: HTTP 401."**
Your `API_KEY` in `.env` doesn't match the Socket Server's own
`API_KEY`. These have to be identical — it's the server's admin key, not
something the bot generates itself.

**The bot hangs forever and never finishes starting (Docker, or any
unattended setup).**
Set `HEADLESS=true` in `.env`. Without it, some setup paths (notably an
Ollama model that needs recovery) try to ask an interactive question
that never gets answered because there's no terminal attached.

**I can't reach `http://localhost:4141`.**
Either `STATUS_SERVER=false` is set (remove it or set `true`), or —
if you're running the bot on a different machine than the one you're
browsing from — use that machine's IP instead of `localhost`, and make
sure port `4141` (or your `STATUS_PORT`) isn't blocked by a firewall.

**Running two bots and their dashboards keep conflicting.**
Give each bot its own `STATUS_PORT` in its own `.env` — see "Running
more than one bot" above.

---

For AI backend details, the full environment variable list, and how the
bot's tag system/adventure logic works, see [README.md](README.md).
