# Two Seats at the Table

**Player Mode and Passive Mode for the Fate's Edge AI GM bot.**

| | |
|---|---|
| Status | Design finalized. No implementation code written. |
| Design owner | Claude (this document) |
| Implementation owner | Codex |
| Primary entry point | `modules/commands/gm-commands.js` |
| Companion doc | `fates-edge-docs/SAAS_MANAGER.md` (room identity) |

The bot already knows how to run a game. These two features teach it how to *sit down* at
one — once as a player with something to hide, once as a reference that knows better than to
spoil anything.

---

## 1. Decisions on the record

Every design question raised during review has been ruled on. Nothing below is open.

| Question | Decision |
|---|---|
| Where does a bot-played character live? | Its own process — one `bots.json` entry per seat, **not** a mode flag on the GM bot. |
| How many player seats per table? | **Two**, shipped idle in `bots.example.json`. |
| Who may read a dossier? | **GM and Assistant GM.** Gate on the existing GM-like predicate, not a fresh `=== 'gm'` check. |
| Does the bot take Bonds with players? | **No.** Continuity comes from searching public chat history instead — memory without mechanical leverage. |
| Room identity across a cluster? | `room_id` UUID as the durable key; `room_code` as a rotatable human locator. Per `SAAS_MANAGER.md`. |
| May `ask` see adventure knowledge? | **Yes**, strictly where `revealed === true`. See the reveal-is-live rule in §4.1. |
| Where do dossiers and hidden timers persist? | **Per-seat local file, mode `0600`, never in a campaign save.** The campaign save is shared and client-readable. |
| Must passive commands leave state untouched? | **Pure reads yes** (byte-identical). **Table utilities** (`dice`, `roll`, `deck draw`) may advance deck/RNG/roll history only. |

Two numbers are deliberately left to tuning, not design (see §10).

---

## 2. Seams that already exist

Neither feature is a new subsystem. Both are postures the bot can nearly hold already; most of
this document is about *which existing machinery to reuse*.

- `myRole` in `ai-gm-bot.js` initialises to `'player'` and only becomes `'gm'` via the takeover
  timer. A bot that never takes over is already a player-seat client.
- `bot-manager.js` + `bots.json` supervises one process per room, each with its own env file.
- Adventures already carry `knowledge[]` entries with a `revealed` flag, surfaced by
  `!gm knowledge`. That flag is the spoiler boundary — read it, do not invent a second one.
- `rules-index.js` already section-splits `data/rules.txt` for `[LOOKUP RULE]`.
- `knowledge-index.js` already indexes facts / NPCs / summaries into Elasticsearch, and
  `!gm recall <query>` already searches it.
- `dice.js` owns pools, Position and the Outcome Matrix. Both features roll through it; neither
  gets its own randomness.

### 2.1 Fix in passing

`!gm create` (gm-commands.js, `cmd === 'create'`) still seeds the retired sixteen-skill list —
`Unarmed`, `Subterfuge`, `Investigation`, `Medicine`. The SRD retired those into Melee,
Deception, Insight and Craft. Any character the bot rolls up is wrong on arrival until that
literal is updated to the twelve.

---

## 3. Feature 1 — Player Mode

**Root command:** `!gm player …`

The bot creates a player character, holds a secret about it, and plays it at the table under the
same rules as everyone else.

The brief that defines this feature is *"roll up a sneaky rogue that the party shouldn't trust."*
Two things are asked at once: a character sheet, which is easy; and **a secret the bot must keep
while acting on it**, which is the actual feature. Everything below follows from taking the
second half seriously.

### 3.1 Seats, not modes

A bot-played character is a **separate process with its own identity in the room** — one more
entry in `bots.json`, supervised by the existing `bot-manager.js`.

This buys three things nearly for free:

