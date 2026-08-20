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
//
// CHANGED (this pass), cross-checked against the real server/adventure.js:
//   - status is 'planned' | 'active' | 'completed'. A just-reset
//     adventure is 'planned' but still fully loaded (moduleId intact) --
//     it must NOT be treated the same as "nothing loaded". All the
//     ad-hoc `current.status === 'active'` checks below now go through
//     adventureContext.isAdventureActive(), the single shared definition,
//     so this file and adventure-context.js can never disagree again.
//   - GM-only gating for adventure-management subcommands was previously
//     completely absent -- any player could type `!gm adventure reset`
//     or `!gm adventure choose <n>` and it would just run. Added a role
//     check inside handleAdventureCommand() itself (rather than in
//     commands.js's dispatcher) so the one genuinely democratic
//     subcommand, `vote abandon`, stays open to everyone.
//   - parseAdventureJson() now tolerates an LLM prefacing the JSON with
//     prose instead of only stripping fences at the exact start/end --
//     previously any stray "Here's the adventure:" before the JSON threw
//     and silently fell back to the generic filler adventure every time.

const adventureContext = require('./adventure-context');
const { formatColumns, shortTitle } = require('./format-utils');
const legacyTracker = require('./legacy-tracker'); // NEW: structured cross-adventure carryover -- see that file's header
const WebSocket = require('ws'); // NEW: Reactive Soundscape -- see advanceScene()/maybeSendAmbience() below

const MAX_CUSTOM_ADVENTURES = 5;
const ABANDON_VOTE_RATIO = 0.5; // majority of currently-present players
// NEW: how many !gm session end marks before a dynamic-growth adventure
// generates its climax instead of another regular scene. Chosen as a
// module-level default; could be made configurable per-adventure later
// (e.g. asked as a question during Crown Spread setup) if 4 doesn't fit
// your table's pace.
const DEFAULT_CLIMAX_AFTER_SESSIONS = 4;
// NEW: default cap on scene-transitions a dynamic-growth adventure's climax
// act gets before this director is allowed to force a dramatic turn toward
// resolution instead of letting the climax stall indefinitely -- see
// handleSceneComplete()'s climax-pacing check and server/adventure.js's
// matching DEFAULT_CLIMAX_PAD_SCENES/climaxScenesSinceTrigger tracking.
const DEFAULT_CLIMAX_PAD_SCENES = 2;
// Cap on how many completed-adventure summaries to keep for continuity.
// This is the whole point of archiving summaries instead of raw chat
// logs -- a handful of paragraphs of history, not megabytes of transcript.
const MAX_ARCHIVED_ADVENTURES = 10;

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

/**
 * NEW: Clear the bot's own local narrative memory (chat history + rolling
 * summary) whenever an adventure is loaded, swapped, or reset.
 *
 * Root cause this fixes: loading a new adventure (or a different one via
 * choose/abandon) correctly updates SERVER-side state (adventure.js's
 * module/currentAct/currentScene) and invalidates adventure-context.js's
 * cache, so the system prompt's live scene-context block updates
 * immediately. But ai-gm-bot.js still feeds the LLM
 * `orchestrator.campaign.state.conversation` as actual chat history every
 * turn -- and that array is untouched by an adventure swap. A dozen+
 * turns of real dialogue about the OLD adventure's NPCs/plot outweighs a
 * few lines of system-prompt scene description, so the model just
 * continues the old story regardless of what's "loaded" server-side.
 * (Command replies like "'X' begins" never even enter this history --
 * they go straight to sendChat -- so the model has no signal at all that
 * anything changed.) Clearing conversation + summary here means the next
 * AI turn starts genuinely fresh, grounded only in the new adventure's
 * own scene context.
 *
 * Deliberately leaves campaign-wide facts (campaign_seed/campaign_hook/
 * campaign_region from the initial Crown Spread seeding) untouched --
 * those describe the overall campaign, not a specific adventure, and a
 * mid-campaign adventure swap shouldn't erase that framing.
 */
function resetNarrativeState(orchestrator) {
    const state = orchestrator.campaign.state;
    state.conversation = [];
    state.messagesSinceLastSummary = 0;
    if (typeof orchestrator.campaign.setSummary === 'function') {
        orchestrator.campaign.setSummary('');
    }
}

// ─── Region list ───────────────────────────────────────────────────
//
// BUGFIX: this used to `require('../data/regions.js')` — but that file's
// content is a bare JSON object literal (`{ "Kahfagia": {...}, ... }`)
// with a `.js` extension and no `module.exports =`. A top-level `{` is
// parsed by Node as a block statement, and `"Kahfagia": {...}` inside it
// is not valid JS (string literals can't be statement labels), so the
// require() ALWAYS threw a SyntaxError and this function ALWAYS fell
// back to the single hardcoded ['Acasia'] — every Crown Spread region
// picker only ever offered one region, no matter how many were actually
// loaded. It's also a second, separately-maintained 16-region dataset
// that had already drifted from the real 23-region data/regions/*.json
// set (missing Dungeons, Midh Ahkaz, Silkstrand, The Wilds, The Ways
// Between, Theona, Vilikari), and its Title-Case keys ("Black Banners")
// don't match the underscore ids ("black_banners") the deck/card-meaning
// system looks files up by.
//
// Fix: read straight from WorldManager's already-loaded region set (the
// same data deck.js/world-manager.js's getRegion() use), returning
// {id, title} pairs. `id` is what gets sent on to the deck/Crown Spread
// endpoint; `title` is only for display. Falls back to the static file
// (now fixed to be valid JS — see data/regions.js) only if WorldManager
// hasn't loaded any regions for some reason, and to a single safe
// default after that.
function getRegionList(context) {
    const world = context?.orchestrator?.world;
    if (world && typeof world.listRegions === 'function') {
        const regions = world.listRegions();
        if (regions.length > 0) return regions;
    }
    try {
        const regions = require('../data/regions.js');
        return Object.keys(regions).map(title => ({ id: title.toLowerCase().replace(/\s+/g, '_'), title }));
    } catch (e) {
        return [{ id: 'acasia', title: 'Acasia' }]; // safe fallback -- matches the server/deck default region
    }
}

