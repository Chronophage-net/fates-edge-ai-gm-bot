# Changelog
All notable changes to this project will be documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/).

## [4.12.0] - 2026-08-19

Adventure Director v2: Legacy Tracker, Climax Pacing Engine

### Added
- **`modules/legacy-tracker.js` (new)** — structured, adventure-specific carryover between adventures in the same campaign. An adventure module opts in with a `persistence` block (`{ schema, carryover: [{key, type, default?, max?}], reset_on_complete }`); `adventure-director.js`'s `finalizeAdventure()` extracts the declared keys (reading `campaign.state.facts`/`[FACT ...]` first, falling back to matching campaign/scene timers, then the item's own `default`) into `campaign.state.legacy[schema]` when the adventure finishes. `adventure-context.js` injects that schema's tracked values as a structured JSON block into the LLM system prompt every turn a matching-schema adventure is active, not just at load. New GM-only command: `!gm adventure legacy [schema] [set <key> <value>|clear]` for visibility and manual override.
- **Climax narration & pacing** — `adventure-context.js` now injects strong, explicit narration constraints (short/punchy sentences, escalating stakes, no filler, heavier roll stakes) into the system prompt whenever `state.climaxTriggered` is true, plus live progress (`climaxScenesSinceTrigger`/`climaxPadScenes`). `generateAndAppendClimax()`'s own act-generation prompt got the same constraints. New `generateForcedClimaxTwist()` in `adventure-director.js` generates one short, forceful scene (LLM-generated, with a fallback) and calls the server's new `POST /adventure/climax-forced` route if a climax runs past its pad without resolving — a mechanical "the story pushes itself forward" hook for a stalled table, firing at most once per climax.
- New `DESIGN.md` — an architecture deep dive into the Adventure Director's dynamic-growth engine (scene/climax generation, session-count-based climax triggering, climax pacing/forcing, the Legacy Tracker), how it hands off to `server/adventure.js`'s live state machine, and how `adventure-context.js` assembles the LLM system prompt from all of it every turn.

### Docs
- `README.md` and `adventure_manual.md` updated to document `!gm adventure legacy`, climax pacing behavior, and the `persistence` adventure-schema field.

### Other
- Fix Docker Hub login condition + wrong indexNameFor() test assertion
- Fix to workflow, check for the DOCKER_HUB environment variable, if it doesn't exist, log in using the secrets instead.
- Build & publish the Docker image as multi-arch (amd64+arm64)

## [Unreleased]

## [4.11.2] - 2026-08-17

### Changed
- **Modularized `modules/commands.js`** (2326 lines, two ~600-1200 line mega-functions) into `modules/commands/` — `api-client.js`, `tokens.js`, `characters-sync.js`, `npc-actions.js`, `tag-repair.js`, `messages.js`, plus `gm-commands.js` (the `!gm` command dispatcher) and `process-tags.js` (the `[TAG ...]` directive processor), each kept whole since their internal control flow shares mutable local state that would be risky to split further mechanically. `modules/commands/index.js` re-exports the exact same public API, so no call site (`ai-gm-bot.js`, tests) needed to change beyond the two test files' require paths. Verified as a pure extraction: every moved function's source is byte-identical between the old and new files (checked programmatically before the swap), and the full test suite passes at the same baseline as before (one pre-existing, unrelated `indexNameFor()` failure).

### Fixed
- **Assistant GM's own `!gm suggestions` / `!gm approve` / `!gm reject` / `!gm confirm-takeover` commands were unreachable dead code.** Found while mapping `handleBotCommand`'s branch order for the refactor above: a blanket "Only the Game Master can run resource commands" gate (requires `myRole === 'gm'`) ran ahead of this block, which itself requires `myRole === 'assistant-gm'` — since no caller is ever both at once, the gate rejected every call before it could reach its own check. These four commands now run for anyone in Assistant GM mode, exactly as documented; the gate still applies to every other resource command unchanged. Covered by three new regression tests in `tests/modules/gm-commands-assistant.test.js`.

## [4.11.1] - 2026-08-17

