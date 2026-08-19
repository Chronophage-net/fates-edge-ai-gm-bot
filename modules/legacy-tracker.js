// modules/legacy-tracker.js
//
// LEGACY TRACKER — structured, adventure-specific carryover between
// adventures in the same campaign.
//
// PROBLEM this solves: campaign.state.adventureArchive (see
// adventure-director.js's finalizeAdventure()) already gives continuity
// as PROSE -- a 150-200 word LLM-written summary per completed adventure.
// That's great for "remind the model what happened," but useless for
// anything the game needs to track precisely: an LLM asked to parse "the
// Fenwood Ledger is ticking down" from a paragraph of prose will guess at
// a number; handed `fenwood_ledger: 5` directly, it just reads it. Some
// campaigns also only want ONE specific adventure's saga to persist (the
// Fenwood Ledger only matters for the Fenwood–Everblood thread) rather
// than dumping every adventure's state into every other adventure's
// context regardless of relevance.
//
// SOLUTION: an adventure module opts in with a top-level `persistence`
// block (see the schema doc in server/adventure.js, right above
// `getReferenceData()`/the KNOWLEDGE STATE comment) declaring:
//   - `schema`: a stable id (e.g. "fenwood-legacy-v1") -- ONLY adventures
//     that declare the SAME schema id read each other's legacy state.
//     Unrelated adventures (no `persistence`, or a different schema) never
//     see it, by construction -- no filtering logic needed elsewhere.
//   - `carryover`: which keys to extract when this adventure finishes, and
//     how (`type`: 'timer' | 'inventory' | 'list' | 'dictionary').
//   - `reset_on_complete`: if true, finishing this adventure CLEARS this
//     schema's legacy entry instead of writing fresh values (e.g. a
//     saga's final chapter "resolves" the thread rather than continuing
//     it).
//
// WHERE THE LIVE VALUES ACTUALLY COME FROM: this bot has no generic
// named-variable store beyond scene/campaign timers (numeric only) and
// campaign.state.facts (the existing free-text `!gm fact <key> <value>` /
// `[FACT key value]` bag -- see gm-commands.js/process-tags.js). Rather
// than inventing a whole second parallel tracking mechanic, carryover
// extraction reads from facts FIRST (a GM or the AI sets
// `!gm fact heirlooms ["laurel_seal","bell_shard"]` or
// `[FACT heirlooms ["laurel_seal","bell_shard"]]` during play -- JSON-typed
// keys are automatically parsed back out of the fact's string value; plain
// strings pass through as-is), falling back to a same-named campaign/scene
// timer for `type: 'timer'` entries, and finally the carryover item's own
// `default`.
//
// INTEGRATION:
//   1. adventure-director.js's finalizeAdventure() calls finalizeLegacy()
//      right before archiving the prose summary -- see that file.
//   2. adventure-context.js's getSceneContextForPrompt() calls
//      getLegacyContextBlock() to inject whatever the CURRENT adventure's
//      own persistence.schema already has on file as a structured JSON
//      block, every turn an adventure with dat schema is active -- not
//      just at load, so the model can reference it consistently
//      throughout play, not just in the opening beat.
//   3. adventure-director.js's `!gm adventure legacy` subcommand (GM-only)
//      gives the transparency/override the design called for: view the
//      raw tracked state for the active adventure's schema, or any
//      schema by name, and set/clear individual keys by hand.

// Cap on how many distinct schemas a campaign can accumulate -- mirrors
// adventure-director.js's MAX_ARCHIVED_ADVENTURES pattern (bounded state,
// not unbounded growth). Most campaigns will only ever use one or two
// recurring sagas; this is a safety net, not an expected ceiling.
const MAX_LEGACY_SCHEMAS = 20;

function getLegacyState(orchestrator) {
    const state = orchestrator.campaign.state;
    if (!state.legacy) state.legacy = {};
    return state.legacy;
}