// Formats a region list as a numbered, `ls`-style multi-column block —
// there are 20+ regions, and a one-per-line list runs off the screen.
// Uses the short form of each title (drops the " — Subtitle" flavor
// text) so labels are compact enough to actually land more than one per
// row; the full title still shows once a region is chosen.
function formatRegionMenu(regions) {
    const items = regions.map((r, i) => `${i + 1}. ${shortTitle(r.title)}`);
    return formatColumns(items, { width: 60, maxCols: 4 });
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
            // NEW: capture description too -- previously only name/tier
            // were kept, so !gm adventure preview had nothing to show
            // for module options without an extra round-trip.
            options.push({
                kind: 'module',
                moduleId: m.id,
                label: `${m.name} (Tier ${m.tierRange || m.tier || '?'})`,
                description: m.description || '',
            });
        }
    } catch (e) {
        console.warn('[AdventureDirector] Could not fetch /api/modules:', e.message);
    }

    // Last N custom (Crown Spread) adventures
    for (const custom of dir.customAdventures) {
        options.push({
            kind: 'custom',
            customId: custom.id,
            label: `${custom.title} (Tier ${custom.tier}) — saved custom adventure`,
            description: custom.content?.description || '',
        });
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
 * Spread) if nothing usable is loaded server-side. Safe to call
 * repeatedly -- it checks live server state first rather than trusting
 * local memory, so it can't drift out of sync with a reset/abandon that
 * happened through some other path (e.g. a human GM using the web
 * client).
 */
async function maybePromptOnStartup(context) {
    let current;
    try {
        current = await context.apiRequest('GET', ['adventure']);
    } catch (e) {
        console.warn('[AdventureDirector] Could not fetch adventure state:', e.message);
        return;
    }
    if (adventureContext.isAdventureActive(current)) {
        return; // already running (or paused mid-reset) something -- nothing to do
    }
    await promptSelection(context);
}

async function promptSelection(context) {
    const dir = getDirectorState(context.orchestrator);
    const options = await buildSelectionMenu(context);
    dir.pendingSelection = { options, awaitingRegion: false };
    context.sendChat(formatSelectionMenu(options));
}

/**
 * NEW: generates a proper table-setting opening for a just-loaded
 * adventure -- location, mood, time of day, and how the party came to
 * be here -- BEFORE any specific NPC interaction begins. Previously,
 * loading an adventure (module choice, saved custom, or a fresh Crown
 * Spread build) only ever sent a bare templated confirmation string
 * ("'X' begins. Use !gm adventure to check status.") and then silently
 * waited for the player's next chat message -- at which point the AI
 * would narrate straight from the opening SCENE's own terse
 * `description` field, which is often written assuming a GM will
 * supply the connective tissue (hence "suddenly an NPC is already
 * mid-conversation with you," with zero scene-setting beat first).
 * This is now an explicit, dedicated LLM call run right after every
 * successful load, so there's always a proper opening beat regardless
 * of how sparse the raw scene description happens to be.
 *
 * Returns the narration string, or null if generation failed (callers
 * should fall back to something simple rather than leaving total
 * silence).
 */
async function generateOpeningNarration(context, { title, actTitle, sceneTitle, sceneDescription }) {
    const prompt = `You are opening a new Fate's Edge adventure for the players at the table.

Adventure: "${title}"
Opening act: "${actTitle || ''}"
Opening scene: "${sceneTitle || ''}" -- ${sceneDescription || '(no scene description provided)'}

Write a short scene-setting opening (3-5 sentences): establish where the player characters are, what time of day and mood it is, and how they've come to be here. Do NOT jump straight into an NPC who is already mid-conversation, or a decision already in progress -- set the table first. End with a natural, open invitation for the players to look around, ask questions, or act (e.g. "What do you do?"). Write ONLY the narration itself -- no headers, no commentary, no markdown formatting beyond plain prose.`;

    try {
        const narration = await context.driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge Game Master opening a new adventure for the table. Write immersive, concise scene-setting prose only -- nothing else.',
            messages: [{ role: 'user', content: prompt }]
        });
        const trimmed = (narration || '').trim();
        return trimmed || null;
    } catch (e) {
        console.warn('[AdventureDirector] Opening narration generation failed:', e.message);
        return null;
    }
}

/**
 * Fetches the just-loaded adventure's state, generates (or falls back
 * to a simple templated) opening narration, sends it to chat, and
 * seeds it as the first entry in conversation history (resetNarrativeState
 * just cleared that array, so this becomes turn one of the new
 * adventure) -- so the model's NEXT reply continues coherently from an
 * opening it actually "remembers" narrating, rather than contradicting
 * or re-narrating it.
 */
async function announceAdventureOpening(context) {
    let state;
    try {
        state = await context.apiRequest('GET', ['adventure']);
    } catch (e) {
        console.warn('[AdventureDirector] Could not fetch state for opening narration:', e.message);
        return;
    }
    if (!state || !state.moduleId) return;

    const opening = await generateOpeningNarration(context, {
        title: state.title,
        actTitle: state.currentAct?.title,
        sceneTitle: state.currentScene?.title,
        sceneDescription: state.currentScene?.description,
    }) || state.currentScene?.description || state.description || 'The story begins.';

    context.sendChat(opening);

    const convState = context.orchestrator.campaign.state;
    convState.conversation = convState.conversation || [];
    convState.conversation.push({ role: 'assistant', content: opening });
    await context.orchestrator.campaign.save();
}

// ─── Crown Spread → adventure (via LLM) ──────────────────────────────

/** Minimal fallback formatter for a raw {rank, suit} card object, used
 * only if a `.display` string is unexpectedly missing from the server's
 * response (it always should be present -- see deck.js's cardDisplay()). */
function cardToStringFallback(card) {
    if (!card) return '';
    return `${card.rank} of ${card.suit}`;
}

/**
 * NEW: `tension` (optional) carries the highest-non-wildcard-card signal
 * that deck.js's synthesiseCrownSpread() already computes for its own
 * timer-segment suggestion (see server/adventure.js integration in
 * runCrownSpreadFlow below). Deliberately used as a soft PACING nudge --
 * "how urgent/dangerous should this feel" -- rather than a hard mapping
 * from suit to theme. A mechanical "Spades always means combat" rule
 * would make every reading feel like a slot machine over time; a vague
 * intensity cue lets the LLM's own judgment fill in what that urgency
 * actually looks like for this specific synthesis, so ostensibly a
 * "high tension" reading in one region might read as looming war and in
 * another as a ticking curse -- shaped by the actual cards/synthesis,
 * not a fixed lookup table.
 */
