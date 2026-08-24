// modules/commands/gm-commands.js
// Extracted from the original monolithic modules/commands.js.
// Main !gm command dispatcher (handleBotCommand) plus its small
// argument parser. Kept as one cohesive function rather than split
// further per-subcommand, since every branch shares the same
// mutable local state (parsed args, character lookups, the
// post-gate GM-role check) and splitting it risks subtly changing
// dispatch order or the role gate's exact logical position.

const diceModule = require('../dice');
const timersModule = require('../timers');
const adventureDirector = require('../adventure-director');
const travelModule = require('../travel');
const rulesModule = require('../rules-index');
const { formatColumns, shortTitle } = require('../format-utils');
const { getVocab, encounterType, DEFAULT_TYPE } = require('../objective-types');
const knowledgeIndex = require('../knowledge-index');
const assistantSuggestions = require('../assistant-suggestions');
const adventureContext = require('../adventure-context');
const assistantSynthesis = require('../assistant-synthesis');
const wsCorrelator = require('../ws-correlator');
const WebSocket = require('ws');
const { globalApiRequest } = require('./api-client');
const { encounterIcon, placeOrUpdateToken, moveToken, removeToken, clearEnemyTokens, inferFaction } = require('./tokens');
const { ensureCharacterOnServer, syncCharactersFromServer } = require('./characters-sync');
const { resolveNPCAction } = require('./npc-actions');

function parseArgs(text) {
    const parts = text.split(/\s+/);
    const cmd = parts[1]?.toLowerCase();
    const args = parts.slice(2);
    return { cmd, args };
}

