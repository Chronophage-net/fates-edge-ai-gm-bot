// modules/adventure-director.js
//
// Adventure selection/lifecycle for the AI GM bot.
//
// Handles:
//   - Default behavior: if no adventure is loaded server-side, prompt
//     players to pick one (available modules + last 5 custom Crown
//     Spread adventures + a "new Crown Spread" option).
//   - Crown Spread flow: poll for a region, draw via the room's deck
//     (POST /api/rooms/:code/deck/crown, same endpoint the web client
//     uses), send the synthesis to the LLM driver to build a full
//     adventure (acts/scenes/encounters/bestiary/campaignTimers) with a
//     real title, save it into the last-5 custom list, and load it via
//     the load-custom endpoint (server/adventure.js) since it has no
//     file on disk.
//   - !gm adventure vote abandon — majority vote among currently-present
//     players resets the adventure back to the selection prompt.
//   - !gm adventure reset — reset the CURRENT adventure back to its start
//     (POST /api/rooms/:code/adventure/reset), no reselection needed.
//
// State lives in orchestrator.campaign.state.adventureDirector, which
// rides along with the existing campaign save/load (ai-gm-bot.js already
// calls orchestrator.campaign.save() after every command) -- no new
// persistence layer needed.
//
// Every command here that mutates server-side adventure state also calls
// adventureContext.invalidate(), so gm-orchestrator.js's NPC lookups and
// the next system-prompt build immediately see the change instead of
// waiting out adventure-context.js's cache TTL.
//
// INTEGRATION (see the three snippets below this file):
//   1. commands.js: route `!gm adventure ...` to handleAdventureCommand().
//   2. ai-gm-bot.js: call maybePromptOnStartup() once the bot confirms
//      it's GM, alongside the existing scheduleStartupMessage() call.
//   3. ai-gm-bot.js: inject adventureContext.getSceneContextForPrompt()
//      into fullSystemPrompt when building free-form narration.

const adventureContext = require('./adventure-context');

const MAX_CUSTOM_ADVENTURES = 5;
const ABANDON_VOTE_RATIO = 0.5; // majority of currently-present players

// ─── State helpers ──────────────────────────────────────────────────

function getDirectorState(orchestrator) {
    const state = orchestrator.campaign.state;
    if (!state.adventureDirector) {
        state.adventureDirector = {
            pendingSelection: null,   // { options: [...], awaitingRegion: bool }
            customAdventures: [],     // last MAX_CUSTOM_ADVENTURES { id, title, tier, content, createdAt }
            abandonVotes: [],         // array of sender names who've voted this round
        };
    }
    return state.adventureDirector;
}

function pushCustomAdventure(orchestrator, entry) {
    const dir = getDirectorState(orchestrator);
    dir.customAdventures.unshift(entry);
    if (dir.customAdventures.length > MAX_CUSTOM_ADVENTURES) {
        dir.customAdventures.length = MAX_CUSTOM_ADVENTURES;
    }
}

// ─── Region list (reuses data/regions.js, already loaded elsewhere) ──

function getRegionNames() {
    try {
        const regions = require('../data/regions.js');
        return Object.keys(regions);
    } catch (e) {
        return ['Acasia']; // safe fallback -- matches the server/deck default region
    }
}

// ─── Building the selection menu ─────────────────────────────────────

async function buildSelectionMenu(context) {
    const dir = getDirectorState(context.orchestrator);
    const options = [];

    // Available modules from the server (type: "adventure" only)
    try {
        const modulesRes = await context.globalApiRequest('/modules');
        const adventureModules = (modulesRes.modules || []).filter(m => m.type === 'adventure');
        for (const m of adventureModules) {
            options.push({ kind: 'module', moduleId: m.id, label: `${m.name} (Tier ${m.tierRange || m.tier || '?'})` });
        }
    } catch (e) {
        console.warn('[AdventureDirector] Could not fetch /api/modules:', e.message);
    }

    // Last N custom (Crown Spread) adventures
    for (const custom of dir.customAdventures) {
        options.push({ kind: 'custom', customId: custom.id, label: `${custom.title} (Tier ${custom.tier}) — saved custom adventure` });
    }

    // Always-available: generate a brand new one
    options.push({ kind: 'crown', label: 'Draw a Crown Spread and build a new adventure' });

    return options;
}