1. The seat appears in the player list under the character's own name, not as the GM wearing a hat.
2. Its `myRole` simply stays `'player'` — where `ai-gm-bot.js` already starts — so the
   GM-takeover timer is disabled by configuration rather than special-casing.
3. The fair-play rule that gave this design the most trouble — *the bot must not GM its own
   character* — stops being a rule anyone enforces, because the two halves are different
   processes that can only talk through the room, in public, like everybody else.

```json
{
  "bots": [
    { "roomId": "0192f3a1-…", "room": "AC12", "envFile": ".env",        "mode": "gm",      "seat": 0 },
    { "roomId": "0192f3a1-…", "room": "AC12", "envFile": ".env.vessa",  "mode": "player",  "seat": 1 },
    { "roomId": "0192f3a1-…", "room": "AC12", "envFile": ".env.oracle", "mode": "passive", "seat": 2 }
  ]
}
```

`bot-manager.js` currently requires `room` to be **unique across the manifest**. That constraint
must relax to *room plus seat* — several bots in one room is the entire point. `STATUS_PORT` is
already assigned sequentially, so seat index falls out of manifest order for free.

### 3.2 Routing, when three bots hear every message

All seats receive every `!gm` command. Exactly one must answer, decided without leader election.

**Rule: ownership first, then lowest seat index.**

| Command shape | Answered by |
|---|---|
| `!gm player <verb> <name>` | The seat that owns `<name>`. Every other bot ignores it **silently**. |
| `!gm player new <brief>` | The lowest-index **idle** player seat (no character yet). It claims the seat and answers. If every player seat is taken, the GM seat replies saying to add one to `bots.json`. |
| `!gm ask` / `look` / `quickref` | The GM seat if present, else the lowest-index passive seat. Player seats never answer these. |
| Anything that mutates state | The GM seat only, as today. |

Ownership is announced on connect and re-announced on reconnect, so a seat that restarts
mid-session **reclaims** its character rather than duplicating it.

Silence is the correct behaviour for a bot that does not own a command. Do not emit "not mine"
replies — a three-bot table would produce two error messages per command.

**Known blocker:** `sendWhisper()` hardcodes `sender: 'GM'`. A player seat speaking or whispering
must send under its character's name, or the illusion collapses in the first message.

### 3.3 Room identity (UUID for the machine, code for the humans)

`SAAS_MANAGER.md` already settled the general case; the runtime has not caught up:

> The room's UUID is its durable identity. `room_code` is a short, human-facing locator and may be
> rotated if it leaks. Existing game APIs may continue to use the code at their edge, but they
> resolve it to the UUID before authorization.

and `managed_rooms.room_code` is annotated *"human-facing locator, not the primary identity."*

Below the manager everything is still code-keyed: `ai-gm-bot.js` holds `ROOM_CODE` and puts it in
the socket query string, the REST path `/rooms/<code>/…` and the Elasticsearch index name;
`ws-handlers.js` reads `?room=`; `scaling.js` relays Redis pub/sub on `roomCode`;
`knowledgeIndex.search()` keys on `campaignCode`.

Three consequences, none hypothetical:

- **A rotated code splits a live room.** The spec permits rotating a leaked code. Do it
  mid-session and the Redis relay channel changes underneath — half the instances stay on the
  old subject.
- **The index sanitiser is lossy.** `indexNameFor()` lowercases and maps everything outside
  `[a-z0-9_-]` to a dash, so two distinct codes can land on one Elasticsearch index and merge two
  campaigns' memories. A UUID is already `[a-z0-9-]`, making that function a no-op instead of a
  hazard.
- **Short codes are enumerable.** A four-character code is a crawlable keyspace at cluster scale.
  Codes belong at join time only and must never be the subject of an authorization decision —
  which is what the manager already means when it says routing cannot substitute for authorization.

**Therefore: GUIDs as a second field, never as a replacement.** Nobody reads a UUID aloud over
voice chat. `room_code` stays for joining and rotates freely; `room_id` becomes the key for
placement, pub/sub subjects, index names, storage and the bot manifest.

