// modules/commands.js
const diceModule = require('./dice');
const timersModule = require('./timers');
const adventureDirector = require('./adventure-director');
const travelModule = require('./travel');
const rulesModule = require('./rules-index');
const { formatColumns, shortTitle } = require('./format-utils');
const { getVocab, encounterType, DEFAULT_TYPE } = require('./objective-types');
const knowledgeIndex = require('./knowledge-index');
const assistantSuggestions = require('./assistant-suggestions');
// NEW: structured knowledge-state reveal/hide (module.knowledge[] entries)
// -- see adventure-context.js's KNOWLEDGE STATE section and
// server/adventure.js's revealKnowledge()/hideKnowledge(). Not required by
// adventure-director.js (that file only ever reads via context.apiRequest),
// but commands.js needs invalidate() directly here so a [REVEAL ...]/
// [HIDE ...] tag or `!gm knowledge reveal/hide` command takes effect on
// the very next prompt build, not after the next TTL expiry.
const adventureContext = require('./adventure-context');

// Icon per encounter type, used in [ENCOUNTER START]/[ENCOUNTER RESOLVE]
// chat replies so player-facing text doesn't always show a crossed-swords
// icon for encounters that aren't fights. Falls back to the combat icon
// for any unrecognized/missing type (DEFAULT_TYPE === 'combat').
const ENCOUNTER_ICON = {
    combat: '⚔️',
    obstruction: '🚧',
    skill_challenge: '🎯',
    trap_ward: '🪤',
    lockpick: '🔓',
    heist: '🕵️',
    social: '🤝',
};
function encounterIcon(type) {
    return ENCOUNTER_ICON[type] || ENCOUNTER_ICON[DEFAULT_TYPE];
}
// CHANGED: WebSocket.OPEN is referenced below (region set, deck commands)
// but this module never imported it -- every one of those branches threw
// "ReferenceError: WebSocket is not defined" the moment it ran.
const WebSocket = require('ws');
// characters module is passed via context

// ─── Helper: derive HTTP API base from WebSocket URL ─────────────
function getApiBaseUrl(wsUrl) {
    if (!wsUrl) return 'http://localhost:10000/api';
    const url = new URL(wsUrl);
    url.protocol = url.protocol.replace('ws', 'http');
    url.pathname = '/api';
    return url.toString().replace(/\/$/, '');
}

// ─── HTTP request helper (global API, outside room context) ──────
function globalApiRequest(path, method = 'GET', body = null) {
    const wsUrl = process.env.WS_URL || 'ws://localhost:10000';
    const apiBase = getApiBaseUrl(wsUrl);
    const fullUrl = apiBase + (path.startsWith('/') ? '' : '/') + path;
    const apiKey = process.env.API_KEY || '';

    return fetch(fullUrl, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
        // CHANGED: same fix as apiRequest() in index.js -- read as text
        // first so a non-JSON response (HTML fallback page from a route
        // that doesn't exist, proxy error page, etc.) reports what
        // actually went wrong instead of a bare JSON.parse crash.
        const raw = await res.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (e) {
            const snippet = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
            throw new Error(
                `API returned non-JSON response (HTTP ${res.status} ${res.statusText}) ` +
                `for ${method} ${fullUrl} -- likely a route that doesn't exist server-side. ` +
                `Body starts with: "${snippet}"`
            );
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    });
}

