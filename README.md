# 🤖 Fate's Edge AI Game Master Bot

An extensible, pluggable AI bot that connects to the Fate's Edge WebSocket server and acts as a fully automated Game Master. It drives the narrative, interprets player actions, rolls dice, manages the Deck of Consequences, and handles timers – all through a simple terminal or headless operation.

---

## ✨ Features

- **Pluggable AI backends** – use OpenAI, Ollama, DeepSeek, or any custom LLM.
- **Automatic GM takeover** – joins the room, requests the Game Master role, and manages GM approvals.
- **Narrative generation** – interprets player chat and creates immersive, descriptive responses.
- **Dice rolling** – uses Fate's Edge dice mechanics (d10 pool, successes, story beats).
- **Deck of Consequences** – draws cards, performs Crown Spreads, and tracks deck state.
- **Timer management** – creates and ticks scene timers on demand.
- **Player management** – kick, ban, and unban players directly from the bot's terminal.
- **Conversation memory** – maintains a sliding window of recent messages for coherent stories.
- **MUD‑style terminal** – all events are logged in color, and you can manually override the AI by typing messages.
- **One‑click setup wizard** – a configuration script (`configure-bot.js`) that scans available drivers, prompts for API keys, and writes a `.env` file.
- **Live status dashboard** – a local web page (`http://localhost:4141` by default) showing recent
  activity, the loaded adventure, session token usage, and connection state at a glance — see
  "Status Dashboard" below.
- **Leveled logging** – `LOG_LEVEL` keeps noisy background chatter (aggressive-sync ticks, raw
  wire traffic) out of the terminal and dashboard by default; flip to `debug` to see it all.
- **Session token tracking** – real usage counts from OpenAI/DeepSeek/Ollama where the provider
  reports them, so you always know roughly what a session is costing (for paid backends) or how
  close to the model's context window you're running.
- **Optional long-term memory** – Facts, NPCs, and campaign summaries can be indexed into
  Elasticsearch for relevance-ranked recall across a long-running campaign ("who knows about the
  cursed well?"), instead of relying only on a fixed recent-history window — see "Long-Term
  Memory" below. Fully optional; the bot works exactly the same without it.

---

## 🧱 Architecture

```
players in VTT / terminal
        │
        ▼
┌─────────────────────────────┐
│  Fate's Edge Socket Server  │
│   (WebSocket + REST)        │
└─────────────────────────────┘
        │
        ▼
┌───────────────────────────────────┐        ┌───────────────────────────┐
│     AI GM Bot                     │──────▶│  Status Dashboard (HTTP)   │
│  - ai-gm-bot.js (core)            │        │  localhost:4141, optional │
│  - drivers/                       │        └───────────────────────────┘
│    ├── ai-driver.js               │  ← abstract driver interface
│    ├── openai-driver.js           │
│    ├── ollama-driver.js           │        ┌───────────────────────────┐
│    └── deepseek-driver.js         │──────▶│  Elasticsearch, optional   │
│  - modules/                       │        │  long-term memory only    │
│    (game logic, see "Modules")    │        └───────────────────────────┘
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│   AI Backend (OpenAI, etc.) │
└─────────────────────────────┘
```

The core bot is completely decoupled from the AI backend. It communicates with the server via WebSocket and delegates all narrative generation to a **driver**. Drivers implement a simple interface and can be swapped in seconds.

Game logic itself (dice, world data, tag parsing, adventures, etc.) lives in `/modules` and is
driver-agnostic — every driver produces plain text, and `modules/commands.js` parses that text
for `[TAG ...]` markers regardless of which backend generated it. See "Modules" below.

The status dashboard and Elasticsearch are both entirely optional side-components — the bot
works exactly the same with neither running; see "Status Dashboard" and "Long-Term Memory" below.

---

**→ See [INSTALL.md](INSTALL.md) for the full setup guide** — the setup
wizard, Docker, keeping it running long-term, updates, and
troubleshooting, written for anyone who's run a dedicated game server
before. The short version below still works fine too.

## 📦 Prerequisites

- **Node.js** ≥ 18 (includes built‑in `fetch`; no extra dependencies needed for most drivers)
- **A Fate's Edge WebSocket server** (the modular socket server from this repo)
- **An API key for your chosen AI service** (or a local LLM running via Ollama)

---

## 🚀 Installation

```bash
git clone <your-repo-url>
cd ai-gm-bot
npm install
```

Core runtime dependencies: `ws` (WebSocket), `dotenv`, and `openai` (used by the OpenAI driver).
`@elastic/elasticsearch` is also installed but only ever loaded if you set `ES_URL` — see
"Long-Term Memory" below; leave it unset and it's inert.

---

## ⚙️ Configuration – The Easy Way

Run the built‑in configuration wizard:

```bash
npm run configure
# equivalent to: node configure-bot.js
```

It will:

1. Scan the `/drivers` folder and display all available backends.
2. Let you pick a driver.
3. Ask for any required API keys (or a file path containing the key).
4. Generate a `.env` file with all necessary settings.

After the wizard finishes, you can start the bot immediately.

### Manual Configuration (optional)

Create a `.env` file in the bot's root directory. Example for OpenAI:

```
AI_DRIVER=./drivers/openai-driver
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
AI_MODEL=gpt-4o-mini
WS_URL=ws://localhost:10000
ROOM=ABC123
BOT_NAME=AI_GM
```

For Ollama (local or cloud):

```
AI_DRIVER=./drivers/ollama-driver
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral
WS_URL=ws://localhost:10000
ROOM=ABC123
```

For DeepSeek:

```
AI_DRIVER=./drivers/deepseek-driver
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_MODEL=deepseek-chat
WS_URL=ws://localhost:10000
ROOM=ABC123
```

---

## 🧠 Driver System

All drivers live in `/drivers` and extend `ai-driver.js`. A driver must implement:

```javascript
class MyDriver extends AIDriver {
    async generateResponse(context, onToken) {
        // context.systemPrompt  – string
        // context.messages      – array of { role: 'user'|'assistant', content: string }
        // onToken (optional)    – callback invoked with each streamed text chunk,
        //                          if the caller wants a live/typing-style reply.
        //                          Ignore it if you don't support streaming.
        // Return the AI's full reply as a string either way.
    }
}
```

The base `AIDriver` class also provides shared utilities every built-in driver uses,
so behavior doesn't drift between backends:

- **`this.contextWindow`** – the model's real context window in tokens. Set this in your
  driver's constructor (ideally overridable via an env var, since e.g. Ollama's window
  depends entirely on which local model is configured).
