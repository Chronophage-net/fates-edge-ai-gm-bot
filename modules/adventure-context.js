// modules/adventure-context.js
//
// Bridges the AI GM bot to the server's Adventure Engine
// (server/adventure.js) for anything that used to be WorldManager's job:
// "what NPCs/locations/factions exist right now, and what's the current
// scene." Unlike WorldManager's local file-loading (regions/factions/
// settlements/patrons/npcs/wiki -- see the grep that found almost none of
// it consumed anywhere except one getRegion() and one getFaction() call),
// this pulls SPECIFICALLY what the currently-loaded adventure actually
// defines, live from the server, so it can never drift out of sync with
// whatever a human GM or another bot instance changed via the web client
// or the REST API.
//
// Two jobs:
//   1. getSceneContextForPrompt() -- a formatted block to inject into the
//      LLM system prompt, so free-form narration is grounded in the real
//      current scene/NPCs/encounter, not generic setting flavor.
//   2. getActiveNpc(name) / getActiveLocation(name) / getActiveFaction(name)
//      -- real lookups gm-orchestrator.js's generateNPC() etc. should
//      check FIRST, falling back to its own NPC_TEMPLATES generation only
//      when nothing matches (no adventure loaded, or this specific NPC
//      isn't one the module defined).
//   3. getAdventureDoc() -- reads the full adventure text from the local
//      data/docs/adventures/ folder, using the manifest to map moduleId
//      to the HTML doc file, and returns plain text for the LLM system prompt.
//
// Caches state, reference, and doc data for CACHE_TTL_MS to avoid hitting
// the API or filesystem on every single chat message. invalidate() clears
// all caches when the adventure state mutates.

const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 15000;
const DOC_CACHE_TTL_MS = 60000; // doc changes rarely, cache longer

// Directories for adventure docs and manifest
const ADVENTURES_DOC_DIR = path.resolve(process.cwd(), 'data', 'docs', 'adventures');
const MANIFEST_PATH = path.resolve(process.cwd(), 'data', 'adventures', 'manifest.json');

let cachedState = null;
let cachedReference = null;
let cachedDoc = null;
let stateFetchedAt = 0;
let referenceFetchedAt = 0;
let docFetchedAt = 0;

/** Call after any command that mutates adventure state (scene change,
 *  encounter start/resolve, timer tick, load, reset) so the next read
 *  picks up the change immediately instead of waiting out the TTL. */
function invalidate() {
    stateFetchedAt = 0;
    referenceFetchedAt = 0;
    docFetchedAt = 0; // also clear doc cache
}

async function getState(context) {
    if (cachedState && Date.now() - stateFetchedAt < CACHE_TTL_MS) {
        return cachedState;
    }
    try {
        cachedState = await context.apiRequest('GET', ['adventure']);
        stateFetchedAt = Date.now();
    } catch (e) {
        console.warn('[AdventureContext] Failed to fetch adventure state:', e.message);
        cachedState = null;
    }
    return cachedState;
}

async function getReference(context) {
    if (cachedReference && Date.now() - referenceFetchedAt < CACHE_TTL_MS) {
        return cachedReference;
    }
    try {
        cachedReference = await context.apiRequest('GET', ['adventure', 'reference']);
        referenceFetchedAt = Date.now();
    } catch (e) {
        // Expected/normal when no adventure is loaded -- not worth logging as a warning.
        cachedReference = null;
    }
    return cachedReference;
}

/**
 * CHANGED: The real server-side status machine (see server/adventure.js)
 * is 'planned' -> 'active' -> 'completed'. 'planned' is NOT "nothing
 * loaded" -- ensureAdventureState() only defaults to it when module is
 * null, AND resetAdventure() explicitly sets status back to 'planned'
 * while leaving the module (and moduleId) fully intact. The previous
 * `state.status !== 'active'` checks in this file treated a reset
 * adventure as if nothing were loaded at all, which:
 *   - blanked the LLM's scene context after every !gm adventure reset
 *   - made maybePromptOnStartup() and the bare `!gm adventure` status
 *     command re-show the adventure-selection menu on top of a
 *     perfectly valid, just-reset adventure
 *
 * The only state that should be treated as "nothing usable is loaded"
 * is moduleId being absent, or the adventure having actually finished
 * ('completed'). Everything else ('planned' post-reset, 'active') is
 * a real, resumable adventure.
 */
function isAdventureActive(state) {
    return !!(state && state.moduleId && state.status !== 'completed');
}

async function hasActiveAdventure(context) {
    const state = await getState(context);
    return isAdventureActive(state);
}

