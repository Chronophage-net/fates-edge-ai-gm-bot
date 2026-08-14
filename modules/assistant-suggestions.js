// modules/assistant-suggestions.js
//
// Suggestion queue for Assistant GM mode (see ai-gm-bot.js's myRole ===
// 'assistant-gm' handling and commands.js's processSpecialTags()).
//
// Assistant GM mode is a middle tier between full GM (the bot narrates and
// every [TAG ...] it emits applies immediately) and a passive player/
// spectator (the bot does nothing at all). In Assistant GM mode the bot
// still narrates and still runs every *mechanical* tag immediately (rolls,
// resource deltas, timers) -- but anything with real narrative authority
// (a new fact becoming campaign truth, a brand-new NPC, a scene ending)
// gets held here instead of applied, so the human GM/Co-GM keeps final say.
//
// Deliberately a single in-memory queue, not persisted to the campaign
// JSON: a pending suggestion is a proposal, not committed state, and this
// bot is a single process per room -- there is nothing to recover across a
// restart except suggestions nobody had reviewed yet, which is fine to
// simply lose (they were never real).
//
// Each entry is:
//   {
//     id,               // string, stable for this process's lifetime
//     kind,             // 'fact' | 'npc-create' | 'scene-complete'
//     label,            // short human-readable description for the panel
//     createdAt,        // epoch ms
//     apply,            // async () => string|void -- performs the actual
//                        //   mutation exactly as full-GM mode would, and
//                        //   returns whatever chat text should be posted
//                        //   (or falsy for a silent tag like [FACT ...])
//   }
//
// `apply` is a closure captured at enqueue time (character/orchestrator
// references, regex-matched args, etc.) rather than a serialized payload --
// this queue only ever needs to be read/approved from within the same
// process (the status dashboard's HTTP API calls back into this module
// directly), so there's no need to reconstruct call context from JSON.

let nextId = 1;
let queue = [];

/**
 * @param {Object} entry
 * @param {string} entry.kind
 * @param {string} entry.label
 * @param {Function} entry.apply - async () => string|void
 * @returns {Object} the queued entry (safe to log; `apply` omitted from any
 *   serialization the caller does, since callers should use toJSON()/list()
 *   for anything that leaves this module)
 */
function enqueue({ kind, label, apply }) {
    if (typeof apply !== 'function') {
        throw new Error('assistant-suggestions.enqueue() requires an apply() function');
    }
    const entry = {
        id: `sugg_${nextId++}`,
        kind: kind || 'other',
        label: label || '(no description)',
        createdAt: Date.now(),
        apply,
    };
    queue.push(entry);
    return entry;
}

/** Plain-JSON list for the status dashboard -- never exposes `apply`. */
function list() {
    return queue.map(({ id, kind, label, createdAt }) => ({ id, kind, label, createdAt }));
}

function count() {
    return queue.length;
}

function find(id) {
    return queue.find(e => e.id === id) || null;
}

/**
 * Runs the suggestion's apply() and removes it from the queue regardless of
 * outcome (a suggestion that fails to apply shouldn't sit there forever --
 * it's re-proposable next time the AI narrates the same beat).
 * @returns {Promise<{ ok: boolean, result?: any, error?: string }>}
 */
async function approve(id) {
    const entry = find(id);
    if (!entry) return { ok: false, error: `No pending suggestion "${id}"` };
    queue = queue.filter(e => e.id !== id);
    try {
        const result = await entry.apply();
        return { ok: true, result, entry };
    } catch (e) {
        return { ok: false, error: e.message, entry };
    }
}

function reject(id) {
    const entry = find(id);
    if (!entry) return { ok: false, error: `No pending suggestion "${id}"` };
    queue = queue.filter(e => e.id !== id);
    return { ok: true, entry };
}

/** Rejects everything -- used when a session ends or the bot loses
 * Assistant GM status (a full GM taking back the seat should not come back
 * to a pile of stale suggestions from before they were even present). */
function clear() {
    const cleared = queue.length;
    queue = [];
    return cleared;
}

// Exposed for tests only -- resets the id counter so test output is
// deterministic across files/runs.
function _resetForTests() {
    queue = [];
    nextId = 1;
}

module.exports = { enqueue, list, count, find, approve, reject, clear, _resetForTests };