- **`trimToFit(context)`** – called internally by each built-in driver's `generateResponse()`
  before sending. Trims the system prompt (keeping the head and tail, cutting the middle) and
  drops the oldest chat messages until everything fits inside `contextWindow`, so a small local
  model's provider-side truncation never silently drops the character sheets or rules text
  instead of old chat history. This is a **last-resort safety net** — the real fix for token
  bloat is `ai-gm-bot.js` sending a pruned prompt in the first place (see "Context Management"
  below), not asking the driver to clean up an oversized one every turn.
- **`_fetchWithRetries(url, options, opts)`** – shared retry/backoff/timeout helper for drivers
  that call a raw HTTP API (DeepSeek, Ollama) instead of an SDK with its own retry handling
  (OpenAI, which is configured via the SDK's own `timeout`/`maxRetries` client options instead).

### Built‑in Drivers

| Driver | File | Retries/Timeout | Context Window | Streaming |
|--------|------|------------------|-----------------|-----------|
| **OpenAI** | `openai-driver.js` | Via SDK (`OPENAI_MAX_RETRIES`, `OPENAI_TIMEOUT_MS`) | `OPENAI_CONTEXT_WINDOW` (default 128000) | ✅ |
| **Ollama** | `ollama-driver.js` | `OLLAMA_MAX_RETRIES`, `OLLAMA_TIMEOUT_MS` | `OLLAMA_CONTEXT_WINDOW` (default 8192 — **set this to match your actual model**) | ✅ |
| **DeepSeek** | `deepseek-driver.js` | `DEEPSEEK_MAX_RETRIES`, `DEEPSEEK_TIMEOUT_MS` | `DEEPSEEK_CONTEXT_WINDOW` (default 64000) | ✅ |

All three now handle transient failures (429/5xx/network errors) with exponential backoff
the same way, instead of that behavior depending on which driver you picked.

To add your own driver, create a file in `/drivers`, implement `generateResponse`, and export a `meta` object:

```javascript
class MyDriver extends AIDriver { ... }
MyDriver.meta = {
    name: 'My Custom LLM',
    description: 'Talks to my server',
    requiredEnv: ['MY_API_KEY']
};
module.exports = MyDriver;
```

It will automatically appear in the configuration wizard.

---

## 🧩 Modules

All game logic lives in `/modules`, separate from the driver layer above. Each module is a
plain CommonJS file (`require`/`module.exports`), most are stateless or take an explicit state
object rather than reaching for globals, and each has a matching test file under
`tests/modules/` (see "Testing" below).

| Module | Responsibility |
|--------|-----------------|
| **`gm-orchestrator.js`** | The brain of the bot — integrates every other module, owns campaign state defaults, and drives the scene lifecycle each turn. |
| **`commands.js`** | Parses `[TAG ...]` markers out of the AI's raw text output (`[ROLL ...]`, `[APPLY ...]`, `[LOOKUP RULE ...]`, `[SET POSITION/DV ...]`, `[TIMER ...]`, `[DRAW ...]`, `[CROWN ...]`, `[NPC CAST/CREATE ...]`, `[SCENE COMPLETE ...]`, `[TOKEN MOVE/REMOVE ...]`, `[ENCOUNTER RESOLVE ...]`, and more) and dispatches each to the module that actually performs it. Also handles `!gm` terminal/chat command dispatch. The single highest-blast-radius file in the bot — regex-based tag parsing silently breaks if the model's output drifts even slightly, so every tag handler here is covered by `tests/modules/commands.test.js`. |
| **`dice.js`** | Fate's Edge dice-pool mechanics: rolling, Position modifiers, the Outcome Matrix (Clean Success / Success with Story Beat / Partial / Miss), Story Beat generation on 1s, Harm/Fatigue application with armor conversion. |
| **`characters.js`** | In-memory character store for the session — attribute/skill resolution (case-insensitive), delta application (Harm/Fatigue/Boons/Obligation/Corruption/Leash) with clamping at their max values. |
| **`world-manager.js`** | Loads and indexes world data (regions, factions, patrons, NPCs, spells, wiki entries) from `data/`. `getRegion()` normalizes a display name to its `data/regions/*.json` filename stem (spaces→underscores, lowercased) — this exact lookup has independently broken and been re-fixed several times across this ecosystem (see "Cross-Repo Region Slug Bug" below), so treat any change here with extra care. |
| **`rules-index.js`** | Splits `data/rules.txt` into named sections and builds a compact section-title index for the system prompt, plus `findSection()` keyword lookup (title match, falling back to body-text match) for `[LOOKUP RULE "..."]`. Lets the bot avoid re-sending the full rulebook every turn — see "Context Management" above. |
| **`travel.js`** | Core Travel Procedure and Worked Itineraries: `generateJourney()` (suit-locked card draws, timer-segment table, policed-region club-source toggling), `generateItineraryJourney()`, `generateTravelersSpread()`, and `handleTravelCommand()` dispatch for the bot's travel subcommands. |
| **`deck.js`** | Deck of Consequences: card draws, Crown Spreads, `transformRegionData()` (converts a region's authored content into the flat suit/rank meaning table), ace effects (region-specific, generic fallback, or partial-key match). |
| **`timers.js`** | Scene- and campaign-level timer create/tick/fill, with boundary clamping so a timer's `current` segment count never exceeds its `max`. |
| **`adventure-director.js`** | Adventure selection and lifecycle — the module selection menu, Crown Spread-driven adventure picks, and handing off into `adventure-context.js`'s scene tracking once one is active. |
| **`adventure-context.js`** | Bridges the bot to the server's Adventure Engine (`server/adventure.js`): `isAdventureActive()` status-machine checks (`planned`/`active`/`completed` × `moduleId` presence) and scene context building for the current turn. Must stay in sync with the server-side contract — see that file's own header comment. |
| **`format-utils.js`** | Small shared text-formatting helpers for chat output: `formatColumns()` (multi-column `ls`-style layout), `shortTitle()` (truncates a long title at its first em-dash/colon). |
| **`logger.js`** | Leveled logging (`error`/`warn`/`info`/`debug`, via `LOG_LEVEL`) shared by the whole bot. Monkey-patches `console.log/warn/error` so every existing call site is automatically level-aware and feeds the in-memory ring buffer the status dashboard reads from — no per-call-site changes needed except the handful of intentionally spammy lines, which call `logger.debug()` directly. |
| **`status-server.js`** | Serves the local status dashboard (see "Status Dashboard" below) — plain `http` + Server-Sent Events, no extra dependency. |
| **`knowledge-index.js`** | Optional Elasticsearch-backed long-term memory (see "Long-Term Memory" below) — indexes Facts/NPCs/campaign summaries and serves relevance-ranked search. No-ops everywhere when `ES_URL` isn't set. |

---

## ▶️ Running the Bot

```bash
npm start
```

The bot connects to the WebSocket server, claims the Game Master role, and starts listening to chat.  
Players will see a join message: *"The AI Game Master has joined."*

### Terminal Commands

Inside the bot's terminal you can type:

- **Any text** – sent as a GM chat message (manual override).
- **`/admin players`** – list players in the room (requires `API_KEY`).
- **`/admin kick <clientId> [reason]`** – kick a player.
- **`/admin ban <clientId> [reason]`** – ban a player.
- **`/admin unban <clientId>`** – remove a ban.

For automated admin via the REST API, set the `API_KEY` environment variable to your server's API key.

---

## 🎮 Bot Behavior

1. **Connects and handshakes** as a GM – if another GM is present, it requests the role and will auto‑approve any pending GM vote.
2. **Narrates** each player message using the selected AI backend.
3. **Processes special commands** found in the AI's output:
   - `[ROLL "Name" Attribute+Skill DV N Position]` → performs a dice roll and posts the result.
   - `[DRAW count region]` → draws cards from the Deck of Consequences.
   - `[TIMER name segments]` / `[SET POSITION ...]` / `[SET DV ...]` / `[APPLY HARM/FATIGUE/BOON ...]` → mechanical state changes.
   - `[LOOKUP RULE "Section Title or keyword"]` → looks up and inserts the full text of one rules.txt
     section. The system prompt only includes a compact section-title index by default (see
     "Context Management" below); the model asks for a section by name when it actually needs the
     exact wording of a specific rule, instead of the whole rulebook being re-sent every turn.
4. **Maintains conversation context** (last `MAX_HISTORY` messages, further trimmed per-driver to
   fit the model's real context window — see "Context Management").
5. **Listens for all server events** (presence, player join/leave, deck updates) and logs them in the terminal.

---

## 🧮 Context Management (Contextual Pruning, Not RAG)

Fate's Edge's game data (regions, characters, rules, adventure state) is small and already
structured/indexed in memory — nothing here needs vector search or a retrieval pipeline. The
fix for token bloat is pruning **what** goes into the prompt, not adding an indirection layer
on top of an oversized one:

> **Exception:** `campaignState.facts` and NPCs registered via `[NPC CREATE ...]` are the one
> part of this that genuinely does grow unbounded over a *long-running* campaign — they're
> dumped in full every turn (facts) or only tracked server-side with no way to search them
> (NPCs). That's what the optional Elasticsearch-backed "Long-Term Memory" feature below
> (`modules/knowledge-index.js`) exists for — real retrieval, but scoped specifically to that
> one growing-without-bound category, not applied to the small, already-pruned state above.

- **Rules text**: the system prompt gets a compact index of `data/rules.txt` section titles, not
  the full ~600-line file. The model requests a specific section in full via
  `[LOOKUP RULE "..."]` only when it actually needs one (see `modules/rules-index.js`).
- **Character sheets**: only the character(s) relevant to the current turn — whoever is
  speaking, plus anyone named in their message — get their full sheet (attributes, skills,
  talents, bonds, complications, assets, followers). Everyone else gets a one-line status
  (Harm/Fatigue/Boons/Obligation only), the same way a human GM only actively "holds" the
  character currently in the spotlight.
- **Driver-level `trimToFit()`**: a last-resort safety net (see "Driver System" above) — it
  should rarely trigger if the pruning above is working, and its warnings in the log are worth
  watching for ("dropped N oldest messages" / "system prompt truncated") since they mean a
  turn's context genuinely didn't fit even after pruning.

---

## 🔗 Integration

The bot expects the Fate's Edge WebSocket server to be running.  
Any client (web VTT, terminal client, Discord bot) can join the same room and interact with the AI GM.

### Running Headless (systemd / Docker / `nohup`)

If you run the bot without an attached terminal, set:

```
HEADLESS=true
```

**This matters most for the Ollama driver.** Its model-recovery flow (offering to pull a
missing model, letting you pick from a list) uses interactive terminal prompts — with no
attached stdin, those prompts never resolve and the process hangs forever instead of failing
in a way a process supervisor could detect and restart. With `HEADLESS=true` (or the more
specific `OLLAMA_NONINTERACTIVE=true`), a missing/broken model logs the available models and
throws immediately instead. Combined with the bot's own startup behavior — `driver.initialize()`
failing now exits the process with a non-zero code — a broken AI backend gets you a clean,
supervisor-restartable failure instead of a silently-broken bot that "connects" but can't
actually respond to anyone.

---

## ✅ Testing

```bash
npm test
```

Runs Node's built-in test runner (`node --test`, Node ≥18 — no extra test dependency) over
everything in `tests/`. Layout mirrors the source tree:

```
tests/
├── drivers/
│   ├── ai-driver.test.js       — trimToFit(), estimateTokens()
│   ├── deepseek-driver.test.js — fetch mocked: happy path, retry/backoff, SSE streaming, error formatting
│   ├── openai-driver.test.js   — SDK client mocked: timeout/maxRetries wiring, streaming, initialize() error rethrow
│   └── ollama-driver.test.js   — fetch mocked: HEADLESS fail-fast, retry/backoff, NDJSON streaming, model recovery
└── modules/
    ├── commands.test.js        — [ROLL]/[APPLY]/[LOOKUP RULE]/[SET ...] tag parsing (see below)
    ├── format-utils.test.js
    ├── rules-index.test.js
    ├── travel.test.js
    ├── deck.test.js
    ├── dice.test.js
    ├── characters.test.js
    ├── world-manager.test.js
    ├── timers.test.js
    └── adventure-context.test.js
```

A few things worth knowing before adding to this suite:

- **Known gaps, not bugs**: `commands.test.js` documents two `[ROLL ...]` parsing cases that
  currently do *not* resolve — a space around the `+` in `Attribute + Skill`, and `DV` given as
  a word (`DV three`) instead of a digit. These are marked with `// KNOWN GAP:` comments rather
  than silently treated as passing; if you fix the parser to handle either, update the test and
  drop the marker.
- **Regex-desync fix (all `[TAG ...]` handlers in `commands.js`)**: every tag handler used to
  scan `output` with a stateful global regex (`while ((match = someRegex.exec(output)) !== null)`)
  while also reassigning `output` inside the loop body. Once a replacement's length differs from
  the tag it replaced — normal for every tag here — the regex's internal `lastIndex` pointed at
  the wrong offset in the mutated string, and later tags of the same type in one message could be
  silently left unresolved (found via a test with four `[APPLY ...]` tags in one message; two
  were skipped). Fixed by resetting `lastIndex = 0` after each mutation (and, for the manual
  `[ROLL ...]` fallback parser, by tracking the scan offset from the actual replacement length
  instead of the pre-replacement tag length). `commands.test.js` has a regression test for this.
- Driver tests mock `fetch` or the SDK client directly rather than hitting real APIs — no network
  access or API keys are needed to run the suite.

---

## 🛠️ Troubleshooting

| Symptom | Solution |
|---------|----------|
| `Cannot find module '../ai-driver'` | Ensure `ai-gm-bot.js` requires `'./drivers/ai-driver'` (correct path). |
| `MODULE_NOT_FOUND: node-fetch` | The bot uses built‑in `fetch`; remove any `require('node-fetch')` from driver files. |
| `EADDRINUSE` on port 10000 | Another process is using the port; kill it or change the server port. |
| Bot doesn't become GM | Check that the server supports GM election. The bot auto‑requests the GM role. |
| AI responses are poor | Tune the system prompt inside `ai-gm-bot.js` (around line 170) or adjust the model's temperature. |
| No response from AI | Verify the API key and model name; check server logs for errors. |
| Bot hangs forever at startup, no output, no crash | You're running Ollama headless without `HEADLESS=true` and it hit a missing/broken model — it's stuck at an interactive prompt with no stdin. Set `HEADLESS=true` and restart. |
| Local model narrates with no mechanical grounding (ignores character stats/rules) | The context window is smaller than what's being sent. Set `OLLAMA_CONTEXT_WINDOW` to match your actual model (check its real window, not just this bot's default guess of 8192) and watch the logs for `trimToFit` truncation warnings. |
| `[LOOKUP RULE "..."]` shows up literally in chat instead of the rule text | The tag's quoted title didn't match any `data/rules.txt` section closely enough — check `!gm` logs for the exact query the model sent, or ask it to use the section title verbatim as shown in the index. |

### Environment Variables Reference

| Variable | Applies To | Default | Purpose |
|----------|-----------|---------|---------|
| `HEADLESS` / `OLLAMA_NONINTERACTIVE` | Ollama | off | Skip interactive model-recovery prompts; fail fast instead. **Required for any unattended deployment.** |
| `OLLAMA_CONTEXT_WINDOW` | Ollama | `8192` | Set to your actual model's real context window. |
| `OLLAMA_TIMEOUT_MS` | Ollama | `60000` | Per-request timeout (local models are slow). |
| `OLLAMA_MAX_RETRIES` | Ollama | `1` | Retries on transient HTTP/network failures. |
| `OPENAI_CONTEXT_WINDOW` | OpenAI | `128000` | Context window for the configured model. |
| `OPENAI_TIMEOUT_MS` | OpenAI | `30000` | Passed to the OpenAI SDK client. |
| `OPENAI_MAX_RETRIES` | OpenAI | `2` | Passed to the OpenAI SDK client (handles 429/5xx internally). |
| `DEEPSEEK_CONTEXT_WINDOW` | DeepSeek | `64000` | Context window for the configured model. |
| `DEEPSEEK_TIMEOUT_MS` | DeepSeek | `30000` | Per-request timeout. |
| `DEEPSEEK_MAX_RETRIES` | DeepSeek | `2` | Retries on transient HTTP/network failures. |
| `LOG_LEVEL` | All | `info` | `error` \| `warn` \| `info` \| `debug`. `debug` also unlocks aggressive-sync ticks and raw inbound WebSocket traffic, both silenced at `info` since they fire constantly. |
| `LOG_RING_SIZE` | All | `300` | How many recent log entries `modules/logger.js` keeps in memory for the status dashboard's feed. |
| `STATUS_SERVER` | All | `true` (any value other than `false`) | Set to `false` to disable the status dashboard entirely. |
| `STATUS_PORT` | All | `4141` | Port for the status dashboard (see "Status Dashboard" below). |
| `STATUS_HOST` | All | `127.0.0.1` (loopback only) | Interface the dashboard binds to. The dashboard has **no login/auth** — it shows live campaign content, so it deliberately doesn't listen beyond your own machine unless you opt in. Set to `0.0.0.0` to allow LAN access (already set for you inside `docker-compose.yml`, since a container needs to bind all interfaces internally for its published port to work at all — that does not, by itself, expose it beyond what you've mapped in `ports:`). |
| `ES_URL` | Long-Term Memory | unset (feature disabled) | Elasticsearch endpoint, e.g. `http://localhost:9200`. Setting this is what turns the whole feature on — see "Long-Term Memory" below. |
| `ES_API_KEY` | Long-Term Memory | unset | Preferred auth method if your cluster supports API keys. |
| `ES_USERNAME` / `ES_PASSWORD` | Long-Term Memory | unset | Basic-auth fallback if `ES_API_KEY` isn't set. |
| `ES_INDEX_PREFIX` | Long-Term Memory | `gm-knowledge` | Index name prefix; one index per campaign (`<prefix>-<campaignCode>`). |
| `ES_TLS_REJECT_UNAUTHORIZED` | Long-Term Memory | `true` | Set to `false` only for a local/dev cluster with a self-signed cert. |

---

## 📊 Status Dashboard

The bot starts a small local web dashboard at **http://localhost:4141** (configurable via
`STATUS_PORT`) alongside the terminal. It shows, live:

