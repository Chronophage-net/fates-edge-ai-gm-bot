# Changelog
All notable changes to this project will be documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/).

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