function formatSelectionMenu(options) {
    const lines = options.map((o, i) => `${i + 1}. ${o.label}`);
    return (
        `**No adventure is currently running. Choose one:**\n` +
        lines.join('\n') +
        `\n\nType \`!gm adventure choose <number>\` to pick.`
    );
}

/**
 * Show the selection menu (available modules + last 5 custom + Crown
 * Spread) if nothing is loaded server-side. Safe to call repeatedly --
 * it checks live server state first rather than trusting local memory,
 * so it can't drift out of sync with a reset/abandon that happened
 * through some other path (e.g. a human GM using the web client).
 */
async function maybePromptOnStartup(context) {
    let current;
    try {
        current = await context.apiRequest('GET', ['adventure']);
    } catch (e) {
        console.warn('[AdventureDirector] Could not fetch adventure state:', e.message);
        return;
    }
    if (current && current.moduleId && current.status === 'active') {
        return; // already running something -- nothing to do
    }
    await promptSelection(context);
}

async function promptSelection(context) {
    const dir = getDirectorState(context.orchestrator);
    const options = await buildSelectionMenu(context);
    dir.pendingSelection = { options, awaitingRegion: false };
    context.sendChat(formatSelectionMenu(options));
}

// ─── Crown Spread → adventure (via LLM) ──────────────────────────────

function buildAdventurePrompt(synthesis, cardsText, region) {
    return `You are building a structured Fate's Edge adventure module from a Crown Spread card reading.

Region: ${region}
Cards drawn: ${cardsText}
Reading synthesis: ${synthesis}

Respond with ONLY a single JSON object (no markdown fences, no commentary) matching this exact shape:

{
  "title": "An evocative adventure title (not just the region name)",
  "description": "1-2 sentence hook",
  "tier": "I",
  "tierRange": "I",
  "author": "AI GM (Crown Spread)",
  "acts": [
    {
      "id": "act-1",
      "title": "Act title",
      "description": "What this act is about",
      "scenes": [
        {
          "id": "scene-1-1",
          "title": "Scene title",
          "description": "Read-aloud/narrative text for this scene, 2-4 sentences",
          "timers": [ { "name": "Timer name", "segments": 4, "current": 0, "description": "What it tracks" } ],
          "encounters": [
            { "name": "Encounter name", "dv": 3, "position": "Controlled", "outcomes": { "clean": "...", "partial": "...", "miss": "..." } }
          ]
        }
      ]
    }
  ],
  "npcs": [ { "id": "npc-1", "name": "Name", "role": "Role", "motivation": "Motivation" } ],
  "locations": [ { "id": "loc-1", "name": "Name", "description": "Description" } ],
  "factions": [],
  "campaignTimers": [ { "name": "Timer name", "segments": 6, "current": 0, "description": "The pressure driving this adventure" } ],
  "bestiary": [],
  "notes": "Any GM-facing notes tying back to the Crown Spread reading"
}

Write 2-3 acts, each with 1-2 scenes. Keep it playable in a single session. Every encounter needs all three outcome tiers (clean/partial/miss). Output ONLY the JSON object.`;
}

/** Strip markdown code fences an LLM sometimes wraps JSON in, then parse. */
function parseAdventureJson(raw) {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(text);
}

/** Minimal, always-valid fallback adventure if the LLM output can't be parsed. */
function buildFallbackAdventure(synthesis, cardsText, region) {
    return {
        title: `The ${region} Reading`,
        description: synthesis.slice(0, 200),
        tier: 'I',
        tierRange: 'I',
        author: 'AI GM (Crown Spread, fallback)',
        acts: [{
            id: 'act-1',
            title: 'The Reading Unfolds',
            description: synthesis,
            scenes: [{
                id: 'scene-1-1',
                title: 'Opening Scene',
                description: synthesis,
                timers: [{ name: 'Adventure Clock', segments: 6, current: 0, description: 'Overall pace' }],
                encounters: []
            }]
        }],
        npcs: [],
        locations: [],
        factions: [],
        campaignTimers: [{ name: 'Adventure Clock', segments: 8, current: 0, description: 'Overall adventure pace' }],
        bestiary: [],
        notes: `Cards: ${cardsText}. Region: ${region}.`
    };
}