Three concrete picks:

- **UUIDv7, not v4.** Same shape, time-ordered — indexes well as a primary key, sorts by creation,
  carries its own created-at. Render lowercase; prefix in logs (`room_0192f3a1…`, `seat_…`,
  `server_…`) so a room id can never be mistaken for a server id at three in the morning.
- **Backfill with UUIDv5, not a lookup table.** Legacy rooms get `uuidv5(NAMESPACE, room_code)`:
  every node derives the same stable id for `AC12` with no coordination and no migration table.
  Dual-read code and id for one release, then drop the code from every durable key.
- **Make `room_code` nullable.** It is currently `text unique not null`. Offshoot rooms — a
  breakout scene, a private scouting turn, a delegated side-task with its own transcript — are
  joined programmatically, never typed. Forcing them to mint a human code burns the small code
  space on rooms no human will ever locate by name. A child room wants `id` and `parent_id` and
  nothing else.

That last point is where this stops being tidiness. Once a room is a UUID with an optional parent,
an offshoot is nearly free: the GM seat spawns a child room, a player seat follows, the pub/sub
subject is `room.<child-id>`, and placement can co-locate it with its parent by hashing the parent
id. None of that is expressible when identity is a four-character string a human must be able to
say out loud.

### 3.4 A public sheet and a private dossier

Every bot-played character is two objects with different audiences.

**The sheet** is an ordinary character: attributes, skills, talents, Harm, Fatigue, Boons. It syncs
to the web client through `characters-sync.js` exactly like a human's, appears in the roster, and is
inspectable by anyone. Nothing about it says "bot."

**The dossier** never leaves the GM table — the GM and the Assistant GM, if one is seated. It holds:

- **Agenda** — what this character actually wants.
- **Tell** — the detail that would give them away.
- **Price** — what would buy their loyalty.
- **Trigger** — the fiction that makes them move.

Delivered by whisper via `sendWhisper()`, never `sendChat()`, and excluded from every prompt the
bot builds for public narration.

Gate it on the established GM-like predicate rather than a fresh `=== 'gm'` check — `assistant-gm`
is already a first-class role in `process-tags.js` and the socket server's `ROLES.md`, and a co-GM
who cannot see the twist cannot help run it.

**Storage:** the dossier is written to a per-seat local file with mode `0600` and is never included
in a campaign save. See §5.

> **Failure mode to design against.** An LLM given a secret in its context will leak it — in an
> aside, in a suspiciously careful denial, in a word choice. The dossier must not sit in the same
> prompt that generates public speech. Generate the character's intent in a **private pass**, reduce
> it to a short directive ("deflect questions about the northern road"), and pass **only that
> directive** to the speaking pass.

### 3.5 Make the betrayal mechanical, not vibes

A bot that decides on its own when to turn is unpredictable in the bad way. Bind the secret to a
**hidden Timer** using the machinery behind `!gm timer` — the same Progress/Threat timers the SRD
already runs scenes on.

- Creation sets a hidden timer, sized like any other: `[4]` to turn this session, `[8]` for a slow
  burn across an arc.
- It ticks on **stated fiction**, not GM whim: the party does the thing the dossier names, or the
  trigger condition fires.
- When it fills, the bot escalates — and the GM gets a whisper saying so **before** it acts, with
  `!gm player hold` to veto.

This gives the GM a dial they can read, keeps the AI from surprising the table in a way nobody
enjoys, and makes the eventual turn legible in hindsight.

### 3.6 The spotlight leash

The fastest way to make a bot player unbearable is to let it answer everything.

The bot takes a turn when it is **addressed by name**, when its character is **targeted** by an
action or roll, when a **timer it owns** ticks, or when the GM calls `!gm player act`. Absent any of
those, it speaks at most once every *N* table messages — `tight`, `normal`, `loose`. Default
`normal`. A bot player should feel like the quiet one at the table, not the loud one.