- **Latest messages** — the same output as the terminal, minus DEBUG-level noise (aggressive
  sync ticks, raw per-message WebSocket traffic) which is pruned by default. Set `LOG_LEVEL=debug`
  to see everything, in both the terminal and here.
- **Connection** — connected/disconnected, GM/player role, driver + model in use.
- **Adventure Module** — currently loaded adventure title, status, act, and scene.
- **Session Token Usage** — prompt/completion/total tokens across the session, from the active
  driver's real API-reported usage where the provider supplies it (OpenAI, DeepSeek, and Ollama's
  non-streaming path all do), falling back to a `~` estimate otherwise.
- **Party** — synced characters and a one-line Harm/Fatigue status for each.

No extra dependency: it's a plain `http` server pushing updates over Server-Sent Events. Disable
it with `STATUS_SERVER=false` if you don't want it running (e.g. a locked-down headless box).

---

## 🧠 Long-Term Memory (optional, Elasticsearch)

Off by default. Set `ES_URL` and the bot indexes three things into Elasticsearch as they happen:

- **Facts** — every `!gm fact <key> <value>` and every `[FACT ...]` tag the model emits.
- **NPCs** — every `[NPC CREATE "Name" "Role" "Motivation" "Location"]` tag. Location is a fully
  optional 4th argument — plenty of NPCs wander, travel with the party, or just don't have a
  fixed address, and the model is instructed not to invent one to fill the slot. It can be
  set/changed/cleared later, independent of everything else already known about that NPC, via
  `[NPC LOCATION "Name" "Place"]` (or `[NPC LOCATION "Name" ""]` to clear a stale one).
