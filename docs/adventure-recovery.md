# Adventure crash recovery

The bot saves the room's adventure together with its campaign conversation, narrative summary,
facts and director state. A server restart can recover the last successful save automatically.
The server still keeps live adventure state in memory; campaign auto-save is the durability layer.

## GM commands

- `!gm adventure snapshot`: inspect the pending saved snapshot, or capture a live summary if none
  is pending. Shows its capture time, module, act/scene, timers, session count and encounter status.
  Captures older than 24 hours are flagged; the bot cannot infer real session length.
- `!gm adventure recover`: retry the pending recovery now.
- `!gm adventure recover --force`: explicitly replace an already-loaded adventure or override an
  archive conflict. It never bypasses room identity, version or structural validation.

These commands require a server-verified human GM/Co-GM sender. They never print the raw snapshot.
Choosing/loading/resetting an adventure discards a pending snapshot; recovering preserves narrative
memory and clears obsolete selection menus and abandon votes. While recovery is pending, ordinary
AI narration waits. A GM can recover or select a fresh adventure.

## What survives

A version-1 snapshot contains the **actual engine state**, including the mutable `module` object
(all appended acts/scenes, NPCs, creatures, knowledge reveals, campaign and scene timers),
`currentAct`, `currentScene`, `activeEncounterRef`, status, timestamps, logs, session/climax
tracking, and the complete ad-hoc timer bucket. The envelope adds `snapshotVersion`, `roomId`,
`savedAt`, `moduleId`, `contentRef`, `customAdventures` and `adhocTimers`.

Custom adventure source content travels in the snapshot's active `customAdventures` entry. This
is essential: the server's custom registry disappears on restart too. `contentRef` must resolve
to the same custom module or recovery fails with 404. The bot's saved-custom history pins the
active adventure and evicts the oldest unpinned entry. Manifest snapshots retain `moduleSourceId`
because an authored content ID can differ from its filename; the installed source must still
exist in `data/adventures/` or `server/modules/<id>/adventure.json`.

Auto-save uses the stable room UUID, not its changeable join code. Keep `ROOM_ID` configured when
restarting a bot whose join code has rotated, and keep the server room-directory file durable.
The demo and main Docker Compose stacks store the SQLite database and room directory in a named
persistence volume. Existing installations using an old container-local database must copy that
database and room-directory file into the new volume before recreating their containers.

## Recovery ordering and failures

`CampaignManager` serializes saves and recovery with one promise queue. Capture is reused for up
to five seconds when nothing invalidates adventure state; bot mutations and incoming adventure
updates invalidate it immediately. After three capture failures it backs off to one attempt per
minute. A failed capture retains the last good snapshot instead of erasing the only recovery copy.
HTTP requests time out after eight seconds. Failed campaign loads cannot overwrite saved state.

On handshake, recovery checks room identity and archive conflicts, then calls the authenticated
restore endpoint. It retries once after five seconds if needed and retains the pending snapshot
on failure. Every reconnect starts a new bounded attempt cycle; the GM can also retry manually.

The server builds and validates the entire replacement before swapping it into the room. Invalid
indices, timers, knowledge flags, encounter references, unknown versions, missing source content,
and a triggered climax without an appended act all fail without changing live state. An identical
replay succeeds without duplication; a different snapshot gets 409 while an adventure is loaded,
unless `force: true` is explicit. Existing player-facing `adventure-state` and `adhoc-timer-state`
events update clients; no private snapshot content is broadcast.

Legacy carryover is applied once per schema/adventure run, and concurrent finalization shares one
operation. Archive entries identify a run by module ID and start time, so replaying an adventure
is distinct from recovering an already-finished run. Fully archived completed runs are not queued
for automatic recovery again.

## Limits

- Recovery reaches the last successful save, plus any capture reuse window. During an outage,
  the retained snapshot can be older; inspect its timestamp. There is no claim of atomicity
  between a remote character write and the adventure save. Harm/Fatigue pushes now trigger a save
  after the server acknowledges them, reducing that window.
- Whiteboard/grid tokens are not in the snapshot. An active encounter restores, and the bot logs
  that its grid tokens must be replaced. Unacknowledged mid-exchange Harm and narration improvised
  between saves are not guaranteed to survive.
- Elasticsearch is an optional search index, not the source of truth. It may lead or lag recovered
  state; subsequent writes refresh affected entries, rather than performing a full rollback.
- Passive public memory and pending Assistant GM suggestions are ephemeral. Suggestions must be
  proposed again after a bot restart.
- Delegated side tasks persist separately and resume paused. Resume obtains a new side room/token
  after server loss. That feature remains limited to a single unmanaged server instance.
- Losing both the server auto-save and the bot's in-memory snapshot means there is nothing to
  restore. The bot reports no pending snapshot and a GM can start fresh. Deleting the DB alone
  while the bot remains alive does **not** imply total loss: the bot can still recover its copy.

## Verification

- Bot: `npm test` (capture, persistence, retries, authorization, queue ordering, retention,
  finalization, and delegated-task regression tests).
- Socket server: `npm test` (transactional restore, rejection paths, authentication, manifests,
  idempotency, code rotation, append/reset, and private delegation routing).
- Cross-repository: `npm run test:recovery` from the bot repository. Requires the sibling
  `fates-edge-apps` checkout and its server dependencies, or set `RECOVERY_SERVER_PATH`.
  Starts isolated HTTP/WebSocket servers with a temporary SQLite database, kills the server,
  reloads a new campaign manager, restores through a handshake, continues play, then tests total
  database loss. It never calls a paid model or modifies a real campaign.