### 3.7 Fair play, enforced structurally

- **No private dice.** Every roll goes through `!gm roll <name> <pool> DV <n> <position>` and lands
  in chat like anyone's.
- **No hidden resources.** Boons, Harm, Fatigue and Obligation live in the same character store and
  sync path.
- **The bot may not GM itself** — and with separate seats it structurally cannot. The player seat
  asks for a roll in the room; whoever holds the GM seat sets DV and Position; the answer comes back
  through public chat. Neither process can read the other's state, so there is no back channel to
  police.

### 3.8 No Bonds. Memory instead.

A bot-played character **does not take Bonds** with real players. Bonds are how the game hands out
Boons and how two characters are bound to each other; a Bond the bot spends three sessions building
in order to cash in later is a sharper instrument than this feature needs. No Bond means no Boon
exchange and no mechanical claim on anybody.

What replaces it is **memory**: the seat can search the table's chat history. The rogue remembers
that Kesh pulled her out of the canal because somebody *said so at the table*, not because a Bond
records it. Continuity without leverage — a better description of an untrustworthy companion anyway.

The plumbing exists. `!gm recall` already searches the Elasticsearch knowledge index. Chat becomes a
**fourth document type** in `knowledge-index.js`, with three scoping rules:

- **Whispers are never indexed.** Filter at **write time**, not query time. A message carrying
  `whisper: true` or a `recipient` does not enter the index at all, so no query — and no
  prompt-injected instruction — can retrieve one. This covers dossiers, GM asides and private player
  DMs in a single rule.
- **Scoped to the seat's own room.** One more consumer of `room_id`; `knowledgeIndex.search()`
  currently keys on the rotatable `campaignCode`.
- **Scoped in fiction to what the character was present for.** Retrieval is bounded to messages at
  or after the character entered play. A bot player quoting a scene from before it existed breaks
  the table faster than a bad line of dialogue.

**Three tiers of memory, kept straight:**

| Tier | Gate | Reaches |
|---|---|---|
| `!gm recall` | GM · AGM | Everything: facts, NPCs, summaries, chat |
| Player seat internal retrieval | — | Public chat only, scoped as above |
| `!gm recap` | any seat | Revealed knowledge + public chat |

> **Tell the table.** Searchable history means anything said in the room can be quoted back months
> later by a character with an agenda. That is a feature, but it should be a known one — ship it with
> a retention window and a `!gm forget <query>` that drops matching messages from the index.

### 3.9 Command surface

| Command | Gate | Behaviour |
|---|---|---|
| `!gm player new <brief>` | GM | Claims the lowest idle player seat. Brief → sheet posted publicly, dossier whispered to GM/AGM. A secret named in the brief goes to the dossier and never to chat. |
| `!gm player seats` | GM | Which seats are configured, claimed, idle. First thing to check when `new` refuses. |
| `!gm player list` | GM | Bot-played characters, leash setting, hidden-timer state. |
| `!gm player dossier <name>` | GM · AGM | Whispers the private half. Refuses for every other seat, including in a DM. |
| `!gm player act <name> [nudge]` | GM | Forces a turn now, optionally steered. Nudge is GM-private. |
| `!gm player speak <name> <text>` | GM | Puppets the character verbatim — the escape hatch when the AI misreads the room. |
| `!gm player leash <name> <tight\|normal\|loose>` | GM | Spotlight frequency. |
| `!gm player hold <name>` | GM | Vetoes a pending escalation; timer stays full until released. |
| `!gm player reveal <name>` | GM | Burns the secret deliberately — moves the dossier into play. |
| `!gm player retire <name>` | GM | Stops the bot voicing them; sheet stays in the roster. |

### 3.10 Worked example