// ─── Whiteboard grid-combat token sync ────────────────────────────
// NEW: lets the AI GM actually WRITE to the whiteboard (previously
// `!gm whiteboard`/`!gm grid` could only read a summary). Tokens are
// addressed by a stable slug derived from the character/NPC name, so
// repeated tag calls for the same name update the same token instead of
// creating duplicates. Positions are grid CELLS (col/row), not pixels --
// the server converts using the room's cellSize, since the bot has no
// canvas of its own to reason about.
function slugifyTokenId(name) {
    return 'npc-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Simple round-robin slot picker so tokens the AI places without an
// explicit position don't all stack on the same cell. Not persisted
// across process restarts -- purely a "spread them out a bit" default;
// the AI (or a human) can always reposition via [TOKEN MOVE ...] / drag.
let _autoTokenSlot = 0;
function nextAutoTokenCell() {
    const col = 2 + (_autoTokenSlot % 6);
    const row = 1 + Math.floor(_autoTokenSlot / 6);
    _autoTokenSlot++;
    return { col, row };
}

function inferFaction(role, motivation) {
    const text = `${role || ''} ${motivation || ''}`.toLowerCase();
    if (/\b(ally|allied|companion|friend|guide|helper|patron|mentor)\b/.test(text)) return 'ally';
    return 'enemy';
}

async function placeOrUpdateToken(context, { name, faction, col, row, vision, body }) {
    if (!context.apiRequest) return null;
    const id = slugifyTokenId(name);
    const pos = (Number.isFinite(col) && Number.isFinite(row)) ? { col, row } : nextAutoTokenCell();
    try {
        const result = await context.apiRequest('POST', ['whiteboard', 'tokens'], {
            token: {
                id,
                label: name,
                faction: faction || 'enemy',
                col: pos.col,
                row: pos.row,
                vision: Number.isFinite(vision) ? vision : (faction === 'ally' ? 3 : 0),
                body: Number.isFinite(body) ? body : 3
            }
        });
        return result;
    } catch (e) {
        console.warn(`[Whiteboard] Failed to place token for "${name}":`, e.message);
        return null;
    }
}

async function moveToken(context, name, col, row) {
    if (!context.apiRequest) return null;
    const id = slugifyTokenId(name);
    try {
        return await context.apiRequest('POST', ['whiteboard', 'tokens', encodeURIComponent(id), 'move'], { col, row });
    } catch (e) {
        console.warn(`[Whiteboard] Failed to move token "${name}":`, e.message);
        return null;
    }
}

async function removeToken(context, name) {
    if (!context.apiRequest) return null;
    const id = slugifyTokenId(name);
    try {
        return await context.apiRequest('DELETE', ['whiteboard', 'tokens', encodeURIComponent(id)]);
    } catch (e) {
        // Not fatal -- token may never have been placed (e.g. an NPC that
        // was only ever named, never actually put in a fight).
        return null;
    }
}

// Clear every enemy-faction token off the grid, e.g. once an encounter
// resolves. Deliberately scoped to faction:'enemy' only -- ally/PC
// tokens (which this bot never creates itself, only humans do via the
// whiteboard UI) are left alone, so resolving one fight can't silently
// wipe party tokens a human placed.
async function clearEnemyTokens(context) {
    if (!context.apiRequest) return;
    try {
        const board = await context.apiRequest('GET', ['whiteboard']);
        const tokens = board?.gridCombat?.tokens || [];
        const enemyIds = tokens.filter(t => t.faction === 'enemy').map(t => t.id);
        for (const id of enemyIds) {
            await context.apiRequest('DELETE', ['whiteboard', 'tokens', encodeURIComponent(id)]).catch(() => {});
        }
    } catch (e) {
        console.warn('[Whiteboard] Failed to clear enemy tokens after encounter resolve:', e.message);
    }
}

// ─── Command parser ────────────────────────────────────────────────
function parseArgs(text) {
    const parts = text.split(/\s+/);
    const cmd = parts[1]?.toLowerCase();
    const args = parts.slice(2);
    return { cmd, args };
}

// Helper to ensure character exists on server (uses context.apiRequest)
async function ensureCharacterOnServer(name, context) {
    try {
        const data = await context.apiRequest('GET', ['characters', encodeURIComponent(name)]);
        if (data && typeof data === 'object' && data.harm !== undefined) {
            return true;
        }
    } catch (e) {
        if (!e.message.includes('404')) {
            console.warn(`Failed to check character ${name} on server: ${e.message}`);
            return false;
        }
    }
    try {
        const updates = {
            harm: 0,
            fatigue: 0,
            obligation: 0,
            boons: 0,
            leash: 0,
            corruption: 0,
            tier: 1,
            xp: 0,
            attributes: { Body: 2, Wits: 2, Spirit: 2, Presence: 2 },
            skills: {
                Melee: 0, Ranged: 0, Unarmed: 0,
                Athletics: 0, Stealth: 0, Endurance: 0, Craft: 0,
                Sway: 0, Deception: 0, Subterfuge: 0, Performance: 0, Insight: 0,
                Lore: 0, Investigation: 0, Medicine: 0,
                Arcana: 0
            },
            talents: [],
            bonds: [],
            complications: [],
            assets: [],
            followers: [],
            active: true
        };
        await context.apiRequest('POST', ['characters', 'update'], { updates: { [name]: updates } });
        console.log(`✅ Created character ${name} on server.`);
        return true;
    } catch (e) {
        console.warn(`Failed to create character ${name} on server: ${e.message}`);
        return false;
    }
}

/**
 * NEW: extracted from the !gm discover command body so it can also be
 * used by index.js's performAggressiveSync() -- which previously did its
 * own SEPARATE, cruder implementation (a full wholesale replace via
 * characters.loadCharacters(), rather than this field-by-field merge).
 * Having the same logic live in two places is exactly the kind of
 * duplication that caused the case-sensitivity fragmentation bug a few
 * fixes back, and the wholesale-replace version was also strictly more
 * dangerous: it discards any local-only state that hasn't yet round-
 * tripped through the server between sync ticks. This is the one true
 * implementation now; both callers share it.
 *
 * @param {object} context - needs { apiRequest, charactersModule }
 * @returns {Promise<{synced: number, error?: string}>}
 */
async function syncCharactersFromServer(context) {
    const listData = await context.apiRequest('GET', ['characters']);
    if (!listData || !Array.isArray(listData.characters)) {
        return { synced: 0, error: 'No character data from server.' };
    }
    const serverChars = listData.characters;
    let synced = 0;
    for (const data of serverChars) {
        if (!data || !data.name) continue;
        const char = context.charactersModule.get(data.name);
        if (data.harm !== undefined) char.harm = data.harm;
        if (data.fatigue !== undefined) char.fatigue = data.fatigue;
        if (data.obligation !== undefined) char.obligation = data.obligation;
        if (data.boons !== undefined) char.boons = data.boons;
        if (data.leash !== undefined) char.leash = data.leash;
        if (data.corruption !== undefined) char.corruption = data.corruption;
        if (data.attributes) char.attributes = { ...char.attributes, ...data.attributes };
        if (data.skills) char.skills = { ...char.skills, ...data.skills };
        if (data.talents) char.talents = data.talents;
        if (data.bonds) char.bonds = data.bonds;
        if (data.complications) char.complications = data.complications;
        if (data.assets) char.assets = data.assets;
        if (data.followers) char.followers = data.followers;
        if (data.tier !== undefined) char.tier = data.tier;
        if (data.xp !== undefined) char.xp = data.xp;
        synced++;
    }
    return { synced };
}

// ─── Helper: NPC action resolver (unchanged) ──────────────────────
async function resolveNPCAction(actionType, npcName, target, context, options = {}) {
    const charactersModule = context.charactersModule;
    if (!charactersModule) return '❌ Characters module not available.';

    const orchestrator = context.orchestrator;
    if (!orchestrator) return '❌ Orchestrator not available.';

    const state = orchestrator.campaign.state;
    const saveCampaign = () => orchestrator.campaign.save();

    let sbCost = options.cost || 2;
    if (options.dangerous) sbCost += 1;
    if (options.area) sbCost += 1;

    if ((state.sb || 0) < sbCost) {
        return `❌ Not enough SB (need ${sbCost}, have ${state.sb || 0})`;
    }

    state.sb = (state.sb || 0) - sbCost;

    let result = '';
    let targetChar = charactersModule.get(target);
    const isPlayer = !!targetChar;

    switch (actionType) {
        case 'attack': {
            const harm = options.harm || 1;
            if (isPlayer) {
                diceModule.applyHarmAndFatigue(targetChar, harm, options.armorStep || 1, saveCampaign);
                result = `${npcName} attacks ${target} for ${harm} Harm.`;
                if (options.fatigue) {
                    targetChar.fatigue = (targetChar.fatigue || 0) + 1;
                    result += ` ${target} also marks 1 Fatigue.`;
                }
            } else {
                result = `${npcName} attacks ${target} (narrative).`;
            }
            break;
        }
        case 'social': {
            const tactic = options.tactic || 'intimidate';
            if (isPlayer) {
                const penalty = options.penalty || 1;
                result = `${npcName} ${tactic}s ${target}. Position worsens by ${penalty} step.`;
            } else {
                result = `${npcName} ${tactic}s ${target} (narrative).`;
            }
            break;
        }
        case 'spell': {
            const spellName = options.spell || 'Light';
            const spell = orchestrator.world.getSpell(spellName);
            if (!spell) return `❌ Spell "${spellName}" not found.`;
            const tagCount = spell.tags ? spell.tags.length : 1;
            let cost = Math.min(Math.max(tagCount, 2), 5);
            const dangerous = ['LEAP', 'FOLD', 'GATE', 'TRANSFORM', 'CREATE', 'SUMMON', 'DOMINATE', 'REVIVE'];
            if (spell.tags && spell.tags.some(t => dangerous.includes(t.toUpperCase()))) cost = Math.min(cost + 1, 6);
            if (isPlayer) {
                if (spell.tags.includes('HARM')) {
                    diceModule.applyHarmAndFatigue(targetChar, 1, 1, saveCampaign);
                    result = `${npcName} casts ${spell.name} on ${target} – ${target} takes 1 Harm.`;
                } else if (spell.tags.includes('FATIGUE')) {
                    targetChar.fatigue = (targetChar.fatigue || 0) + 1;
                    result = `${npcName} casts ${spell.name} on ${target} – ${target} marks 1 Fatigue.`;
                } else {
                    result = `${npcName} casts ${spell.name} on ${target} – the Weave shifts.`;
                }
            } else {
                result = `${npcName} casts ${spell.name} on ${target} (narrative).`;
            }
            break;
        }
        default:
            return '❌ Unknown NPC action type.';
    }

    await saveCampaign();
    return result;
}

// ─── Main command handler ──────────────────────────────────────────
async function handleBotCommand(sender, text, context) {
    const charactersModule = context.charactersModule;
    if (!charactersModule) {
        return '❌ Characters module not available.';
    }

    if (!context.orchestrator) {
        return '❌ Orchestrator not available.';
    }
    const campaignState = context.orchestrator.campaign.state;
    const saveCampaign = () => context.orchestrator.campaign.save();
    const ws = context.ws;

    const { cmd, args } = parseArgs(text);

    // ─── Help ──────────────────────────────────────────────────────
    if (cmd === 'help') {
        return `Available commands:
!gm help - this list
!gm create <name> - create a new character (default stats)
!gm delete <name> - delete a character permanently
!gm characters cleanup - merge any duplicate/case-fragmented character records (GM only)
!gm status [name] - show character stats (list all if no name)
!gm dice XdY - roll generic dice
!gm roll "Name" Attribute+Skill DV Position - roll Fate's Edge pool
!gm harm/fatigue/boons/obligation/corruption/leash <name> <amount> [armorStep] - change resource
!gm setattr <name> <attribute> <value> - set attribute (local only)
!gm setskill <name> <skill> <value> - set skill (local only)
!gm addtalent <name> <talent> - add a talent
!gm bond <name> <target> "<description>" - add a bond
!gm complication <name> "<description>" - add a complication
!gm asset <name> add/remove <asset name> - manage assets
!gm follower <name> add/remove <follower name> [cap] - manage followers
!gm timer add/tick/remove <name> [segments] [onFill] - manage local timers
!gm fact <key> <value> - update a fact
!gm suggestions - list pending Assistant GM suggestions awaiting approval
!gm approve <id> - approve a pending Assistant GM suggestion
!gm reject <id> - reject a pending Assistant GM suggestion
!gm confirm-takeover - Assistant GM only: assume full GM control when no GM is present
!gm recall <query> - search facts/NPCs/summaries (requires ES_URL configured)
!gm sync - sync existing characters from server
!gm discover - discover and sync all characters from server
!gm export-characters - show global character roster (all rooms)
!gm sync-all - sync characters from all rooms into local campaign
!gm room-state - show current room state (scene, timers, etc.)
!gm upload - upload campaign
!gm load <code> - load campaign
!gm sb - show Story Beats
!gm position set <Dominant|Controlled|Desperate> - set scene position
!gm dv set <number> - set default DV
!gm etiquette - show game etiquette reminder
!gm region - show current region info
!gm region list - list all available regions (multi-column)
!gm region set <name> - set the campaign region (syncs to VTT)
!gm travel - travel status + settings
!gm travel to <region> [legs] - journey to a region via the Core Travel Procedure (draws Place/Actor/Pressure/Leverage per leg, then arrives)
!gm travel policed on|off - toggle strongly-policed route (Pressure from destination instead of the Wilds)
!gm travel gateway <region>|clear - set/clear the gateway authority region for Leverage draws
!gm travel itineraries - list named Worked Itineraries (scripted journeys from the sourcebook)
!gm travel itinerary <n|name> - run a Worked Itinerary end to end
!gm travel spread [region] - draw the Traveler's Spread (3-card quick journey reading)
!gm travel history - recent journeys this campaign
!gm adventure - show adventure status or selection menu
!gm adventure choose <n> - pick an adventure from the menu (GM only)
!gm adventure preview [n] - preview the active adventure, or a pending menu option (any player)
!gm adventure crown - jump straight to a Crown Spread (GM only)
!gm adventure vote abandon - vote to abandon the current adventure
!gm adventure reset - restart the current adventure from the top (GM only)
!gm adventure debug - full adventure state + reference data dump (GM only)
!gm session end - mark a real-world play session as ended (dynamic-growth adventures)
!gm npc create "Name" ["Role"] ["Motivation"] - register an ad-hoc NPC into the current adventure
!gm knowledge [list] - show this adventure's knowledge/secret state (GM only)
!gm knowledge reveal <id> - mark a knowledge entry revealed, safe to share (GM only)
!gm knowledge hide <id> - mark a knowledge entry secret again (GM only)
!gm resume - show current adventure status (shortcut for !gm adventure)
!gm seed - seed campaign with Crown Spread (GM only)
!gm spell <name> - show details of a spell
!gm spells - list all available spells
!gm encounter start "<name>" [type] - start an encounter (type: combat/obstruction/skill_challenge/trap_ward/lockpick/heist/social, default combat)
!gm encounter status - show the currently active encounter
!gm npc attack <npc> <target> [harm] - NPC attacks (costs 2 SB)
!gm npc social <npc> <target> <tactic> - NPC social maneuver (costs 2 SB)
!gm npc spell <npc> <target> <spell> - NPC casts spell (costs 2-6 SB)
!gm enemy-turn - tick enemy turn timer (use SB for actions)
!gm deck draw [count] [region] - draw cards (via WebSocket)
!gm deck shuffle - shuffle the deck
!gm deck crown [region] - Crown Spread
!gm deck history - show recent draws (if supported)
!gm whiteboard - show whiteboard summary (drawings, notes, images)
!gm grid - show grid combat status (tokens, enabled)
!gm token place <name> <col> <row> [ally|enemy] - place a token on the grid
!gm token move <name> <col> <row> - move an existing token
!gm token remove <name> - remove a token
!gm token clear - remove all enemy tokens
!gm modules - list loaded modules (if any)`;
    }

    // ─── Adventure command (handled by adventure-director) ────────
    if (cmd === 'adventure') {
        return await adventureDirector.handleAdventureCommand(sender, args, context);
    }

    // ─── Resume adventure (alias for adventure status) ─────────────
    // NEW: `!gm resume` is a shortcut for `!gm adventure status`. Any
    // trailing words (e.g. `!gm resume adventure`) are ignored since the
    // parser already treats `resume` itself as the whole command -- that's
    // fine, `handleAdventureCommand` with no sub-args just shows status.
    if (cmd === 'resume') {
        return await adventureDirector.handleAdventureCommand(sender, [], context);
    }

    // ─── Session end (dynamic-growth adventures: climax/session tracking) ──
    // NEW: manual marker for "a real-world play session just ended" --
    // see the DEFAULT_CLIMAX_AFTER_SESSIONS comment in adventure-director.js
    // for why this can't be inferred from chat volume alone.
    if (cmd === 'session' && (args[0] || '').toLowerCase() === 'end') {
        if (context.myRole !== 'gm') return 'Only the GM can end a session.';
        return await adventureDirector.handleSessionEnd(context);
    }

    // ─── Create ──────────────────────────────────────────────────
    if (cmd === 'create') {
        const name = args[0];
        if (!name) return 'Usage: !gm create <name>';
        const existing = charactersModule.get(name);
        if (existing && Object.keys(existing.attributes).some(k => existing.attributes[k] !== undefined)) {
            return `Character "${name}" already exists locally. Use !gm status ${name} to see stats.`;
        }
        const char = charactersModule.get(name);
        char.attributes = { Body: 2, Wits: 2, Spirit: 2, Presence: 2 };
        char.skills = {
            Melee: 0, Ranged: 0, Unarmed: 0,
            Athletics: 0, Stealth: 0, Endurance: 0, Craft: 0,
            Sway: 0, Deception: 0, Subterfuge: 0, Performance: 0, Insight: 0,
            Lore: 0, Investigation: 0, Medicine: 0,
            Arcana: 0
        };
        char.talents = [];
        char.bonds = [];
        char.complications = [];
        char.harm = 0;
        char.fatigue = 0;
        char.boons = 0;
        char.obligation = 0;
        char.corruption = 0;
        char.leash = 0;
        char.assets = [];
        char.followers = [];
        char.tier = 1;
        char.xp = 0;
        await saveCampaign();
        await ensureCharacterOnServer(name, context);
        return `Created character "${name}" with default stats. Use !gm setattr to customize.`;
    }

    // ─── Delete ──────────────────────────────────────────────────
    // NEW: characters.js has always exported remove(name), but nothing
    // ever called it -- there was no way to clean up a mistakenly-created
    // character (e.g. the "0"/"1" bogus entries the !gm discover bug
    // above used to create) without restarting the whole bot process.
    if (cmd === 'delete') {
        if (context.myRole !== 'gm') return 'Only the GM can delete characters.';
        const name = args.join(' ');
        if (!name) return 'Usage: !gm delete <name>';
        const existed = charactersModule.remove(name);
        await saveCampaign();
        return existed
            ? `Deleted character "${name}".`
            : `No character named "${name}" was found locally.`;
    }

    // ─── Status ──────────────────────────────────────────────────
    if (cmd === 'status') {
        const allChars = charactersModule.getAll();
        const names = Object.keys(allChars);
        if (names.length === 0) {
            return 'No characters found. Use !gm create <name> to create one.';
        }
        if (args.length === 0) {
            const lines = names.map(name => {
                const char = allChars[name];
                return `**${name}** (Tier ${char.tier || 1}) – Harm: ${char.harm}, Fatigue: ${char.fatigue}, Boons: ${char.boons}, Obligation: ${char.obligation}`;
            });
            return 'Characters:\n' + lines.join('\n');
        } else {
            const name = args.join(' ');
            const char = charactersModule.get(name);
            // Safely handle arrays
            const talents = char.talents || [];
            const bonds = char.bonds || [];
            const complications = char.complications || [];
            const assets = char.assets || [];
            const followers = char.followers || [];
            return `${name} → Harm: ${char.harm}, Fatigue: ${char.fatigue}, Boons: ${char.boons}, Obligation: ${char.obligation}, Corruption: ${char.corruption}, Leash: ${char.leash}` +
                `\nAttributes: ${JSON.stringify(char.attributes)}` +
                `\nSkills: ${JSON.stringify(char.skills)}` +
                `\nTalents: ${talents.join(', ') || 'None'}` +
                `\nBonds: ${bonds.map(b => `${b.target} (${b.description})`).join(', ') || 'None'}` +
                `\nComplications: ${complications.join(', ') || 'None'}` +
                `\nAssets: ${assets.join(', ') || 'None'}` +
                `\nFollowers: ${followers.map(f => `${f.name} (Cap ${f.cap}, Loyalty: ${f.loyalty}, Fitness: ${f.fitness})`).join(', ') || 'None'}`;
        }
    }

    // ─── Dice rolling ─────────────────────────────────────────────
    if (cmd === 'dice' && args.length > 0) {
        const formula = args[0];
        const match = formula.match(/^(\d+)d(\d+)$/i);
        if (match) {
            const count = parseInt(match[1]), sides = parseInt(match[2]);
            if (sides !== 10) {
                const rolls = [];
                let total = 0;
                for (let i = 0; i < count; i++) {
                    const r = Math.floor(Math.random() * sides) + 1;
                    rolls.push(r);
                    total += r;
                }
                return `${sender} requested a roll: ${formula} → [${rolls.join(', ')}] = ${total}`;
            } else {
                const result = diceModule.rollDice(count);
                const outcome = diceModule.determineOutcome(result.successes, 3, result.sb);
                return `🎲 ${sender} rolled ${count}d10 → [${result.results.join(', ')}] → ${result.successes} successes, ${result.sb} SB. ${outcome.outcome}`;
            }
        }
        return 'Usage: !gm dice 2d6  (or 3d10 for Fate\'s Edge pool)';
    }

    // ─── Roll with Position and DV ────────────────────────────────
    if (cmd === 'roll' && args.length >= 4) {
        const name = args[0];
        const poolExpr = args[1];
        const dv = parseInt(args[2]);
        const position = args[3];
        const diceCount = charactersModule.getPool(name, poolExpr);
        if (diceCount === 0) return `Could not resolve dice pool for ${name} with expression ${poolExpr}.`;
        let result = diceModule.rollDice(diceCount);
        result = diceModule.applyPosition(result, position);
        const char = charactersModule.get(name);
        const formatted = diceModule.formatRollResult(name, poolExpr, diceCount, result, dv, position, char);
        const outcome = diceModule.determineOutcome(result.successes, dv, result.sb);
        if (outcome.boonGain > 0) {
            charactersModule.applyDelta(name, 'boons', outcome.boonGain, saveCampaign);
            try {
                await context.apiRequest('POST', ['characters', encodeURIComponent(name), 'boons'], { delta: outcome.boonGain });
            } catch (e) { /* ignore */ }
        }
        campaignState.sb = (campaignState.sb || 0) + result.sb;
        await saveCampaign();
        return formatted;
    }

    // ─── Resource commands (GM only) ──────────────────────────────
    if (context.myRole !== 'gm') {
        return 'Only the Game Master can run resource commands.';
    }

    // harm/fatigue/boons/obligation/corruption/leash
    if (['harm', 'fatigue', 'boons', 'obligation', 'corruption', 'leash'].includes(cmd)) {
        const name = args[0];
        const amount = parseInt(args[1]);
        if (!name || isNaN(amount)) return `Usage: !gm ${cmd} <name> <amount> [armorStep for harm]`;
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        let result = '';
        if (cmd === 'harm') {
            const armorStep = args[2] ? parseInt(args[2]) : 1;
            diceModule.applyHarmAndFatigue(char, amount, armorStep, saveCampaign);
            result = `${name} took ${amount} Harm (armor step ${armorStep}). New Harm: ${char.harm}, Fatigue: ${char.fatigue}`;
            try {
                await context.apiRequest('POST', ['characters', encodeURIComponent(name), 'harm'], { delta: amount });
            } catch (e) { /* ignore */ }
        } else {
            charactersModule.applyDelta(name, cmd, amount, saveCampaign);
            result = `${name}'s ${cmd} changed by ${amount >= 0 ? '+' : ''}${amount} → now ${char[cmd]}`;
            if (['fatigue', 'boons', 'obligation'].includes(cmd)) {
                try {
                    await context.apiRequest('POST', ['characters', encodeURIComponent(name), cmd], { delta: amount });
                } catch (e) { /* ignore */ }
            }
        }
        return result;
    }

    // ─── Characters cleanup ─────────────────────────────────────────
    // NEW: one-time merge of any pre-existing case-fragmented character
    // records ("Khor" vs "khor" as separate server-side entries) left
    // over from before room.js's character storage normalized casing.
    // See room.js's mergeDuplicateCharacters() for the merge heuristic
    // and its known limitations -- worth a !gm status check afterward.
    if (cmd === 'characters' && (args[0] || '').toLowerCase() === 'cleanup') {
        if (context.myRole !== 'gm') return 'Only the GM can run character cleanup.';
        try {
            const result = await context.apiRequest('POST', ['characters', 'cleanup'], {});
            if (result.merged === 0) {
                return '✅ No duplicate character records found -- nothing to clean up.';
            }
            return `✅ Merged ${result.merged} duplicate character record${result.merged === 1 ? '' : 's'}. ` +
                `Removed keys: ${result.removedKeys.join(', ')}. ` +
                `Run \`!gm status\` to confirm the merged stats look right -- this is a best-effort merge, not guaranteed perfect for every field.`;
        } catch (e) {
            return `Cleanup failed: ${e.message}`;
        }
    }

    // ─── Discover ──────────────────────────────────────────────────
    // FIXED: GET /api/rooms/:code/characters returns
    // { characters: Object.values(chars) } -- an ARRAY of full character
    // objects (index.js's performAggressiveSync() already correctly
    // treats it this way). This command instead did
    // `Object.keys(serverChars)` on that array, which returns numeric
    // string INDICES ("0", "1", ...) rather than names, then used those
    // indices as character names -- creating bogus characters literally
    // named "0" and "1" (with the real character's stats copied onto
    // them) every time this ran. Now iterates the array directly and
    // reads each character's own `.name` field.
    if (cmd === 'discover') {
        if (context.myRole !== 'gm') return 'Only the GM can discover characters.';
        try {
            const { synced, error } = await syncCharactersFromServer(context);
            if (error) return error;
            await saveCampaign();
            return `Discovered and synced ${synced} characters from server.`;
        } catch (e) {
            return `Discovery failed: ${e.message}`;
        }
    }

    // ─── Sync ──────────────────────────────────────────────────────
    if (cmd === 'sync') {
        const names = Object.keys(charactersModule.getAll());
        if (names.length === 0) return 'No characters to sync.';
        let synced = 0;
        for (const name of names) {
            try {
                const data = await context.apiRequest('GET', ['characters', encodeURIComponent(name)]);
                if (data && typeof data === 'object') {
                    const char = charactersModule.get(name);
                    if (data.harm !== undefined) char.harm = data.harm;
                    if (data.fatigue !== undefined) char.fatigue = data.fatigue;
                    if (data.obligation !== undefined) char.obligation = data.obligation;
                    if (data.boons !== undefined) char.boons = data.boons;
                    if (data.leash !== undefined) char.leash = data.leash;
                    if (data.corruption !== undefined) char.corruption = data.corruption;
                    if (data.attributes) char.attributes = { ...char.attributes, ...data.attributes };
                    if (data.skills) char.skills = { ...char.skills, ...data.skills };
                    if (data.talents) char.talents = data.talents;
                    if (data.bonds) char.bonds = data.bonds;
                    if (data.complications) char.complications = data.complications;
                    if (data.assets) char.assets = data.assets;
                    if (data.followers) char.followers = data.followers;
                    if (data.tier !== undefined) char.tier = data.tier;
                    if (data.xp !== undefined) char.xp = data.xp;
                    synced++;
                }
            } catch (e) {
                console.warn(`Failed to sync ${name}: ${e.message}`);
            }
        }
        await saveCampaign();
        return `Synced ${synced} characters from server.`;
    }

    // ─── Export global characters ──────────────────────────────────
    if (cmd === 'export-characters') {
        if (context.myRole !== 'gm') return 'Only the GM can export characters.';
        try {
            const data = await globalApiRequest('/characters/export');
            if (!data || !data.rooms) return 'No global character data found.';
            let result = '🌍 **Global Character Roster:**\n';
            for (const [room, roomData] of Object.entries(data.rooms)) {
                const chars = roomData.characters || {};
                const count = Object.keys(chars).length;
                result += `\n📁 **${room}**: ${count} character${count > 1 ? 's' : ''}`;
                const entries = Object.entries(chars).slice(0, 5);
                for (const [name, stats] of entries) {
                    result += `\n  - **${name}**: H${stats.harm || 0} F${stats.fatigue || 0} B${stats.boons || 0}`;
                }
                if (count > 5) result += `\n  - ... and ${count - 5} more`;
            }
            return result;
        } catch (e) {
            return `Export failed: ${e.message}`;
        }
    }

    // ─── Sync all characters from all rooms ──────────────────────
    if (cmd === 'sync-all') {
        if (context.myRole !== 'gm') return 'Only the GM can sync all rooms.';
        try {
            const data = await globalApiRequest('/characters/export');
            if (!data || !data.rooms) return 'No global character data found.';
            let total = 0;
            for (const [room, roomData] of Object.entries(data.rooms)) {
                const chars = roomData.characters || {};
                for (const [name, stats] of Object.entries(chars)) {
                    const char = charactersModule.get(name);
                    if (stats.harm !== undefined) char.harm = stats.harm;
                    if (stats.fatigue !== undefined) char.fatigue = stats.fatigue;
                    if (stats.obligation !== undefined) char.obligation = stats.obligation;
                    if (stats.boons !== undefined) char.boons = stats.boons;
                    if (stats.leash !== undefined) char.leash = stats.leash;
                    if (stats.corruption !== undefined) char.corruption = stats.corruption;
                    total++;
                }
            }
            await saveCampaign();
            return `Synced ${total} characters from all rooms.`;
        } catch (e) {
            return `Sync-all failed: ${e.message}`;
        }
    }

    // ─── Room state ─────────────────────────────────────────────────
    // CHANGED: this used to call context.apiRequest('GET', ['state']),
    // i.e. GET /api/rooms/:code/state -- a route that doesn't exist
    // anywhere in server/api.js. Every call fell through to the
    // server's catch-all and came back as an HTML page, which then
    // failed JSON parsing with the cryptic "Unexpected token '<'" error.
    // The fields this command actually wants (location, position,
    // effect, defaultDV, timers, npcs) are an exact match for the BOT'S
    // OWN local campaignState.scene (see gm-orchestrator.js's
    // _defaultCampaignState()) -- this was never server data, it's
    // right here in memory. No network call needed at all.
    if (cmd === 'room-state') {
        if (context.myRole !== 'gm') return 'Only the GM can view room state.';
        const scene = campaignState.scene || {};
        let result = '🏠 **Room State:**\n';
        result += `Location: ${scene.location || 'unknown'}\n`;
        result += `Position: ${scene.position || 'Controlled'}\n`;
        result += `Effect: ${scene.effect || 'Standard'}\n`;
        result += `Default DV: ${scene.defaultDV || 3}\n`;
        const sceneTimers = scene.timers || [];
        if (sceneTimers.length > 0) {
            result += `Timers:\n`;
            for (const timer of sceneTimers) {
                result += `  - ${timer.name}: ${timer.current}/${timer.max}\n`;
            }
        } else {
            result += 'Timers: None\n';
        }
        const sceneNpcs = scene.npcs || [];
        if (sceneNpcs.length > 0) {
            // npcs may be plain name strings or full NPC objects (see
            // generateNPC() in gm-orchestrator.js) -- handle both.
            const npcNames = sceneNpcs.map(n => (typeof n === 'string' ? n : (n?.name || 'Unknown')));
            result += `NPCs: ${npcNames.join(', ')}\n`;
        }
        return result;
    }

    // ─── setattr ────────────────────────────────────────────────────
    if (cmd === 'setattr') {
        const name = args[0];
        const attr = args[1];
        const value = parseInt(args[2]);
        if (!name || !attr || isNaN(value)) return 'Usage: !gm setattr <name> <attribute> <value>';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        char.attributes[attr] = value;
        try {
            const updates = { [name]: { attributes: char.attributes } };
            await context.apiRequest('POST', ['characters', 'update'], { updates });
        } catch (e) { /* ignore */ }
        await saveCampaign();
        return `${name}'s ${attr} set to ${value}`;
    }

    // ─── setskill ──────────────────────────────────────────────────
    if (cmd === 'setskill') {
        const name = args[0];
        const skill = args[1];
        const value = parseInt(args[2]);
        if (!name || !skill || isNaN(value)) return 'Usage: !gm setskill <name> <skill> <value>';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        char.skills[skill] = value;
        try {
            const updates = { [name]: { skills: char.skills } };
            await context.apiRequest('POST', ['characters', 'update'], { updates });
        } catch (e) { /* ignore */ }
        await saveCampaign();
        return `${name}'s ${skill} set to ${value}`;
    }

    // ─── addtalent ──────────────────────────────────────────────────
    if (cmd === 'addtalent') {
        const name = args[0];
        const talent = args.slice(1).join(' ');
        if (!name || !talent) return 'Usage: !gm addtalent <name> <talent name>';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        char.talents.push(talent);
        try {
            const updates = { [name]: { talents: char.talents } };
            await context.apiRequest('POST', ['characters', 'update'], { updates });
        } catch (e) { /* ignore */ }
        await saveCampaign();
        return `Added talent "${talent}" to ${name}`;
    }

    // ─── bond ──────────────────────────────────────────────────────
    if (cmd === 'bond') {
        const name = args[0];
        const target = args[1];
        const desc = args.slice(2).join(' ');
        if (!name || !target || !desc) return 'Usage: !gm bond <name> <target> "<description>"';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        char.bonds.push({ target, description: desc });
        try {
            const updates = { [name]: { bonds: char.bonds } };
            await context.apiRequest('POST', ['characters', 'update'], { updates });
        } catch (e) { /* ignore */ }
        await saveCampaign();
        return `Added bond: ${name} → ${target} (${desc})`;
    }

    // ─── complication ──────────────────────────────────────────────
    if (cmd === 'complication') {
        const name = args[0];
        const desc = args.slice(1).join(' ');
        if (!name || !desc) return 'Usage: !gm complication <name> "<description>"';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        char.complications.push(desc);
        try {
            const updates = { [name]: { complications: char.complications } };
            await context.apiRequest('POST', ['characters', 'update'], { updates });
        } catch (e) { /* ignore */ }
        await saveCampaign();
        return `Added complication to ${name}: ${desc}`;
    }

    // ─── asset ──────────────────────────────────────────────────────
    if (cmd === 'asset') {
        const name = args[0];
        const action = args[1];
        const assetName = args.slice(2).join(' ');
        if (!name || !action || !assetName) return 'Usage: !gm asset <name> add/remove <asset name>';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        if (action === 'add') {
            char.assets.push(assetName);
            try {
                const updates = { [name]: { assets: char.assets } };
                await context.apiRequest('POST', ['characters', 'update'], { updates });
            } catch (e) { /* ignore */ }
            await saveCampaign();
            return `Added asset "${assetName}" to ${name}`;
        } else if (action === 'remove') {
            char.assets = char.assets.filter(a => a !== assetName);
            try {
                const updates = { [name]: { assets: char.assets } };
                await context.apiRequest('POST', ['characters', 'update'], { updates });
            } catch (e) { /* ignore */ }
            await saveCampaign();
            return `Removed asset "${assetName}" from ${name}`;
        } else {
            return 'Invalid action. Use add or remove.';
        }
    }

    // ─── follower ──────────────────────────────────────────────────
    if (cmd === 'follower') {
        const name = args[0];
        const action = args[1];
        const followerName = args[2];
        const cap = parseInt(args[3]) || 1;
        if (!name || !action || !followerName) return 'Usage: !gm follower <name> add/remove <follower name> [cap]';
        await ensureCharacterOnServer(name, context);
        const char = charactersModule.get(name);
        if (action === 'add') {
            char.followers.push({ name: followerName, cap, loyalty: 'Faithful', fitness: 'Ready' });
            try {
                const updates = { [name]: { followers: char.followers } };
                await context.apiRequest('POST', ['characters', 'update'], { updates });
            } catch (e) { /* ignore */ }
            await saveCampaign();
            return `Added follower "${followerName}" (Cap ${cap}) to ${name}`;
        } else if (action === 'remove') {
            char.followers = char.followers.filter(f => f.name !== followerName);
            try {
                const updates = { [name]: { followers: char.followers } };
                await context.apiRequest('POST', ['characters', 'update'], { updates });
            } catch (e) { /* ignore */ }
            await saveCampaign();
            return `Removed follower "${followerName}" from ${name}`;
        } else {
            return 'Invalid action. Use add or remove.';
        }
    }

    // ─── Timer management (LOCAL orchestrator timers -- see note in
    // processSpecialTags below about how these differ from the server
    // adventure engine's scene/campaign timers) ────────────────────
    if (cmd === 'timer') {
        const sub = args[0];
        if (sub === 'add') {
            const name = args[1];
            const max = parseInt(args[2]);
            const onFill = args.slice(3).join(' ') || 'Timer fills.';
            if (!name || isNaN(max)) return 'Usage: !gm timer add <name> <segments> [onFill]';
            timersModule.addTimer(campaignState, name, max, onFill);
            await saveCampaign();
            return `Timer "${name}" added with ${max} segments.`;
        } else if (sub === 'tick') {
            const name = args[1];
            const ticks = parseInt(args[2]) || 1;
            if (!name) return 'Usage: !gm timer tick <name> [ticks]';
            const filled = timersModule.tickTimer(campaignState, name, ticks);
            if (filled) {
                const event = timersModule.resolveTimer(campaignState, name);
                await saveCampaign();
                return `Timer "${name}" filled! ${event}`;
            } else {
                const timer = campaignState.scene.timers.find(t => t.name === name);
                await saveCampaign();
                return `Timer "${name}" advanced to ${timer.current}/${timer.max}`;
            }
        } else if (sub === 'remove') {
            const name = args[1];
            if (!name) return 'Usage: !gm timer remove <name>';
            const idx = campaignState.scene.timers.findIndex(t => t.name === name);
            if (idx !== -1) {
                campaignState.scene.timers.splice(idx, 1);
                await saveCampaign();
                return `Timer "${name}" removed.`;
            } else {
                return `Timer "${name}" not found.`;
            }
        } else {
            return 'Usage: !gm timer add/tick/remove <name> [segments] [onFill]';
        }
    }

    // ─── Fact ──────────────────────────────────────────────────────
    if (cmd === 'fact') {
        const key = args[0];
        const value = args.slice(1).join(' ');
        if (!key || !value) return 'Usage: !gm fact <key> <value>';
        campaignState.facts[key] = value;
        await saveCampaign();
        // Fire-and-forget: indexes into Elasticsearch if configured (see
        // modules/knowledge-index.js), no-ops silently otherwise. Doesn't
        // block the command response either way.
        knowledgeIndex.indexFact(context.orchestrator?.campaign?.campaignCode, key, value).catch(() => {});
        return `Fact updated: ${key} = ${value}`;
    }

    // ─── Assistant GM suggestion queue ───────────────────────────────
    // Only meaningful while this bot holds the 'assistant-gm' role (see
    // processSpecialTags()'s isAssistant branches above and the "Assistant
    // GM Mode" section of the README) -- that's when narrative-authority
    // tags get held here instead of applied immediately. The same queue is
    // also visible (with clickable Approve/Reject) on the status dashboard;
    // these commands are the chat-native equivalent for tables that live in
    // chat rather than the dashboard.
    if (cmd === 'suggestions') {
        if (context.myRole !== 'assistant-gm') return 'I only hold pending suggestions while I\'m the Assistant GM.';
        const pending = assistantSuggestions.list();
        if (!pending.length) return 'No pending suggestions.';
        return '📋 Pending suggestions:\n' + pending.map(s => `- \`${s.id}\` [${s.kind}] ${s.label}`).join('\n') +
            '\n\nUse `!gm approve <id>` or `!gm reject <id>`.';
    }
    if (cmd === 'approve') {
        if (context.myRole !== 'assistant-gm') return 'I only hold pending suggestions while I\'m the Assistant GM.';
        const id = args[0];
        if (!id) return 'Usage: !gm approve <id> — see `!gm suggestions` for pending ids.';
        const { ok, result, error } = await assistantSuggestions.approve(id);
        if (!ok) return `❌ ${error}`;
        await saveCampaign();
        return (typeof result === 'string' && result) ? `✅ Approved.\n${result}` : '✅ Approved.';
    }
    if (cmd === 'reject') {
        if (context.myRole !== 'assistant-gm') return 'I only hold pending suggestions while I\'m the Assistant GM.';
        const id = args[0];
        if (!id) return 'Usage: !gm reject <id> — see `!gm suggestions` for pending ids.';
        const { ok, error } = assistantSuggestions.reject(id);
        return ok ? '🗑️ Suggestion rejected.' : `❌ ${error}`;
    }

    // ─── Confirm takeover (Assistant GM → full GM) ───────────────────
    // The one path by which Assistant GM mode ever takes the full GM
    // seat -- see ai-gm-bot.js's startGmTakeoverTimer(), which prompts
    // for this instead of silently requesting the seat the way an
    // ordinary player-role bot's takeover timer does. Anyone in the room
    // can confirm; the actual grant still goes through the server's
    // normal request_gm/approve_gm flow (nothing here bypasses that).
    if (cmd === 'confirm-takeover') {
        if (context.myRole !== 'assistant-gm') return 'I\'m not in Assistant GM mode, so there\'s nothing to confirm.';
        if (!ws) return '❌ No connection available to request the GM seat.';
        ws.send(JSON.stringify({ type: 'request_gm' }));
        return '👑 Requesting the GM seat…';
    }

    // ─── Recall ────────────────────────────────────────────────────
    // Operator/player-facing manual search over the long-term knowledge
    // index (Elasticsearch, optional -- see modules/knowledge-index.js).
    // "Who knows about the well?" / "where does Kestrel live?" without
    // needing the model to happen to still hold it in context. The same
    // search also runs automatically every turn (see ai-gm-bot.js's
    // handleMessage()) to feed the LLM's own prompt; this is the direct,
    // no-LLM-involved version for a human to check the same index.
    if (cmd === 'recall') {
        const query = args.join(' ').trim();
        if (!query) return 'Usage: !gm recall <query>';
        if (!knowledgeIndex.isEnabled()) {
            return '❌ Recall requires Elasticsearch (set ES_URL) -- see README "Long-Term Memory".';
        }
        const hits = await knowledgeIndex.search(context.orchestrator.campaign.campaignCode, query, { size: 5 });
        if (!hits.length) return `No memory matches for "${query}".`;
        return `🔎 Memory matches for "${query}":\n` + hits.map(h => `- [${h.type}] ${h.text}`).join('\n');
    }

    // ─── SB ────────────────────────────────────────────────────────
    if (cmd === 'sb') {
        return `Current Story Beat pool: ${campaignState.sb || 0}`;
    }

    // ─── Position ──────────────────────────────────────────────────
    if (cmd === 'position' && args[0] === 'set') {
        const pos = args[1];
        if (!['Dominant', 'Controlled', 'Desperate'].includes(pos)) return 'Invalid position. Use Dominant, Controlled, or Desperate.';
        campaignState.scene.position = pos;
        await saveCampaign();
        return `Scene Position set to ${pos}.`;
    }

    // ─── DV ────────────────────────────────────────────────────────
    if (cmd === 'dv' && args[0] === 'set') {
        const dv = parseInt(args[1]);
        if (isNaN(dv)) return 'Usage: !gm dv set <number>';
        campaignState.scene.defaultDV = dv;
        await saveCampaign();
        return `Default DV set to ${dv}.`;
    }

    // ─── Upload ────────────────────────────────────────────────────
    if (cmd === 'upload') {
        if (context.apiRequest) {
            try {
                const data = await context.apiRequest('POST', ['campaigns'], campaignState);
                return `Campaign uploaded! Share code: ${data.code}`;
            } catch (e) {
                return `Upload failed: ${e.message}`;
            }
        } else {
            return 'Upload not supported.';
        }
    }

    // ─── Load ──────────────────────────────────────────────────────
    if (cmd === 'load') {
        const code = args[0];
        if (!code) return 'Usage: !gm load <code>';
        if (context.apiRequest) {
            try {
                // SECURITY: encode the user-supplied code before it becomes
                // a URL path segment, same as every other user-supplied
                // identifier passed to apiRequest() elsewhere in this file
                // (e.g. character names). Without this, a code containing
                // "/" or other path-meaningful characters could alter which
                // API route the request actually hits.
                const data = await context.apiRequest('GET', ['campaigns', encodeURIComponent(code)]);
                Object.assign(campaignState, data);
                await saveCampaign();
                return `Campaign ${code} loaded!`;
            } catch (e) {
                return `Load failed: ${e.message}`;
            }
        } else {
            return 'Load not supported.';
        }
    }

    // ─── Etiquette ──────────────────────────────────────────────────
    if (cmd === 'etiquette') {
        return generateEtiquetteReminder();
    }

    // ─── Region ────────────────────────────────────────────────────
    if (cmd === 'region') {
        if (args.length > 0 && args[0] === 'set') {
            const region = args.slice(1).join(' ');
            if (!region) return 'Usage: !gm region set <name>';
            if (context.ws && context.ws.readyState === WebSocket.OPEN) {
                context.ws.send(JSON.stringify({ type: 'set-region', region }));
                campaignState.scene.region = region;
                await saveCampaign();
                return `📍 Region set to: ${region}`;
            } else {
                return '❌ WebSocket not available.';
            }
        }

        // NEW: `!gm region list` — every loaded region, `ls`-style multi-
        // column layout since there are 20+ of them and a one-per-line
        // list runs off the screen. Reads straight from WorldManager's
        // in-memory region set (see world-manager.js loadAll()), which is
        // the same 23-region data/regions/*.json set the deck/Crown
        // Spread system actually uses -- not a separately-maintained list
        // that can drift out of sync.
        if (args.length > 0 && (args[0] === 'list' || args[0] === 'ls')) {
            const regions = context.orchestrator?.world?.listRegions() || [];
            if (regions.length === 0) return '📍 No regions loaded.';
            const lines = formatColumns(regions.map(r => shortTitle(r.title)), { width: 60, maxCols: 4 });
            return `📍 **Regions (${regions.length}):**\n\`\`\`\n${lines}\n\`\`\`\nUse \`!gm region set <name>\` to switch, or \`!gm adventure crown\` to draw a Crown Spread from one.`;
        }

        // BUGFIX: this used to read regionData.name/.description/.genre,
        // but region JSON files store the display name under `title`
        // (e.g. "Acasia — Broken Marches") and the blurb/genre under
        // `overview.tagline`/`overview.genre` — .name/.description/.genre
        // don't exist at the top level, so this always silently rendered
        // just the raw slug with two blank lines beneath it.
        const region = campaignState.scene?.region || context.orchestrator?.options?.defaultRegion || 'unknown';
        const regionData = context.orchestrator?.world?.getRegion(region);
        if (regionData) {
            const title = regionData.title || regionData.label || region;
            const tagline = regionData.overview?.tagline || '';
            const genre = regionData.overview?.genre || '';
            return `📍 **Region:** ${title}\n${tagline}${genre ? `\nGenre: ${genre}` : ''}`;
        } else {
            return `📍 Current region: ${region} (no detailed data available — try \`!gm region list\`)`;
        }
    }

    // ─── Travel ────────────────────────────────────────────────────
    if (cmd === 'travel') {
        return await travelModule.handleTravelCommand(sender, args, context);
    }

    // ─── Seed ──────────────────────────────────────────────────────
    if (cmd === 'seed') {
        if (context.myRole !== 'gm') return 'Only the GM can seed the campaign.';
        if (context.seedCampaign) {
            context.seedCampaign();
            return '🌱 Seeding campaign with a Crown Spread...';
        } else {
            return '❌ Seed function not available.';
        }
    }

    // ─── Spell lookup ──────────────────────────────────────────────
    if (cmd === 'spell') {
        const name = args.join(' ');
        if (!name) return 'Usage: !gm spell <name> (e.g., !gm spell "Light")';
        const spell = context.orchestrator.world.getSpell(name);
        if (!spell) return `No spell found for "${name}". Use !gm spells to list all spells.`;
        let result = `📜 **${spell.name || name}**\n`;
        if (spell.tags && spell.tags.length) result += `Tags: ${spell.tags.join(', ')}\n`;
        result += `DV: ${spell.dv || '?'}\n`;
        result += `Effect: ${spell.effect || 'No effect description.'}\n`;
        if (spell.notes) result += `Notes: ${spell.notes}\n`;
        return result;
    }

    // ─── List spells ──────────────────────────────────────────────
    if (cmd === 'spells') {
        const allSpells = context.orchestrator.world.listSpells();
        if (allSpells.length === 0) return 'No spells loaded.';
        const names = allSpells.map(s => s.name || s.id || 'Unnamed').sort();
        let result = '📚 **Available Spells**\n';
        let currentLetter = '';
        for (const name of names) {
            const first = name.charAt(0).toUpperCase();
            if (first !== currentLetter) {
                currentLetter = first;
                result += `\n**${currentLetter}**\n`;
            }
            result += `• ${name}\n`;
        }
        return result;
    }

    // ─── Encounter start/status ──────────────────────────────────
    // NEW: minimal manual counterpart to the AI's [ENCOUNTER START ...]
    // tag (see processSpecialTags below) -- lets a human GM kick off an
    // ad-hoc encounter and (optionally) tag its type, same
    // POST /api/rooms/:code/adventure/encounter/start route the tag uses.
    // `type` defaults to 'combat' when omitted -- exactly current
    // behavior for any pre-existing data/callers with no type field.
    if (cmd === 'encounter') {
        if (context.myRole !== 'gm') return 'Only the GM can manage encounters.';
        const sub = (args[0] || '').toLowerCase();

        if (sub === 'start') {
            const rest = text.slice(text.toLowerCase().indexOf('start') + 'start'.length).trim();
            const quotedMatch = rest.match(/"([^"]+)"\s*(\S+)?/);
            let name, type;
            if (quotedMatch) {
                name = quotedMatch[1];
                type = quotedMatch[2];
            } else {
                const parts = rest.split(/\s+/).filter(Boolean);
                type = parts.length > 1 ? parts[parts.length - 1] : undefined;
                name = (type ? parts.slice(0, -1) : parts).join(' ');
            }
            if (!name) return 'Usage: !gm encounter start "<name>" [type]';
            const encType = encounterType({ type });
            try {
                const result = await context.apiRequest('POST', ['adventure', 'encounter', 'start'], {
                    encounter: { name, type: encType },
                });
                const vocab = getVocab(encType);
                return `${encounterIcon(encType)} Encounter "${name}" (${vocab.label}) begins.${result?.activeEncounter?.dv ? ` DV ${result.activeEncounter.dv}.` : ''}`;
            } catch (e) {
                return `Failed to start encounter: ${e.message}`;
            }
        }

        if (sub === 'status') {
            try {
                const state = await context.apiRequest('GET', ['adventure']);
                if (!state?.activeEncounter) return 'No active encounter.';
                const enc = state.activeEncounter;
                const encType = encounterType(enc);
                const vocab = getVocab(encType, enc);
                return `${encounterIcon(encType)} **${enc.name || enc.creatureId}** (${vocab.label}) -- DV ${enc.dv ?? '?'}, ${enc.position || 'Controlled'}.`;
            } catch (e) {
                return `Encounter status failed: ${e.message}`;
            }
        }

        return 'Usage: !gm encounter start "<name>" [type]\n       !gm encounter status';
    }

    // ─── NPC actions ──────────────────────────────────────────────
    if (cmd === 'npc') {
        if (context.myRole !== 'gm') return 'Only the GM can command NPCs.';
        const sub = args[0];

        // NEW: !gm npc create "Name" ["Role"] ["Motivation"] -- manual
        // variant of the [NPC CREATE ...] tag the AI emits automatically;
        // useful if a human GM wants to register an ad-hoc NPC by hand.
        // Registers into the currently loaded adventure's own npcs[] so
        // it's a real, trackable NPC from here on (see server/adventure.js
        // addNpc()), not disposable narration.
        if (sub === 'create') {
            const rest = text.slice(text.toLowerCase().indexOf('create') + 'create'.length);
            const quoted = [...rest.matchAll(/"([^"]*)"/g)].map(m => m[1]);
            if (quoted.length < 1) return 'Usage: !gm npc create "Name" ["Role"] ["Motivation"]';
            const [name, role, motivation] = quoted;
            try {
                await context.apiRequest('POST', ['adventure', 'npc'], { npc: { name, role: role || 'NPC', motivation: motivation || '' } });
                return `✅ "${name}"${role ? ` (${role})` : ''} is now a recognized part of this adventure.`;
            } catch (e) {
                return `Failed to register NPC: ${e.message}`;
            }
        }

        const npcName = args[1];
        const target = args[2];
        const extra = args.slice(3).join(' ');

        if (!sub || !npcName || !target) {
            return 'Usage: !gm npc attack <npc> <target> [harm]\n' +
                   '       !gm npc social <npc> <target> <tactic>\n' +
                   '       !gm npc spell <npc> <target> <spell>\n' +
                   '       !gm npc create "Name" ["Role"] ["Motivation"]';
        }

        let options = {};
        switch (sub) {
            case 'attack': {
                const harm = parseInt(extra) || 1;
                options = { harm, cost: 2 };
                return await resolveNPCAction('attack', npcName, target, context, options);
            }
            case 'social': {
                const tactic = extra || 'intimidate';
                options = { tactic, cost: 2 };
                return await resolveNPCAction('social', npcName, target, context, options);
            }
            case 'spell': {
                const spellName = extra;
                if (!spellName) return 'Usage: !gm npc spell <npc> <target> <spell>';
                options = { spell: spellName };
                return await resolveNPCAction('spell', npcName, target, context, options);
            }
            default:
                return 'Unknown NPC action. Use attack, social, or spell.';
        }
    }

    // ─── Knowledge state (manual GM control over module.knowledge[]) ──
    // Human-GM equivalent of the AI's [REVEAL "id"]/[HIDE "id"] tags --
    // see adventure-context.js's KNOWLEDGE STATE section for the full
    // design and server/adventure.js's revealKnowledge()/hideKnowledge()
    // for the underlying state mutation. GM-only: this is exactly the
    // "what am I allowed to tell the players?" gate, so only the GM
    // (human or the bot acting as full GM, never a player) should flip it
    // directly -- the AI still goes through [REVEAL ...] like everyone
    // else, subject to the same Assistant GM suggestion-queue gating as
    // [FACT ...]/[NPC CREATE ...].
    if (cmd === 'knowledge') {
        if (context.myRole !== 'gm') return 'Only the GM can view or change knowledge state.';
        const sub = (args[0] || '').toLowerCase();

        if (!sub || sub === 'list' || sub === 'status') {
            let ref;
            try {
                ref = await context.apiRequest('GET', ['adventure', 'reference']);
            } catch (e) {
                return `Failed to fetch knowledge state: ${e.message}`;
            }
            const list = ref?.knowledge || [];
            if (list.length === 0) return 'This adventure defines no `knowledge` entries (or none is loaded).';
            const lines = list.map(k =>
                `${k.revealed ? '🔓' : '🔒'} \`${k.id}\`${k.subject ? ` (${k.subject})` : ''} — ${k.revealed ? 'REVEALED' : 'secret'}: ${k.revealed ? k.gm : (k.player ?? '(nothing to tell yet)')}`
            );
            return '📖 **Knowledge State**\n' + lines.join('\n') +
                '\n\nUse `!gm knowledge reveal <id>` / `!gm knowledge hide <id>` to change one.';
        }

        if (sub === 'reveal' || sub === 'hide') {
            const id = args[1];
            if (!id) return `Usage: !gm knowledge ${sub} <id>`;
            try {
                await context.apiRequest('POST', ['adventure', 'knowledge', sub], { id, by: sender || 'GM' });
                adventureContext.invalidate();
                return sub === 'reveal'
                    ? `🔓 Revealed knowledge entry \`${id}\`. The AI GM (if running) will now treat it as safe to share.`
                    : `🔒 Hid knowledge entry \`${id}\` again.`;
            } catch (e) {
                return `Failed to ${sub} "${id}": ${e.message}`;
            }
        }

        return 'Usage: !gm knowledge [list] | !gm knowledge reveal <id> | !gm knowledge hide <id>';
    }

    // ─── Enemy Turn ────────────────────────────────────────────────
    if (cmd === 'enemy-turn') {
        if (context.myRole !== 'gm') return 'Only the GM can run enemy turns.';
        if (!campaignState.timers) campaignState.timers = {};
        if (!campaignState.timers['Enemy Turn']) {
            campaignState.timers['Enemy Turn'] = { segments: 4, current: 0 };
        }
        const timer = campaignState.timers['Enemy Turn'];
        timer.current += 1;
        let result = `⏰ Enemy Turn advanced to ${timer.current}/${timer.segments}.`;
        if (timer.current >= timer.segments) {
            timer.current = 0;
            result += ` Enemy acts! Spend SB to use !gm npc attack/social/spell.`;
        }
        await saveCampaign();
        return result;
    }

    // ─── Deck commands (via WebSocket) ─────────────────────────────
    if (cmd === 'deck') {
        if (context.myRole !== 'gm') return 'Only the GM can use deck commands.';
        const sub = args[0]?.toLowerCase();
        const param1 = args[1];
        const param2 = args[2];
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return '❌ WebSocket not connected. Deck commands unavailable.';
        }
        switch (sub) {
            case 'draw': {
                const count = Math.min(parseInt(param1) || 1, 5);
                const region = param2 || campaignState.scene?.region || 'Acasia';
                ws.send(JSON.stringify({ type: 'deck-draw', count, region }));
                return `🃏 Requested draw of ${count} card(s) from ${region}.`;
            }
            case 'shuffle': {
                ws.send(JSON.stringify({ type: 'deck-shuffle' }));
                return '🔀 Deck shuffle requested.';
            }
            case 'crown': {
                const region = param1 || campaignState.scene?.region || 'Acasia';
                ws.send(JSON.stringify({ type: 'crown-spread', region }));
                return `👑 Crown Spread requested from ${region}.`;
            }
            case 'history': {
                ws.send(JSON.stringify({ type: 'deck-history' }));
                return '📜 Deck history requested.';
            }
            default:
                return 'Usage: !gm deck draw [count] [region]\n       !gm deck shuffle\n       !gm deck crown [region]\n       !gm deck history';
        }
    }

    // ─── Whiteboard ────────────────────────────────────────────────
    if (cmd === 'whiteboard') {
        if (context.myRole !== 'gm') return 'Only the GM can view whiteboard status.';
        try {
            const data = await context.apiRequest('GET', ['whiteboard']);
            if (!data) return 'No whiteboard data.';
            let result = '📋 **Whiteboard Summary**\n';
            result += `Drawings: ${data.drawings?.length || 0}\n`;
            result += `Notes: ${data.notes?.length || 0}\n`;
            result += `Images: ${data.images?.length || 0}\n`;
            if (data.gridCombat) {
                const gc = data.gridCombat;
                result += `Grid Combat: ${gc.enabled ? '✅ Active' : '❌ Inactive'}\n`;
                if (gc.enabled) {
                    result += `  Grid Type: ${gc.gridType || 'square'}\n`;
                    result += `  Cell Size: ${gc.cellSize || 40}\n`;
                    result += `  Tokens: ${gc.tokens?.length || 0}\n`;
                }
            }
            return result;
        } catch (e) {
            return `Whiteboard status failed: ${e.message}`;
        }
    }

    // ─── Grid Combat ──────────────────────────────────────────────
    if (cmd === 'grid') {
        if (context.myRole !== 'gm') return 'Only the GM can view grid status.';
        try {
            const data = await context.apiRequest('GET', ['whiteboard']);
            if (!data || !data.gridCombat) return 'No grid combat data.';
            const gc = data.gridCombat;
            let result = '⚔️ **Grid Combat Status**\n';
            result += `Enabled: ${gc.enabled ? '✅' : '❌'}\n`;
            if (gc.enabled) {
                result += `Grid Type: ${gc.gridType || 'square'}\n`;
                result += `Cell Size: ${gc.cellSize || 40}\n`;
                result += `Tokens: ${gc.tokens?.length || 0}\n`;
                if (gc.tokens && gc.tokens.length) {
                    // CHANGED: was `t.name`, which tokens don't have (the
                    // field is `label` -- see room.js's default token shape
                    // and placeOrUpdateToken() above) -- every token printed
                    // as "undefined". Also show grid cell instead of raw
                    // pixel x/y, since that's what a human or the AI would
                    // actually reference (e.g. via !gm token move).
                    const cellSize = gc.cellSize || 40;
                    const tokenList = gc.tokens
                        .map(t => `${t.label || t.id} [${t.faction || '?'}] (${Math.round((t.x||0)/cellSize)},${Math.round((t.y||0)/cellSize)})`)
                        .join(', ');
                    result += `  Tokens: ${tokenList}\n`;
                }
            }
            return result;
        } catch (e) {
            return `Grid status failed: ${e.message}`;
        }
    }

    // ─── Manual token control (place / move / remove) ──────────────
    // Mirrors the [TOKEN MOVE ...]/[TOKEN REMOVE ...] tags and NPC-create
    // auto-placement above, but for a human GM (or the AI, via a plain
    // !gm command instead of an inline tag) driving it directly.
    if (cmd === 'token') {
        if (context.myRole !== 'gm') return 'Only the GM can control tokens.';
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'place' || sub === 'add') {
            const name = args[1];
            const col = parseInt(args[2], 10);
            const row = parseInt(args[3], 10);
            const faction = (args[4] || 'enemy').toLowerCase();
            if (!name || !Number.isFinite(col) || !Number.isFinite(row)) {
                return 'Usage: !gm token place <name> <col> <row> [ally|enemy]';
            }
            const result = await placeOrUpdateToken(context, { name, faction, col, row });
            return result ? `📍 Placed "${name}" at (${col},${row}).` : `❌ Failed to place token for "${name}".`;
        }
        if (sub === 'move') {
            const name = args[1];
            const col = parseInt(args[2], 10);
            const row = parseInt(args[3], 10);
            if (!name || !Number.isFinite(col) || !Number.isFinite(row)) {
                return 'Usage: !gm token move <name> <col> <row>';
            }
            const result = await moveToken(context, name, col, row);
            return result ? `📍 Moved "${name}" to (${col},${row}).` : `❌ Failed to move token "${name}" (does it exist?).`;
        }
        if (sub === 'remove' || sub === 'delete') {
            const name = args[1];
            if (!name) return 'Usage: !gm token remove <name>';
            await removeToken(context, name);
            return `🗑️ Removed token "${name}" (if it existed).`;
        }
        if (sub === 'clear') {
            await clearEnemyTokens(context);
            return '🗑️ Cleared all enemy tokens.';
        }
        return 'Usage: !gm token place <name> <col> <row> [ally|enemy]\n       !gm token move <name> <col> <row>\n       !gm token remove <name>\n       !gm token clear';
    }

    // ─── Modules ──────────────────────────────────────────────────
    if (cmd === 'modules') {
        if (context.myRole !== 'gm') return 'Only the GM can list modules.';
        try {
            const data = await context.apiRequest('GET', ['modules']);
            if (!data || !data.modules) return 'No module data.';
            const modules = data.modules;
            if (modules.length === 0) return '📦 No modules loaded.';
            let result = '📦 **Loaded Modules**\n';
            modules.forEach(m => {
                result += `• ${m.name || m.id} v${m.version || '1.0.0'}\n`;
                if (m.description) result += `  ${m.description}\n`;
            });
            return result;
        } catch (e) {
            return `Modules list failed: ${e.message}`;
        }
    }

    return 'Unknown command. Try !gm help';
}

