// modules/ws-correlator.js
//
// Tiny request/response correlator for the bot's single WebSocket
// connection. Some server responses (crown-spread, deck-drawn) arrive as
// a broadcast on the *same* connection that requested them, with no
// per-request id anywhere in the wire protocol -- so this assumes at
// most one in-flight request per response `type` at a time, matching the
// existing seedCampaign()/seedRequested single-in-flight pattern already
// in ai-gm-bot.js (this module generalizes that pattern instead of
// duplicating it for the new Crown Spread synthesis flow -- see
// gm-commands.js's `!gm deck crown` handling and ROADMAP.md item 2).
//
// A second request for the same response `type` while one is already
// pending replaces the first waiter (the first's promise rejects instead
// of hanging forever). That's an acceptable trade-off here: Assistant GM
// commands are typed serially by a human at one table, this bot is one
// process per room, and there is no realistic case where two unrelated
// Crown Spread draws are in flight at once.

const pending = new Map(); // responseType -> { resolve, reject, timer }

/**
 * @param {string} responseType - the inbound WS message `type` to wait for.
 * @param {number} [timeoutMs]
 * @returns {Promise<Object>} resolves with the full message object handed
 *   to resolve() below.
 */
function waitFor(responseType, timeoutMs = 15000) {
    return new Promise((resolvePromise, rejectPromise) => {
        const existing = pending.get(responseType);
        if (existing) {
            clearTimeout(existing.timer);
            pending.delete(responseType);
            existing.reject(new Error(`Superseded by a newer "${responseType}" request`));
        }
        const timer = setTimeout(() => {
            pending.delete(responseType);
            rejectPromise(new Error(`Timed out waiting for "${responseType}"`));
        }, timeoutMs);
        pending.set(responseType, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
}

/**
 * Called from ai-gm-bot.js's handleMessage() when a message of this type
 * arrives. Returns true if a waiter was resolved, false if nothing was
 * pending (the normal case for most messages -- callers should keep doing
 * whatever they already did with the message either way).
 */
function resolve(responseType, data) {
    const waiter = pending.get(responseType);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    pending.delete(responseType);
    waiter.resolve(data);
    return true;
}

// Exposed for tests only.
function _resetForTests() {
    pending.forEach(w => clearTimeout(w.timer));
    pending.clear();
}

module.exports = { waitFor, resolve, _resetForTests };