```
nick › !gm player new roll up a sneaky rogue that the party shouldn't trust

— to the table —
Vessa Corrin joins the party. Tier I, 32 XP.
  Wits 3, Body 2 · Stealth 2, Deception 1, Insight 1 · Follower: a street informant (Cap 1)
  Pool: Wits 3 + Stealth 2 = 5 dice
  Bond: "Kesh pulled me out of the canal. I have not forgotten."
  She says she came up from the Thepyrgos gutters. She says a lot of things.

— whispered to nick —
DOSSIER · Vessa Corrin
  Agenda   She is paid by the Chain-Lanterns to find out who is freecasting.
  Tell     She counts to eight and stops. Aeler habit. She is not Aeler.
  Price    Passage out of the city for her sister. Nothing else moves her.
  Trigger  Ticks when the party uses magic in front of her, or names a patron.
  Timer    Ledger [6] — 0/6. On fill she reports them, then decides.
  Directive (public voice): deflect questions about her accent; volunteer to scout alone.
```

The public block is a legal 32 XP Tier I build the GM can hand to a human if the bot is retired.
The private block is the feature.

*(Note: the flavour Bond line above is characterisation in the sheet's notes, not a mechanical Bond
— see §3.8.)*

---

## 4. Feature 2 — Passive Mode

**Root commands:** `!gm ask` · `!gm look` · `!gm roll` and friends.

A rules oracle any player can use, that answers from the books and cannot reach the adventure.

Today almost every command in `gm-commands.js` opens with
`if (context.myRole !== 'gm') return 'Only the GM can…'`. That is correct for anything that changes
the world and wrong for everything a player might simply want to *know*. Passive Mode is the set of
commands safe for anyone because they only read, and only from sources that cannot spoil a session.

### 4.1 The spoiler firewall

This is the load-bearing decision, and it must be an **allowlist**. A denylist over a growing corpus
leaks the first time somebody adds a source and forgets to exclude it.

**Readable in Passive Mode**

- SRD, Player's Guide, GM Guide rules text via `rules-index`
- Bestiary entries — Resilience, Clock, Resolution
- Spells, tags, talents, region and culture reference
- The asking player's **own** character sheet
- Knowledge entries where `revealed === true`
- Public room chat, scoped to this room

**Unreachable, structurally**

- Anything under `adventure/*` — scenes, beats, outcomes
- `getSceneContextForPrompt()` — the GM's working context
- Knowledge entries where `revealed === false`
- NPC motivations, hidden timers, Player Mode dossiers
- Other players' sheets, and **every whisper** — never indexed in the first place
- GM notes, seeds, and the Crown Spread interpretation

> **Reveal is live, not a snapshot.** `revealed` flips mid-session in both directions —
> `!gm knowledge reveal` and `hide` already exist. Knowledge is indexed **on reveal** and dropped
> **on hide**, never indexed at creation and filtered later: the same write-time rule as whispers,
> for the same reason. Hiding stops future answers; it cannot retract one already given, and the GM
> should not expect it to.

Implement as a distinct context builder — `buildPassiveContext()` — that constructs its payload from
the allowlist alone and **never receives the orchestrator**. Not a filter applied to the GM context;
a separate assembly that has nothing to filter.

### 4.2 Command surface

Two verbs carry most of it. `ask` is fuzzy and costs an LLM call; `look` is exact, deterministic and
free. Prefer routing to `look` when the query resolves cleanly.

| Command | Gate | Behaviour |
|---|---|---|
| `!gm ask <question>` | any | Rules question in plain language. Cited, spoiler-free, refuses rather than invents. |
| `!gm look <term>` | any | Exact lookup across spells, talents, tags, creatures, regions, rules sections. No model call. |
| `!gm quickref [topic]` | any | SRD reference tables — DV ladder, Position & Effect, Outcome Matrix, armour conversion, SB spend menu. |
| `!gm dice <NdN>` | any | Already exists and is already ungated. Keep. |
| `!gm roll <name> <pool> DV <n> <pos>` | any | Already exists. Full resolution with Position and Outcome Matrix. |
| `!gm sheet [name]` | any | Your own sheet in full; anyone else's reduced to what is public. |
| `!gm recap` | any | What has been *revealed* so far — public chat and revealed knowledge only. |
| `!gm deck draw` | any | Already exists. A card and its suit reading; no adventure context. |
| `!gm name <culture>` | any | Name generator from `world-manager`. |