// ─── Fuzzy tag repair ────────────────────────────────────────────────
// The tag regexes below (rollRegex, applyRegex, tickRegex, ...) expect
// the model to emit tags in an exact shape: canonical-case keyword right
// after "[", no stray whitespace inside a roll pool expression, and a
// balanced closing quote + "]". Real model output drifts from that
// constantly, e.g.:
//   [ROLL "Asadef" Wits + Stealth DV 3 Controlled]   (spaces around +)
//   [Roll "Asadef" Wits+Stealth DV 3 Controlled]      (wrong case)
//   [ROLL "Asadef Wits+Stealth DV 3 Controlled       (dropped quote/bracket)
// A tag that doesn't match its regex exactly doesn't error -- it just
// silently fails to match, and the raw bracket text leaks into the chat
// unresolved. repairAITagSyntax() runs once, before any of the specific
// tag regexes, and normalizes these drift patterns into the exact shape
// those regexes expect. It's deliberately conservative: it only touches
// spans that open with "[" followed by one of the known tag keywords
// (case-insensitively), so ordinary bracketed prose/OOC asides in the
// model's narration are left untouched.

// Longest-first so a compound keyword ("TICK TIMER", "ENCOUNTER START")
// is recognized as itself rather than accidentally matched against a
// shorter keyword that happens to be a prefix-adjacent word (not
// currently possible given the literal-anchored matching below, but
// kept in this order for clarity/safety if more keywords are added).
const AI_TAG_KEYWORDS = [
    'ENCOUNTER START', 'ENCOUNTER RESOLVE', 'SCENE COMPLETE',
    'CALL FOR ROLL',
    'LOOKUP RULE', 'SET POSITION', 'SET DV', 'TICK TIMER',
    'NPC CAST', 'NPC CREATE', 'NPC LOCATION',
    'TOKEN MOVE', 'TOKEN REMOVE', 'SPEND SB',
    'APPLY', 'ADD', 'ROLL', 'TIMER', 'DRAW', 'CROWN', 'FACT',
    'REVEAL', 'HIDE',
].sort((a, b) => b.length - a.length);