function buildAdventurePrompt(synthesis, cardsText, region, tension = null) {
    const tensionParagraph = tension
        ? `\nThe reading's dominant card is the ${tension.cardLabel} -- treat this as a loose sense of how quickly and how intensely this story should build (roughly a ${tension.segments}-beat arc from opening hook to climax), not as a rule dictating specific plot content. Let the synthesis above, not this card alone, decide what actually happens.\n`
        : '';

    return `You are building a structured Fate's Edge adventure module from a Crown Spread card reading.

Region: ${region}
Cards drawn: ${cardsText}
Reading synthesis: ${synthesis}
${tensionParagraph}
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

Write 2-3 acts, each with 1-2 scenes. Keep it playable in a single session. Every encounter needs all three outcome tiers (clean/partial/miss). Give every scene at least one timer with a distinctive, memorable name (not the literal word "Timer") -- the GM bot ticks these by name, and a vague name makes it harder to reference correctly during play. Output ONLY the JSON object.`;
}

/**
 * Strip markdown code fences an LLM sometimes wraps JSON in, then parse.
 * CHANGED: previously only stripped fences at the exact start/end of the
 * string, so any stray prose before/after the JSON (e.g. "Here's the
 * adventure:\n```json...") caused JSON.parse to throw and silently fall
 * back to buildFallbackAdventure() every single time. Now falls back to
 * extracting the outermost {...} block if the trimmed text doesn't
 * already start/end cleanly with braces.
 */
function parseAdventureJson(raw) {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!(text.startsWith('{') && text.endsWith('}'))) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            text = text.slice(start, end + 1);
        }
    }
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

/**
 * CONFIRMED (previously just assumed): POST /api/rooms/:code/deck/crown
 * does return the full crown-spread result synchronously in the HTTP
 * response body. That said, this route was actually BROKEN until
 * recently -- it called `deck.synthesiseCrownSpread(...)`, a function
 * that didn't exist anywhere in deck.js, guaranteeing a 404 on every
 * call. Fixed by adding that function to deck.js (extracted from
 * crownSpread()'s own composition logic). If you're seeing "The cards
 * would not settle" errors, confirm your deployed deck.js actually
 * exports `synthesiseCrownSpread`.
 */
