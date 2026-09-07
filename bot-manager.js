#!/usr/bin/env node
'use strict';

// bot-manager.js
//
// Supervises multiple ai-gm-bot.js processes (one per room) from a single
// console, with a tabbed HTTP dashboard aggregating them. See ROADMAP.md
// item 1 for the full design rationale -- this is deliberately a separate,
// opt-in entry point: `node ai-gm-bot.js` (and the Docker images,
// docker-compose.yml) are completely unaffected. Run this instead of
// ai-gm-bot.js only if you want to run several tables on one host.
//
// Usage:
//   node bot-manager.js [path/to/bots.json]     (defaults to ./bots.json)
//
// Manifest format (see bots.example.json):
//   {
//     "bots": [
//       { "room": "AC12", "envFile": ".env",        "mode": "gm"              },
//       { "room": "AC12", "envFile": ".env.p1",     "mode": "player", "seat": 1 },
//       { "room": "XY99", "envFile": ".env.xy99" }
//     ]
//   }
//
// SEATS. Several bots may now share a room -- that is the whole point of
// Player Mode (docs/two-seats-spec.md SS3.1): a table can seat a GM bot, one
// or two bot-played characters, and a passive rules oracle at once. The unit
// of identity is therefore the SEAT, not the room:
//
//   room     the table, as humans say it out loud. No longer unique.
//   seat     integer >= 0, unique WITHIN a room. Auto-assigned in manifest
//            order when omitted, so legacy entries need no changes.
//   mode     'gm' | 'player' | 'passive'. Defaults to 'gm', which is what a
//            lone legacy bot has always been.
//   roomId   optional opaque durable room id (UUIDv7 recommended) -- see
//            SAAS_MANAGER.md: the room's UUID is its identity, `room` is a
//            rotatable human locator. Passed through as ROOM_ID; the manager
//            does not interpret it.
//
// LEGACY ENTRIES ARE PRESERVED EXACTLY. An entry that declares none of
// seat/mode/roomId is treated as legacy: seat 0, mode gm, and its log stays
// at logs/<ROOM>.log rather than moving to the seat-qualified name. Nothing
// about a single-bot-per-room manifest changes.
//
// Each bot is forked as its own child process (`child_process.fork`), so a
// crash in one table's bot cannot take another down -- the same isolation
// posture the socket server's CLUSTER_WORKERS already uses for its own
// workers. Each child's env is that entry's envFile (parsed with the
// `dotenv` package, already a dependency) merged over this process's own
// env, with `ROOM`, `STATUS_PORT` and `BOT_SEAT` force-set from the
// manifest entry / assigned port -- so an envFile can be a straight copy of
// the repo's root .env and still get a distinct room, seat and dashboard
// port per bot. `MODE` and `ROOM_ID` are force-set ONLY when the manifest
// declares them, so an envFile that already sets MODE keeps working.
//
// Every child keeps running its own existing status-server.js dashboard
// unchanged, on a manager-assigned port. Rather than reinventing that
// dashboard, the manager's own "tab" for a bot is mostly an <iframe> onto
// that bot's already-existing dashboard -- the tabbed console just adds
// the piece that didn't exist before: a live per-room log pane (tailed
// from a file under logs/<ROOM>-s<SEAT>.log) and a lightweight system-wide
// overview (CPU/RAM per child, process table), one thing status-server.js
// deliberately doesn't try to do for itself.

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { fork, exec } = require('child_process');
const dotenv = require('dotenv');

const REPO_ROOT = __dirname;
const LOG_DIR = path.join(REPO_ROOT, 'logs');
const MAX_BOTS = parseInt(process.env.MAX_BOTS || '12', 10);
const MANAGER_PORT = parseInt(process.env.MANAGER_PORT || '4140', 10);
const MANAGER_HOST = process.env.MANAGER_HOST || '127.0.0.1';
const BASE_BOT_STATUS_PORT = parseInt(process.env.BASE_BOT_STATUS_PORT || '4150', 10);
const LOG_RING_SIZE = 500; // lines kept in memory per bot for the dashboard's live pane; full history is still on disk

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ============================================================
// Manifest loading
// ============================================================