// 1) Case repair: force the leading keyword of any recognized tag to
// its canonical uppercase form, wherever it appears with the wrong
// case or irregular internal whitespace ("tick   timer" -> "TICK
// TIMER"). Everything after the keyword (quoted names/args) keeps its
// original case -- only the command word itself is normalized. Most of
// the regexes below already carry an 'i' flag so this is partly a
// defensive no-op against today's code, but it keeps tags working
// correctly against any tag processor that isn't (or stops being)
// case-insensitive, and directly covers the "[Roll]" style drift.
function normalizeAITagCase(text) {
    let out = text;
    for (const kw of AI_TAG_KEYWORDS) {
        const pattern = new RegExp('\\[\\s*' + kw.split(' ').join('\\s+') + '\\b', 'gi');
        out = out.replace(pattern, '[' + kw);
    }
    return out;
}

// 2) Roll pool spacing repair: the pool expression in [ROLL "Name"
// <pool> DV <n> <position>] must be contiguous letters/plus signs
// (`[A-Za-z\+]+`) for rollRegex to match -- "Wits + Stealth" (spaces
// around the +, which is how a human -- and apparently the model --
// naturally writes an attribute+skill pool) fails to match at all.
// Squeeze whitespace out of just the `+` joins in that segment.
function tightenRollPoolSpacing(text) {
    // Covers both [ROLL "Name" ...] and [CALL FOR ROLL "Name" ...] --
    // same pool-expression shape, same spacing drift from the model.
    return text.replace(
        /(\[(?:CALL FOR ROLL|ROLL)\s+"[^"]*"\s+)([^\]]*?)(\s+DV\s+\d+)/gi,
        (full, prefix, pool, suffix) => prefix + pool.replace(/\s*\+\s*/g, '+').trim() + suffix
    );
}

// 3) Unterminated tag repair: if a recognized tag never got a closing
// "]" (cut off, or the model moved on to the next tag/sentence without
// finishing it), every regex below fails to match it and the tag leaks
// into chat as literal, unresolved bracket text. For each occurrence of
// a known "[KEYWORD" that isn't already properly closed before the next
// "[" or end of string, close it: append a closing '"' first if it has
// an odd number of quote characters (an unterminated quoted argument),
// then append "]".
function closeUnterminatedAITags(text) {
    let out = text;
    for (const kw of AI_TAG_KEYWORDS) {
        const opener = '[' + kw;
        let searchFrom = 0;
        while (true) {
            const start = out.indexOf(opener, searchFrom);
            if (start === -1) break;
            const nextClose = out.indexOf(']', start);
            const nextOpen = out.indexOf('[', start + 1);
            if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
                // Already properly closed before anything else starts --
                // nothing to repair. Keep scanning after it.
                searchFrom = nextClose + 1;
                continue;
            }
            const boundary = nextOpen !== -1 ? nextOpen : out.length;
            const span = out.slice(start, boundary).replace(/\s+$/, '');
            const quoteCount = (span.match(/"/g) || []).length;
            const fixedSpan = span + (quoteCount % 2 === 1 ? '"' : '') + ']';
            out = out.slice(0, start) + fixedSpan + out.slice(boundary);
            searchFrom = start + fixedSpan.length;
        }
    }
    return out;
}

// 0) Bare (unquoted) name repair: the model sometimes drops the required
// quotes around a roll tag's name entirely -- e.g. emits
// "[CALL FOR ROLL Asadef Wits+Stealth DV 3 Controlled]" instead of
// '[CALL FOR ROLL "Asadef" Wits+Stealth DV 3 Controlled]'. Every regex
// downstream of this (rollRegex, callForRollRegex, and even
// tightenRollPoolSpacing above) requires the name to already be quoted,
// so without this repair the whole tag leaks into chat as literal
// unresolved bracket text -- exactly what a first-time user saw running
// the demo against a small local model. Only fires when a pool
// expression containing "+" (Attribute+Skill) is found before "DV" --
// that's the one part of this syntax reliable enough to anchor on
// without risking mis-slicing a legitimate multi-word name.
function quoteBareRollName(text) {
    return text.replace(
        /\[(CALL FOR ROLL|ROLL)\s+(?!")([A-Za-z][A-Za-z '-]*?)\s+([A-Za-z]+\+[A-Za-z]+)(\s+DV\s+\d+)/gi,
        (full, kw, name, pool, suffix) => `[${kw} "${name.trim()}" ${pool}${suffix}`
    );
}

function repairAITagSyntax(text) {
    if (!text || typeof text !== 'string') return text;
    let repaired = normalizeAITagCase(text);
    repaired = quoteBareRollName(repaired);
    repaired = tightenRollPoolSpacing(repaired);
    repaired = closeUnterminatedAITags(repaired);
    return repaired;
}

// ─── Special tag processing ────────────────────────────────────────
async function processSpecialTags(text, context, senderName = null) {
    const charactersModule = context.charactersModule;
    if (!charactersModule) {
        return text;
    }

    if (!context.orchestrator) {
        return text;
    }

    // Repair drift in the model's own tag syntax before any of the
    // strict per-tag regexes below get a chance at it.
    text = repairAITagSyntax(text);
    const campaignState = context.orchestrator.campaign.state;
    const saveCampaign = () => context.orchestrator.campaign.save();
    const ws = context.ws;

    // ─── Timeout helper ──────────────────────────────────────────────
    // Prevents any individual API request from hanging the entire function.
    const withTimeout = (promise, ms = 5000, fallback = null) => {
        return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
        ]).catch(() => fallback);
    };

    // ─── Assistant GM mode ──────────────────────────────────────────
    const isAssistant = context.myRole === 'assistant-gm';

    let output = text;

    // Helper to resolve character name
    const resolveCharName = (name) => {
        if ((name === 'me' || (typeof name === 'string' && name.toLowerCase() === 'unknown')) && senderName) {
            return senderName;
        }
        return name;
    };

    // ─── Helper: process a single roll tag ─────────────────────────
    async function processRollTag(name, poolExpr, dv, position, fullTag) {
        name = resolveCharName(name);
        const char = charactersModule.get(name);
        const hasAttributes = char && Object.keys(char.attributes || {}).some(k => char.attributes[k] !== undefined);

        if (!hasAttributes) {
            return `*(⚠️ Character "${name}" not found. Please select a character in the VTT or create one with \`!gm create "${name}"\`.)*`;
        }

        const diceCount = charactersModule.getPool(name, poolExpr);
        if (diceCount === 0) {
            return `*(Could not resolve dice pool for ${name} with "${poolExpr}". Check attribute/skill names.)*`;
        }

        let result = diceModule.rollDice(diceCount);
        result = diceModule.applyPosition(result, position);
        const formatted = diceModule.formatRollResult(name, poolExpr, diceCount, result, dv, position, char);
        const outcome = diceModule.determineOutcome(result.successes, dv, result.sb);
        if (outcome.boonGain > 0) {
            charactersModule.applyDelta(name, 'boons', outcome.boonGain, saveCampaign);
        }
        campaignState.sb = (campaignState.sb || 0) + result.sb;
        saveCampaign();
        return formatted;
    }

    let match;

    // ─── [CALL FOR ROLL ...] – GM calls for a roll, does NOT resolve it ──
    // Unlike [ROLL ...] below (which immediately rolls dice and returns a
    // finished result), this tag is how the GM asks a player to make a
    // check without deciding the outcome for them. A real GM says "make a
    // Presence roll" (and maybe "-- though your low Presence means you
    // might get more out of leaning on your Melee skill to intimidate
    // instead") and then *waits*; they don't secretly roll the dice on the
    // player's behalf the instant the words leave their mouth. This
    // renders a prompt telling the player exactly what to roll (and an
    // optional GM suggestion/alternative-approach note) and leaves the
    // actual roll to the player's own `!gm roll ...` command or VTT roll
    // button -- see ai-gm-bot.js's recordRollResultInHistory() for how
    // that eventual result gets back into the AI's context so it can
    // react to a roll it didn't fabricate itself.
    const callForRollRegex = /\[CALL FOR ROLL\s*"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)(?:\s*"([^"]*)")?\s*\]/gi;
    while ((match = callForRollRegex.exec(output)) !== null) {
        const name = resolveCharName(match[1]);
        const poolExpr = match[2];
        const dv = parseInt(match[3]);
        const position = match[4];
        const suggestion = (match[5] || '').trim();

        const char = charactersModule.get(name);
        const hasAttributes = char && Object.keys(char.attributes || {}).some(k => char.attributes[k] !== undefined);

        let replacement;
        if (!hasAttributes) {
            replacement = `*(⚠️ Character "${name}" not found. Please select a character in the VTT or create one with \`!gm create "${name}"\`.)*`;
        } else {
            const diceCount = charactersModule.getPool(name, poolExpr);
            const poolNote = diceCount > 0 ? ` (${diceCount} dice)` : '';
            replacement = `🎲 **${name}**, this calls for a **${poolExpr}** roll — DV ${dv}, ${position}${poolNote}.` +
                (suggestion ? ` _${suggestion}_` : '') +
                ` Roll it with \`!gm roll "${name}" ${poolExpr} DV ${dv} ${position}\` — or describe a different approach and I'll adjust the pool — whenever you're ready.`;
        }
        output = output.replace(match[0], replacement);
        callForRollRegex.lastIndex = 0;
    }

    // ─── [ROLL ...] – supports "me" placeholder ────────────────────
    // Immediately rolls and resolves. Still used for GM/system-driven
    // rolls (e.g. an NPC's own check, or a roll a player already agreed to
    // out loud) — the AI's system prompt now steers it toward [CALL FOR
    // ROLL ...] instead for asking a *player* to roll, so this tag firing
    // less often against player characters is expected and fine.
    // First, try the regex approach with flexible spacing
    const rollRegex = /\[ROLL\s*"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)\s*\]/gi;
    let foundAny = false;
    while ((match = rollRegex.exec(text)) !== null) {
        foundAny = true;
        const name = match[1];
        const poolExpr = match[2];
        const dv = parseInt(match[3]);
        const position = match[4];
        const replacement = await processRollTag(name, poolExpr, dv, position, match[0]);
        output = output.replace(match[0], replacement);
    }

    // If regex found nothing, try a more manual parser (more forgiving of whitespace)
    if (!foundAny) {
        let startIdx = 0;
        while (true) {
            const rollStart = output.indexOf('[ROLL "', startIdx);
            if (rollStart === -1) break;
            const rollEnd = output.indexOf(']', rollStart);
            if (rollEnd === -1) break;
            const fullTag = output.slice(rollStart, rollEnd + 1);
            const tagContent = output.slice(rollStart + 7, rollEnd);
            const parts = tagContent.match(/"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)/);
            if (parts) {
                const name = parts[1];
                const poolExpr = parts[2];
                const dv = parseInt(parts[3]);
                const position = parts[4];
                const replacement = await processRollTag(name, poolExpr, dv, position, fullTag);
                output = output.replace(fullTag, replacement);
                startIdx = rollStart + replacement.length;
            } else {
                startIdx = rollEnd + 1;
            }
        }
    }

    // ─── [LOOKUP RULE "..."] ────────────────────────────────────────
    const lookupRegex = /\[LOOKUP RULE\s*"([^"]+)"\s*\]/gi;
    while ((match = lookupRegex.exec(output)) !== null) {
        const query = match[1];
        const rulesText = context.orchestrator?.world?.getRules?.() || context.orchestrator?.world?.rules;
        const section = rulesModule.findSection(rulesText, query);
        const replacement = section
            ? `\n---\n**${section.title}**\n${section.body}\n---\n`
            : `*(No rule section found matching "${query}".)*`;
        output = output.replace(match[0], replacement);
        lookupRegex.lastIndex = 0;
    }

    // ─── [SET POSITION ...] ────────────────────────────────────────
    const posRegex = /\[SET POSITION ([A-Za-z]+)\]/gi;
    while ((match = posRegex.exec(output)) !== null) {
        const pos = match[1];
        campaignState.scene.position = pos;
        saveCampaign();
        output = output.replace(match[0], `*(Position set to ${pos})*`);
        posRegex.lastIndex = 0;
    }

    // ─── [SET DV ...] ──────────────────────────────────────────────
    const dvRegex = /\[SET DV (\d+)\]/gi;
    while ((match = dvRegex.exec(output)) !== null) {
        const dv = parseInt(match[1]);
        campaignState.scene.defaultDV = dv;
        saveCampaign();
        output = output.replace(match[0], `*(Default DV set to ${dv})*`);
        dvRegex.lastIndex = 0;
    }

    // ─── [APPLY ...] – supports "me" placeholder ───────────────────
    const applyRegex = /\[(?:APPLY|ADD)\s+(HARM|FATIGUE|BOON|OBLIGATION|CORRUPTION|LEASH)\s+([A-Za-z0-9_]+)\s+(-?\d+)(?:\s+(\d+))?\]/gi;
    while ((match = applyRegex.exec(output)) !== null) {
        const type = match[1].toLowerCase();
        let name = match[2];
        name = resolveCharName(name);
        const amount = parseInt(match[3]);
        const extra = match[4] ? parseInt(match[4]) : null;
        if (type === 'harm') {
            const armorStep = extra || 1;
            const char = charactersModule.get(name);
            diceModule.applyHarmAndFatigue(char, amount, armorStep, saveCampaign);
            output = output.replace(match[0], `*(${name} took ${amount} Harm, armor step ${armorStep})*`);
        } else {
            charactersModule.applyDelta(name, type, amount, saveCampaign);
            output = output.replace(match[0], `*(${name} ${type} ${amount >= 0 ? '+' : ''}${amount})*`);
        }
        applyRegex.lastIndex = 0;
    }

    // ─── [TICK TIMER ...] ──────────────────────────────────────────
    const tickRegex = /\[TICK TIMER "([^"]+)" (\d+)\]/gi;
    while ((match = tickRegex.exec(output)) !== null) {
        const name = match[1];
        const ticks = parseInt(match[2]);
        const filled = timersModule.tickTimer(campaignState, name, ticks);
        if (filled) {
            const event = timersModule.resolveTimer(campaignState, name);
            output = output.replace(match[0], `*(Timer "${name}" fills! ${event})*`);
        } else {
            const timer = campaignState.scene.timers.find(t => t.name === name);
            if (timer) {
                output = output.replace(match[0], `*(Timer "${name}" advanced to ${timer.current}/${timer.max})*`);
            } else {
                output = output.replace(match[0], `*(Timer "${name}" not found)*`);
            }
        }
        saveCampaign();
        tickRegex.lastIndex = 0;
    }

    // ─── [TIMER ...] – create timer ───────────────────────────────
    const createRegex = /\[TIMER "([^"]+)" (\d+) "([^"]*)"\]/gi;
    while ((match = createRegex.exec(output)) !== null) {
        const name = match[1];
        const max = parseInt(match[2]);
        const onFill = match[3] || 'Timer fills.';
        timersModule.addTimer(campaignState, name, max, onFill);
        saveCampaign();
        output = output.replace(match[0], `*(Timer "${name}" created with ${max} segments)*`);
        createRegex.lastIndex = 0;
    }

    // ─── [DRAW ...] – WebSocket deck-draw ──────────────────────────
    const drawRegex = /\[DRAW (\d+) ([\w-]+)\]/gi;
    while ((match = drawRegex.exec(output)) !== null) {
        const count = parseInt(match[1]);
        const region = match[2];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'deck-draw', count, region }));
            output = output.replace(match[0], `*(Requested draw of ${count} cards from ${region})*`);
        } else {
            output = output.replace(match[0], `*(Deck draw not available – WebSocket closed)*`);
        }
        drawRegex.lastIndex = 0;
    }

    // ─── [CROWN ...] – WebSocket crown-spread ──────────────────────
    const crownRegex = /\[CROWN ([\w-]+)\]/gi;
    while ((match = crownRegex.exec(output)) !== null) {
        const region = match[1];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'crown-spread', region }));
            output = output.replace(match[0], `*(Requested Crown Spread for ${region})*`);
        } else {
            output = output.replace(match[0], `*(Crown Spread not available – WebSocket closed)*`);
        }
        crownRegex.lastIndex = 0;
    }

    // ─── [SPEND SB ...] ────────────────────────────────────────────
    const sbRegex = /\[SPEND SB (\d+)\]/gi;
    while ((match = sbRegex.exec(output)) !== null) {
        const cost = parseInt(match[1]);
        if (campaignState.sb >= cost) {
            campaignState.sb -= cost;
            saveCampaign();
            output = output.replace(match[0], `*(Spent ${cost} Story Beat${cost > 1 ? 's' : ''})*`);
        } else {
            output = output.replace(match[0], '*(Not enough SB)*');
        }
        sbRegex.lastIndex = 0;
    }

    // ─── [FACT ...] ────────────────────────────────────────────────
    const factRegex = /\[FACT (.+?) (.+?)\]/gi;
    while ((match = factRegex.exec(output)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (isAssistant) {
            assistantSuggestions.enqueue({
                kind: 'fact',
                label: `New fact — ${key}: ${value}`,
                apply: async () => {
                    campaignState.facts[key] = value;
                    saveCampaign();
                    knowledgeIndex.indexFact(context.orchestrator?.campaign?.campaignCode, key, value).catch(() => {});
                },
            });
        } else {
            campaignState.facts[key] = value;
            saveCampaign();
            knowledgeIndex.indexFact(context.orchestrator?.campaign?.campaignCode, key, value).catch(() => {});
        }
        output = output.replace(match[0], '');
        factRegex.lastIndex = 0;
    }

    // ─── [NPC CAST ...] – supports "me" placeholder ───────────────
    const npcCastRegex = /\[NPC CAST "([^"]+)" ([^\]]+)\]/gi;
    while ((match = npcCastRegex.exec(output)) !== null) {
        const spellName = match[1];
        let target = match[2].trim();
        target = resolveCharName(target);
        const spell = context.orchestrator?.world?.getSpell(spellName);
        if (!spell) {
            output = output.replace(match[0], `*(NPC spell "${spellName}" not found)*`);
            npcCastRegex.lastIndex = 0;
            continue;
        }
        const tagCount = spell.tags ? spell.tags.length : 1;
        let sbCost = Math.min(Math.max(tagCount, 2), 5);
        const dangerousTags = ['LEAP', 'FOLD', 'GATE', 'TRANSFORM', 'CREATE', 'SUMMON', 'DOMINATE', 'REVIVE'];
        if (spell.tags && spell.tags.some(t => dangerousTags.includes(t.toUpperCase()))) {
            sbCost = Math.min(sbCost + 1, 6);
        }
        if ((campaignState.sb || 0) < sbCost) {
            output = output.replace(match[0], `*(Not enough SB (need ${sbCost}, have ${campaignState.sb || 0}) for NPC spell "${spellName}")*`);
            npcCastRegex.lastIndex = 0;
            continue;
        }
        campaignState.sb -= sbCost;
        const targetIsPlayer = charactersModule.get(target) ? true : false;
        let resultMsg = `*NPC casts ${spell.name} on ${target}*`;
        if (targetIsPlayer) {
            const char = charactersModule.get(target);
            if (spell.tags.includes('HARM')) {
                diceModule.applyHarmAndFatigue(char, 1, 1, saveCampaign);
                resultMsg += ` – ${target} takes 1 Harm.`;
            } else if (spell.tags.includes('FATIGUE')) {
                char.fatigue = (char.fatigue || 0) + 1;
                resultMsg += ` – ${target} marks 1 Fatigue.`;
            } else {
                resultMsg += ` – The Weave shifts, and ${target} feels the consequence.`;
            }
        } else {
            resultMsg += ` – The Weave answers.`;
        }
        saveCampaign();
        output = output.replace(match[0], resultMsg);
        npcCastRegex.lastIndex = 0;
    }

    // ─── [SCENE COMPLETE "notes"] ──────────────────────────────────
    const sceneCompleteRegex = /\[SCENE COMPLETE(?:\s+"([^"]*)")?\]/gi;
    while ((match = sceneCompleteRegex.exec(output)) !== null) {
        const notes = match[1] || '';
        if (isAssistant) {
            assistantSuggestions.enqueue({
                kind: 'scene-complete',
                label: `Advance the scene${notes ? ` — ${notes}` : ''}`,
                apply: async () => {
                    try {
                        // Timeout the scene completion call to avoid hanging
                        return await withTimeout(
                            adventureDirector.handleSceneComplete(context, notes),
                            5000,
                            '*(Scene completion timed out – please try again)*'
                        );
                    } catch (e) {
                        return `*(Scene completion error: ${e.message})*`;
                    }
                },
            });
            output = output.replace(match[0], '');
        } else {
            let resultMsg;
            try {
                // Timeout the scene completion call
                resultMsg = await withTimeout(
                    adventureDirector.handleSceneComplete(context, notes),
                    5000,
                    '*(Scene completion timed out – please try again)*'
                );
            } catch (e) {
                resultMsg = `*(Scene completion error: ${e.message})*`;
            }
            output = output.replace(match[0], resultMsg || '');
        }
        sceneCompleteRegex.lastIndex = 0;
    }

    // ─── [NPC CREATE "Name" "Role" "Motivation" "Location"] ────────
    const npcCreateRegex = /\[NPC CREATE "([^"]+)"(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?\]/gi;
    while ((match = npcCreateRegex.exec(output)) !== null) {
        const name = match[1];
        const role = match[2] || 'NPC';
        const motivation = match[3] || '';
        const location = match[4] || undefined;
        const registerNpc = async () => {
            try {
                // Timeout the API call to avoid hanging
                await withTimeout(
                    context.apiRequest('POST', ['adventure', 'npc'], { npc: { name, role, motivation, location } }),
                    5000
                );
            } catch (e) {
                console.warn(`[NPC CREATE] failed to register "${name}":`, e.message);
            }
            // Best-effort token placement and indexing – these are fire-and-forget with .catch()
            placeOrUpdateToken(context, { name, faction: inferFaction(role, motivation) }).catch(() => {});
            knowledgeIndex.indexNpc(context.orchestrator?.campaign?.campaignCode, {
                name, role, motivation, location, faction: inferFaction(role, motivation), source: 'created'
            }).catch(() => {});
        };
        if (isAssistant) {
            assistantSuggestions.enqueue({
                kind: 'npc-create',
                label: `New NPC — ${name}${role ? ` (${role})` : ''}`,
                apply: registerNpc,
            });
        } else {
            await registerNpc();
        }
        output = output.replace(match[0], '');
        npcCreateRegex.lastIndex = 0;
    }

    // ─── [NPC LOCATION "Name" "Place"] ──────────────────────────────
    const npcLocationRegex = /\[NPC LOCATION "([^"]+)" "([^"]*)"\]/gi;
    while ((match = npcLocationRegex.exec(output)) !== null) {
        const name = match[1];
        const place = match[2].trim();
        knowledgeIndex.updateNpcLocation(context.orchestrator?.campaign?.campaignCode, name, place || null).catch(() => {});
        output = output.replace(match[0], '');
        npcLocationRegex.lastIndex = 0;
    }

    // ─── [REVEAL "knowledge-id"] / [HIDE "knowledge-id"] ────────────
    const revealRegex = /\[REVEAL\s+"([^"]+)"\]/gi;
    while ((match = revealRegex.exec(output)) !== null) {
        const id = match[1];
        const doReveal = async () => {
            try {
                // Timeout the API call to avoid hanging
                await withTimeout(
                    context.apiRequest('POST', ['adventure', 'knowledge', 'reveal'], { id, by: context.myRole === 'assistant-gm' ? 'AI_GM (assistant)' : 'AI_GM' }),
                    5000
                );
                adventureContext.invalidate();
            } catch (e) {
                console.warn(`[REVEAL] failed to reveal "${id}":`, e.message);
            }
        };
        if (isAssistant) {
            assistantSuggestions.enqueue({ kind: 'knowledge-reveal', label: `Reveal knowledge — ${id}`, apply: doReveal });
        } else {
            await doReveal();
        }
        output = output.replace(match[0], '');
        revealRegex.lastIndex = 0;
    }

    const hideRegex = /\[HIDE\s+"([^"]+)"\]/gi;
    while ((match = hideRegex.exec(output)) !== null) {
        const id = match[1];
        const doHide = async () => {
            try {
                // Timeout the API call to avoid hanging
                await withTimeout(
                    context.apiRequest('POST', ['adventure', 'knowledge', 'hide'], { id, by: context.myRole === 'assistant-gm' ? 'AI_GM (assistant)' : 'AI_GM' }),
                    5000
                );
                adventureContext.invalidate();
            } catch (e) {
                console.warn(`[HIDE] failed to hide "${id}":`, e.message);
            }
        };
        if (isAssistant) {
            assistantSuggestions.enqueue({ kind: 'knowledge-hide', label: `Hide knowledge — ${id}`, apply: doHide });
        } else {
            await doHide();
        }
        output = output.replace(match[0], '');
        hideRegex.lastIndex = 0;
    }

    // ─── [TOKEN MOVE "Name" col row] ────────────────────────────────
    const tokenMoveRegex = /\[TOKEN MOVE "([^"]+)"\s+(-?\d+)\s+(-?\d+)\]/gi;
    while ((match = tokenMoveRegex.exec(output)) !== null) {
        const name = match[1];
        const col = parseInt(match[2], 10);
        const row = parseInt(match[3], 10);
        moveToken(context, name, col, row).catch(() => {});
        output = output.replace(match[0], '');
        tokenMoveRegex.lastIndex = 0;
    }

    // ─── [TOKEN REMOVE "Name"] ───────────────────────────────────────
    const tokenRemoveRegex = /\[TOKEN REMOVE "([^"]+)"\]/gi;
    while ((match = tokenRemoveRegex.exec(output)) !== null) {
        const name = match[1];
        removeToken(context, name).catch(() => {});
        output = output.replace(match[0], '');
        tokenRemoveRegex.lastIndex = 0;
    }

    // ─── [ENCOUNTER START "Name" type] ─────────────────────────────
    const encStartRegex = /\[ENCOUNTER START\s+"([^"]+)"(?:\s+(\w+))?\]/gi;
    while ((match = encStartRegex.exec(output)) !== null) {
        const name = match[1];
        const encType = encounterType({ type: match[2] });
        try {
            const apiRequest = context.apiRequest;
            if (apiRequest) {
                // Timeout the API call to avoid hanging
                const result = await withTimeout(
                    apiRequest('POST', ['adventure', 'encounter', 'start'], {
                        encounter: { name, type: encType },
                    }),
                    5000
                );
                const vocab = getVocab(encType);
                const dv = result?.activeEncounter?.dv;
                output = output.replace(match[0], `${encounterIcon(encType)} Encounter "${name}" (${vocab.label}) begins.${dv !== undefined ? ` DV ${dv}.` : ''}`);
            } else {
                output = output.replace(match[0], '⚠️ Encounter start failed (API not available).');
            }
        } catch (e) {
            output = output.replace(match[0], `⚠️ Encounter start error: ${e.message}`);
        }
        encStartRegex.lastIndex = 0;
    }

    // ─── [ENCOUNTER RESOLVE outcome "notes"] ──────────────────────
    const encResolveRegex = /\[ENCOUNTER RESOLVE\s+(clean|partial|miss)(?:\s+"([^"]*)")?\]/gi;
    while ((match = encResolveRegex.exec(output)) !== null) {
        const outcome = match[1];
        const notes = match[2] || '';
        try {
            const apiRequest = context.apiRequest;
            if (apiRequest) {
                // Timeout the API call to avoid hanging
                const result = await withTimeout(
                    apiRequest('POST', ['adventure', 'encounter', 'resolve'], { outcome, notes }),
                    5000
                );
                clearEnemyTokens(context).catch(() => {});
                if (result && result.lastResolution) {
                    const r = result.lastResolution;
                    const encType = encounterType(r);
                    const msg = `${encounterIcon(encType)} Encounter "${r.encounter || 'Unknown'}" resolved as ${r.outcome}.${r.result ? ' ' + r.result : ''}`;
                    output = output.replace(match[0], msg);
                } else {
                    output = output.replace(match[0], '⚔️ Encounter resolved.');
                }
            } else {
                output = output.replace(match[0], '⚠️ Encounter resolution failed (API not available).');
            }
        } catch (e) {
            output = output.replace(match[0], `⚠️ Encounter resolution error: ${e.message}`);
        }
        encResolveRegex.lastIndex = 0;
    }

    return output;
}