async function runCrownSpreadFlow(context, regionArg) {
    // Accept either a {id, title} pair (from the region picker, post-
    // getRegionList()) or a plain string (backward compatible with any
    // other caller / a typed-in name) -- normalize to both forms here.
    // BUGFIX: every region's `title` includes a display subtitle (e.g.
    // "Black Banners — Condotta & Crowns"), which the server's slugifier
    // can't turn back into a filename. The deck/Crown Spread API call
    // MUST use the bare `id` (e.g. "black_banners", matching
    // data/regions/black_banners.json); only chat narration should use
    // the human-readable `title`.
    const regionId = (regionArg && typeof regionArg === 'object') ? regionArg.id : regionArg;
    const regionTitle = (regionArg && typeof regionArg === 'object') ? (regionArg.title || regionArg.id) : regionArg;

    context.sendChat(`*Drawing a Crown Spread for ${regionTitle}...*`);

    let crownResult;
    try {
        crownResult = await context.apiRequest('POST', ['deck', 'crown'], { region: regionId });
    } catch (e) {
        context.sendChat(`*The cards would not settle: ${e.message}*`);
        return;
    }

    // FIXED: this used to build cardsText from crownResult.cards[i].rankName
    // / .suitName -- but deck.js's card objects only ever have .rank/.suit
    // (e.g. {rank:"A", suit:"Clubs"}), never rankName/suitName. Every card
    // was silently rendering as "undefined of undefined" in both the chat
    // message below and the adventure-generation prompt. Using the
    // already-correctly-formatted `.display` strings (e.g. "♠ Ace of
    // Spades") that synthesiseCrownSpread() computes via deck.js's own
    // cardDisplay() instead.
    const positionDisplays = (crownResult.result?.positions || []).map(p => p.display || cardToStringFallback(p.card));
    const wildcardDisplay = crownResult.result?.wildcard?.display || cardToStringFallback(crownResult.wildcard);
    const cardsText = [...positionDisplays, wildcardDisplay].filter(Boolean).join(', ');

    const synthesis = typeof crownResult.result?.synthesis === 'string'
        ? crownResult.result.synthesis
        : JSON.stringify(crownResult.result?.synthesis || crownResult.result || '');

    // NEW: soft pacing signal from the highest non-wildcard card -- see
    // the tension parameter docstring on buildAdventurePrompt() above for
    // why this stays a loose nudge rather than a hard theme mapping.
    // deck.js's synthesiseCrownSpread() already computes this (originally
    // just to suggest a timer length) -- reusing that exact same signal
    // here rather than inventing a separate, possibly-conflicting one.
    const tension = crownResult.result?.timer
        ? { cardLabel: crownResult.result.timer.card, segments: crownResult.result.timer.segments }
        : null;

    context.sendChat(`*The cards fall: ${cardsText}.*\n${synthesis}\n\n*Weaving this into an adventure...*`);

    let adventureContent;
    try {
        const raw = await context.driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge adventure designer. You output only valid JSON, nothing else.',
            messages: [{ role: 'user', content: buildAdventurePrompt(synthesis, cardsText, regionTitle, tension) }]
        });
        adventureContent = parseAdventureJson(raw);
        if (!adventureContent.title || !Array.isArray(adventureContent.acts) || adventureContent.acts.length === 0) {
            throw new Error('LLM output missing required fields');
        }
    } catch (e) {
        console.warn('[AdventureDirector] LLM adventure generation failed, using fallback:', e.message);
        adventureContent = buildFallbackAdventure(synthesis, cardsText, regionTitle);
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
        // NEW: dynamicGrowth: true opts this specific adventure into the
        // growth system (see server/adventure.js) -- only Crown-Spread-
        // generated adventures get this; module-based and previously-
        // saved-custom adventures do not (they play through to their own
        // authored/previously-generated ending, unmodified).
        await context.apiRequest('POST', ['adventure', 'load-custom'], {
            content: adventureContent,
            id: customId,
            dynamicGrowth: true,
            climaxAfterSessions: DEFAULT_CLIMAX_AFTER_SESSIONS,
            climaxPadScenes: DEFAULT_CLIMAX_PAD_SCENES,
        });
        adventureContext.invalidate();
        resetNarrativeState(context.orchestrator); // NEW: clear stale chat history from any prior adventure
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
    await announceAdventureOpening(context); // NEW: set the stage before play begins
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
        resetNarrativeState(context.orchestrator); // NEW: the party is abandoning this story -- don't let the LLM keep narrating it
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

    // CHANGED: GM-only gate for anything that actually mutates adventure
    // selection/state. `vote abandon` stays open to all players (that's
    // the whole point of it being a vote), and the bare status command
    // (`!gm adventure` with no args) is read-only so it's fine for anyone.
    const gmOnlySubs = ['choose', 'region', 'crown', 'reset', 'debug', 'legacy'];
    if (gmOnlySubs.includes(sub) && context.myRole !== 'gm') {
        return '*Only the Game Master can manage adventure selection. Players can use `!gm adventure vote abandon`.*';
    }

    // ─── !gm adventure  (no args -- status, or re-show the menu) ───
    if (!sub) {
        let current;
        try {
            current = await context.apiRequest('GET', ['adventure']);
        } catch (e) {
            return `*Couldn't reach the adventure engine: ${e.message}*`;
        }
        if (adventureContext.isAdventureActive(current)) {
            const sceneTitle = current.currentScene?.title || 'Unknown scene';
            const actTitle = current.currentAct?.title || 'Unknown act';
            const statusNote = current.status === 'planned' ? ' (reset -- not yet resumed)' : '';
            return `**${current.title}**${statusNote} — ${actTitle} / ${sceneTitle}\nUse \`!gm adventure vote abandon\` or \`!gm adventure reset\`.`;
        }
        await promptSelection(context);
        return null;
    }

    // ─── !gm adventure choose <n> ───────────────────────────────────
    if (sub === 'choose') {
        if (!dir.pendingSelection) {
            await promptSelection(context);
            return null;
        }
        const idx = parseInt(args[1], 10) - 1;
        const chosen = dir.pendingSelection.options[idx];
        if (!chosen) {
            return `*Invalid choice. Pick a number between 1 and ${dir.pendingSelection.options.length}.*`;
        }

        if (chosen.kind === 'crown') {
            dir.pendingSelection.awaitingRegion = true;
            const regions = getRegionList(context);
            dir.pendingSelection.regionOptions = regions;
            return `**Choose a region for the Crown Spread (${regions.length}):**\n\`\`\`\n${formatRegionMenu(regions)}\n\`\`\`\nType \`!gm adventure region <number>\`.`;
        }

        if (chosen.kind === 'module') {
            try {
                await context.apiRequest('POST', ['adventure', 'load'], { moduleId: chosen.moduleId });
                adventureContext.invalidate();
                resetNarrativeState(context.orchestrator); // NEW: clear stale chat history from any prior adventure
            } catch (e) {
                return `*Failed to load "${chosen.label}": ${e.message}*`;
            }
            dir.pendingSelection = null;
            dir.abandonVotes = [];
            context.sendChat(`**"${chosen.label}" begins.** Use \`!gm adventure\` to check status any time.`);
            await announceAdventureOpening(context); // NEW: set the stage before play begins
            return null;
        }

        if (chosen.kind === 'custom') {
            const saved = dir.customAdventures.find(c => c.id === chosen.customId);
            if (!saved) return '*That saved adventure is no longer available.*';
            try {
                await context.apiRequest('POST', ['adventure', 'load-custom'], { content: saved.content, id: saved.id });
                adventureContext.invalidate();
                resetNarrativeState(context.orchestrator); // NEW: clear stale chat history from any prior adventure
            } catch (e) {
                return `*Failed to load "${saved.title}": ${e.message}*`;
            }
            dir.pendingSelection = null;
            dir.abandonVotes = [];
            context.sendChat(`**"${saved.title}" resumes from the top.** Use \`!gm adventure\` to check status any time.`);
            await announceAdventureOpening(context); // NEW: set the stage before play begins
            return null;
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
        const regions = getRegionList(context);
        dir.pendingSelection = { options: [{ kind: 'crown', label: 'Crown Spread' }], awaitingRegion: true, regionOptions: regions };
        return `**Choose a region for the Crown Spread (${regions.length}):**\n\`\`\`\n${formatRegionMenu(regions)}\n\`\`\`\nType \`!gm adventure region <number>\`.`;
    }

    // ─── !gm adventure vote abandon ─────────────────────────────────
    if (sub === 'vote' && (args[1] || '').toLowerCase() === 'abandon') {
        return await handleAbandonVote(sender, context);
    }

    // ─── !gm adventure debug ─────────────────────────────────────────
    // NEW: full raw-ish dump of both getPublicState() (act/scene
    // position, active encounter, campaign timers, table of contents,
    // recent log) and getReferenceData() (bestiary/npcs/locations/
    // factions/notes) -- everything the server already computes but
    // that `!gm adventure`'s one-line status never surfaces. GM-only
    // since reference data includes GM-facing notes/secrets not meant
    // for players.
    if (sub === 'debug') {
        let state;
        try {
            state = await context.apiRequest('GET', ['adventure']);
        } catch (e) {
            return `*Couldn't reach the adventure engine: ${e.message}*`;
        }
        if (!state || !state.moduleId) {
            return '*No adventure is currently loaded.* (state.moduleId is null -- nothing to debug.)';
        }

        const lines = [];
        lines.push('🔧 **Adventure Debug**');
        lines.push(`Module ID: \`${state.moduleId}\``);
        lines.push(`Status: ${state.status}`);
        lines.push(`Dynamic Growth: ${state.dynamicGrowth ? 'ON' : 'off'}${state.dynamicGrowth ? ` (${state.sessionsPlayed || 0}/${state.climaxAfterSessions || DEFAULT_CLIMAX_AFTER_SESSIONS} sessions, climax ${state.climaxTriggered ? 'triggered' : 'not yet triggered'})` : ''}`);
        lines.push(`Position: Act ${state.currentActIndex} / Scene ${state.currentSceneIndex}`);
        if (state.currentAct) lines.push(`Act: "${state.currentAct.title}" -- ${state.currentAct.description || ''}`);
        if (state.currentScene) {
            lines.push(`Scene: "${state.currentScene.title}"`);
            lines.push(`  Description: ${state.currentScene.description || '(none)'}`);
            lines.push(`  Completed: ${!!state.currentScene.completed}`);
            if (state.currentScene.timers?.length) {
                lines.push(`  Scene Timers: ${state.currentScene.timers.map(t => `${t.name} ${t.current}/${t.segments}`).join(', ')}`);
            }
            if (state.currentScene.encounters?.length) {
                lines.push(`  Encounters defined: ${state.currentScene.encounters.map(e => e.name || e.creatureId).join(', ')}`);
            }
        }
        if (state.activeEncounter) {
            lines.push(`Active Encounter: ${JSON.stringify(state.activeEncounter)}`);
        } else {
            lines.push('Active Encounter: none');
        }
        if (state.campaignTimers?.length) {
            lines.push(`Campaign Timers: ${state.campaignTimers.map(t => `${t.name} ${t.current}/${t.segments}`).join(', ')}`);
        }
        if (state.tableOfContents?.length) {
            lines.push('Table of Contents:');
            for (const act of state.tableOfContents) {
                lines.push(`  ${act.title}`);
                for (const s of act.scenes) {
                    lines.push(`    ${s.completed ? '✅' : '⬜'} ${s.title}`);
                }
            }
        }
        if (state.log?.length) {
            lines.push(`Recent Log (last ${state.log.length}):`);
            for (const entry of state.log.slice(-10)) {
                lines.push(`  [${entry.type}] ${entry.message}`);
            }
        }

        let ref = null;
        try {
            ref = await context.apiRequest('GET', ['adventure', 'reference']);
        } catch (e) {
            lines.push(`\n⚠️ Reference data unavailable: ${e.message}`);
        }
        if (ref) {
            lines.push('\n--- Reference Data ---');
            lines.push(`NPCs (${ref.npcs?.length || 0}): ${(ref.npcs || []).map(n => n.name).join(', ') || 'none'}`);
            lines.push(`Locations (${ref.locations?.length || 0}): ${(ref.locations || []).map(l => l.name).join(', ') || 'none'}`);
            lines.push(`Factions (${ref.factions?.length || 0}): ${(ref.factions || []).map(f => f.name).join(', ') || 'none'}`);
            lines.push(`Bestiary (${ref.bestiary?.length || 0}): ${(ref.bestiary || []).map(b => b.name).join(', ') || 'none'}`);
            if (ref.notes) lines.push(`GM Notes: ${ref.notes}`);
        }

        return lines.join('\n');
    }

    // ─── !gm adventure legacy [schema] [set <key> <json-value>|clear] ──
    // NEW: GM transparency/override for the legacy tracker (see
    // modules/legacy-tracker.js) -- "the GM can see exactly what carries
    // over and override it if needed" from the design brief. GM-only
    // (gmOnlySubs above) since legacy values can include GM-facing plot
    // state a player shouldn't be able to rewrite via chat.
    //   !gm adventure legacy                       -- list every tracked schema
    //   !gm adventure legacy <schema>               -- show one schema's values
    //   !gm adventure legacy <schema> set <key> <v> -- override one key by hand
    //   !gm adventure legacy <schema> clear         -- wipe that schema's entry
    if (sub === 'legacy') {
        const schema = args[1];
        if (!schema) {
            return legacyTracker.formatAllLegacy(context.orchestrator);
        }
        const action = (args[2] || '').toLowerCase();
        if (!action) {
            return legacyTracker.formatLegacyEntry(context.orchestrator, schema);
        }
        if (action === 'clear') {
            const existed = legacyTracker.clearLegacy(context.orchestrator, schema);
            await context.orchestrator.campaign.save();
            return existed ? `*Cleared legacy state for \`${schema}\`.*` : `*No legacy state existed for \`${schema}\`.*`;
        }
        if (action === 'set') {
            const key = args[3];
            const rawValue = args.slice(4).join(' ');
            if (!key || !rawValue) {
                return 'Usage: `!gm adventure legacy <schema> set <key> <value>` -- value may be plain text or JSON (e.g. `["a","b"]`, `5`, `{"status":"kept"}`).';
            }
            legacyTracker.setLegacyValue(context.orchestrator, schema, key, rawValue);
            await context.orchestrator.campaign.save();
            return legacyTracker.formatLegacyEntry(context.orchestrator, schema);
        }
        return 'Usage: `!gm adventure legacy [schema] [set <key> <value>|clear]`';
    }

    // ─── !gm adventure preview [n] ───────────────────────────────────
    // NEW: player-facing summary command -- deliberately NOT in
    // gmOnlySubs above, since the whole point is letting any player get
    // a spoiler-safe overview. Two modes:
    //   - An adventure is already loaded/active: preview THAT adventure
    //     (title, tier, current act/scene) regardless of any `n` given.
    //   - Nothing loaded, a selection menu is pending: preview a
    //     specific numbered option's description before committing to
    //     `!gm adventure choose <n>`.
    // Deliberately does NOT include GM-facing reference data (npcs,
    // locations, factions, bestiary, notes) -- that's what
    // `!gm adventure debug` is for, and it's GM-only for exactly this
    // reason (notes/secrets aren't meant for players to see).
    if (sub === 'preview') {
        let current;
        try {
            current = await context.apiRequest('GET', ['adventure']);
        } catch (e) {
            return `*Couldn't reach the adventure engine: ${e.message}*`;
        }

        if (adventureContext.isAdventureActive(current)) {
            const lines = [];
            lines.push(`📖 **${current.title}**${current.tier ? ` (Tier ${current.tierRange || current.tier})` : ''}`);
            if (current.description) lines.push(current.description);
            if (current.currentAct) lines.push(`\n**Current Act:** ${current.currentAct.title}`);
            if (current.currentScene) lines.push(`**Current Scene:** ${current.currentScene.title}`);
            return lines.join('\n');
        }

        if (!dir.pendingSelection) {
            return '*No adventure is active and no selection is pending. Type `!gm adventure` to see the menu.*';
        }
        const idx = args[1] !== undefined ? parseInt(args[1], 10) - 1 : NaN;
        if (isNaN(idx)) {
            return 'Usage: `!gm adventure preview <n>` -- pick a number from the current menu to preview it.';
        }
        const option = dir.pendingSelection.options[idx];
        if (!option) {
            return `*Invalid choice. Pick a number between 1 and ${dir.pendingSelection.options.length}.*`;
        }
        if (option.kind === 'crown') {
            return `🃏 **Draw a Crown Spread** -- this doesn't preview in advance. Choosing it draws 5 fresh cards and builds an entirely new adventure from that reading.`;
        }
        return `📖 **${option.label}**\n${option.description || '(no description available)'}`;
    }

    // ─── !gm adventure reset ────────────────────────────────────────
    if (sub === 'reset') {
        try {
            await context.apiRequest('POST', ['adventure', 'reset']);
            adventureContext.invalidate();
            resetNarrativeState(context.orchestrator); // NEW: a restarted adventure should feel like a genuine fresh start, not a continuation of wherever the story left off
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
        '`!gm adventure preview [n]` — preview the active adventure, or a pending menu option\n' +
        '`!gm adventure region <n>` — pick a region during Crown Spread setup\n' +
        '`!gm adventure crown` — jump straight to a Crown Spread\n' +
        '`!gm adventure vote abandon` — vote to abandon the current adventure\n' +
        '`!gm adventure reset` — restart the current adventure from the top\n' +
        '`!gm adventure debug` — full state + reference data dump (GM only)\n' +
        '`!gm adventure legacy [schema] [set <key> <value>|clear]` — view/override cross-adventure legacy state (GM only)'
    );
}

module.exports = {
    handleAdventureCommand,
    maybePromptOnStartup,
    handleSceneComplete,
    handleSessionEnd,
    MAX_CUSTOM_ADVENTURES,
};

// =====================================================================
// NEW: DYNAMIC GROWTH ENGINE
// =====================================================================
// The pieces below are what actually implement "add scenes/encounters as
// the adventure grows, but with a session-count-based climax/conclusion,
// for Crown-Spread-seeded adventures only; pre-written adventures play
// through to their own natural end unmodified" -- see the architecture
// note in chat for the full design. Everything here is driven by
// handleSceneComplete(), called from commands.js's processSpecialTags()
// whenever the AI emits a [SCENE COMPLETE "notes"] tag.

/**
 * Entry point for the [SCENE COMPLETE "notes"] tag. Decides between:
 *   - ordinary sequential advance (plenty of content left)
 *   - generating + appending one new scene (dynamic-growth adventure,
 *     content about to run out, climax not yet due)
 *   - generating + appending a climax act (dynamic-growth adventure,
 *     session threshold reached, climax not yet triggered)
 *   - a plain advance that's allowed to actually complete (pre-written
 *     adventure running out naturally, OR a dynamic-growth adventure
 *     whose climax act just finished)
 * Returns a short string to splice into the AI's narration in place of
 * the tag, or null if there's no adventure loaded at all (tag is a
 * silent no-op in that case, since scene-tracking simply doesn't apply
 * to freeform play with no adventure loaded).
 */
async function handleSceneComplete(context, notes = '') {
    let state;
    try {
        state = await context.apiRequest('GET', ['adventure']);
    } catch (e) {
        return `*(Couldn't check adventure state: ${e.message})*`;
    }
    if (!state || !state.moduleId) {
        return null; // no adventure loaded -- nothing to advance
    }

    const toc = state.tableOfContents || [];
    const currentActScenes = toc[state.currentActIndex]?.scenes || [];
    const isLastSceneOfAct = state.currentSceneIndex >= currentActScenes.length - 1;
    const isLastAct = state.currentActIndex >= toc.length - 1;
    const wouldExhaust = isLastSceneOfAct && isLastAct;

    // NEW: CLIMAX PACING -- if the climax has been running longer than
    // climaxPadScenes (scene-transitions since climaxTriggered flipped
    // true) without reaching its own final scene, force one dramatic
    // turn now rather than letting it drift indefinitely. Only ever
    // fires once per climax (climaxForced), and only while there's still
    // climax content left to play through -- wouldExhaust below means
    // the climax's own last scene just concluded, which already
    // completes the adventure normally with no forcing needed.
    if (state.climaxTriggered && !state.climaxForced && !wouldExhaust) {
        const pad = state.climaxPadScenes || DEFAULT_CLIMAX_PAD_SCENES;
        if ((state.climaxScenesSinceTrigger || 0) >= pad) {
            return await generateForcedClimaxTwist(context, state, notes);
        }
    }

    if (!wouldExhaust) {
        return await advanceAndReport(context, notes);
    }

    if (!state.dynamicGrowth) {
        // Pre-written (or previously-generated, non-growth) adventure --
        // let it complete exactly as authored, no generation involved.
        return await advanceAndReport(context, notes);
    }

    if (state.climaxTriggered) {
        // The climax act itself just finished -- let it truly complete.
        return await advanceAndReport(context, notes);
    }

    const climaxDue = (state.sessionsPlayed || 0) >= (state.climaxAfterSessions || DEFAULT_CLIMAX_AFTER_SESSIONS);
    if (climaxDue) {
        return await generateAndAppendClimax(context, state, notes);
    }

    return await generateAndAppendScene(context, state, notes);
}

/**
 * NEW: Reactive Soundscape -- fire-and-forget, best-effort ambience cue
 * for the scene a POST /adventure/scene just landed on. No-ops silently
 * (never throws past this function) when soundscape isn't configured
 * (adventureContext.resolveAmbienceEvent() returns null), the scene's
 * inferred mood doesn't map to anything in the GM's profile, or the
 * bot's own WS connection isn't open right now -- exactly the same
 * fail-soft posture as every other optional integration in this repo.
 */
function maybeSendAmbience(context, state) {
    try {
        const mood = adventureContext.inferSceneMood(state);
        const ambience = adventureContext.resolveAmbienceEvent(mood);
        if (!ambience) return;
        const ws = context.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: 'soundboard-ambience',
            mood: ambience.mood,
            trackId: ambience.trackId,
            transitionDuration: ambience.transitionDuration,
        }));
    } catch (e) {
        console.warn('[AdventureDirector] Soundscape ambience trigger failed:', e.message);
    }
}

