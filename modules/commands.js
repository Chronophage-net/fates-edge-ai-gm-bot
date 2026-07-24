// modules/commands.js
const diceModule = require('./dice');
const timersModule = require('./timers');
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
        const data = await res.json();
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
    const ws = context.ws; // WebSocket for real-time deck commands

    const { cmd, args } = parseArgs(text);

    // ─── Help ──────────────────────────────────────────────────────
    if (cmd === 'help') {
        return `Available commands:
!gm help - this list
!gm create <name> - create a new character (default stats)
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
!gm timer add/tick/remove <name> [segments] [onFill] - manage timers
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
            return `${name} → Harm: ${char.harm}, Fatigue: ${char.fatigue}, Boons: ${char.boons}, Obligation: ${char.obligation}, Corruption: ${char.corruption}, Leash: ${char.leash}` +
                `\nAttributes: ${JSON.stringify(char.attributes)}` +
                `\nSkills: ${JSON.stringify(char.skills)}` +
                `\nTalents: ${char.talents.join(', ') || 'None'}` +
                `\nBonds: ${char.bonds.map(b => `${b.target} (${b.description})`).join(', ') || 'None'}` +
                `\nComplications: ${char.complications.join(', ') || 'None'}` +
                `\nAssets: ${char.assets.join(', ') || 'None'}` +
                `\nFollowers: ${char.followers.map(f => `${f.name} (Cap ${f.cap}, Loyalty: ${f.loyalty}, Fitness: ${f.fitness})`).join(', ') || 'None'}`;
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

    // ─── Discover ──────────────────────────────────────────────────
    if (cmd === 'discover') {
        if (context.myRole !== 'gm') return 'Only the GM can discover characters.';
        try {
            const listData = await context.apiRequest('GET', ['characters']);
            if (!listData || !listData.characters) {
                return 'No character data from server.';
            }
            const serverChars = listData.characters;
            const names = Object.keys(serverChars);
            if (names.length === 0) return 'No characters on server.';
            let synced = 0;
            for (const name of names) {
                const char = charactersModule.get(name);
                const data = serverChars[name];
                if (data) {
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
            }
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
    if (cmd === 'room-state') {
        if (context.myRole !== 'gm') return 'Only the GM can view room state.';
        try {
            const data = await context.apiRequest('GET', ['state']);
            if (!data) return 'No room state data.';
            let result = '🏠 **Room State:**\n';
            result += `Location: ${data.location || 'unknown'}\n`;
            result += `Position: ${data.position || 'Controlled'}\n`;
            result += `Effect: ${data.effect || 'Standard'}\n`;
            result += `Default DV: ${data.defaultDV || 3}\n`;
            if (data.timers && data.timers.length > 0) {
                result += `Timers:\n`;
                for (const timer of data.timers) {
                    result += `  - ${timer.name}: ${timer.current}/${timer.max}\n`;
                }
            } else {
                result += 'Timers: None\n';
            }
            if (data.npcs && data.npcs.length > 0) {
                result += `NPCs: ${data.npcs.join(', ')}\n`;
            }
            return result;
        } catch (e) {
            return `Room state failed: ${e.message}`;
        }
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
        // Sync full character to server (we'll update via API)
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

    // ─── Timer management ──────────────────────────────────────────
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
        const npcName = args[1];
        const target = args[2];
        const extra = args.slice(3).join(' ');

        if (!sub || !npcName || !target) {
            return 'Usage: !gm npc attack <npc> <target> [harm]\n' +
                   '       !gm npc social <npc> <target> <tactic>\n' +
                   '       !gm npc spell <npc> <target> <spell>';
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
function processSpecialTags(text, context) {
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

    // [ROLL ...]
    const rollRegex = /\[ROLL "([^"]+)" ([A-Za-z\+]+) DV(\d+) ([A-Za-z]+)\]/gi;
    let match;
    while ((match = rollRegex.exec(text)) !== null) {
        const name = match[1];
        const poolExpr = match[2];
        const dv = parseInt(match[3]);
        const position = match[4];
        const diceCount = charactersModule.getPool(name, poolExpr);
        if (diceCount === 0) {
            output = output.replace(match[0], `*(Could not resolve dice pool for ${name}.)*`);
            continue;
        }
        let result = diceModule.rollDice(diceCount);
        result = diceModule.applyPosition(result, position);
        const char = charactersModule.get(name);
        const formatted = diceModule.formatRollResult(name, poolExpr, diceCount, result, dv, position, char);
        const outcome = diceModule.determineOutcome(result.successes, dv, result.sb);
        if (outcome.boonGain > 0) {
            charactersModule.applyDelta(name, 'boons', outcome.boonGain, saveCampaign);
        }
        campaignState.sb = (campaignState.sb || 0) + result.sb;
        saveCampaign();
        output = output.replace(match[0], formatted);
    }

    // [SET POSITION ...]
    const posRegex = /\[SET POSITION ([A-Za-z]+)\]/gi;
    while ((match = posRegex.exec(text)) !== null) {
        const pos = match[1];
        campaignState.scene.position = pos;
        saveCampaign();
        output = output.replace(match[0], `*(Position set to ${pos})*`);
    }

    // [SET DV ...]
    const dvRegex = /\[SET DV (\d+)\]/gi;
    while ((match = dvRegex.exec(text)) !== null) {
        const dv = parseInt(match[1]);
        campaignState.scene.defaultDV = dv;
        saveCampaign();
        output = output.replace(match[0], `*(Default DV set to ${dv})*`);
    }

    // [APPLY ...]
    const applyRegex = /\[APPLY (HARM|FATIGUE|BOON|OBLIGATION|CORRUPTION|LEASH) ([A-Za-z0-9_]+) (\d+)(?:\s+(\d+))?\]/gi;
    while ((match = applyRegex.exec(text)) !== null) {
        const type = match[1].toLowerCase();
        const name = match[2];
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

    // [TICK TIMER ...]
    const tickRegex = /\[TICK TIMER "([^"]+)" (\d+)\]/gi;
    while ((match = tickRegex.exec(text)) !== null) {
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

    // [TIMER ...]
    const createRegex = /\[TIMER "([^"]+)" (\d+) "([^"]*)"\]/gi;
    while ((match = createRegex.exec(text)) !== null) {
        const name = match[1];
        const max = parseInt(match[2]);
        const onFill = match[3] || 'Timer fills.';
        timersModule.addTimer(campaignState, name, max, onFill);
        saveCampaign();
        output = output.replace(match[0], `*(Timer "${name}" created with ${max} segments)*`);
    }

    // ─── Deck tags (now via WebSocket) ─────────────────────────────
    // [DRAW ...] – WebSocket deck-draw
    const drawRegex = /\[DRAW (\d+) (\w+)\]/gi;
    while ((match = drawRegex.exec(text)) !== null) {
        const count = parseInt(match[1]);
        const region = match[2];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'deck-draw', count, region }));
            output = output.replace(match[0], `*(Requested draw of ${count} cards from ${region})*`);
        } else {
            output = output.replace(match[0], `*(Deck draw not available – WebSocket closed)*`);
        }
    }

    // [CROWN ...] – WebSocket crown-spread
    const crownRegex = /\[CROWN (\w+)\]/gi;
    while ((match = crownRegex.exec(text)) !== null) {
        const region = match[1];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'crown-spread', region }));
            output = output.replace(match[0], `*(Requested Crown Spread for ${region})*`);
        } else {
            output = output.replace(match[0], `*(Crown Spread not available – WebSocket closed)*`);
        }
    }

    // [SPEND SB ...]
    const sbRegex = /\[SPEND SB (\d+)\]/gi;
    while ((match = sbRegex.exec(text)) !== null) {
        const cost = parseInt(match[1]);
        if (campaignState.sb >= cost) {
            campaignState.sb -= cost;
            saveCampaign();
            output = output.replace(match[0], `*(Spent ${cost} Story Beat${cost > 1 ? 's' : ''})*`);
        } else {
            output = output.replace(match[0], '*(Not enough SB)*');
        }
    }

    // [FACT ...]
    const factRegex = /\[FACT (.+?) (.+?)\]/gi;
    while ((match = factRegex.exec(text)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        campaignState.facts[key] = value;
        saveCampaign();
        output = output.replace(match[0], '');
    }

    // ─── NPC CAST: GM spends SB to have an NPC cast a spell ──
    const npcCastRegex = /\[NPC CAST "([^"]+)" ([^\]]+)\]/gi;
    while ((match = npcCastRegex.exec(text)) !== null) {
        const spellName = match[1];
        const target = match[2].trim();
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
    generateEtiquetteReminder
};