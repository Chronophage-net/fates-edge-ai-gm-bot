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
//     kind,             // 'fact' | 'npc-create' | 'scene-complete' |
//                       //   'knowledge-reveal' | 'knowledge-hide' |
//                       //   'sb-spend-synthesis' | 'crown-synthesis'
//     label,            // short human-readable description for the panel
//     preview,          // longer text a client can show before approving
//                        //   -- for most kinds this is redundant with
//                        //   `label`, but for the two synthesis kinds it's
//                        //   the actual proposed prose (see ROADMAP.md's
//                        //   "Decided -- preview on every kind" note)
//     groupId,          // optional -- ties together multiple suggestions
//                        //   that are alternatives for the same event (e.g.
//                        //   several Crown Spread interpretations from one
//                        //   draw). Approving one member auto-rejects every
//                        //   other pending suggestion sharing this groupId.
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
//
// ─── Broadcasting (assistant-suggestion-created/-resolved) ────────────
// This module has no idea what a WebSocket is -- it just calls an optional
// broadcaster callback, set once by ai-gm-bot.js at startup via
// setBroadcaster(), any time a suggestion is created or resolved. That
// keeps every call site in process-tags.js/gm-commands.js exactly as
// simple as before (just enqueue()/approve()/reject(), same as pre-groupId)
// while still getting the two new socket events out to clients uniformly.
// See fates-edge-socket-server's ws-handlers.js/socketio-handlers.js for
// the plain pass-through relay these events ride on, and ROADMAP.md for
// the full payload spec.

let nextId = 1;
let queue = [];
let broadcaster = null;

/**
 * @param {Function|null} fn - (event: string, payload: object) => void.
 *   Pass null to disable broadcasting (e.g. before the bot's WS connection
 *   is up, or in tests).
 */
function setBroadcaster(fn) {
    broadcaster = typeof fn === 'function' ? fn : null;
}

function emit(event, payload) {
    if (!broadcaster) return;
    try {
        broadcaster(event, payload);
    } catch (e) {
        // Never let a broadcast failure break suggestion handling itself.
        console.warn(`[assistant-suggestions] broadcaster threw for "${event}":`, e.message);
    }
}

/**
 * @param {Object} entry
 * @param {string} entry.kind
 * @param {string} entry.label
 * @param {string} [entry.preview] - defaults to `label` when omitted, so
 *   every kind gets a usable `preview` field even if the call site didn't
 *   bother passing one.
 * @param {string} [entry.groupId] - see the module doc comment above.
 * @param {Function} entry.apply - async () => string|void
 * @returns {Object} the queued entry (safe to log; `apply` omitted from any
 *   serialization the caller does, since callers should use toJSON()/list()
 *   for anything that leaves this module)
 */
function enqueue({ kind, label, preview, groupId, apply }) {
    if (typeof apply !== 'function') {
        throw new Error('assistant-suggestions.enqueue() requires an apply() function');
    }
    const entry = {
        id: `sugg_${nextId++}`,
        kind: kind || 'other',
        label: label || '(no description)',
        preview: preview || label || '(no description)',
        groupId: groupId || null,
        createdAt: Date.now(),
        apply,
    };
    queue.push(entry);
    emit('assistant-suggestion-created', {
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        preview: entry.preview,
        groupId: entry.groupId,
        createdAt: entry.createdAt,
    });
    return entry;
}

/** Plain-JSON list for the status dashboard -- never exposes `apply`. */
function list() {
    return queue.map(({ id, kind, label, preview, groupId, createdAt }) => ({ id, kind, label, preview, groupId, createdAt }));
}

function count() {
    return queue.length;
}

function find(id) {
    return queue.find(e => e.id === id) || null;
}

/**
 * Runs the suggestion's apply(), removes it from the queue regardless of
 * outcome (a suggestion that fails to apply shouldn't sit there forever --
 * it's re-proposable next time the AI narrates the same beat), and -- when
 * the entry has a groupId -- auto-rejects every other still-pending
 * suggestion sharing that groupId (e.g. approving one Crown Spread
 * interpretation drops the sibling interpretations from the same draw).
 * @returns {Promise<{ ok: boolean, result?: any, error?: string, autoRejected?: string[] }>}
 */
async function approve(id) {
    const entry = find(id);
    if (!entry) return { ok: false, error: `No pending suggestion "${id}"` };
    queue = queue.filter(e => e.id !== id);

    let autoRejected = [];
    if (entry.groupId) {
        const siblings = queue.filter(e => e.groupId === entry.groupId);
        queue = queue.filter(e => e.groupId !== entry.groupId);
        autoRejected = siblings.map(s => s.id);
        siblings.forEach(s => {
            emit('assistant-suggestion-resolved', { id: s.id, outcome: 'auto-rejected', result: null });
        });
    }

    try {
        const result = await entry.apply();
        emit('assistant-suggestion-resolved', { id: entry.id, outcome: 'approved', result: (typeof result === 'string') ? result : null });
        return { ok: true, result, entry, autoRejected };
    } catch (e) {
        emit('assistant-suggestion-resolved', { id: entry.id, outcome: 'approved', result: null });
        return { ok: false, error: e.message, entry, autoRejected };
    }
}

function reject(id) {
    const entry = find(id);
    if (!entry) return { ok: false, error: `No pending suggestion "${id}"` };
    queue = queue.filter(e => e.id !== id);
    emit('assistant-suggestion-resolved', { id: entry.id, outcome: 'rejected', result: null });
    return { ok: true, entry };
}

/** Rejects everything -- used when a session ends or the bot loses
 * Assistant GM status (a full GM taking back the seat should not come back
 * to a pile of stale suggestions from before they were even present).
 * Deliberately does NOT emit assistant-suggestion-resolved per entry --
 * this is a bulk teardown, not individual GM decisions, and callers that
 * care can treat "role changed" as implicitly clearing every suggestion
 * client-side. */
function clear() {
    const cleared = queue.length;
    queue = [];
    return cleared;
}

// Exposed for tests only -- resets the id counter and broadcaster so test
// output is deterministic across files/runs.
function _resetForTests() {
    queue = [];
    nextId = 1;
    broadcaster = null;
}

module.exports = { enqueue, list, count, find, approve, reject, clear, setBroadcaster, _resetForTests };