/**
 * NEW: single choke point for "advance to the next scene" -- every path
 * below (ordinary advance, generated scene, generated climax, forced
 * climax twist) used to duplicate this exact
 * apiRequest+invalidate pair inline; centralizing it here is also where
 * the Reactive Soundscape hook above naturally belongs, so a scene
 * change triggers an ambience cue regardless of which of those four
 * paths caused it.
 */
async function advanceScene(context) {
    const newState = await context.apiRequest('POST', ['adventure', 'scene'], {});
    adventureContext.invalidate();
    maybeSendAmbience(context, newState);
    return newState;
}

/**
 * Plain sequential advance (no growth decision needed), reporting either
 * the new scene or -- if this was the natural end of the adventure --
 * running finalizeAdventure() to archive a summary and re-prompt
 * selection.
 */
async function advanceAndReport(context, notes) {
    let newState;
    try {
        newState = await advanceScene(context);
    } catch (e) {
        return `*(Scene advance failed: ${e.message})*`;
    }
    if (newState.status === 'completed') {
        await finalizeAdventure(context, newState);
        return `*(The adventure reaches its conclusion.)*`;
    }
    return `*(${notes ? notes + ' ' : ''}Moving on to: ${newState.currentScene?.title || 'the next scene'}.)*`;
}

