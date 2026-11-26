// modules/logger.js
//
// Small leveled logger shared by the whole bot. Two jobs:
//
//   1. Let noisy, low-value output (aggressive-sync ticks, the raw
//      per-message WebSocket dump) be marked DEBUG so it's off by
//      default instead of drowning the terminal and the status
//      dashboard's "latest messages" feed. Set LOG_LEVEL=debug to see
//      it again.
//   2. Feed a small in-memory ring buffer + EventEmitter that
//      modules/status-server.js reads from / subscribes to, so the
//      dashboard's live feed doesn't need its own separate logging path
//      -- it just sees whatever actually got logged.
//
// Existing `console.log(...)` call sites all over the codebase are left
// alone: at the bottom of this module we monkey-patch console.log/warn/
// error/debug so they're automatically treated as their matching level,
// recorded into the ring buffer, and still print to the terminal exactly
// as before (when the configured LOG_LEVEL allows it). Call sites that
// want to be DEBUG-only (i.e. excluded from the default terminal AND
// dashboard) call logger.debug(...) directly instead of console.log(...).

const { EventEmitter } = require('events');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const RING_SIZE = parseInt(process.env.LOG_RING_SIZE || '300', 10);

// Captured BEFORE any monkey-patching below, and used directly by
// Logger's own methods -- calling the (later-patched) console.log from
// inside logger.info() etc. would double-record every entry (once here,
// once when the patched console.log re-enters _record()).
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

// Terminal formatting, matching the socket server's console:
//   16:56:33.248 INFO  🤝 Handshake OK. Role: gm
// Coloured on a terminal, ISO time elsewhere (Docker, systemd, files);
// LOG_FORMAT=json prints one JSON object per line for log collectors.
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const JSON_FORMAT = String(process.env.LOG_FORMAT || '').toLowerCase() === 'json';
const COLOR = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.stdout.isTTY);

function print(printFn, level, args) {
    const now = new Date();
    if (JSON_FORMAT) {
        printFn(JSON.stringify({ time: now.toISOString(), level, msg: args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ') }));
        return;
    }
    const time = COLOR ? now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0') : now.toISOString();
    const tag = level.toUpperCase().padEnd(5);
    printFn(COLOR ? `\x1b[2m${time}\x1b[0m ${COLORS[level]}${tag}\x1b[0m` : `${time} ${tag}`, ...args);
}

class Logger extends EventEmitter {
    constructor() {
        super();
        this.setLevel(process.env.LOG_LEVEL || 'info');
        this.buffer = [];
        this._seq = 0;
    }

    setLevel(level) {
        const lvl = String(level || 'info').toLowerCase();
        this.level = LEVELS.hasOwnProperty(lvl) ? lvl : 'info';
        this.levelValue = LEVELS[this.level];
    }

    _record(level, args) {
        const entry = {
            id: ++this._seq,
            level,
            time: Date.now(),
            text: args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ')
        };
        this.buffer.push(entry);
        if (this.buffer.length > RING_SIZE) this.buffer.shift();
        this.emit('entry', entry);
        return entry;
    }

    _log(level, printFn, args) {
        const shouldPrint = LEVELS[level] <= this.levelValue;
        // Always record at debug level or finer-than-current so the ring
        // buffer can hold recent debug entries too if someone bumps
        // LOG_LEVEL up mid-session -- but only entries that were at or
        // under the *current* level at the time get emitted live, since
        // status-server.js's SSE stream should reflect what an operator
        // watching the terminal right now would actually see.
        if (shouldPrint) {
            this._record(level, args);
            print(printFn, level, args);
        }
    }

    error(...args) { this._log('error', _origError, args); }
    warn(...args) { this._log('warn', _origWarn, args); }
    info(...args) { this._log('info', _origLog, args); }
    debug(...args) { this._log('debug', _origLog, args); }

    recent(limit = 100) {
        return this.buffer.slice(-limit);
    }
}

function safeStringify(v) {
    try {
        return JSON.stringify(v);
    } catch (e) {
        return String(v);
    }
}

const logger = new Logger();

// ── Monkey-patch console.* so every EXISTING call site in the codebase
// (console.log/warn/error) automatically feeds the ring buffer and
// respects LOG_LEVEL, with zero per-call-site changes required.
// console.log()/console.debug() are treated as 'info' -- most existing
// call sites are ordinary status lines, not the handful of intentionally
// spammy ones (which have been switched to call logger.debug() directly
// instead, bypassing this patch entirely).
console.log = (...args) => {
    if (LEVELS.info <= logger.levelValue) {
        logger._record('info', args);
        print(_origLog, 'info', args);
    }
};
console.warn = (...args) => {
    if (LEVELS.warn <= logger.levelValue) {
        logger._record('warn', args);
        print(_origWarn, 'warn', args);
    }
};
console.error = (...args) => {
    // Errors always print/record regardless of LOG_LEVEL -- silencing
    // real errors because someone turned logging down is exactly the
    // kind of surprise a GM bot running unattended shouldn't spring.
    logger._record('error', args);
    print(_origError, 'error', args);
};

module.exports = logger;
