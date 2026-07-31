// modules/commands.js
const diceModule = require('./dice');
const timersModule = require('./timers');
const adventureDirector = require('./adventure-director');
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
!gm region set <name> - set the campaign region (syncs to VTT)
!gm adventure - show adventure status or selection menu
!gm adventure choose <n> - pick an adventure from the menu (GM only)
!gm adventure preview [n] - preview the active adventure, or a pending menu option (any player)
!gm adventure crown - jump straight to a Crown Spread (GM only)
!gm adventure vote abandon - vote to abandon the current adventure
!gm adventure reset - restart the current adventure from the top (GM only)
!gm adventure debug - full adventure state + reference data dump (GM only)
!gm session end - mark a real-world play session as ended (dynamic-growth adventures)
!gm npc create "Name" ["Role"] ["Motivation"] - register an ad-hoc NPC into the current adventure
!gm resume - show current adventure status (shortcut for !gm adventure)
!gm seed - seed campaign with Crown Spread (GM only)
!gm spell <name> - show details of a spell
!gm spells - list all available spells
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
        return `Fact updated: ${key} = ${value}`;
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
                const data = await context.apiRequest('GET', ['campaigns', code]);
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
        const region = campaignState.scene?.region || context.orchestrator?.options?.defaultRegion || 'unknown';
        const regionData = context.orchestrator?.world?.getRegion(region);
        if (regionData) {
            return `📍 **Region:** ${regionData.name || region}\n${regionData.description || ''}\n${regionData.genre ? `Genre: ${regionData.genre}` : ''}`;
        } else {
            return `📍 Current region: ${region} (no detailed data available)`;
        }
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
                    const tokenList = gc.tokens.map(t => `${t.name} (${t.x},${t.y})`).join(', ');
                    result += `  Tokens: ${tokenList}\n`;
                }
            }
            return result;
        } catch (e) {
            return `Grid status failed: ${e.message}`;
        }
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