### 4.3 The answer contract

An oracle that bluffs is worse than no oracle, because a table will act on it.

1. **Cite or decline.** Every rules answer names its source section. If retrieval returns nothing
   above threshold, the answer is *"That is not in the rules I can see"* — not a plausible-sounding
   ruling.
2. **Rules, not adjudication.** Passive Mode says what the DV ladder *is*. It does not say what the
   DV *should be* for the thing you are about to attempt — that is the GM's call, and answering it
   quietly takes authority away from them.
3. **Refuse sideways questions.** "What's in the vault?" and "Is Vessa lying?" get a fixed, cheerful
   deflection, logged for the GM. Detect these **before** retrieval, not after.
4. **Name which kind of source answered.** "The rules say" and "your GM has established" are
   different claims. Where they disagree — a revealed campaign fact contradicting the book — **the
   campaign wins and the answer says so.** House rules outrank the SRD; an oracle that quietly
   prefers the book is arguing with the GM.

### 4.4 Deployment posture

`MODE=passive` in a seat's env file disables the GM-takeover timer, suppresses all unsolicited
narration, and leaves only the table above. That is the configuration for a group with a human GM who
wants a rules oracle in the room and nothing else — and it is the safest first thing to ship, because
it cannot affect a session even if it is wrong.

---

## 5. Shared concerns

**Cost and rate.** Passive Mode opens LLM calls to every player, not just the GM. `ask` needs a
per-user rate limit and a per-room hourly ceiling, with `look` as the unmetered fallback. Player Mode
turns should route through `delegated-tasks.js` so a slow generation never blocks the socket loop —
which is where this design touches the side-task work already in flight.

**Audit.** Everything Player Mode does privately — dossier creation, hidden timer ticks, held
escalations — goes to `logger.js` at GM visibility. A GM who inherits a session mid-arc should be
able to reconstruct what the bot has been up to without reading its prompts.

**Persistence.** Split by audience, because the campaign save is **shared** — it syncs to the server
and is readable by the web client, so anything written there is readable by the table.

| Lives in | What |
|---|---|
| Shared campaign state, via `orchestrator.campaign.save()` | The public sheet, and the seat claim (which seat owns which character). |
| **Per-seat local file, mode `0600`, beside that seat's env file — never synced** | The dossier, the public-voice directive derived from it, and the hidden timer's position. |

An earlier draft of this document put dossiers and hidden timers in the campaign save. That was not
a style preference, it was a leak: it would have made every secret readable by any client that can
read campaign state, defeating "never leaves the GM table" completely. If the GM seat needs to know
across a restart that a dossier exists, put an **opaque reference** in campaign state and keep the
content local.

Create the local store with `fs.writeFileSync(path, data, { mode: 0o600 })` and verify the mode on
read — a store that has been chmodded wider should refuse to load and say so, rather than quietly
serving secrets from a world-readable file.

Passive Mode holds no state at all, which is a feature.

---

## 6. Build order

Sequenced so the lowest-risk, most-useful thing ships first and each stage is independently valuable.

