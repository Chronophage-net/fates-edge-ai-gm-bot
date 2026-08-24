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
//       { "room": "AC12", "envFile": ".env" },
//       { "room": "XY99", "envFile": ".env.xy99" }
//     ]
//   }
//
// Each bot is forked as its own child process (`child_process.fork`), so a
// crash in one table's bot cannot take another down -- the same isolation
// posture the socket server's CLUSTER_WORKERS already uses for its own
// workers. Each child's env is that entry's envFile (parsed with the
// `dotenv` package, already a dependency) merged over this process's own
// env, with `ROOM` and `STATUS_PORT` force-set from the manifest entry /
// assigned port -- so an envFile can be a straight copy of the repo's
// root .env and still get a distinct room and dashboard port per bot.
//
// Every child keeps running its own existing status-server.js dashboard
// unchanged, on a manager-assigned port. Rather than reinventing that
// dashboard, the manager's own "tab" for a bot is mostly an <iframe> onto
// that bot's already-existing dashboard -- the tabbed console just adds
// the piece that didn't exist before: a live per-room log pane (tailed
// from a file under logs/<ROOM>.log) and a lightweight system-wide
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

function loadManifest(manifestPath) {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    const bots = Array.isArray(parsed.bots) ? parsed.bots : [];
    if (!bots.length) throw new Error(`Manifest "${manifestPath}" has no bots[] entries.`);

    const seen = new Set();
    for (const entry of bots) {
        if (!entry.room || typeof entry.room !== 'string') {
            throw new Error(`Manifest entry missing a "room" string: ${JSON.stringify(entry)}`);
        }
        if (seen.has(entry.room)) {
            throw new Error(`Duplicate room "${entry.room}" in manifest -- each bot needs its own room.`);
        }
        seen.add(entry.room);
    }

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
    return {
        ...process.env,
        ...fileEnv,
        ROOM: entry.room,
        STATUS_PORT: String(entry.statusPort || BASE_BOT_STATUS_PORT + index),
        STATUS_HOST: '127.0.0.1',
    };
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
    const logPath = path.join(LOG_DIR, `${entry.room}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    console.log(`🚀 Starting bot for room ${entry.room} (dashboard: http://127.0.0.1:${statusPort}/, log: ${logPath})`);

    const child = fork(path.join(REPO_ROOT, 'ai-gm-bot.js'), [], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const bot = bots.get(entry.room) || { entry, index, ring: [], restarts: 0 };
    bot.entry = entry;
    bot.index = index;
    bot.child = child;
    bot.logStream = logStream;
    bot.status = 'running';
    bot.startedAt = Date.now();
    bot.statusPort = statusPort;
    bots.set(entry.room, bot);

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
        console.warn(`🔴 Bot for room ${entry.room} exited (code=${code}, signal=${signal}).`);
        logStream.end();
    });

    return bot;
}

function restartBot(room) {
    const bot = bots.get(room);
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
            room: b.entry.room,
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
        `<button class="tab-btn" data-room="${escapeHtml(b.entry.room)}">${escapeHtml(b.entry.room)}</button>`
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
    <td class="status-\${b.status}">\${b.status}</td>
    <td>\${b.pid ?? '-'}</td>
    <td>\${b.cpuPercent != null ? b.cpuPercent.toFixed(1) + '%' : 'n/a'}</td>
    <td>\${b.rssMb != null ? b.rssMb + ' MB' : 'n/a'}</td>
    <td>\${b.diskIo ? ('R ' + b.diskIo.readMb + 'MB / W ' + b.diskIo.writeMb + 'MB') : 'n/a'}</td>
    <td>\${b.uptimeSec}s</td>
    <td>\${b.restarts}</td>
    <td><a href="http://127.0.0.1:\${b.statusPort}/" target="_blank">dashboard</a> · <button class="action" onclick="restartBot('\${b.room}')">Restart</button></td>
  </tr>\`).join('');
  document.getElementById('content').innerHTML = \`<div id="overview">
    <table><thead><tr><th>Room</th><th>Status</th><th>PID</th><th>CPU</th><th>RAM</th><th>Disk I/O</th><th>Uptime</th><th>Restarts</th><th></th></tr></thead>
    <tbody>\${rows}</tbody></table>
  </div>\`;
}
function renderBotTab(room) {
  document.getElementById('content').innerHTML = \`
    <div style="padding:1rem;">
      <iframe src="http://127.0.0.1:\${window.__statusPorts[room]}/"></iframe>
      <div id="log">(loading log…)</div>
    </div>\`;
  refreshLog(room);
}
window.__statusPorts = {};
async function refreshOverview() {
  const res = await fetch('/api/overview'); const data = await res.json();
  data.bots.forEach(b => window.__statusPorts[b.room] = b.statusPort);
  if (currentRoom === '__overview') renderOverview(data);
}
async function refreshLog(room) {
  if (currentRoom !== room) return;
  const res = await fetch('/api/bots/' + encodeURIComponent(room) + '/log');
  const text = await res.text();
  const el = document.getElementById('log');
  if (el) { el.textContent = text; el.scrollTop = el.scrollHeight; }
}
async function restartBot(room) {
  await fetch('/api/bots/' + encodeURIComponent(room) + '/restart', { method: 'POST' });
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
            const bot = bots.get(decodeURIComponent(logMatch[1]));
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

module.exports = { loadManifest, loadBotEnv, samplePids, readDiskIo, buildOverview, bots };