/**
 * Formatted block for the LLM system prompt: current adventure/act/scene,
 * the scene's own read-aloud text, any active encounter, campaign
 * timers, and a short NPC/location/faction roster. Returns '' if nothing
 * usable is loaded, so callers can just always append it with no
 * special-casing.
 *
 * CHANGED: _gmhints from the adventure state are injected FIRST, at the
 * very top of the context block, so they act as immutable constraints
 * that override any generic narrative instincts the LLM might have.
 */
async function getSceneContextForPrompt(context) {
    const state = await getState(context);
    if (!isAdventureActive(state)) return '';

    const lines = [];

    // ================================================================
    // 1. GM HINTS (IMMUTABLE CONSTRAINTS) — read these FIRST
    // ================================================================
    if (state._gmhints) {
        const hints = state._gmhints;
        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push('GM HINTS (IMMUTABLE CONSTRAINTS — obey these before narrating)');
        lines.push('═══════════════════════════════════════════════════════════════');

        // Pacing rules (object or string)
        if (hints.pacing) {
            if (typeof hints.pacing === 'string') {
                lines.push(`PACING: ${hints.pacing}`);
            } else if (typeof hints.pacing === 'object') {
                for (const [act, rule] of Object.entries(hints.pacing)) {
                    lines.push(`PACING (${act}): ${rule}`);
                }
            }
        }

        // NPC secrets
        if (hints.npcSecrets) {
            if (typeof hints.npcSecrets === 'object') {
                for (const [npc, secret] of Object.entries(hints.npcSecrets)) {
                    lines.push(`NPC SECRET (${npc}): ${secret}`);
                }
            } else {
                lines.push(`NPC SECRETS: ${hints.npcSecrets}`);
            }
        }

        // Forbidden early revelations (array or string)
        if (hints.forbiddenEarlyRevelations) {
            const list = Array.isArray(hints.forbiddenEarlyRevelations)
                ? hints.forbiddenEarlyRevelations.join(', ')
                : String(hints.forbiddenEarlyRevelations);
            lines.push(`FORBIDDEN EARLY REVELATIONS: ${list}`);
        }

        // Catch-all for any other root-level hint fields
        for (const [key, value] of Object.entries(hints)) {
            if (!['pacing', 'npcSecrets', 'forbiddenEarlyRevelations'].includes(key)) {
                const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
                lines.push(`${key.toUpperCase()}: ${val}`);
            }
        }

        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push(''); // blank line before the rest of the context
    }

    // ================================================================
    // 2. Current adventure / act / scene state
    // ================================================================
    lines.push(`**Current Adventure: "${state.title}"** (${state.status})`);
    if (state.currentAct) lines.push(`Act: ${state.currentAct.title}`);
    if (state.currentScene) {
        lines.push(`Scene: ${state.currentScene.title}`);
        if (state.currentScene.description) lines.push(state.currentScene.description);
    }
    if (state.activeEncounter) {
        const enc = state.activeEncounter;
        lines.push(`Active Encounter: ${enc.name || enc.creatureId} (DV ${enc.dv ?? '?'}, ${enc.position || 'Controlled'})`);
        if (enc.creature) {
            lines.push(`  Creature: ${enc.creature.name} (TL${enc.creature.tl}, ${enc.creature.class || ''})`);
        }
    }
    if (state.campaignTimers?.length) {
        lines.push('Campaign Timers: ' + state.campaignTimers.map(t => `${t.name} ${t.current}/${t.segments}`).join(', '));
    }
    // CHANGED: surface the current scene's own timers too, not just
    // campaign-wide ones -- this is what !gm's forceRollIfMissing /
    // auto-tick-on-Partial-Miss logic in ai-gm-bot.js actually operates
    // on, and the AI has no way to know these timer names exist otherwise.
    if (state.currentScene?.timers?.length) {
        lines.push('Scene Timers: ' + state.currentScene.timers.map(t => `${t.name} ${t.current}/${t.segments}`).join(', '));
    }

    // ================================================================
    // 3. Reference data (NPCs, locations, factions, notes)
    // ================================================================
    const ref = await getReference(context);
    if (ref) {
        if (ref.npcs?.length) {
            lines.push('\nKnown NPCs:');
            for (const npc of ref.npcs) {
                lines.push(`- ${npc.name} (${npc.role || 'NPC'}): ${npc.motivation || ''}`);
            }
        }
        if (ref.locations?.length) {
            lines.push('\nKnown Locations:');
            for (const loc of ref.locations) {
                lines.push(`- ${loc.name}: ${loc.description || ''}`);
            }
        }
        if (ref.factions?.length) {
            lines.push('\nKnown Factions:');
            for (const f of ref.factions) {
                lines.push(`- ${f.name}: ${f.goals || ''}`);
            }
        }
        if (ref.notes) {
            lines.push(`\nGM Notes: ${ref.notes}`);
        }
    }

    // ================================================================
    // 4. Final instruction
    // ================================================================
    lines.push(
        '\nStay consistent with the NPCs/locations/factions listed above when they\'re relevant. ' +
        'You may still improvise minor, unnamed background characters as needed. ' +
        'The GM Hints at the top of this block are IMMUTABLE — they override all other narrative instincts.'
    );

    return '\n\n' + lines.join('\n');
}