/**
 * Generate ONE new scene continuing the current act, append it, then
 * advance into it. Uses the same forgiving JSON parser as the original
 * Crown Spread adventure-builder (parseAdventureJson) since this has the
 * exact same "LLM might wrap output in prose or fences" failure mode.
 */
async function generateAndAppendScene(context, state, notes) {
    const summary = context.orchestrator.campaign.getSummary() || '';
    const facts = context.orchestrator.campaign.state.facts || {};
    const factsText = Object.entries(facts).map(([k, v]) => `- ${k}: ${v}`).join('\n');

    const prompt = `You are continuing a Fate's Edge adventure titled "${state.title}".

Current act: "${state.currentAct?.title || ''}" -- ${state.currentAct?.description || ''}
Story so far: ${summary || '(early in the story, no summary yet)'}
Known facts:
${factsText || '(none yet)'}
Scene that just concluded: "${state.currentScene?.title || ''}" -- ${state.currentScene?.description || ''}
${notes ? `How that scene just ended: ${notes}` : ''}

Write ONE new scene that continues this act naturally from here. Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "title": "Scene title",
  "description": "2-4 sentences of read-aloud/narrative text for this scene",
  "timers": [ { "name": "A distinctive timer name (not the word 'Timer')", "segments": 4, "description": "What it tracks" } ],
  "encounters": [ { "name": "Encounter name", "dv": 3, "position": "Controlled", "outcomes": { "clean": "...", "partial": "...", "miss": "..." } } ]
}
"timers" and "encounters" are both optional -- omit either if this scene is purely social/exploration with no mechanical pressure. Output ONLY the JSON object.`;

    let sceneContent;
    try {
        const raw = await context.driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge scene designer. You output only valid JSON, nothing else.',
            messages: [{ role: 'user', content: prompt }]
        });
        sceneContent = parseAdventureJson(raw);
        if (!sceneContent.title) throw new Error('generated scene is missing a title');
    } catch (e) {
        console.warn('[AdventureDirector] Scene generation failed, using fallback:', e.message);
        sceneContent = {
            title: 'The Story Continues',
            description: 'The path forward reveals itself, and the story presses on.',
            timers: [],
            encounters: [],
        };
    }

    try {
        await context.apiRequest('POST', ['adventure', 'scene', 'append'], {
            actIndex: state.currentActIndex,
            scene: sceneContent,
        });
        // Appending BEFORE advancing means the server's own ordinary
        // sequential-advance logic naturally lands on the new scene --
        // no explicit actIndex/sceneIndex needed here.
        await advanceScene(context);
        return `*(${notes ? notes + ' ' : ''}A new chapter unfolds: "${sceneContent.title}".)*`;
    } catch (e) {
        return `*(Failed to continue the adventure: ${e.message})*`;
    }
}