### Fixed
- **`[CALL FOR ROLL ...]` (and `[ROLL ...]`) leaked into chat as literal unresolved bracket text when the model dropped the required quotes around the name.** Spotted live in the demo recording: a small local model (`llama3.2:1b`) emitted `[CALL FOR ROLL Asadef Wits+Stealth DV 3 Controlled]` instead of `[CALL FOR ROLL "Asadef" Wits+Stealth DV 3 Controlled]` -- every downstream regex (`callForRollRegex`, `rollRegex`, even `tightenRollPoolSpacing`'s own spacing fix) requires the name to already be quoted, so the tag fell through unrepaired and the player saw the GM's own tag syntax mid-sentence instead of a roll prompt. New `quoteBareRollName()` repair pass (`modules/commands.js`) runs first in `repairAITagSyntax()`, adding quotes around a bare name when a `Attribute+Skill DV <n>` pool expression is found right after it -- the one part of this tag's syntax reliable enough to anchor on without risking mis-slicing a legitimate multi-word name. Covered by a new regression test using the exact string observed in the demo.

## [4.11.0] - 2026-08-17

### Changed
- **GM no longer auto-rolls for players.** Previously the AI GM's `[ROLL ...]` tag resolved a player's dice roll immediately and silently, the instant the model emitted it — meaning the "GM" was secretly rolling on the player's behalf rather than asking them to. New tag `[CALL FOR ROLL "Name" Attribute+Skill DV Position "optional suggestion"]` (`modules/commands.js`) instead prompts the player with what to roll, an optional one-sentence GM suggestion (e.g. "low Presence, but Melee could sell the threat instead"), and the `!gm roll ...` command to actually make it — then stops and waits, like a real GM would. `[ROLL ...]` still exists and still resolves immediately, but is now reserved for GM/NPC-driven rolls rather than player checks; the system prompt (`ai-gm-bot.js`) and the `forceRollIfMissing()` fallback were both updated to steer the model toward `[CALL FOR ROLL ...]`. Because the roll no longer resolves inside the same AI turn that called for it, `!gm roll` and player-typed `[ROLL "..."]` results are now recorded into conversation history (`recordRollResultInHistory()`) so the AI actually sees the outcome on its next turn instead of never learning it happened.
- **Raised default max-token budgets** across all three drivers (`drivers/deepseek-driver.js`, `drivers/openai-driver.js`, `drivers/ollama-driver.js`): 400 → 1200. At 400, a GM turn (a paragraph or two of narration plus several mechanical tags) routinely got cut off mid-tag, leaving `processSpecialTags()` a dangling/malformed bracket to untangle and making replies feel slow or stuck. All three remain overridable via `DEEPSEEK_MAX_TOKENS` / `OPENAI_MAX_TOKENS` / `OLLAMA_MAX_TOKENS`.
- `drivers/ollama-driver.js` previously **ignored `OLLAMA_MAX_TOKENS` entirely** — `generateResponse()` hardcoded `400` (`num_predict`) directly at both call sites regardless of any env var, and `trimToFit()`'s context-budget reserve silently fell back to a default since `this.maxTokens` was never set. Now wired up like the other two drivers.
- Added a truncation warning (mirroring `deepseek-driver.js`'s existing `finish_reason` check) to `openai-driver.js` (`finish_reason !== 'stop'`) and `ollama-driver.js` (`done_reason !== 'stop'`), so a cut-off response is visible in the logs instead of silently shipping a truncated reply.
- **`OLLAMA_CONTEXT_WINDOW` now actually configures Ollama's own context size, not just this bot's local trimming budget.** Previously `this.contextWindow` only drove `trimToFit()`'s client-side "how much history to send" calculation — it was never passed to Ollama itself, so a correctly-sized prompt could still get silently truncated server-side by Ollama's own default `num_ctx` (commonly 2048-4096 depending on the model/Modelfile, unrelated to that model's real max context) instead of whatever was configured here. `drivers/ollama-driver.js` now sends `num_ctx: this.contextWindow` on every request, so the two stay in sync by construction.
- `ai-gm-bot.js`'s two `processSpecialTags()` call sites now race against a 20s hard timeout and fall back to the un-tag-processed reply on expiry, instead of `await`ing indefinitely — a safety net against a hang from a malformed/truncated tag or an unusually slow external lookup, on top of the per-tag 5s timeouts `processSpecialTags()` already had internally.

### Fixed
- **`scripts/build-adventure-manifest.js` generated broken doc-manifest keys for every adventure.** The prefix-stripping regex left a leading `-` on filenames like `Fates_-_Edge_-_-The-_-Grumbling-_-Vault.html`, and each `-_-` separator became three underscores once dashes were converted -- so ids came out as `_the___grumbling___vault` instead of the intended `the_grumbling_vault`, which never matched any entry in the script's own `specialCases` map. `data/adventures/manifest.json`'s keys therefore never matched the filename-stem ids used everywhere else in this codebase (see `world-manager.js`'s identical region-loading bugfix), so `getAdventureContext()`'s `manifest[moduleId]` lookup could never succeed and the AI never actually received any adventure's HTML doc as context. Fixed by collapsing/trimming underscores before the `specialCases` lookup, and by adding the missing `the_cursed_caravan` / `the_hazel_root` / `the_ninth_proof` / `the_nameless` entries to that map (only `grumbling_vault`, `serpents_coil`, `blood_and_silk_saga`, `lantern_at_dusk`, and `whispers_in_the_tunnels` had ever resolved correctly). Regenerated `data/adventures/manifest.json` -- all 10 keys now match their adventure JSON filenames exactly.
- `data/docs/manifest.json` (the docs-browsing manifest) had drifted out of sync with `data/docs/`'s actual contents: three adventure docs (Cursed Caravan, Hazel Root, Ninth Proof) and the Fate's Edge Quickstart guide were missing entirely, and `total_count`/`active_count` were stale. Added the four missing entries and refreshed the counts and `generated` timestamp. Left existing ids (including the pre-existing `canival_of_broken_dreams` typo and `the_serpent_s_coil`) unchanged rather than renaming them, since an external doc-browsing consumer may already link to those ids. `data/docs/manifest-core.json`'s curated 5-item list was checked and still resolves correctly -- left untouched.
- Removed a stale, 0-byte `data/docs/manifest-core.json.tmp` leftover from a previous interrupted write. (`device_bash` can't delete files on a mounted folder, so it's been moved to `data/docs/_to_delete/` -- delete that folder to finish removing it.)

### Added
- **New adventure: The Nameless** (`data/adventures/nameless.json` + `data/docs/adventures/Fates_-_Edge_-_-The-_-Nameless.html`) — a 30-floor, choice-driven penitential megadungeon converted from the source draft at `fates-edge-docs/ttrpg/reference/adventures/nameless.tex`. Structured as 4 acts (an entry hook plus three 10-floor acts), each floor a self-contained scene with its own Floor Timer, a hidden true "Key Name" clue ladder, and a Mercy/Restitution/Renunciation Resolution Fork encounter. Includes a full "Penitent Lich" bestiary/NPC/Runekeeper-patron writeup, the Penitential Corruption tables, five campaign-level timers (Final Persuasion, plus three combat-only escalation timers and an optional Party Miasma track), and 34 `knowledge[]` entries (each floor's Key Name as a plot secret, plus the Lich's true Utaran-official backstory). The HTML doc uses its own "penitent" theme (deep indigo/plum palette with candle-gold accents) following the same CSS-variable structure as the other adventure docs. Manifest regenerated via `scripts/build-adventure-manifest.js`; `data/docs/manifest.json` updated to list the new doc alongside the others.
- New tag `[CALL FOR ROLL ...]` and its test coverage (`tests/modules/commands.test.js`) — see "Changed" above.
- **Structured knowledge state**: adventure modules can now define a `knowledge[]` array — explicit `{ id, subject, gm, player, revealed, revealCondition, tags }` secret entries — as a first-class alternative to burying secrets in `_gmhints` prose (still fully supported, unchanged). `revealed` is live, server-tracked state (resets to its authored value on every adventure load, exactly like scene/timer state) with an explicit "GM eyes only" truth (`gm`) and a "safe to say right now" truth (`player`, may be `null`). See `fates-edge-apps`' matching server-side change (`revealKnowledge()`/`hideKnowledge()`, new `POST /adventure/knowledge/reveal|hide` routes, and the `getPublicState()`/`getReferenceData()` split so `gm` text never reaches player-facing views).
- `modules/adventure-context.js`'s scene-context block now injects a KNOWLEDGE STATE section (GM/AI-eyes-only, built from `getReferenceData()`) alongside the existing GM HINTS section: unrevealed entries show their reveal condition and player-safe cover text; revealed entries show the full truth as safe to narrate.
- New AI tags `[REVEAL "id"]` / `[HIDE "id"]` (`modules/commands.js`) — the AI GM flips a knowledge entry's live gate the moment it narrates the actual reveal, keeping game state in sync with narration instead of leaving "what have the players actually learned" to be re-inferred from chat history every turn. Carries narrative authority, so Assistant GM mode queues these for human approval exactly like `[FACT ...]`/`[NPC CREATE ...]`.
- New human-GM command `!gm knowledge [list] | !gm knowledge reveal <id> | !gm knowledge hide <id>` for manual control over the same state.
- `data/adventures/grumbling_vault.json` updated with a worked `knowledge[]` example (Durin's fraud, the Ward-Primus's magic immunity, the Ward Resonance timer's trigger, the Iron Wraiths' trigger) alongside its existing `_gmhints`, as a migration reference for other modules.

## [4.10.0] - 2026-08-14

### Added
- **Assistant GM mode**: a new `assistant-gm` room role (alongside GM/Co-GM/Player/Spectator — see `fates-edge-apps`' v4.12 changes) a GM can hand to this bot's own client. In this mode the bot keeps narrating and keeps running mechanics live (rolls, resource deltas, timers, aggressive character/adventure sync), but holds narrative-authority tags — `[FACT ...]`, `[NPC CREATE ...]`, `[SCENE COMPLETE ...]` — as pending suggestions instead of applying them immediately, so a human GM/Co-GM keeps final say. New `modules/assistant-suggestions.js` (the in-memory suggestion queue), new chat commands `!gm suggestions` / `!gm approve <id>` / `!gm reject <id>` / `!gm confirm-takeover`, and a new "Pending Suggestions" panel on the status dashboard with one-click Approve/Reject.
- GM-disconnect handling now branches on this: an Assistant GM bot no longer silently auto-requests the full GM seat the way an ordinary player-role bot does — it prompts in chat instead, requiring an explicit `!gm confirm-takeover`.

### Docs
- README: new "Assistant GM Mode" section, updated Features list, module table (`commands.js`, new `assistant-suggestions.js` entry), and Status Dashboard section.

## [4.9.1] - 2026-08-13

### Added
- **AI GM Session Panel**: the status dashboard (`STATUS_PORT`, default 4141 — see `modules/status-server.js`) now has a GM-facing panel distinct from the VTT chat, showing the Story Beats bank, campaign Facts the AI has recorded, a live "Recent AI Memory" feed (the model's actual conversation window, plus its running summary once one exists), and Obligation totals grouped by Patron. Fed by `ai-gm-bot.js`'s `buildStatusSnapshot()` from the orchestrator's existing campaign state — no new storage, just a window onto what the bot already tracks.
- **Fuzzy tag repair** (`modules/commands.js`): `repairAITagSyntax()` runs before the strict per-tag regexes and normalizes common AI drift — wrong-case keywords (`[Roll ...]` → `[ROLL ...]`), stray whitespace around `+` in a roll pool expression (`Wits + Stealth` → `Wits+Stealth`), and a dropped closing quote/`]`. Previously any of these caused a tag to silently fail to match and leak into chat as literal unresolved bracket text.

### Docs
- README/CHANGELOG pass covering the two additions above and the status dashboard's new panel.

### Other
- Updated to add more information in the server status panel.
- Updated the package-lock.json file
- Public release! Updated funding, README.md, etc

## [4.9.0] - 2026-08-13

First public release.

_No commits since the last tag — manual version bump._

## [4.8.0] - 2026-08-12

Prep for going public: add CONTRIBUTING.md (with dual-license contribution note) and SECURITY.md, run tests in CI, fix README clone URL placeholder, clean up stale COMMERCIAL-LICENSE.md stub and env-deepseek.md cross-reference. History also scrubbed of a leaked API key and work-email commit authorship (force-pushed separately, not part of this commit).

### Chore
- untrack stray test artifact, add to gitignore

## [4.7.1] - 2026-08-12

Added COMMERCIAL.md (renamed from COMMERCIAL-LICENSE.md, now leads with the standard commercial-licensing notice); COMMERCIAL-LICENSE.md is a redirect stub. Updated README/LICENSE/package.json cross-references. No functional code changes.

_No commits since the last tag — manual version bump._

## [4.7.0] - 2026-08-12

Relicensed from MIT to AGPL-3.0-or-later, with a commercial license available for closed-source/redistribution use (see COMMERCIAL-LICENSE.md). No functional code changes.

_No commits since the last tag — manual version bump._

## [4.6.0] - 2026-08-12

Security hardening: status dashboard no longer binds to all network interfaces by default.

_No commits since the last tag — manual version bump._

## [4.5.0] - 2026-08-12

Status dashboard, leveled logging, session token tracking, optional Elasticsearch long-term memory (Facts/NPCs/summaries + !gm recall), optional NPC location tracking, INSTALL.md

### Added
- type-aware encounter narration (objective-types)

### Fixed
- prompt for API_KEY during setup
- fix three bugs breaking the setup wizard

### Chore
- prune 5 not-yet-free adventures per updated allowlist
- sync 9 new adventures (JSON) from fates-edge-docs
- sync 18 new patron files from fates-edge-docs

### Other
- Security (URL parsing and sanitation) and performance improvements.
- worldbook language pass on region data, tutorial GM hints, new terrestrial factions

## [4.4.2] - 2026-08-06

_No commits since the last tag — manual version bump._

## [4.4.1] - 2026-08-06

_No commits since the last tag — manual version bump._

## [4.4.0] - 2026-08-05

Driver/module test suite (120 tests), commands.js tag-parser regex-desync fix across every [TAG ...] handler, README modules/testing docs.

### Other
- Added tests, fixed bugs
- Removeing erroneous file
- Repo hygiene: untrack node_modules (was committed since first commit), remove stale duplicate doc, bump version to match ecosystem (4.3a)
- Lots of updates
- Updated Patrons and Regions
- Updates to fix display and syncing bugs, improve GM behavior, and run adventures properly.
- Updated to actually run adventures.
- Updated bot to work better.
- Updated commands to process tags better.
- Major updates
- First commit