/**
 * Resolve ONE carryover item's live value at finalize-time.
 *  1. campaign.state.facts[key], if the GM/AI ever set it during play --
 *     JSON.parse'd back into a real array/object/number when possible
 *     (facts are always stored as plain strings -- see gm-commands.js's
 *     `!gm fact` handler -- so a fact set to `["a","b"]` needs parsing
 *     back into an actual array here, not left as that literal string).
 *  2. For `type: 'timer'` items with no matching fact: the finished
 *     adventure's own campaign/scene timers, matched by name (loose --
 *     underscores/spaces interchangeable, case-insensitive, substring
 *     match) since an authored timer is very unlikely to be named with
 *     the carryover key's exact snake_case spelling.
 *  3. The carryover item's own `default`, if given.
 *  4. A type-appropriate empty value (0 for timer, [] for inventory/list,
 *     {} for dictionary) as the last resort, so extraction never throws
 *     on a key nobody ever touched.
 */
function readCarryoverValue(orchestrator, finishedState, item) {
    const facts = orchestrator.campaign.state.facts || {};
    if (Object.prototype.hasOwnProperty.call(facts, item.key)) {
        const raw = facts[item.key];
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            } catch (e) {
                return raw; // plain string fact -- use as-is
            }
        }
        return raw;
    }

    if (item.type === 'timer') {
        const timers = [
            ...(finishedState?.campaignTimers || []),
            ...(finishedState?.currentScene?.timers || []),
        ];
        const needle = String(item.key).toLowerCase().replace(/_/g, ' ');
        const match = timers.find(t => {
            const name = String(t.name || '').toLowerCase().replace(/_/g, ' ');
            return name === needle || name.includes(needle) || needle.includes(name);
        });
        if (match) return match.current || 0;
    }

    if (Object.prototype.hasOwnProperty.call(item, 'default')) {
        return item.default;
    }
    switch (item.type) {
        case 'inventory':
        case 'list':
            return [];
        case 'dictionary':
            return {};
        case 'timer':
            return 0;
        default:
            return null;
    }
}

/** Extract every declared carryover key's value from the just-finished adventure. Clamps `type: 'timer'` values to [0, max] when `max` is given. */
function extractCarryover(orchestrator, persistenceSpec, finishedState) {
    const values = {};
    for (const item of persistenceSpec.carryover || []) {
        if (!item || !item.key) continue;
        let value = readCarryoverValue(orchestrator, finishedState, item);
        if (item.type === 'timer' && typeof item.max === 'number') {
            value = Math.max(0, Math.min(item.max, Number(value) || 0));
        }
        values[item.key] = value;
    }
    return values;
}

/**
 * Write (or, if `reset_on_complete`, clear) one schema's legacy entry.
 * Overwrites any prior entry for the same schema outright -- this is
 * meant to be "the current state of this ongoing thread," not a history
 * of every past visit, so the newest finalize always wins.
 */
function applyCarryover(orchestrator, persistenceSpec, extractedValues, adventureTitle) {
    const legacy = getLegacyState(orchestrator);
    const schema = persistenceSpec.schema;
    if (!schema) return;

    if (persistenceSpec.reset_on_complete) {
        delete legacy[schema];
        return;
    }

    legacy[schema] = {
        schema,
        values: extractedValues,
        sourceAdventure: adventureTitle || null,
        updatedAt: Date.now(),
    };

    const keys = Object.keys(legacy);
    if (keys.length > MAX_LEGACY_SCHEMAS) {
        keys.sort((a, b) => (legacy[a].updatedAt || 0) - (legacy[b].updatedAt || 0));
        delete legacy[keys[0]]; // drop the stalest schema, not the one we just wrote
    }
}

/**
 * Called from adventure-director.js's finalizeAdventure(), right before
 * it generates the prose archival summary. Fetches the just-finished
 * adventure's `persistence` declaration (GM/AI-eyes-only reference data,
 * same fetch path as npcs/notes/knowledge) and, if present, extracts +
 * applies its carryover. A complete no-op (not an error) for the many
 * adventures that never declare `persistence` at all.
 */
async function finalizeLegacy(context, finishedState) {
    let ref = null;
    try {
        ref = await context.apiRequest('GET', ['adventure', 'reference']);
    } catch (e) {
        console.warn('[LegacyTracker] Could not fetch reference data for legacy extraction:', e.message);
        return;
    }
    const persistenceSpec = ref?.persistence;
    if (!persistenceSpec || !persistenceSpec.schema || !Array.isArray(persistenceSpec.carryover)) {
        return; // this adventure never opted into the legacy tracker
    }
    const extracted = extractCarryover(context.orchestrator, persistenceSpec, finishedState);
    applyCarryover(context.orchestrator, persistenceSpec, extracted, finishedState.title);
}