const VALID_MODES = ['gm', 'player', 'passive'];

/** Stable identity of a running bot: its room AND its seat within that room. */
function seatKeyFor(entry) {
    return `${entry.room}#${entry.seat}`;
}

/** A human label for logs and dashboard tabs. */
function seatLabelFor(entry) {
    return entry._legacy ? entry.room : `${entry.room} s${entry.seat}`;
}

/**
 * Log file for a seat.
 *
 * Legacy entries keep logs/<ROOM>.log so an existing deployment's log path,
 * and anything tailing it, is unaffected. Seat-aware entries get
 * logs/<ROOM>-s<SEAT>.log. The choice is per-entry and does not depend on
 * how many other seats share the room, so adding a seat never silently
 * renames another seat's log.
 *
 * Room names come from a local manifest, but they still reach the
 * filesystem here, so anything outside [A-Za-z0-9._-] is replaced rather
 * than trusted.
 */
function logPathFor(entry) {
    const safeRoom = String(entry.room)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_');   // path.join already cannot escape LOG_DIR; this just keeps ".." out of the filename
    const suffix = entry._legacy ? '' : `-s${entry.seat}`;
    return path.join(LOG_DIR, `${safeRoom}${suffix}.log`);
}

/**
 * Fills in seat/mode defaults and rejects the configurations that would
 * produce two bots answering the same command (see docs/two-seats-spec.md
 * SS3.2 and SS7.6). Returns a new array; the caller's objects are not mutated.
 */
function normalizeEntries(bots, manifestPath) {
    const seatsByRoom = new Map();   // room -> Set(seat)
    const gmByRoom = new Map();      // room -> seat that already claimed 'gm'
    const out = [];

    for (const raw of bots) {
        if (!raw.room || typeof raw.room !== 'string') {
            throw new Error(`Manifest entry missing a "room" string: ${JSON.stringify(raw)}`);
        }
        const entry = { ...raw };

        // An entry that declares none of these is a pre-seats manifest entry
        // and is kept bit-for-bit compatible.
        entry._legacy = raw.seat === undefined && raw.mode === undefined && raw.roomId === undefined;

        if (raw.mode !== undefined) {
            if (typeof raw.mode !== 'string' || !VALID_MODES.includes(raw.mode)) {
                throw new Error(`Invalid "mode" ${JSON.stringify(raw.mode)} for room "${raw.room}" -- expected one of ${VALID_MODES.join(', ')}.`);
            }
        }
        entry.mode = raw.mode !== undefined ? raw.mode : 'gm';
        entry._modeDeclared = raw.mode !== undefined;

        if (raw.roomId !== undefined) {
            if (typeof raw.roomId !== 'string' || !raw.roomId.trim()) {
                throw new Error(`Invalid "roomId" for room "${raw.room}" -- expected a non-empty opaque id string (UUIDv7 recommended).`);
            }
            entry.roomId = raw.roomId.trim();
        }

        const used = seatsByRoom.get(entry.room) || new Set();
        if (raw.seat !== undefined) {
            if (!Number.isInteger(raw.seat) || raw.seat < 0) {
                throw new Error(`Invalid "seat" ${JSON.stringify(raw.seat)} for room "${raw.room}" -- expected a non-negative integer.`);
            }
            entry.seat = raw.seat;
        } else {
            // Lowest unused seat in manifest order, so legacy entries land on 0.
            let n = 0;
            while (used.has(n)) n += 1;
            entry.seat = n;
        }

        if (used.has(entry.seat)) {
            throw new Error(`Duplicate seat ${entry.seat} in room "${entry.room}" -- several bots may share a room, but each needs its own "seat".`);
        }
        used.add(entry.seat);
        seatsByRoom.set(entry.room, used);

        if (entry.mode === 'gm') {
            if (gmByRoom.has(entry.room)) {
                throw new Error(`Room "${entry.room}" has more than one "gm" seat (seats ${gmByRoom.get(entry.room)} and ${entry.seat}) -- exactly one bot per room may hold the GM chair. Set the others to "player" or "passive".`);
            }
            gmByRoom.set(entry.room, entry.seat);
        }

        out.push(entry);
    }
    return out;
}