| Stage | Work | Why here |
|---|---|---|
| 1 | Ungate the safe commands — `dice`, `roll`, `deck draw`, `sheet` | No new code paths; immediate value |
| 2 | `buildPassiveContext()` + the spoiler-canary test | The firewall before anything that uses it. Ship the test *with* it |
| 3 | `look`, `quickref`, `recap`, `name` | Deterministic lookups; no model calls, no hallucination surface |
| 4 | `ask`, with citations and refusal | First feature that costs money. Rate limits land here |
| 5 | `MODE=passive` posture | A bot that only answers. Shippable to real tables |
| 6 | Seats: manifest, identity, routing | Relax one-bot-per-room, add `mode`/`seat`, ownership announce, speak under own name |
| 7 | Player Mode: sheet, dossier, whisper | Creation and inspection only; the seat does not yet speak |
| 8 | Player Mode: turns, leash, hidden timer | Ship `speak` and `hold` in the same stage — the manual overrides make the automatic behaviour safe to try |
| ∥ | `room_id` everywhere the code is load-bearing | Independent; safe any time. **Do it before offshoot rooms, not after** |

---

## 7. Acceptance requirements

The ones that are not negotiable are marked **CRITICAL** — they are the difference between a feature
and an incident.

### 7.1 Spoiler containment

1. **CRITICAL — Spoiler canary.** A fixture adventure contains the string `SPOILER-CANARY` in (a) an
   unrevealed `knowledge` entry and (b) an NPC `motivation`. Automated test: no Passive Mode response
   to any command in §4.2, for any input, may contain it. This test ships in Stage 2, not later.
2. **CRITICAL — Whispers are never indexed.** Assert the index write path rejects any message with
   `whisper: true` or a `recipient`. Separately assert a whispered dossier is unretrievable via a
   player seat's chat retrieval.
3. **CRITICAL — Reveal/hide lifecycle.** A knowledge entry is absent from the passive corpus before
   `reveal`, present after, and absent again after `hide`. Assert all three transitions.
4. `buildPassiveContext()` must not accept an orchestrator reference. Enforce by signature, and
   assert in test that passing one throws rather than being ignored.
5. **Passive Mode mutates nothing it must not.** The passive surface splits in two, and the two have
   different obligations:

   - **Pure reads** — `ask`, `look`, `quickref`, `sheet`, `recap`. Run all of them against a live
     campaign and assert campaign state is **byte-identical** before and after.
   - **Table utilities** — `dice`, `roll`, `deck draw`. These legitimately advance the deck position,
     the room's seeded RNG (`server/rng.js`'s `getRoomRng`) and roll history; a deterministic RNG's
     cursor *is* state, so a byte-identical assertion over the whole campaign can never pass for
     them. Assert instead that they touch **none** of: adventure, characters, timers, Story Beats,
     Obligation, or knowledge.

   Do not collapse these into one test. The first is the spoiler-safety property; the second is a
   scope property, and conflating them means the first silently stops being checked.

### 7.2 Seats and routing

6. **CRITICAL — Exactly one responder.** With a GM, player and passive seat in one room, every
   command class in §3.2 produces exactly **one** chat response. No duplicates, no "not mine" replies.
7. **Reclaim, don't duplicate.** A player seat restarted mid-session reclaims its character; the
   roster does not gain a second Vessa.
8. A seat with `mode !== 'gm'` never starts the GM-takeover timer, even if the GM seat disconnects.
9. `!gm player new` with no idle seat returns a clear error and leaves **no partial state** — no
   half-created sheet, no orphan dossier.
10. A player seat speaks and whispers under its **character's** name, not `'GM'`.

### 7.3 Fair play

11. **CRITICAL — Dossier gate.** A `!gm player dossier` request from any seat that is not GM or
    Assistant GM is refused, including via DM. Test the negative case explicitly.
12. Every bot-player roll appears in public chat and goes through `dice.js`. Assert no code path lets
    a player seat resolve a roll privately.
13. The dossier does not appear in the prompt used for public speech. Assert on the constructed
    prompt, not on the output.

### 7.4 Regression

14. Existing single-bot, single-room operation is unchanged: `node ai-gm-bot.js` with no `mode`, no
    `seat` and no `roomId` behaves exactly as it does today. This is the compatibility floor.