/**
 * Formatted JSON block for the LLM system prompt -- called every turn an
 * adventure declaring `persistence` is active (see
 * adventure-context.js's getSceneContextForPrompt()), not just at load,
 * so the model can reference exact figures consistently throughout play.
 * Returns '' (safe to always append) if this adventure has no
 * `persistence` block, or its schema has no legacy entry yet (e.g. the
 * very first adventure to ever use this schema).
 */
function getLegacyContextBlock(orchestrator, persistenceSpec) {
    if (!persistenceSpec || !persistenceSpec.schema) return '';
    const legacy = getLegacyState(orchestrator);
    const entry = legacy[persistenceSpec.schema];
    if (!entry) return '';

    const lines = [];
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push(`LEGACY / CARRYOVER STATE — schema "${entry.schema}" (factual, from a previous adventure)`);
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push(`Carried over from: "${entry.sourceAdventure || 'a previous adventure'}"`);
    lines.push(JSON.stringify(entry.values, null, 2));
    lines.push(
        'Treat the values above as established campaign fact, not narrative flavor -- ' +
        'reference them precisely (exact counts, exact statuses) rather than paraphrasing ' +
        'vaguely. If this adventure also tracks the same keys going forward, keep them ' +
        'current with `[FACT key value]` as play advances them.'
    );
    lines.push('═══════════════════════════════════════════════════════════════');
    return '\n\n' + lines.join('\n');
}

/** GM-facing dump of a single schema's tracked state (or "none yet"), used by `!gm adventure legacy [schema]`. */
function formatLegacyEntry(orchestrator, schema) {
    const legacy = getLegacyState(orchestrator);
    const entry = legacy[schema];
    if (!entry) return `*No legacy state recorded yet for schema \`${schema}\`.*`;
    const lines = [];
    lines.push(`📜 **Legacy — \`${entry.schema}\`**`);
    lines.push(`From: "${entry.sourceAdventure || 'unknown'}" — updated ${new Date(entry.updatedAt).toLocaleString()}`);
    lines.push('```json');
    lines.push(JSON.stringify(entry.values, null, 2));
    lines.push('```');
    return lines.join('\n');
}

/** GM-facing list of every schema currently tracked, used by `!gm adventure legacy` with no argument. */
function formatAllLegacy(orchestrator) {
    const legacy = getLegacyState(orchestrator);
    const schemas = Object.keys(legacy);
    if (schemas.length === 0) return '*No legacy/carryover state has been recorded yet.*';
    const lines = ['📜 **Tracked legacy schemas:**'];
    for (const schema of schemas) {
        const entry = legacy[schema];
        lines.push(`- \`${schema}\` (from "${entry.sourceAdventure || 'unknown'}", ${Object.keys(entry.values || {}).length} key(s))`);
    }
    lines.push('\nUse `!gm adventure legacy <schema>` to see the full values, or `!gm adventure legacy <schema> set <key> <json-value>` to override one by hand.');
    return lines.join('\n');
}

/** GM override: set a single key within a schema's legacy entry by hand (creates the schema entry if it doesn't exist yet). `rawValue` is JSON-parsed when possible, else stored as a plain string -- same convention as everywhere else here. */
function setLegacyValue(orchestrator, schema, key, rawValue) {
    const legacy = getLegacyState(orchestrator);
    if (!legacy[schema]) {
        legacy[schema] = { schema, values: {}, sourceAdventure: null, updatedAt: Date.now() };
    }
    let value = rawValue;
    try {
        value = JSON.parse(rawValue);
    } catch (e) {
        // leave as the raw string
    }
    legacy[schema].values[key] = value;
    legacy[schema].updatedAt = Date.now();
    return legacy[schema];
}

/** GM override: clear an entire schema's legacy entry. */
function clearLegacy(orchestrator, schema) {
    const legacy = getLegacyState(orchestrator);
    const existed = !!legacy[schema];
    delete legacy[schema];
    return existed;
}

module.exports = {
    getLegacyState,
    extractCarryover,
    applyCarryover,
    finalizeLegacy,
    getLegacyContextBlock,
    formatLegacyEntry,
    formatAllLegacy,
    setLegacyValue,
    clearLegacy,
};
