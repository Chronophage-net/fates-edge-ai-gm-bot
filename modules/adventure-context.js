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
//
// Caches both state and reference data for CACHE_TTL_MS to avoid hitting
// the API on every single chat message -- reference data especially
// rarely changes mid-scene, and state only changes when a command
// actually mutates it, at which point invalidate() should be called.

const CACHE_TTL_MS = 15000;

let cachedState = null;
let cachedReference = null;
let stateFetchedAt = 0;
let referenceFetchedAt = 0;

/** Call after any command that mutates adventure state (scene change,
 *  encounter start/resolve, timer tick, load, reset) so the next read
 *  picks up the change immediately instead of waiting out the TTL. */
function invalidate() {
    stateFetchedAt = 0;
    referenceFetchedAt = 0;
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

async function hasActiveAdventure(context) {
    const state = await getState(context);
    return !!(state && state.moduleId && state.status === 'active');
}

/**
 * Formatted block for the LLM system prompt: current adventure/act/scene,
 * the scene's own read-aloud text, any active encounter, campaign
 * timers, and a short NPC/location/faction roster. Returns '' if nothing
 * is loaded, so callers can just always append it with no special-casing.
 */
async function getSceneContextForPrompt(context) {
    const state = await getState(context);
    if (!state || !state.moduleId || state.status !== 'active') return '';

    const lines = [`**Current Adventure: "${state.title}"** (${state.status})`];
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

    return (
        '\n\n' + lines.join('\n') +
        '\n\nStay consistent with the NPCs/locations/factions listed above when they\'re relevant. ' +
        'You may still improvise minor, unnamed background characters as needed.'
    );
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

module.exports = {
    invalidate,
    hasActiveAdventure,
    getSceneContextForPrompt,
    getActiveNpc,
    getActiveLocation,
    getActiveFaction,
    getActiveCreature,
};
