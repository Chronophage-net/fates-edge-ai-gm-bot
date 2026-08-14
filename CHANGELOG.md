# Changelog
All notable changes to this project will be documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/).

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