async function runCrownSpreadFlow(context, region) {
    context.sendChat(`*Drawing a Crown Spread for ${region}...*`);

    let crownResult;
    try {
        crownResult = await context.apiRequest('POST', ['deck', 'crown'], { region });
    } catch (e) {
        context.sendChat(`*The cards would not settle: ${e.message}*`);
        return;
    }

    const cardsText = (crownResult.cards || [])
        .map(c => c.isJoker ? `Joker (${c.rank})` : `${c.rankName} of ${c.suitName}`)
        .join(', ');
    const synthesis = typeof crownResult.result?.synthesis === 'string'
        ? crownResult.result.synthesis
        : JSON.stringify(crownResult.result?.synthesis || crownResult.result || '');

    context.sendChat(`*The cards fall: ${cardsText}.*\n${synthesis}\n\n*Weaving this into an adventure...*`);

    let adventureContent;
    try {
        const raw = await context.driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge adventure designer. You output only valid JSON, nothing else.',
            messages: [{ role: 'user', content: buildAdventurePrompt(synthesis, cardsText, region) }]
        });
        adventureContent = parseAdventureJson(raw);
        if (!adventureContent.title || !Array.isArray(adventureContent.acts) || adventureContent.acts.length === 0) {
            throw new Error('LLM output missing required fields');
        }
    } catch (e) {
        console.warn('[AdventureDirector] LLM adventure generation failed, using fallback:', e.message);
        adventureContent = buildFallbackAdventure(synthesis, cardsText, region);
    }

    const customId = `custom_${Date.now()}`;
    pushCustomAdventure(context.orchestrator, {
        id: customId,
        title: adventureContent.title,
        tier: adventureContent.tier || 'I',
        content: adventureContent,
        createdAt: Date.now()
    });

    try {
        await context.apiRequest('POST', ['adventure', 'load-custom'], { content: adventureContent, id: customId });
        adventureContext.invalidate();
    } catch (e) {
        context.sendChat(`*Built the adventure but couldn't load it: ${e.message}*`);
        return;
    }

    const dir = getDirectorState(context.orchestrator);
    dir.pendingSelection = null;
    dir.abandonVotes = [];

    context.sendChat(
        `**"${adventureContent.title}"**\n${adventureContent.description || ''}\n\n` +
        `*The adventure begins. Use \`!gm adventure\` to check status, or \`!gm adventure vote abandon\` if the party wants out.*`
    );
}

// ─── Vote to abandon ──────────────────────────────────────────────────

async function handleAbandonVote(sender, context) {
    const dir = getDirectorState(context.orchestrator);
    if (!dir.abandonVotes.includes(sender)) {
        dir.abandonVotes.push(sender);
    }

    const needed = Math.max(1, Math.ceil((context.playerCount || 1) * ABANDON_VOTE_RATIO));
    const have = dir.abandonVotes.length;

    if (have < needed) {
        return `*${sender} votes to abandon this adventure (${have}/${needed} needed).*`;
    }

    dir.abandonVotes = [];
    try {
        await context.apiRequest('POST', ['adventure', 'reset']);
        adventureContext.invalidate();
    } catch (e) {
        // Reset failing isn't fatal to the abandon flow -- still re-prompt.
        console.warn('[AdventureDirector] adventure/reset failed during abandon:', e.message);
    }
    context.sendChat('*The party abandons this path. A new road must be chosen.*');
    await promptSelection(context);
    return null; // already sent via sendChat above
}

// ─── Command entry point ──────────────────────────────────────────────

/**
 * Handles `!gm adventure ...`. Returns a string to send as a reply, or
 * null if the response was already sent via context.sendChat() directly
 * (some flows, like Crown Spread generation, take a while and want to
 * narrate progress rather than return one final string).
 */