function loadManifest(manifestPath) {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    const rawBots = Array.isArray(parsed.bots) ? parsed.bots : [];
    if (!rawBots.length) throw new Error(`Manifest "${manifestPath}" has no bots[] entries.`);

    const bots = normalizeEntries(rawBots, manifestPath);

    if (bots.length > MAX_BOTS) {
        console.warn(`⚠️  Manifest lists ${bots.length} bots, but MAX_BOTS=${MAX_BOTS}. Only the first ${MAX_BOTS} will be started -- raise MAX_BOTS (env var) to run more. See ROADMAP.md item 1 for why there's a cap at all.`);
    }
    return bots.slice(0, MAX_BOTS);
}

function loadBotEnv(entry, index) {
    let fileEnv = {};
    if (entry.envFile) {
        const envPath = path.isAbsolute(entry.envFile) ? entry.envFile : path.join(REPO_ROOT, entry.envFile);
        if (fs.existsSync(envPath)) {
            fileEnv = dotenv.parse(fs.readFileSync(envPath));
        } else {
            console.warn(`⚠️  envFile "${entry.envFile}" for room ${entry.room} not found -- falling back to this process's own env only.`);
        }
    }
    const env = {
        ...process.env,
        ...fileEnv,
        ROOM: entry.room,
        STATUS_PORT: String(entry.statusPort || BASE_BOT_STATUS_PORT + index),
        STATUS_HOST: '127.0.0.1',
        // Manager-assigned, exactly like STATUS_PORT: a seat does not get to
        // disagree with the manifest about which seat it is.
        BOT_SEAT: String(entry.seat === undefined ? 0 : entry.seat),
    };

    // MODE and ROOM_ID are force-set only when the MANIFEST declares them.
    // Left alone otherwise, so an envFile that already sets MODE (or a
    // pre-seats deployment that sets neither) keeps its existing behaviour
    // instead of being silently overridden by this function's default.
    if (entry._modeDeclared) {
        env.MODE = entry.mode;
    } else if (env.MODE === undefined) {
        env.MODE = 'gm';
    }
    if (entry.roomId !== undefined) {
        env.ROOM_ID = entry.roomId;
    }

    return env;
}

// ============================================================
// Bot supervision
// ============================================================

/** @type {Map<string, { entry, index, child, logStream, ring: string[], status: string, restarts: number, startedAt: number, statusPort: number }>} */
const bots = new Map();

function appendRing(bot, line) {
    bot.ring.push(line);
    if (bot.ring.length > LOG_RING_SIZE) bot.ring.shift();
}