/**
 * Returns the name of the first timer defined in the CURRENT scene, or
 * null if the scene has none. Used by ai-gm-bot.js's Partial/Miss
 * auto-tick instead of a hardcoded guessed timer name (which almost
 * never matches whatever an LLM-generated Crown Spread adventure
 * actually named its timers).
 */
async function getFirstSceneTimerName(context) {
    const state = await getState(context);
    if (!isAdventureActive(state)) return null;
    const timer = state.currentScene?.timers?.[0];
    return timer ? timer.name : null;
}

/** Case-insensitive name match against the active adventure's own NPCs. Returns null if none loaded/no match. */
async function getActiveNpc(context, name) {
    const ref = await getReference(context);
    if (!ref?.npcs) return null;
    const needle = name.toLowerCase();
    return ref.npcs.find(n => (n.name || '').toLowerCase() === needle) || null;
}

/** Case-insensitive name match against the active adventure's own locations. */
async function getActiveLocation(context, name) {
    const ref = await getReference(context);
    if (!ref?.locations) return null;
    const needle = name.toLowerCase();
    return ref.locations.find(l => (l.name || '').toLowerCase() === needle) || null;
}

/** Case-insensitive name match against the active adventure's own factions. */
async function getActiveFaction(context, name) {
    const ref = await getReference(context);
    if (!ref?.factions) return null;
    const needle = name.toLowerCase();
    return ref.factions.find(f => (f.name || '').toLowerCase() === needle) || null;
}

/** Case-insensitive/id match against the active adventure's own bestiary -- what gm-orchestrator.generateNPC() should check before falling back to NPC_TEMPLATES. */
async function getActiveCreature(context, ref_) {
    const ref = await getReference(context);
    if (!ref?.bestiary) return null;
    const needle = String(ref_).toLowerCase();
    return ref.bestiary.find(c => c.id === ref_ || (c.name || '').toLowerCase() === needle) || null;
}

/**
 * Fetch the adventure doc (plain text) for the currently loaded adventure.
 * Reads directly from the filesystem using the manifest.
 * Returns the plain text content, or null if not found/error.
 */
async function getAdventureDoc(context) {
    // Check cache
    if (cachedDoc && Date.now() - docFetchedAt < DOC_CACHE_TTL_MS) {
        return cachedDoc;
    }

    try {
        // 1. Get current adventure state to know which module is loaded
        const state = await getState(context);
        if (!state || !state.moduleId) {
            cachedDoc = null;
            docFetchedAt = Date.now(); // CHANGED: cache the negative result too, respect TTL
            return null;
        }

        const moduleId = state.moduleId;

        // 2. Load manifest
        let manifest = {};
        if (fs.existsSync(MANIFEST_PATH)) {
            manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
        } else {
            console.warn('[AdventureContext] Manifest not found:', MANIFEST_PATH);
            return null;
        }

        const entry = manifest[moduleId];
        if (!entry) {
            // CHANGED: expected/normal for AI-generated Crown Spread adventures
            // (loaded via load-custom, id like "custom_<timestamp>") -- they
            // have no manifest entry or doc file by design. Don't warn.
            cachedDoc = null;
            docFetchedAt = Date.now();
            return null;
        }

        const docPath = path.join(ADVENTURES_DOC_DIR, entry.docFile);
        if (!fs.existsSync(docPath)) {
            console.warn(`[AdventureContext] Doc file not found: ${docPath}`);
            return null;
        }

        const html = fs.readFileSync(docPath, 'utf-8');

        // Strip HTML tags to plain text
        const plainText = html
            .replace(/<[^>]*>/g, ' ')        // remove tags
            .replace(/\s+/g, ' ')             // collapse whitespace
            .trim();

        // Cache and return
        cachedDoc = plainText;
        docFetchedAt = Date.now();
        return plainText;

    } catch (e) {
        console.warn('[AdventureContext] Failed to read adventure doc:', e.message);
        cachedDoc = null;
        return null;
    }
}

module.exports = {
    invalidate,
    hasActiveAdventure,
    isAdventureActive,       // NEW export -- shared source of truth for adventure-director.js
    getSceneContextForPrompt,
    getFirstSceneTimerName,  // NEW export -- used by ai-gm-bot.js's auto-tick fix
    getActiveNpc,
    getActiveLocation,
    getActiveFaction,
    getActiveCreature,
    getAdventureDoc,
};