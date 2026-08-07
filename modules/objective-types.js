// modules/objective-types.js
//
// Small, bot-side mirror of the web client's full objective-type registry
// (fates-edge-web-client/js/core/objective-types.js). The socket-server's
// encounter API now carries an optional `type` field --
// 'combat' | 'obstruction' | 'skill_challenge' | 'trap_ward' | 'lockpick' |
// 'heist' | 'social' -- defaulting to 'combat' for back-compat when absent.
// Encounters were always narrated/tracked as fights (Harm/Heal terms) even
// when they're actually a lock to pick, a trap to disarm, a heist, a skill
// challenge, or a negotiation.
//
// This module doesn't need the whole client registry (icons, colors,
// etc.) -- just enough vocabulary for:
//   1. adventure-context.js's scene-context block, so the LLM sees the
//      right terminology for the active encounter instead of always
//      "Harm"/"Heal".
//   2. commands.js's [ENCOUNTER START]/[ENCOUNTER RESOLVE] chat replies,
//      so player-facing text matches the encounter's own vocabulary.
//
// DEFAULT_TYPE is the single source of truth for "no type field present"
// back-compat behavior -- everything in this file and its callers routes
// through it rather than hardcoding the literal string 'combat' in
// multiple places.

const DEFAULT_TYPE = 'combat';

const VOCAB = {
    combat: {
        label: 'Combat',
        progress: 'Harm', progressVerb: 'damage',
        setback: 'Heal', setbackVerb: 'heal',
        description: 'A fight.',
    },
    obstruction: {
        label: 'Obstruction',
        progress: 'Progress', progressVerb: 'progress',
        setback: 'Setback', setbackVerb: 'setback',
        description: 'Pushing through a physical or logistical barrier.',
    },
    skill_challenge: {
        label: 'Skill Challenge',
        progress: 'Progress', progressVerb: 'progress',
        setback: 'Setback', setbackVerb: 'setback',
        description: 'A multi-roll challenge toward a goal.',
    },
    trap_ward: {
        label: 'Trap/Ward',
        progress: 'Disarm Progress', progressVerb: 'disarm',
        setback: 'Trigger', setbackVerb: 'trigger',
        description: 'Disabling or surviving a trap or magical ward.',
    },
    lockpick: {
        label: 'Lockpick',
        progress: 'Tumblers', progressVerb: 'pick',
        setback: 'Jam', setbackVerb: 'jam',
        description: 'Working a lock or similarly fine mechanism.',
    },
    heist: {
        label: 'Heist',
        progress: 'Heat', progressVerb: 'heat',
        setback: 'Cover', setbackVerb: 'cover',
        description: 'A caper with rising suspicion or alarm.',
    },
    social: {
        label: 'Social',
        progress: 'Leverage', progressVerb: 'sway',
        setback: 'Resistance', setbackVerb: 'resist',
        description: 'A negotiation, debate, or persuasion.',
    },
    // Freeform escape hatch, mirrors the client's `custom` entry
    // (fates-edge-web-client/js/core/objective-types.js) -- the GM types
    // their own Timer Label / Tick Label per-encounter instead of picking
    // from the fixed vocabulary above. getVocab()'s `source` param overlays
    // an encounter's `customLabel`/`customTickLabel` over these generic
    // defaults, same as the client's resolveObjectiveType().
    custom: {
        label: 'Custom / Freeform',
        progress: 'Timer', progressVerb: 'tick',
        setback: 'Tick Back', setbackVerb: 'tick back',
        description: 'A freeform clock with its own GM-supplied label.',
        isCustom: true,
    },
};

/** Normalizes any encounter-ish object/string/nullish value to a valid
 *  type id, defaulting to DEFAULT_TYPE ('combat') for back-compat when
 *  absent or unrecognized -- exactly current behavior when no `type`
 *  field exists anywhere in the data. */
function normalizeType(type) {
    if (typeof type === 'string' && VOCAB[type]) return type;
    return DEFAULT_TYPE;
}

/** Returns the vocabulary entry for a given (possibly missing/unknown)
 *  encounter type -- always a valid object, never undefined.
 *
 *  `source` is an optional encounter-ish object; for the `custom` entry,
 *  its `customLabel`/`customTickLabel` fields (if present and non-blank)
 *  overlay the generic "Timer"/"tick" defaults -- mirrors the client's
 *  resolveObjectiveType(id, source). Non-custom entries ignore `source`
 *  entirely, so this is a no-op for every pre-existing type. */
function getVocab(type, source) {
    const entry = VOCAB[normalizeType(type)];
    if (!entry.isCustom || !source) return entry;
    const progress = (source.customLabel || '').trim() || entry.progress;
    const tick = (source.customTickLabel || '').trim() || entry.progressVerb;
    return {
        ...entry,
        progress,
        progressVerb: tick,
        setback: `${progress} (Back)`,
        setbackVerb: tick,
    };
}

/** Convenience: pull `type` off an encounter-ish object, normalizing
 *  absence/unknown values to the combat default. */
function encounterType(encounter) {
    return normalizeType(encounter && encounter.type);
}

/** True if the given type id is the freeform/custom escape hatch. */
function isCustomType(type) {
    return normalizeType(type) === 'custom';
}

module.exports = {
    DEFAULT_TYPE,
    VOCAB,
    normalizeType,
    getVocab,
    encounterType,
    isCustomType,
};