function startBot(entry, index) {
    const statusPort = entry.statusPort || BASE_BOT_STATUS_PORT + index;
    const env = loadBotEnv(entry, index);
    const key = seatKeyFor(entry);
    const label = seatLabelFor(entry);
    const logPath = logPathFor(entry);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    console.log(`🚀 Starting ${entry.mode} bot for ${label} (dashboard: http://127.0.0.1:${statusPort}/, log: ${logPath})`);

    const child = fork(path.join(REPO_ROOT, 'ai-gm-bot.js'), [], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const bot = bots.get(key) || { entry, index, ring: [], restarts: 0 };
    bot.entry = entry;
    bot.index = index;
    bot.key = key;
    bot.label = label;
    bot.child = child;
    bot.logStream = logStream;
    bot.status = 'running';
    bot.startedAt = Date.now();
    bot.statusPort = statusPort;
    bots.set(key, bot);

    const pipe = (stream, tag) => {
        stream.on('data', (chunk) => {
            logStream.write(chunk);
            const text = chunk.toString();
            text.split('\n').filter(Boolean).forEach(line => appendRing(bot, `${tag}${line}`));
        });
    };
    pipe(child.stdout, '');
    pipe(child.stderr, '[stderr] ');

    child.on('exit', (code, signal) => {
        bot.status = 'crashed';
        appendRing(bot, `[manager] process exited (code=${code}, signal=${signal})`);
        console.warn(`🔴 Bot for ${label} exited (code=${code}, signal=${signal}).`);
        logStream.end();
    });

    return bot;
}

/**
 * @param {string} key - a seat key ("AC12#1"). A bare room name is accepted
 *   as a convenience and resolves only when that room has exactly one seat,
 *   so an old bookmark to /api/bots/AC12/restart keeps working on a
 *   single-seat table but is refused (rather than guessing) on a shared one.
 */
function resolveBot(key) {
    const exact = bots.get(key);
    if (exact) return exact;
    if (!key.includes('#')) {
        const inRoom = [...bots.values()].filter(b => b.entry.room === key);
        if (inRoom.length === 1) return inRoom[0];
    }
    return null;
}

function restartBot(key) {
    const bot = resolveBot(key);
    if (!bot) return false;
    try { bot.child.kill(); } catch (e) { /* already dead */ }
    bot.restarts += 1;
    startBot(bot.entry, bot.index);
    return true;
}

function stopAll() {
    for (const bot of bots.values()) {
        try { bot.child.kill(); } catch (e) { /* already dead */ }
        try { bot.logStream.end(); } catch (e) { /* already closed */ }
    }
}

// ============================================================
// Lightweight per-process CPU/RAM sampling (no new dependency)
// ============================================================
//
// Uses the platform `ps` binary rather than a native/npm profiling
// module -- this manager is meant to be "lightweight," and every target
// platform (macOS, Linux) already ships a `ps` that can report
// per-PID %cpu/rss in one call. True per-process disk I/O has no
// portable equivalent (Linux exposes it via /proc/<pid>/io; macOS does
// not expose it to `ps` or any unprivileged built-in at all), so disk
// I/O is Linux-only here and reported as "n/a" elsewhere -- see
// readDiskIo() below.

function samplePids(pids) {
    return new Promise((resolve) => {
        if (!pids.length) return resolve({});
        exec(`ps -o pid=,pcpu=,rss= -p ${pids.join(',')}`, (err, stdout) => {
            const result = {};
            if (err || !stdout) return resolve(result);
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) return;
                const [pid, pcpu, rssKb] = parts;
                result[pid] = { cpuPercent: parseFloat(pcpu) || 0, rssMb: Math.round((parseInt(rssKb, 10) || 0) / 1024) };
            });
            resolve(result);
        });
    });
}

function readDiskIo(pid) {
    // Linux only -- see the comment above samplePids().
    try {
        const raw = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
        const readMatch = raw.match(/read_bytes:\s*(\d+)/);
        const writeMatch = raw.match(/write_bytes:\s*(\d+)/);
        if (!readMatch || !writeMatch) return null;
        return {
            readMb: Math.round(parseInt(readMatch[1], 10) / 1024 / 1024),
            writeMb: Math.round(parseInt(writeMatch[1], 10) / 1024 / 1024),
        };
    } catch (e) {
        return null; // not Linux, or process already gone
    }
}

async function buildOverview() {
    const running = [...bots.values()].filter(b => b.child && b.status === 'running');
    const samples = await samplePids(running.map(b => String(b.child.pid)));
    const perBot = [...bots.values()].map(b => {
        const sample = b.child ? samples[String(b.child.pid)] : null;
        return {
            key: b.key,
            label: b.label,
            room: b.entry.room,
            roomId: b.entry.roomId || null,
            seat: b.entry.seat,
            mode: b.entry.mode,
            status: b.status,
            pid: b.child ? b.child.pid : null,
            statusPort: b.statusPort,
            restarts: b.restarts,
            uptimeSec: b.startedAt ? Math.round((Date.now() - b.startedAt) / 1000) : 0,
            cpuPercent: sample ? sample.cpuPercent : null,
            rssMb: sample ? sample.rssMb : null,
            diskIo: b.child ? readDiskIo(b.child.pid) : null,
        };
    });
    return {
        manager: {
            maxBots: MAX_BOTS,
            botCount: bots.size,
            loadAvg: os.loadavg(),
            totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
            freeMemMb: Math.round(os.freemem() / 1024 / 1024),
            cpuCount: os.cpus().length,
            uptimeSec: Math.round(process.uptime()),
        },
        bots: perBot,
    };
}