async function handleAdventureCommand(sender, args, context) {
    const dir = getDirectorState(context.orchestrator);
    const sub = (args[0] || '').toLowerCase();

    // ─── !gm adventure  (no args -- status, or re-show the menu) ───
    if (!sub) {
        let current;
        try {
            current = await context.apiRequest('GET', ['adventure']);
        } catch (e) {
            return `*Couldn't reach the adventure engine: ${e.message}*`;
        }
        if (current && current.moduleId && current.status === 'active') {
            const sceneTitle = current.currentScene?.title || 'Unknown scene';
            const actTitle = current.currentAct?.title || 'Unknown act';
            return `**${current.title}** — ${actTitle} / ${sceneTitle}\nUse \`!gm adventure vote abandon\` or \`!gm adventure reset\`.`;
        }
        await promptSelection(context);
        return null;
    }

    // ─── !gm adventure choose <n> ───────────────────────────────────
    if (sub === 'choose') {
        if (!dir.pendingSelection) {
            return '*No selection is pending. Type `!gm adventure` to see the menu.*';
        }
        const idx = parseInt(args[1], 10) - 1;
        const chosen = dir.pendingSelection.options[idx];
        if (!chosen) {
            return `*Invalid choice. Pick a number between 1 and ${dir.pendingSelection.options.length}.*`;
        }

        if (chosen.kind === 'crown') {
            dir.pendingSelection.awaitingRegion = true;
            const regions = getRegionNames();
            const lines = regions.map((r, i) => `${i + 1}. ${r}`).join('\n');
            dir.pendingSelection.regionOptions = regions;
            return `**Choose a region for the Crown Spread:**\n${lines}\n\nType \`!gm adventure region <number>\`.`;
        }

        if (chosen.kind === 'module') {
            try {
                await context.apiRequest('POST', ['adventure', 'load'], { moduleId: chosen.moduleId });
                adventureContext.invalidate();
            } catch (e) {
                return `*Failed to load "${chosen.label}": ${e.message}*`;
            }
            dir.pendingSelection = null;
            dir.abandonVotes = [];
            return `**"${chosen.label}" begins.** Use \`!gm adventure\` to check status any time.`;
        }

        if (chosen.kind === 'custom') {
            const saved = dir.customAdventures.find(c => c.id === chosen.customId);
            if (!saved) return '*That saved adventure is no longer available.*';
            try {
                await context.apiRequest('POST', ['adventure', 'load-custom'], { content: saved.content, id: saved.id });
                adventureContext.invalidate();
            } catch (e) {
                return `*Failed to load "${saved.title}": ${e.message}*`;
            }
            dir.pendingSelection = null;
            dir.abandonVotes = [];
            return `**"${saved.title}" resumes from the top.** Use \`!gm adventure\` to check status any time.`;
        }

        return '*Something went wrong with that choice.*';
    }

    // ─── !gm adventure region <n>  (only meaningful mid Crown-Spread-selection) ───
    if (sub === 'region') {
        if (!dir.pendingSelection?.awaitingRegion) {
            return '*Not currently choosing a region. Type `!gm adventure` to start over.*';
        }
        const idx = parseInt(args[1], 10) - 1;
        const region = dir.pendingSelection.regionOptions?.[idx];
        if (!region) {
            return `*Invalid choice. Pick a number between 1 and ${dir.pendingSelection.regionOptions?.length || 0}.*`;
        }
        dir.pendingSelection = null; // consumed
        await runCrownSpreadFlow(context, region);
        return null; // narrated via sendChat inside runCrownSpreadFlow
    }

    // ─── !gm adventure crown  (shortcut straight into Crown Spread, skipping the menu) ───
    if (sub === 'crown') {
        const regions = getRegionNames();
        dir.pendingSelection = { options: [{ kind: 'crown', label: 'Crown Spread' }], awaitingRegion: true, regionOptions: regions };
        const lines = regions.map((r, i) => `${i + 1}. ${r}`).join('\n');
        return `**Choose a region for the Crown Spread:**\n${lines}\n\nType \`!gm adventure region <number>\`.`;
    }

    // ─── !gm adventure vote abandon ─────────────────────────────────
    if (sub === 'vote' && (args[1] || '').toLowerCase() === 'abandon') {
        return await handleAbandonVote(sender, context);
    }

    // ─── !gm adventure reset ────────────────────────────────────────
    if (sub === 'reset') {
        try {
            await context.apiRequest('POST', ['adventure', 'reset']);
            adventureContext.invalidate();
        } catch (e) {
            return `*Reset failed: ${e.message}*`;
        }
        dir.abandonVotes = [];
        return '*The adventure resets to its beginning.*';
    }

    return (
        '*Unknown adventure command. Try:*\n' +
        '`!gm adventure` — status or selection menu\n' +
        '`!gm adventure choose <n>` — pick from the menu\n' +
        '`!gm adventure region <n>` — pick a region during Crown Spread setup\n' +
        '`!gm adventure crown` — jump straight to a Crown Spread\n' +
        '`!gm adventure vote abandon` — vote to abandon the current adventure\n' +
        '`!gm adventure reset` — restart the current adventure from the top'
    );
}

module.exports = {
    handleAdventureCommand,
    maybePromptOnStartup,
    MAX_CUSTOM_ADVENTURES,
};