// ─── Special tag processing ────────────────────────────────────────
async function processSpecialTags(text, context, senderName = null) {
    const charactersModule = context.charactersModule;
    if (!charactersModule) {
        return text;
    }

    if (!context.orchestrator) {
        return text;
    }
    const campaignState = context.orchestrator.campaign.state;
    const saveCampaign = () => context.orchestrator.campaign.save();
    const ws = context.ws;

    let output = text;

    // Helper to resolve character name
    // CHANGED: a real production log showed a roll card displaying
    // "Unknown" as the character name (e.g. "Unknown rolls Body+Athletics
    // ..."). Whether that came from the model genuinely writing
    // `[ROLL "Unknown" ...]` because it wasn't sure which character was
    // acting, or from a hallucinated card that slipped past the strip
    // filters, the right fix is the same either way: "Unknown" almost
    // certainly means "whoever is actually speaking right now," so
    // resolve it to the real sender exactly like "me" already is,
    // instead of silently creating/rolling for a bogus character
    // literally named "Unknown".
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

    // ─── [ROLL ...] – supports "me" placeholder ────────────────────
    // First, try the regex approach with flexible spacing
    const rollRegex = /\[ROLL\s*"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)\s*\]/gi;
    let match;
    let foundAny = false;
    console.log('🔍 [processSpecialTags] Processing text for roll tags:', text.slice(0, 200));
    while ((match = rollRegex.exec(text)) !== null) {
        foundAny = true;
        console.log('🔍 [processSpecialTags] Found roll tag via regex:', match[0]);
        const name = match[1];
        const poolExpr = match[2];
        const dv = parseInt(match[3]);
        const position = match[4];
        const replacement = await processRollTag(name, poolExpr, dv, position, match[0]);
        output = output.replace(match[0], replacement);
        console.log('🔍 [processSpecialTags] Replaced with:', replacement);
    }

    // If regex found nothing, try a more manual parser (more forgiving of whitespace)
    if (!foundAny) {
        console.log('🔍 [processSpecialTags] Regex found no roll tags, trying manual parser...');
        let startIdx = 0;
        while (true) {
            const rollStart = output.indexOf('[ROLL "', startIdx);
            if (rollStart === -1) break;
            const rollEnd = output.indexOf(']', rollStart);
            if (rollEnd === -1) break;
            const fullTag = output.slice(rollStart, rollEnd + 1);
            const tagContent = output.slice(rollStart + 7, rollEnd); // after '[ROLL "'
            // Parse: "name" whitespace Attribute+Skill whitespace DV number whitespace Position
            const parts = tagContent.match(/"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)/);
            if (parts) {
                const name = parts[1];
                const poolExpr = parts[2];
                const dv = parseInt(parts[3]);
                const position = parts[4];
                console.log('🔍 [processSpecialTags] Found roll tag via manual parser:', fullTag);
                const replacement = await processRollTag(name, poolExpr, dv, position, fullTag);
                output = output.replace(fullTag, replacement);
                console.log('🔍 [processSpecialTags] Replaced with:', replacement);
                startIdx = rollEnd + 1;
            } else {
                startIdx = rollEnd + 1;
            }
        }
    }

    // ─── [SET POSITION ...] ────────────────────────────────────────
    const posRegex = /\[SET POSITION ([A-Za-z]+)\]/gi;
    while ((match = posRegex.exec(output)) !== null) {
        const pos = match[1];
        campaignState.scene.position = pos;
        saveCampaign();
        output = output.replace(match[0], `*(Position set to ${pos})*`);
    }

    // ─── [SET DV ...] ──────────────────────────────────────────────
    const dvRegex = /\[SET DV (\d+)\]/gi;
    while ((match = dvRegex.exec(output)) !== null) {
        const dv = parseInt(match[1]);
        campaignState.scene.defaultDV = dv;
        saveCampaign();
        output = output.replace(match[0], `*(Default DV set to ${dv})*`);
    }

    // ─── [APPLY ...] – supports "me" placeholder ───────────────────
    // CHANGED: the system prompt (index.js) instructs the model to use
    // "[ADD BOON Name N]" for boons, but this regex only ever matched
    // the literal word APPLY -- so every boon grant the model actually
    // followed instructions for silently failed to parse. Also added
    // support for negative amounts (e.g. removing a boon/spending one
    // via a tag) which the old `(\d+)` couldn't match at all.
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
    }

    // ─── [TICK TIMER ...] ──────────────────────────────────────────
    // NOTE: this ticks the LOCAL orchestrator scene timer
    // (campaignState.scene.timers), a different system from the server
    // adventure engine's own scene/campaign timers (server/adventure.js
    // tickTimer(), reached via apiRequest POST ['adventure','timer']).
    // The two are not reconciled -- a [TICK TIMER "X" N] tag here will
    // silently create/advance a LOCAL timer named X even if an adventure
    // module timer with the same name already exists server-side. If you
    // want the AI's [TICK TIMER] tags to drive the adventure engine's
    // scene timers instead, route this branch through
    // context.apiRequest('POST', ['adventure','timer'], {ref:name, amount:ticks, scope:'scene'})
    // and drop the local timersModule call.
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
    }

    // ─── [DRAW ...] – WebSocket deck-draw ──────────────────────────
    // CHANGED: \w+ doesn't match hyphens, so a region like
    // "acasia-broken-marches" (the actual default region) never matched
    // and this tag silently failed to fire for the default region.
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
    }

    // ─── [CROWN ...] – WebSocket crown-spread ──────────────────────
    // CHANGED: same hyphen fix as [DRAW] above.
    const crownRegex = /\[CROWN ([\w-]+)\]/gi;
    while ((match = crownRegex.exec(output)) !== null) {
        const region = match[1];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'crown-spread', region }));
            output = output.replace(match[0], `*(Requested Crown Spread for ${region})*`);
        } else {
            output = output.replace(match[0], `*(Crown Spread not available – WebSocket closed)*`);
        }
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
    }

    // ─── [FACT ...] ────────────────────────────────────────────────
    const factRegex = /\[FACT (.+?) (.+?)\]/gi;
    while ((match = factRegex.exec(output)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        campaignState.facts[key] = value;
        saveCampaign();
        output = output.replace(match[0], '');
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
    }

    // ─── [SCENE COMPLETE "notes"] ──────────────────────────────────
    // NEW: this is the actual scene-advancement mechanism -- previously
    // nothing in the bot ever called the adventure engine's advanceScene()
    // at all, so the "current scene" never moved forward regardless of
    // how the story actually progressed. The AI emits this tag when a
    // scene's dramatic question has resolved and it's time to move on;
    // adventureDirector.handleSceneComplete() decides whether that's a
    // plain advance, generating a new scene (dynamic-growth adventures
    // with content running low), generating a climax (session threshold
    // reached), or letting the adventure complete and archiving a summary.
    const sceneCompleteRegex = /\[SCENE COMPLETE(?:\s+"([^"]*)")?\]/gi;
    while ((match = sceneCompleteRegex.exec(output)) !== null) {
        const notes = match[1] || '';
        let resultMsg;
        try {
            resultMsg = await adventureDirector.handleSceneComplete(context, notes);
        } catch (e) {
            resultMsg = `*(Scene completion error: ${e.message})*`;
        }
        output = output.replace(match[0], resultMsg || '');
    }

    // ─── [NPC CREATE "Name" "Role" "Motivation"] ───────────────────
    // NEW: registers an ad-hoc NPC the AI just invented (mid-narration)
    // into the currently loaded adventure's own npcs[] array, so it
    // becomes a real, trackable NPC from here on (matched by
    // adventure-context.js's getActiveNpc() the same as any pre-authored
    // one) instead of vanishing the moment the scene ends. Deliberately
    // silent on success -- the name already appears naturally in the
    // AI's own sentence; a visible confirmation would be redundant
    // clutter every time a new character is introduced. Fails silently
    // (logged only) if no adventure is loaded, e.g. during freeform play.
    const npcCreateRegex = /\[NPC CREATE "([^"]+)"(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?\]/gi;
    while ((match = npcCreateRegex.exec(output)) !== null) {
        const name = match[1];
        const role = match[2] || 'NPC';
        const motivation = match[3] || '';
        try {
            await context.apiRequest('POST', ['adventure', 'npc'], { npc: { name, role, motivation } });
        } catch (e) {
            console.warn(`[NPC CREATE] failed to register "${name}":`, e.message);
        }
        output = output.replace(match[0], '');
    }

    // ─── [ENCOUNTER RESOLVE outcome "notes"] ──────────────────────
    const encResolveRegex = /\[ENCOUNTER RESOLVE\s+(clean|partial|miss)(?:\s+"([^"]*)")?\]/gi;
    while ((match = encResolveRegex.exec(output)) !== null) {
        const outcome = match[1];
        const notes = match[2] || '';
        try {
            const apiRequest = context.apiRequest;
            if (apiRequest) {
                const result = await apiRequest('POST', ['adventure', 'encounter', 'resolve'], { outcome, notes });
                if (result && result.lastResolution) {
                    const r = result.lastResolution;
                    const msg = `⚔️ Encounter "${r.encounter || 'Unknown'}" resolved as ${r.outcome}.${r.result ? ' ' + r.result : ''}`;
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
};