/**
 * Generate a climax/conclusion act (1-2 scenes), append it, mark
 * climaxTriggered so this only ever happens once, then advance into it.
 */
async function generateAndAppendClimax(context, state, notes) {
    const summary = context.orchestrator.campaign.getSummary() || '';

    const prompt = `You are bringing a Fate's Edge adventure titled "${state.title}" to its climax and conclusion.

Story so far: ${summary || '(the story so far)'}
${notes ? `Most recent development: ${notes}` : ''}

Write a final CLIMAX act with 1-2 scenes that bring this story to a satisfying conclusion, paying off its threads.

CLIMAX WRITING RULES -- this act's scene descriptions and encounter outcome text should already read differently from an ordinary scene, since the live narration during play will be held to these same constraints:
- Short, punchy sentences. Cut extraneous description.
- Escalating stakes -- make clear what the party stands to lose.
- No filler (no shopping, travel montages, or idle small-talk beats).
- Urgent, tense, decisive tone throughout.
- Encounter outcomes should feel weighty: "miss" should read as genuinely costly, "clean" as hard-won and consequential.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "title": "Act title (e.g. 'The Reckoning')",
  "description": "What this final act is about",
  "scenes": [
    {
      "title": "Scene title",
      "description": "2-4 sentences of climactic narrative text",
      "timers": [],
      "encounters": [ { "name": "Encounter name", "dv": 4, "position": "Desperate", "outcomes": { "clean": "...", "partial": "...", "miss": "..." } } ]
    }
  ]
}
Output ONLY the JSON object.`;

    let actContent;
    try {
        const raw = await context.driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge adventure designer. You output only valid JSON, nothing else.',
            messages: [{ role: 'user', content: prompt }]
        });
        actContent = parseAdventureJson(raw);
        if (!actContent.title || !Array.isArray(actContent.scenes) || actContent.scenes.length === 0) {
            throw new Error('generated climax act is missing required fields');
        }
    } catch (e) {
        console.warn('[AdventureDirector] Climax generation failed, using fallback:', e.message);
        actContent = {
            title: 'The Reckoning',
            description: 'The story comes to a head.',
            scenes: [{
                title: 'The Final Confrontation',
                description: 'Everything that came before leads here, to a single decisive moment.',
                timers: [],
                encounters: [],
            }],
        };
    }

    try {
        await context.apiRequest('POST', ['adventure', 'act', 'append'], { act: actContent });
        await context.apiRequest('POST', ['adventure', 'climax-triggered'], {});
        // Same append-before-advance trick as generateAndAppendScene --
        // ordinary sequential advance now lands in the new act's first scene.
        await advanceScene(context);
        return `*(${notes ? notes + ' ' : ''}The final act begins: "${actContent.title}".)*`;
    } catch (e) {
        return `*(Failed to begin the climax: ${e.message})*`;
    }
}

/**
 * NEW: CLIMAX PACING -- called once per climax, the first time
 * handleSceneComplete() sees state.climaxScenesSinceTrigger reach
 * climaxPadScenes without the climax act itself having finished. Generates
 * ONE short, forceful scene ("the ritual completes," "the tower begins to
 * collapse" -- whatever fits THIS story's own stakes, not a generic
 * insert) that pushes events forward regardless of what the party was in
 * the middle of doing, appends it to the current (climax) act, marks
 * climaxForced via POST /adventure/climax-forced so this only ever fires
 * once, then advances into it via the same append-before-advance trick
 * generateAndAppendScene()/generateAndAppendClimax() already use.
 */