// Helper to ensure character exists on server (uses context.apiRequest)

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
!gm deck crown [region] [--raw] - Crown Spread. As Assistant GM, synthesizes up to 3 grounded interpretations for GM approval (!gm suggestions) unless --raw or ASSISTANT_SYNTHESIS_ENABLED=false
!gm deck history - show recent draws (if supported)
!gm spend sb <N> [table|deck] [--raw] - spend N Story Beats; as Assistant GM, synthesizes a grounded complication for GM approval unless --raw or ASSISTANT_SYNTHESIS_ENABLED=false
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
    // BUGFIX: this gate used to run unconditionally, ahead of the
    // suggestions/approve/reject/confirm-takeover block below (which
    // requires myRole === 'assistant-gm'). Since nobody can be both
    // 'gm' and 'assistant-gm' at once, that made those four commands
    // unreachable dead code -- an Assistant GM's own suggestion-queue
    // commands could never actually run via chat for anyone. Exempting
    // them here (rather than moving them earlier) keeps this fix a
    // single-line, easy-to-audit change instead of reordering the file.
    // NEW: 'spend' (!gm spend sb ...) and 'deck' (!gm deck crown ...) are
    // also now reachable by an Assistant GM -- see ROADMAP.md item 2 --
    // each with its own inner role check further down (spend sb allows
    // gm/assistant-gm and applies-vs-suggests accordingly; deck now
    // allows gm/assistant-gm for the same reason). Same fix shape as the
    // four commands above: exempt here rather than reorder the file.
    if (context.myRole !== 'gm' && !['suggestions', 'approve', 'reject', 'confirm-takeover', 'spend', 'deck'].includes(cmd)) {
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

    // ─── SB spend synthesis ────────────────────────────────────────────
    // See ROADMAP.md item 2. Available to full GM too (applies immediately,
    // no approval needed there) as well as Assistant GM (goes through the
    // suggestion queue below, same as everything else with narrative
    // weight in that mode).
    if (cmd === 'spend' && args[0]?.toLowerCase() === 'sb') {
        const isAssistant = context.myRole === 'assistant-gm';
        if (context.myRole !== 'gm' && !isAssistant) return 'Only the GM (or Assistant GM) can spend Story Beats this way.';
        const rawFlag = args.includes('--raw');
        const positional = args.slice(1).filter(a => a !== '--raw');
        const n = parseInt(positional[0]);
        if (!n || n < 1) return 'Usage: `!gm spend sb <N> [table|deck] [--raw]`';
        const mode = (positional[1] || 'deck').toLowerCase();
        if (mode !== 'table' && mode !== 'deck') return 'Usage: `!gm spend sb <N> [table|deck] [--raw]` — mode must be "table" or "deck".';
        if ((campaignState.sb || 0) < n) return `❌ Not enough SB (need ${n}, have ${campaignState.sb || 0}).`;

        const region = campaignState.scene?.region || 'Acasia';
        let sceneContext = '';
        try { sceneContext = await adventureContext.getSceneContextForPrompt({ apiRequest: context.apiRequest }); } catch (e) { /* best-effort */ }
        const { text, synthesized } = await assistantSynthesis.synthesizeSbSpend({
            n, mode, region, driver: context.driver, sceneContext, raw: rawFlag,
        });

        // Returned directly by a full-GM invocation (posted as this
        // command's own reply); returned from the suggestion's apply()
        // when Assistant GM approves it (posted as *that* command's
        // reply by the existing `!gm approve` handler below -- see its
        // "✅ Approved.\n${result}" line). Either way this is returned,
        // never sent directly, so it's never posted twice.
        const applySpend = async () => {
            campaignState.sb -= n;
            await saveCampaign();
            return `💥 **Spending ${n} SB${synthesized ? '' : ' (raw)'}:** ${text}`;
        };

        if (!isAssistant) {
            return await applySpend();
        }
        assistantSuggestions.enqueue({
            kind: 'sb-spend-synthesis',
            label: `Spend ${n} SB (${mode})${synthesized ? '' : ' — raw'}`,
            preview: text,
            apply: applySpend,
        });
        return `📋 Proposed spending ${n} SB — see \`!gm suggestions\` to approve.`;
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
    // NEW: Assistant GM may use these too (previously gm-only) -- see
    // ROADMAP.md item 2. Drawing/shuffling/crown-spreading isn't itself a
    // narrative-authority act (it doesn't mutate campaign truth), so it
    // doesn't need to go through the suggestion queue; only the *synthesis*
    // step below (crown interpretations, sb-spend complications) does.
    if (cmd === 'deck') {
        const isAssistant = context.myRole === 'assistant-gm';
        if (context.myRole !== 'gm' && !isAssistant) return 'Only the GM (or Assistant GM) can use deck commands.';
        const sub = args[0]?.toLowerCase();
        const param1 = args[1];
        const param2 = args[2];
        const rawFlag = args.includes('--raw');
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
                // The actual draw always goes through the server (same as
                // before) so every connected client's deck history / Crown
                // Spread visualization stays in sync. What's new: we also
                // wait for that draw's response and, in Assistant GM mode,
                // run it through an LLM synthesis pass instead of just
                // letting the templated broadcast speak for itself.
                const waitP = wsCorrelator.waitFor('crown-spread', 15000);
                waitP.catch(() => {}); // avoid an unhandled rejection when the full-GM branch below never awaits it
                ws.send(JSON.stringify({ type: 'crown-spread', region }));
                if (!isAssistant) {
                    // Full GM: unchanged behavior, fire-and-forget -- the
                    // server's broadcast (and web client's toast/chat card)
                    // already covers this.
                    return `👑 Crown Spread requested from ${region}.`;
                }
                let crownSpreadResult;
                try {
                    crownSpreadResult = await waitP;
                } catch (e) {
                    return `👑 Crown Spread requested from ${region} (drawing on the shared table now) — synthesis will be skipped: ${e.message}`;
                }
                let sceneContext = '';
                try { sceneContext = await adventureContext.getSceneContextForPrompt({ apiRequest: context.apiRequest }); } catch (e) { /* best-effort */ }
                const { texts, synthesized } = await assistantSynthesis.synthesizeCrownInterpretations({
                    crownSpreadResult, driver: context.driver, sceneContext, raw: rawFlag, count: 3,
                });
                if (!synthesized) {
                    // Raw/disabled/failed -- nothing to approve, the
                    // server's own broadcast already delivered the
                    // templated reading to the table.
                    return `👑 Crown Spread drawn from ${region} (raw — no synthesis).`;
                }
                const groupId = `crown_${Date.now()}`;
                const entries = texts.map((text, idx) => assistantSuggestions.enqueue({
                    kind: 'crown-synthesis',
                    label: `Crown Spread interpretation ${idx + 1}/${texts.length} — ${region}`,
                    preview: text,
                    groupId,
                    // See the SB-spend applySpend() comment above -- apply()
                    // returns the text, it doesn't send it directly, so the
                    // existing `!gm approve` handler is the single place
                    // that ever posts it to chat.
                    apply: async () => `👑 **Crown Spread (${region}):** ${text}`,
                }));
                return `👑 ${entries.length} Crown Spread interpretation(s) from ${region} proposed — see \`!gm suggestions\` (approving one auto-rejects the others).`;
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

module.exports = { handleBotCommand, parseArgs };