// ─── Etiquette Reminder ────────────────────────────────────────────
function generateEtiquetteReminder() {
    return `📜 **Fate's Edge – Game Etiquette**\n\n` +
        `**Optimal Play = Most Fun**\n` +
        `• Spend Boons freely – they fuel drama, not hoarding.\n` +
        `• Embrace failure – it generates Story Beats (SB) that make the story interesting.\n` +
        `• Patrons are allies who demand payment – Obligation is plot, not punishment.\n` +
        `• Flavor is free – describe your actions vividly, but keep it concise.\n` +
        `• The GM is a fan of the players – we are co-creators, not adversaries.\n` +
        `• Safety tools (X-Card, Lines, Veils) are always available – speak up if uncomfortable.\n` +
        `• When in doubt, make a ruling that keeps the story moving.\n\n` +
        `**Remember:** The dice are not the story; they are the spark. Let them sing.`;
}

// ─── Startup Message ──────────────────────────────────────────────
function generateStartupMessage(region, playerCount, charactersExist, botName = 'AI_GM') {
    let message = `🌟 Welcome to Fate's Edge! I am ${botName}, your AI Game Master. ` +
        `I'm here to guide the story, react to your choices, and keep the pressure on. ` +
        `Let's begin.\n\n`;

    if (region && region !== 'unknown') {
        message += `📍 **Current Region:** ${region}\n`;
        message += `The world around you is alive with ancient magic and hidden dangers. ` +
            `Every choice echoes across the Amaranthine.\n\n`;
    } else {
        message += `📍 **Region:** Unknown – but the world is vast and full of stories.\n\n`;
    }

    if (playerCount > 0) {
        message += `👥 **Players online:** ${playerCount}\n\n`;
    } else {
        message += `👤 **No other players connected yet.** You are the first to arrive.\n\n`;
    }

    if (!charactersExist) {
        message += `**No characters found.**\n` +
            `To begin, create a character with:\n` +
            `\`!gm create <YourCharacterName>\`\n` +
            `Then customize stats with \`!gm setattr\` and \`!gm setskill\`.\n` +
            `You can also use \`!gm help\` for all commands.\n\n`;
    } else {
        message += `✅ **Characters exist.** Use \`!gm status\` to see them.\n\n`;
    }

    message += `**What will you do?**\n` +
        `• Explore the region: \`!gm region\`\n` +
        `• Check your status: \`!gm status\`\n` +
        `• Roll dice: \`!gm roll "Name" Attribute+Skill DV Position\`\n` +
        `• Get help: \`!gm help\`\n` +
        `• See etiquette: \`!gm etiquette\`\n\n` +
        `**The story awaits. Make your move.**`;

    return message;
}

// ─── Export ────────────────────────────────────────────────────────
module.exports = {
    handleBotCommand,
    processSpecialTags,
    generateStartupMessage,
    generateEtiquetteReminder,
    globalApiRequest,
    syncCharactersFromServer, // NEW: shared with index.js's performAggressiveSync
    repairAITagSyntax, // exported for unit testing the fuzzy tag repair in isolation
};