async function generateForcedClimaxTwist(context, state, notes) {
    const summary = context.orchestrator.campaign.getSummary() || '';

    const prompt = `You are running the climax of a Fate's Edge adventure titled "${state.title}". The party has been taking longer than expected to bring it to a resolution.

Story so far: ${summary || '(the story so far)'}
${notes ? `Most recent development: ${notes}` : ''}

Write ONE short, forceful scene that pushes the climax toward its conclusion RIGHT NOW, regardless of what the party was in the middle of -- a ticking threat completes, reinforcements arrive, the ground gives way, the villain acts first, whatever fits THIS story's own stakes. It should read as the world refusing to wait any longer, not a random non-sequitur. Keep it short and punchy -- see the climax writing rules (escalating stakes, no filler, urgent/decisive tone). Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "title": "Scene title",
  "description": "2-4 sentences: short, punchy, urgent",
  "timers": [],
  "encounters": []
}
Output ONLY the JSON object.`;

    let sceneContent;
    try {
        const raw = await context.driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge scene designer forcing a stalled climax forward. You output only valid JSON, nothing else.',
            messages: [{ role: 'user', content: prompt }]
        });
        sceneContent = parseAdventureJson(raw);
        if (!sceneContent.title) throw new Error('generated forced scene is missing a title');
    } catch (e) {
        console.warn('[AdventureDirector] Forced climax twist generation failed, using fallback:', e.message);
        sceneContent = {
            title: 'The Reckoning Accelerates',
            description: 'Whatever time remained runs out. The threat that has been building completes itself -- there is no more time for hesitation.',
            timers: [],
            encounters: [],
        };
    }

    try {
        await context.apiRequest('POST', ['adventure', 'scene', 'append'], {
            actIndex: state.currentActIndex,
            scene: sceneContent,
        });
        await context.apiRequest('POST', ['adventure', 'climax-forced'], {});
        await advanceScene(context);
        return `*(${notes ? notes + ' ' : ''}The climax forces itself forward: "${sceneContent.title}".)*`;
    } catch (e) {
        return `*(Failed to force the climax onward: ${e.message})*`;
    }
}

/**
 * Called once an adventure's status genuinely becomes 'completed'
 * (either a pre-written adventure finishing naturally, or a
 * dynamic-growth adventure whose climax act just finished). Generates a
 * compact archival summary via the LLM, stores it in
 * campaign.state.adventureArchive (capped at MAX_ARCHIVED_ADVENTURES),
 * clears local narrative state, and re-prompts adventure selection --
 * this is the actual "continuity without 4MB of chat logs" mechanism:
 * a short summary per completed adventure, not raw transcript.
 */
async function finalizeAdventure(context, finishedState) {
    // NEW: LEGACY TRACKER -- extract this adventure's declared carryover
    // (if any -- see modules/legacy-tracker.js) BEFORE anything else, while
    // the module's reference data (and its `persistence` declaration) is
    // still fetchable. Deliberately not awaited-and-blocking the rest of
    // finalize on failure -- finalizeLegacy() already swallows its own
    // errors (logs + returns) rather than throwing, so a broken/unreachable
    // adventure engine here degrades to "no legacy captured this time,"
    // never to "the adventure fails to conclude."
    await legacyTracker.finalizeLegacy(context, finishedState);

    let summaryText;
    try {
        const conv = context.orchestrator.campaign.state.conversation || [];
        const recent = conv.slice(-40).map(m => `${m.role}: ${m.content}`).join('\n');
        const priorSummary = context.orchestrator.campaign.getSummary() || '';
        const prompt = `${priorSummary ? `Prior rolling summary:\n${priorSummary}\n\n` : ''}Recent events:\n${recent}\n\nWrite a concise (150-200 word) archival summary of this now-completed adventure: what happened, key NPCs and their fates, unresolved threads that could matter later, and the overall outcome. Output only the summary text, nothing else.`;
        summaryText = await context.driver.generateResponse({
            systemPrompt: 'You are a campaign archivist. Output only the summary text, nothing else.',
            messages: [{ role: 'user', content: prompt }]
        });
        summaryText = (summaryText || '').trim();
        if (!summaryText) throw new Error('empty summary');
    } catch (e) {
        console.warn('[AdventureDirector] Failed to generate adventure summary:', e.message);
        summaryText = `"${finishedState.title || 'The adventure'}" concluded.`;
    }

    const state = context.orchestrator.campaign.state;
    if (!state.adventureArchive) state.adventureArchive = [];
    state.adventureArchive.push({
        title: finishedState.title || 'Untitled Adventure',
        summary: summaryText,
        completedAt: Date.now(),
    });
    if (state.adventureArchive.length > MAX_ARCHIVED_ADVENTURES) {
        state.adventureArchive = state.adventureArchive.slice(-MAX_ARCHIVED_ADVENTURES);
    }

    resetNarrativeState(context.orchestrator);
    context.sendChat(`📖 **"${finishedState.title || 'The adventure'}" concludes.**\n\n${summaryText}\n\n*A new road awaits.*`);
    await promptSelection(context);
}

/**
 * Handles `!gm session end`. Purely a manual marker -- see the
 * DEFAULT_CLIMAX_AFTER_SESSIONS comment for why session boundaries
 * aren't something the bot can infer from chat volume alone.
 */
async function handleSessionEnd(context) {
    let state;
    try {
        state = await context.apiRequest('POST', ['adventure', 'session', 'end'], {});
        adventureContext.invalidate();
    } catch (e) {
        return `*Couldn't mark session end: ${e.message}*`;
    }
    if (!state.dynamicGrowth) {
        return `*Session marked (${state.sessionsPlayed} session${state.sessionsPlayed === 1 ? '' : 's'} so far). This is a pre-written adventure -- it'll simply play through to its own ending regardless of session count.*`;
    }
    if (state.climaxTriggered) {
        return `*Session marked (${state.sessionsPlayed} sessions). The climax is already underway.*`;
    }
    const remaining = Math.max(0, (state.climaxAfterSessions || DEFAULT_CLIMAX_AFTER_SESSIONS) - state.sessionsPlayed);
    if (remaining === 0) {
        return `*Session marked (${state.sessionsPlayed} sessions). The story is ready for its climax -- it'll begin the next time a scene concludes.*`;
    }
    return `*Session marked (${state.sessionsPlayed}/${state.climaxAfterSessions} sessions). ${remaining} more before the climax begins.*`;
}
