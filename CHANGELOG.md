# Changelog
All notable changes to this project will be documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **GM no longer auto-rolls for players.** Previously the AI GM's `[ROLL ...]` tag resolved a player's dice roll immediately and silently, the instant the model emitted it — meaning the "GM" was secretly rolling on the player's behalf rather than asking them to. New tag `[CALL FOR ROLL "Name" Attribute+Skill DV Position "optional suggestion"]` (`modules/commands.js`) instead prompts the player with what to roll, an optional one-sentence GM suggestion (e.g. "low Presence, but Melee could sell the threat instead"), and the `!gm roll ...` command to actually make it — then stops and waits, like a real GM would. `[ROLL ...]` still exists and still resolves immediately, but is now reserved for GM/NPC-driven rolls rather than player checks; the system prompt (`ai-gm-bot.js`) and the `forceRollIfMissing()` fallback were both updated to steer the model toward `[CALL FOR ROLL ...]`. Because the roll no longer resolves inside the same AI turn that called for it, `!gm roll` and player-typed `[ROLL "..."]` results are now recorded into conversation history (`recordRollResultInHistory()`) so the AI actually sees the outcome on its next turn instead of never learning it happened.
- **Raised default max-token budgets** across all three drivers (`drivers/deepseek-driver.js`, `drivers/openai-driver.js`, `drivers/ollama-driver.js`): 400 → 1200. At 400, a GM turn (a paragraph or two of narration plus several mechanical tags) routinely got cut off mid-tag, leaving `processSpecialTags()` a dangling/malformed bracket to untangle and making replies feel slow or stuck. All three remain overridable via `DEEPSEEK_MAX_TOKENS` / `OPENAI_MAX_TOKENS` / `OLLAMA_MAX_TOKENS`.
- `drivers/ollama-driver.js` previously **ignored `OLLAMA_MAX_TOKENS` entirely** — `generateResponse()` hardcoded `400` (`num_predict`) directly at both call sites regardless of any env var, and `trimToFit()`'s context-budget reserve silently fell back to a default since `this.maxTokens` was never set. Now wired up like the other two drivers.
- Added a truncation warning (mirroring `deepseek-driver.js`'s existing `finish_reason` check) to `openai-driver.js` (`finish_reason !== 'stop'`) and `ollama-driver.js` (`done_reason !== 'stop'`), so a cut-off response is visible in the logs instead of silently shipping a truncated reply.
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