- **Campaign summaries** — every periodic auto-summary (see `SUMMARISE_EVERY`), each kept as its
  own searchable snapshot rather than overwriting the last one.

Why: `campaignState.facts` is dumped into the system prompt **in full, every turn** with no
pruning (see "Context Management" above) — fine for a short campaign, but it grows unbounded
over a long one. NPCs registered via `[NPC CREATE ...]` have no search surface at all today.
Once `ES_URL` is set:

- Every player turn additionally runs a relevance-ranked search (facts + NPCs + summaries) against
  what the player just said, and injects only the handful of actually-relevant hits into the
  prompt as a **"Relevant Memory"** block — instead of relying on the model still holding it in
  raw chat history (which gets pruned) or the ever-growing full facts dump. This is additive: the
  existing facts dump and everything else in "Context Management" stays exactly as-is.
- **`!gm recall <query>`** — the same search, run manually by an operator or player, with no LLM
  involved. `!gm recall the cursed well` or `!gm recall Kestrel` returns the matching facts/NPCs/
  summaries directly in chat.

**Setup** (running the bot directly with `node`/`npm start`):

```bash
docker compose up -d elasticsearch   # local dev only, see docker-compose.yml
```

```
ES_URL=http://localhost:9200
```

**Setup** (running the bot itself via `docker compose` too — see [INSTALL.md](INSTALL.md)):

```bash
docker compose --profile elastic up -d
```
and set `ES_URL=http://elasticsearch:9200` (the container's own network
name, not `localhost`) in your `.env`.

Either way — indices (`gm-knowledge-<campaignCode>` by default) are created automatically on
first write. For production, point `ES_URL` (plus `ES_API_KEY` or `ES_USERNAME`/`ES_PASSWORD`)
at a real, secured cluster instead of the docker-compose one, which has security disabled and is
meant for local development only.

Entirely optional and fails soft: with `ES_URL` unset, or if the cluster is briefly unreachable,
every part of this silently no-ops and the bot behaves exactly as it did before — Elasticsearch
is never the only copy of any of this data (facts/NPCs/summaries all still live where they always
did), so nothing is lost or blocked if it's down.

---

## 📜 License

The bot's code is licensed under the **MIT License**. The bundled game data
(`data/`, `campaigns/` — regions, patrons, talents, etc.) is Fate's Edge
proprietary content, © Nicholas A. Gasper, used here by the author's own
permission; any SRD-marked material is CC BY-NC-SA 4.0. See [LICENSE](LICENSE)
for the full split.

---

**Enjoy your fully automated tabletop RPG experience!**
