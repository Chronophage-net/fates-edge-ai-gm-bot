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
const { getVocab, encounterType } = require('./objective-types');
const legacyTracker = require('./legacy-tracker'); // NEW: structured cross-adventure carryover -- see that file's header

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
    // 1.5. KNOWLEDGE STATE — explicit secret/reveal data, GM/AI eyes only
    // ================================================================
    // NEW: the structured alternative to burying secrets in _gmhints
    // prose above (which still works, unchanged, for older modules).
    // Each entry in the module's `knowledge` array gives an explicit
    // answer to "what am I allowed to tell the players?" instead of
    // making the LLM infer it: `player` is what's safe to say NOW
    // (possibly null -- nothing to say yet), `gm` is the full truth,
    // and `revealed` is the live gate between them. Comes from
    // getReferenceData() server-side (GM/AI-eyes-only fetch) -- this
    // text NEVER reaches getPublicState()'s player-safe view, so it's
    // safe to print the raw secret here.
    const ref = await getReference(context);
    if (ref?.knowledge?.length) {
        const unrevealed = ref.knowledge.filter(k => !k.revealed);
        const revealed = ref.knowledge.filter(k => k.revealed);

        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push('KNOWLEDGE STATE (GM/AI EYES ONLY — never repeat `gm` text below to players unless its entry is REVEALED)');
        lines.push('═══════════════════════════════════════════════════════════════');

        if (unrevealed.length) {
            lines.push('SECRET (not yet revealed — you may ONLY share the "players currently know" line for these; deflect or stay in the fiction if pressed further):');
            for (const k of unrevealed) {
                lines.push(`  [${k.id}]${k.subject ? ` (${k.subject})` : ''}`);
                lines.push(`    truth (DO NOT reveal): ${k.gm}`);
                lines.push(`    players currently know: ${k.player ?? '(nothing yet)'}`);
                if (k.revealCondition) lines.push(`    reveal when: ${k.revealCondition}`);
            }
        }
        if (revealed.length) {
            lines.push('REVEALED (safe to narrate/confirm openly now):');
            for (const k of revealed) {
                lines.push(`  [${k.id}]${k.subject ? ` (${k.subject})` : ''}: ${k.gm}`);
            }
        }

        lines.push('When a reveal condition above is met in play (the players witness it, an NPC confesses, etc.), emit [REVEAL "id"] so the game\'s knowledge state stays in sync with your narration -- do not just narrate the reveal and leave the tag out, and do not emit [REVEAL "id"] without narrating the reveal actually happening. Use [HIDE "id"] only to correct a mistaken reveal.');
        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push('');
    }

    // ================================================================
    // 1.6. LEGACY / CARRYOVER STATE — structured cross-adventure facts
    // ================================================================
    // NEW: see modules/legacy-tracker.js's header for the full design.
    // Only ever non-empty when the CURRENTLY loaded adventure itself
    // declares a `persistence.schema` (via its reference data) AND a
    // previous adventure using that same schema has already finished and
    // left a legacy entry behind -- both conditions checked inside
    // getLegacyContextBlock() itself, so this is always safe to call.
    // Injected every turn (not just at load) so the model can reference
    // exact carried-over figures consistently throughout play.
    if (ref?.persistence) {
        lines.push(legacyTracker.getLegacyContextBlock(context.orchestrator, ref.persistence));
    }

    // ================================================================
    // 1.7. CLIMAX NARRATION & PACING — active only once the dynamic-growth
    // engine has triggered this adventure's final act (see
    // adventure-director.js's generateAndAppendClimax()/handleSceneComplete()
    // and server/adventure.js's climaxTriggered/climaxPadScenes/
    // climaxScenesSinceTrigger fields). These are STRONG narration
    // constraints, not a suggestion -- the whole point is that the model's
    // prose noticeably tightens up once the climax begins, rather than
    // continuing at the same unhurried pace it used for the rest of the
    // adventure.
    // ================================================================
    if (state.climaxTriggered && state.status !== 'completed') {
        const pad = state.climaxPadScenes || 2;
        const soFar = state.climaxScenesSinceTrigger || 0;
        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push('YOU ARE NOW IN THE FINAL ARC OF THIS ADVENTURE — obey these constraints:');
        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push(`This climax is expected to resolve within roughly ${pad} more scene(s) (${soFar}/${pad} used so far). Move with purpose toward a conclusion.`);
        lines.push('NARRATION RULES FOR THE CLIMAX:');
        lines.push('  1. Use SHORT, PUNCHY sentences. Cut extraneous description.');
        lines.push('  2. Escalate stakes with every action. Remind players what they stand to lose.');
        lines.push('  3. Eliminate filler -- no shopping, no travel montages, no idle NPC small-talk.');
        lines.push('  4. The tone is urgent, tense, and decisive.');
        lines.push('  5. Every roll now carries higher stakes: a Miss should feel catastrophic; a Clean Success should feel earned and consequential.');
        if (state.climaxForced) {
            lines.push('A forced dramatic turn has already occurred this climax (the story pushed itself forward because play was dragging) -- do not let it stall again; drive hard toward resolution now.');
        }
        lines.push('The adventure ends when the climax resolves. Drive the narrative toward that resolution without railroading -- player choices still matter, but keep the pressure constant and rising. Use [SCENE COMPLETE "notes"] as soon as this beat reaches a real conclusion rather than dragging it out.');
        lines.push('═══════════════════════════════════════════════════════════════');
        lines.push('');
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
        // NEW: encounters may carry an optional `type` -- one of
        // 'combat' | 'obstruction' | 'skill_challenge' | 'trap_ward' |
        // 'lockpick' | 'heist' | 'social' -- defaulting to 'combat' when
        // absent, exactly current behavior for back-compat. Surface the
        // type and its own progress/setback vocabulary here so the LLM's
        // narration naturally reaches for "Tumblers"/"Jam" on a lockpick,
        // "Heat"/"Cover" on a heist, etc. instead of always assuming a
        // fight and defaulting to Harm/Heal language.
        const type = encounterType(enc);
        // Pass the encounter object itself as `source` so a `custom` type's
        // GM-supplied customLabel/customTickLabel (if set) overlay the
        // generic "Timer"/"tick" defaults -- mirrors resolveObjectiveType()
        // on the web client.
        const vocab = getVocab(type, enc);
        lines.push(`Active Encounter: ${enc.name || enc.creatureId} (DV ${enc.dv ?? '?'}, ${enc.position || 'Controlled'})`);
        lines.push(`  Type: ${type} -- ${vocab.description}`);
        lines.push(`  Vocabulary: progress = "${vocab.progress}" (${vocab.progressVerb}), setback = "${vocab.setback}" (${vocab.setbackVerb})`);
        if (type === 'combat') {
            lines.push('  This is a fight -- narrate attacks/damage and use [APPLY HARM ...] as normal.');
        } else if (type === 'custom') {
            lines.push(`  This is a custom encounter: ${vocab.progress} (advances by: ${vocab.progressVerb}). Do not narrate attacks or apply Harm for this encounter -- use the "${vocab.progress}"/"${vocab.setback}" language above instead.`);
        } else {
            lines.push(`  This is NOT a fight -- do not narrate attacks or apply Harm for this encounter. Use "${vocab.progress}"/"${vocab.setback}" language instead (e.g. "${vocab.description}").`);
        }
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
    // `ref` already fetched above for the KNOWLEDGE STATE section (1.5) --
    // reused here, not re-fetched.
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
        'The GM Hints at the top of this block are IMMUTABLE — they override all other narrative instincts. ' +
        'The KNOWLEDGE STATE block (if present) is the authoritative answer to what you may tell the players about each secret it lists — treat it as equally immutable.'
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

/**
 * Non-blocking read of whatever adventure state is currently cached --
 * never triggers an API call itself, so it's safe for
 * modules/status-server.js to poll from an HTTP handler on every
 * dashboard refresh without adding load or latency. May be up to
 * CACHE_TTL_MS stale, or null if nothing's been fetched yet this
 * session; both are fine for a "what's loaded right now" display.
 */
function getCachedStateSync() {
    return cachedState;
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
    getCachedStateSync,      // NEW export -- used by modules/status-server.js
};