// ============================================================
// HTTP dashboard
// ============================================================

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderShell() {
    const tabs = [...bots.values()].map(b =>
        `<button class="tab-btn" data-room="${escapeHtml(b.key)}">${escapeHtml(b.label)} <span class="mode mode-${escapeHtml(b.entry.mode)}">${escapeHtml(b.entry.mode)}</span></button>`
    ).join('');
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI GM Bot Manager</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 0; background: #1a1a1a; color: #eee; }
  header { padding: 0.6rem 1rem; background: #222; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 1rem; }
  header h1 { font-size: 1rem; margin: 0; }
  #tabs { display: flex; gap: 0.3rem; padding: 0.5rem 1rem; background: #1e1e1e; flex-wrap: wrap; }
  .tab-btn { background: #2a2a2a; color: #ccc; border: 1px solid #3a3a3a; border-radius: 5px; padding: 0.3rem 0.8rem; cursor: pointer; }
  .tab-btn.active { background: #d4af37; color: #111; font-weight: 600; }
  #overview { padding: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border-bottom: 1px solid #333; padding: 0.3rem 0.6rem; text-align: left; }
  th { color: #d4af37; }
  .status-running { color: #2ecc71; } .status-crashed { color: #e74c3c; }
  .mode { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.85; }
  .mode-gm { color: #d4af37; } .mode-player { color: #e08a72; } .mode-passive { color: #6bb8bd; }
  .tab-btn.active .mode { color: #111; }
  td .mono { font-family: monospace; font-size: 0.9em; color: #999; }
  iframe { width: 100%; height: 72vh; border: 1px solid #333; background: #fff; }
  #log { white-space: pre-wrap; background: #111; padding: 0.6rem; font-family: monospace; font-size: 0.75rem; height: 30vh; overflow-y: auto; border: 1px solid #333; margin-top: 0.5rem; }
  button.action { background: #333; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 0.2rem 0.6rem; cursor: pointer; }
</style></head>
<body>
<header><h1>🤖 AI GM Bot Manager</h1><span id="summary"></span></header>
<div id="tabs"><button class="tab-btn active" data-room="__overview">Overview</button>${tabs}</div>
<div id="content"></div>
<script>
let currentRoom = '__overview';
function renderOverview(data) {
  const m = data.manager;
  document.getElementById('summary').textContent = m.botCount + '/' + m.maxBots + ' bots · load ' + m.loadAvg.map(n=>n.toFixed(2)).join('/') + ' · mem ' + (m.totalMemMb - m.freeMemMb) + '/' + m.totalMemMb + ' MB';
  let rows = data.bots.map(b => \`<tr>
    <td>\${b.room}</td>
    <td>\${b.seat}</td>
    <td><span class="mode mode-\${b.mode}">\${b.mode}</span></td>
    <td class="mono">\${b.roomId ?? '-'}</td>
    <td class="status-\${b.status}">\${b.status}</td>
    <td>\${b.pid ?? '-'}</td>
    <td>\${b.cpuPercent != null ? b.cpuPercent.toFixed(1) + '%' : 'n/a'}</td>
    <td>\${b.rssMb != null ? b.rssMb + ' MB' : 'n/a'}</td>
    <td>\${b.diskIo ? ('R ' + b.diskIo.readMb + 'MB / W ' + b.diskIo.writeMb + 'MB') : 'n/a'}</td>
    <td>\${b.uptimeSec}s</td>
    <td>\${b.restarts}</td>
    <td><a href="http://127.0.0.1:\${b.statusPort}/" target="_blank">dashboard</a> · <button class="action" onclick="restartBot('\${b.key}')">Restart</button></td>
  </tr>\`).join('');
  document.getElementById('content').innerHTML = \`<div id="overview">
    <table><thead><tr><th>Room</th><th>Seat</th><th>Mode</th><th>Room ID</th><th>Status</th><th>PID</th><th>CPU</th><th>RAM</th><th>Disk I/O</th><th>Uptime</th><th>Restarts</th><th></th></tr></thead>
    <tbody>\${rows}</tbody></table>
  </div>\`;
}
function renderBotTab(key) {
  document.getElementById('content').innerHTML = \`
    <div style="padding:1rem;">
      <iframe src="http://127.0.0.1:\${window.__statusPorts[key]}/"></iframe>
      <div id="log">(loading log…)</div>
    </div>\`;
  refreshLog(key);
}
window.__statusPorts = {};
async function refreshOverview() {
  const res = await fetch('/api/overview'); const data = await res.json();
  data.bots.forEach(b => window.__statusPorts[b.key] = b.statusPort);
  if (currentRoom === '__overview') renderOverview(data);
}
async function refreshLog(key) {
  if (currentRoom !== key) return;
  const res = await fetch('/api/bots/' + encodeURIComponent(key) + '/log');
  const text = await res.text();
  const el = document.getElementById('log');
  if (el) { el.textContent = text; el.scrollTop = el.scrollHeight; }
}
async function restartBot(key) {
  await fetch('/api/bots/' + encodeURIComponent(key) + '/restart', { method: 'POST' });
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn'); if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentRoom = btn.dataset.room;
  if (currentRoom === '__overview') refreshOverview(); else renderBotTab(currentRoom);
});
refreshOverview();
setInterval(() => { if (currentRoom === '__overview') refreshOverview(); else refreshLog(currentRoom); }, 3000);
</script>
</body></html>`;
}

function startDashboard() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === '/' ) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(renderShell());
            return;
        }
        if (url.pathname === '/api/overview') {
            const overview = await buildOverview();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(overview));
            return;
        }
        const logMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/log$/);
        if (logMatch && req.method === 'GET') {
            const bot = resolveBot(decodeURIComponent(logMatch[1]));
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(bot ? bot.ring.join('\n') : 'No such bot.');
            return;
        }
        const restartMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/restart$/);
        if (restartMatch && req.method === 'POST') {
            const ok = restartBot(decodeURIComponent(restartMatch[1]));
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok }));
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });
    server.listen(MANAGER_PORT, MANAGER_HOST, () => {
        console.log(`📊 Bot Manager dashboard: http://${MANAGER_HOST}:${MANAGER_PORT}/`);
    });
    return server;
}

// ============================================================
// Entry point
// ============================================================

function main() {
    const manifestPath = path.isAbsolute(process.argv[2] || '')
        ? process.argv[2]
        : path.join(REPO_ROOT, process.argv[2] || 'bots.json');

    if (!fs.existsSync(manifestPath)) {
        console.error(`❌ No manifest found at ${manifestPath}. Copy bots.example.json to bots.json (or pass a path: node bot-manager.js path/to/manifest.json) and list the rooms to run.`);
        process.exit(1);
    }

    const manifest = loadManifest(manifestPath);
    manifest.forEach((entry, index) => startBot(entry, index));
    startDashboard();

    const shutdown = () => {
        console.log('\n🛑 Shutting down all bots...');
        stopAll();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main();
}

module.exports = {
    loadManifest,
    normalizeEntries,
    loadBotEnv,
    seatKeyFor,
    seatLabelFor,
    logPathFor,
    resolveBot,
    restartBot,
    samplePids,
    readDiskIo,
    buildOverview,
    bots,
    VALID_MODES,
};