15. Characters created by `!gm create` use the **twelve** skills (§2.1).
16. After the `room_id` work: `indexNameFor()` is a no-op on a UUID input; and rotating a
    `room_code` mid-session does not change the pub/sub subject or the index name.

---

## 8. Deferred to tuning

Not design questions — numbers only real play can settle. Both configurable.

- **What `normal` means on the leash.** One unprompted turn per how many table messages? Start at
  eight; let a GM who finds the bot quiet or pushy move it.
- **The retrieval score below which `ask` declines.** Too low and the oracle bluffs; too high and it
  refuses questions it could have answered. Log near-misses for a few sessions and tune against real
  ones.

---

## 9. Implementation review — resolved findings

Recorded from the read-only review of the shipped modules, so the reasoning survives the diff.

| # | Finding | Resolution |
|---|---|---|
| P1 | The server reserved a seat (`botBusy`) for `!gm player new`, but three early returns in `PlayerSeat.command` never announced back, stranding the seat until restart. | The early returns re-announce, **and** a reservation older than `RESERVATION_MS` (120s) is reclaimed server-side. Belt and braces, because one half lives in each process. |
| P2 | `ownSheet` was dereferenced from `actor.selectedCharacter`, which any client can set — including on *another* client's presence row. | Seats now read `GET /public-sheet/:clientId`, which resolves the sheet from `room.characterClaims`. Separately, `character-select` now refuses a `clientId` that is neither the sender's own nor a GM's. |
| P3 | `deliverWhisper`/`broadcastToRoom` re-resolved the room by one string, and callers disagreed about which (`room_id` vs `room.code` vs the join code). Under UUID room identity, or after a `room_code` rotation, a whisper would silently vanish — including the error reply that would have reported it. | One `resolveRoom()` accepts a room object or any of its identifiers. |
| P4 | On the Socket.IO path a `!gm player <brief>` message fell through to `recordChatMessage`/`broadcastToRoom` when the room did not resolve — the private brief, in the clear, to the whole table. | Both transports fail **closed**: `isPrivateCommand()` is checked first and the message is dropped when no room resolves. |
| P5 | A single failed `public-context` fetch called `replaceRevealed([])`, so one network blip erased every revealed fact and `ask`/`look` answered DECLINE for things the table already knew. | The last good projection is kept; the failure is audited. |
| P6 | `leash`/`speak`/`act` sliced the character name off by length, so the nameless form (`!gm player leash tight`) ate its own argument. | `stripName()` removes a leading name only when one is actually present, quoted or bare. |
| P7 | The per-seat state file was read with no mode check and no `try`/`catch`. | A file whose mode is wider than `0600` is refused (§5); an unreadable one fails loudly at startup rather than half-loading. |
| P8 | One global `busy` flag reported an in-flight `ask` to everyone as a *personal* rate limit. | The concurrency message and the rate-limit message are now distinct. |
| P9 | A missing `data/rules.txt` threw in the constructor, stopping any seat of any mode from connecting. | Absent rules degrade passive answers to DECLINE; they no longer stop the seat. |
| P10 | A room-identity mismatch threw inside the message pump. | The seat audits, disconnects deliberately, and ignores everything after. |
| — | An undeliverable dossier or escalation notice (no human GM seated) vanished while the state that produced it persisted. | `notifyGms()` audits when there is nobody to tell. |
| — | A handshake presenting the API key with a malformed `botMode`/`botSeat` connected as an ordinary seatless client: unroutable and silent. | The handshake is rejected with a reason on both transports. |

Two review findings were **retracted** on inspection of the sources: `dice.rollDice()` does return
`.dice` (so the `roll` formatting is correct), and `bestiary.json` is an array of name→entry objects
(so the reference loader's `for…of` + `Object.entries` is right).

---

*Design proposal. Rendered version: published as the "Two Seats at the Table" artifact.*
