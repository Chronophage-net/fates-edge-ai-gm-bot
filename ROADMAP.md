# Roadmap

Genuinely planned or proposed work for this bot. If a feature isn't listed here and isn't
described as implemented in [README.md](README.md) or [DESIGN.md](DESIGN.md), it isn't planned.

For anything on the **socket server** side of a cross-repo item below, the authoritative doc is
that repo's own `SCALING.md`/`ROADMAP.md` — `fates-edge-apps/utilities/javascript/
fates-edge-socket-server/`. Items here that touch it are marked **cross-repo** and only describe
the ai-gm-bot side plus what they'd require from the server; they are not a commitment on that
repo's own roadmap.

## Implemented (v4.14.0)

Both items below shipped in v4.14.0 (see [CHANGELOG.md](CHANGELOG.md)). Left in place as the
design history/rationale behind what's now in [README.md](README.md) — "Machine Sizing & Scaling"
for item 1, "Assistant GM Mode" for item 2 — rather than deleted, since the "why" is still useful
context for anyone touching this code. There are no other open items right now; new proposals
belong at the top of this section when they come up.

### 1. Multiple bot processes under one console (tabbed manager) — ✅ Implemented

See `bot-manager.js` and `bots.example.json`.

**What:** Right now, running more than one table means running more than one independent
`node ai-gm-bot.js` process by hand (own terminal, own `.env`, own `ROOM`), each with its own
status dashboard on its own port (`STATUS_PORT`). This proposes a manager process that supervises
several bot processes at once and presents them as tabs/sheets in one console — one tab per room,
same idea as a browser's tab bar — up to a reasonable cap, **`MAX_BOTS`, default `12`, an env var
on the manager process (not the individual bots).** A dozen live tables is already a lot to hold in
one meta-process's memory/attention; anything past that is deliberately pushed out of scope for
this feature — see "Explicitly not planned" below rather than raising the default.

**Why now:** this is the natural next step of the "run N bot processes on one host" story already
described in the README's "Machine Sizing & Scaling" section — that section explains *why* running
many bot processes side by side on one box is cheap; this feature is *how* you'd actually manage
that many at once without N terminal windows.

**Design sketch:**

- A new top-level entry point (e.g. `bot-manager.js`), separate from `ai-gm-bot.js` itself —
  existing single-bot usage (`node ai-gm-bot.js`, the Docker images, `docker-compose.yml`) is
  unaffected; this is opt-in, the same "off by default" posture as `CLUSTER_WORKERS`/`REDIS_URL`
  on the socket server.
- A manifest (`bots.json`, or one `.env.<room>` file per tab under a `bots/` folder — TBD which
  reads more naturally) listing which rooms to run and each one's driver/API key/etc. The manager
  forks one child process per entry (Node's `child_process.fork`, so each bot keeps full process
  isolation — a crash in one table's bot can't take another down, matching how `CLUSTER_WORKERS`
  on the socket server already reasons about worker isolation).
- Each child keeps running exactly as it does today (unchanged `ai-gm-bot.js`); the manager talks
  to it over IPC (IPC messages already come for free with `fork()`) rather than each child running
  its own separate `status-server.js` HTTP listener — one aggregated dashboard with tabs beats N
  dashboards on N ports for this use case.
- The manager's own UI extends the existing status dashboard's HTTP server (`modules/
  status-server.js` already renders a single-bot HTML dashboard from an in-memory state snapshot
  — the tabbed version is the same idea with one snapshot per child instead of one for the whole
  process).

**Open questions, not yet decided:**

- Per-tab log streaming (tail each child's console output into its tab) vs. just status/summary
  per tab with full logs still on disk/stdout per child.
- Auth on the manager UI — today's single-bot dashboard is `127.0.0.1`-only with no login (see
  README's `STATUS_HOST` note); a multi-bot console controlling several live tables is a bigger
  blast radius if left open, worth a harder look at access control than the single-bot dashboard
  needed.
- **Decided:** `MAX_BOTS` is a simple local cap on this manager process only (default `12`,
  operator-configurable) — it does **not** cross-check the socket server's own room capacity/rate
  limits (`server/security.js`), and this manager does not attempt to coordinate with any other
  manager instance. Running more than a dozen tables, or running bot fleets across multiple hosts,
  is explicitly out of scope for this feature — see "Explicitly not planned" below.

---

### 2. LLM-synthesized SB spends and Crown Spread interpretations for the Co-GM (Assistant GM) — ✅ Implemented

See `modules/assistant-synthesis.js`, and `!gm spend sb`/`!gm deck crown` in
`modules/commands/gm-commands.js`.

**What:** Today, `[SPEND SB N]` and `!gm deck crown [region]` both resolve mechanically and
immediately — a card draw, run through `deck.js`'s `synthesiseConsequence()`/
`synthesiseCrownSpread()`, which is **templated string concatenation of each card's fixed
region-meaning text**, not narration. In Assistant GM ("Co-GM") mode specifically, this proposes
routing both through an actual LLM synthesis pass — grounded in the current scene's live context,
the same context block the main narration turn already assembles — producing a real suggested
complication/interpretation in prose, then holding it for GM approval exactly the way
`[SCENE COMPLETE ...]`/`[NPC CREATE ...]`/etc. already do via `modules/assistant-suggestions.js`.

**What already exists and doesn't need to be built:** the approval mechanism itself.
`!gm suggestions` / `!gm approve <id>` / `!gm reject <id>` are real, working chat commands today
(`modules/commands/gm-commands.js`), and they're chat-native — any GM at the table can already
approve or reject a pending suggestion without touching the status dashboard. The suggestion queue
(`assistant-suggestions.js`) already supports arbitrary `kind`s with an `apply()` closure. This
feature is "add two new suggestion kinds that do a real LLM call before enqueuing," not "build an
approval system."

**Proposed commands:**

- `!gm spend sb <N> [table|deck]` — GM-facing (or Assistant-GM-facing) command spending N banked
  Story Beats. `table` resolves against the existing SB spend-tier table (1=minor/2=moderate/
  3=serious/4+=major, already documented in the cheat-sheet-style tags in the system prompt);
  `deck` draws N cards via `deck.drawCards()` instead. Default (no argument) — TBD, probably
  `deck` since that's the existing default behavior for `[SPEND SB N]` today.
- Enhance `!gm deck crown [region]` (or add a distinct `!gm crown suggest [region]`, TBD which
  reads better) to, when the bot is Assistant GM, run the synthesis step below instead of firing
  `crown-spread` immediately.
- Both call a new short out-of-band LLM request — same pattern already used for the conversation
  summarizer (`ai-gm-bot.js`'s `systemPrompt: 'You are a summariser...'` call), not the main
  narration turn — with a tight, single-purpose system prompt: given the drawn card(s)' region
  meanings plus the current scene context (location, active complications/timers, recent
  conversation), produce one suggested complication (SB spend) or, for Crown Spread, optionally
  **multiple** candidate interpretations for the GM to choose between, per the original request.
- The result gets enqueued as a new suggestion kind (`sb-spend-synthesis` / `crown-synthesis`)
  with a **preview of the actual proposed text** in the label (today's suggestion labels are
  short one-liners — this is the first kind where the GM would want to read real prose before
  approving, which may mean the existing dashboard/`!gm suggestions` listing needs to show more
  than a one-line label for these two kinds specifically).
- **Skippable, for cost-conscious tables** (decided — see "Open questions" resolutions below):
  both commands support a `--raw` flag (`!gm spend sb 3 deck --raw`, `!gm deck crown --raw`) that
  bypasses the synthesis call entirely and falls straight back to today's templated
  `synthesiseConsequence()`/`synthesiseCrownSpread()` output — same as running the bot before this
  feature existed. There's also a bot-wide `ASSISTANT_SYNTHESIS_ENABLED` env var (default `true`)
  so a table can opt out of the extra LLM call by default rather than remembering `--raw` every
  time; `--raw` still works as a per-call override either way. Both gates apply only in Assistant
  GM mode — a full-GM bot never made this extra call to begin with.

**Cross-repo API — ✅ Implemented (all four integrations are first-class citizens, not just the web client):**

The chat-only MVP above needs zero socket server changes (approval is already chat-text only, per
"What already exists" above). The better GM experience — the suggestion rendered as a real UI
element with clickable Approve/Reject instead of typing `!gm approve sugg_7` — needs two new
socket events, added to the existing direct-broadcast/relay lists in both `ws-handlers.js` and
`socketio-handlers.js` exactly the way `tts-audio`/`soundboard-ambience` were (plain pass-through
relay, no new server-side logic, no new REST route — the bot already holds an authenticated WS
connection and can broadcast these directly):

| Event | Fired when | Payload |
|---|---|---|
| `assistant-suggestion-created` | The bot enqueues *any* pending suggestion (a natural generalization — `assistant-suggestions.js` already tracks every kind uniformly, not just the two new ones from this feature) | `{ id, kind, label, preview, groupId, createdAt }` |
| `assistant-suggestion-resolved` | `!gm approve <id>` or `!gm reject <id>` resolves one — including an auto-reject triggered by a sibling in the same `groupId` being approved (see Crown Spread resolution below) | `{ id, outcome: 'approved' \| 'rejected' \| 'auto-rejected', result }` — `result` is whatever chat text got posted, same value `assistant-suggestions.approve()` already returns today |

**Decided — `preview` on every kind, not just the two new ones:** every `enqueue()` call across
`process-tags.js` (`fact`, `npc-create`, `scene-complete`, `knowledge-reveal`/`-hide`, and the two
new synthesis kinds) now passes a `preview` string, even where it's redundant with `label` today
(e.g. `fact`'s preview is just `key: value`, same info the label already shows). One consistent
event contract beats a payload shape that varies by kind, and it costs nothing — every one of
these already has the full text in hand at `enqueue()` time, this just stops throwing it away.

No new client→server request type is needed even for a UI button: clicking Approve/Reject in any
client just sends the *existing* `!gm approve <id>` / `!gm reject <id>` chat command over
whatever connection that client already has — 100% reuse of the approval path that works today,
the two new events only add the "notice a suggestion exists and show it nicely" half.

**Integration checklist — all four done, none deferred:**

- **`fates-edge-web-client`** — `onWSEvent('assistant-suggestion-created'/'-resolved', ...)`
  listeners in `vtt-connected.js` render the suggestion as its own chat card
  (`renderSuggestionDetails()` in `vtt-core.js`) with live Approve/Reject buttons.
- **`fates-edge-discord-bot`** (`utils/websocket.js`, `events/ready.js`,
  `events/interactionCreate.js`) — posts an embed with real Approve/Reject buttons; a click
  translates back into the same `!gm approve/reject <id>` chat command over its own connection,
  and the original embed is edited in place once resolved.
- **`foundry_fates-edge-bridge`** (`scripts/bridge.js`) — posts a chat card with the same
  Approve/Reject buttons (delegated click listener, version-agnostic across the module's
  Foundry v11–13 support), edited in place on resolution.
- **`fates-edge-roll20`** (`api/fates-edge-api.js`) — posts a chat message with Roll20's native
  `[Label](!command)` chat buttons wired to a new `!fates-edge suggestion approve/reject <id>`
  subcommand.

An integration left un-updated wouldn't have broken anything either way — the GM could always fall
back to typing `!gm approve <id>` — but all four got done rather than deferring the non-web-client
ones, so the experience is consistent everywhere a table might be running.

**Resolved (previously open questions):**

- **Multiple Crown Spread interpretations → separate suggestions, numbered, approving one
  auto-rejects the rest.** Each candidate interpretation gets its own `enqueue()` call sharing a
  single `groupId` (the draw itself). `assistant-suggestion-created` fires once per interpretation
  — so a three-interpretation Crown Spread draw fires it three times, e.g. surfaced to the GM as
  "1 / 2 / 3" — and `assistant-suggestions.approve()` is extended so that approving any one member
  of a `groupId` walks the rest and resolves them `'auto-rejected'` rather than leaving them
  dangling in the queue. This is why `groupId` and the `'auto-rejected'` outcome were added to the
  event table above.
- **The extra LLM call is skippable.** See the `--raw` flag / `ASSISTANT_SYNTHESIS_ENABLED` bullet
  under "Proposed commands" above — both a per-call escape hatch and a table-wide default-off
  option exist, so cost-conscious tables aren't forced to pay for a second API call per spend.
- **`preview` gets backfilled onto every existing suggestion kind, not just the two new ones.** See
  the "Decided — `preview` on every kind" paragraph above — one consistent event contract for all
  of `fact`/`npc-create`/`scene-complete`/`knowledge-reveal`/`-hide` plus the two synthesis kinds,
  rather than a payload shape that varies by kind.

---

## Explicitly not planned

- **A custom control plane for coordinating bot fleets beyond one `MAX_BOTS`-capped manager
  process.** Item 1's manager is deliberately just "run up to a dozen local processes, show them
  as tabs" — it does not discover, coordinate with, or manage other manager instances, and it does
  not attempt to schedule bots across multiple hosts. If that's ever needed, it would be built as
  a separate layer on top of the bot's own API (see item 1's design sketch — the manager's IPC/
  status surface), not as a bigger `MAX_BOTS`.
