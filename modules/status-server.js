// modules/status-server.js
//
// Tiny built-in HTTP status dashboard -- no new npm dependencies (plain
// `http`, reuses the logger's ring buffer/EventEmitter). Serves one HTML
// page at STATUS_PORT (default 4141) showing:
//   - live "latest messages" feed (logger output, sync-spam pruned to
//     DEBUG so it doesn't flood this by default -- see modules/logger.js)
//   - the currently loaded adventure module / act / scene
//   - session token usage (from the active AI driver)
//   - connection/role/uptime and other at-a-glance bot state
//
// Live updates are pushed over Server-Sent Events (`/events`), which
// needs nothing beyond what's already built into the browser and into
// Node's http module -- no extra dependency just for a live feed.
//
// Usage (see ai-gm-bot.js):
//   const statusServer = require('./modules/status-server');
//   statusServer.start({ getState: () => ({...}) , port: STATUS_PORT });

const http = require('http');
const logger = require('./logger');

let server = null;
let sseClients = [];
let getStateFn = () => ({});
let startedAt = null;

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function levelColor(level) {
    switch (level) {
        case 'error': return 'var(--err)';
        case 'warn': return 'var(--warn)';
        case 'debug': return 'var(--dim)';
        default: return 'var(--fg)';
    }
}

function renderPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI GM Bot – Status</title>
<style>
  :root {
    --bg: #0f1115; --panel: #161a22; --fg: #d8dee9; --dim: #6b7280;
    --accent: #7aa2f7; --ok: #9ece6a; --warn: #e0af68; --err: #f7768e; --border: #262b36;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: var(--dim); font-size: 12px; }
  .grid {
    display: grid; gap: 16px; padding: 20px;
    grid-template-columns: 1.3fr 1fr;
  }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; min-width: 0;
  }
  .panel h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--dim); margin: 0 0 12px 0; font-weight: 600;
  }
  .stack { display: flex; flex-direction: column; gap: 16px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px;
    border: 1px solid var(--border);
  }
  .badge.ok { color: var(--ok); border-color: var(--ok); }
  .badge.bad { color: var(--err); border-color: var(--err); }
  .badge.gm { color: var(--accent); border-color: var(--accent); }
  #feed {
    height: 480px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; background: #0b0d12; border-radius: 8px; padding: 10px;
    border: 1px solid var(--border);
  }
  #feed .line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
  #feed .time { color: var(--dim); margin-right: 8px; }
  .empty { color: var(--dim); font-style: italic; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.on { background: var(--ok); } .dot.off { background: var(--err); }
  .footer-note { color: var(--dim); font-size: 11px; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <span class="dot off" id="conn-dot"></span>
  <h1>🤖 AI GM Bot Status</h1>
  <span class="sub" id="header-sub">connecting…</span>
</header>
<div class="grid">
  <div class="panel">
    <h2>Latest Messages <span class="footer-note" id="loglevel-note"></span></h2>
    <div id="feed"><div class="empty">Waiting for log entries…</div></div>
    <div class="footer-note">Aggressive-sync / raw wire traffic is DEBUG-level and pruned from this feed by default. Set LOG_LEVEL=debug to see everything.</div>
  </div>
  <div class="stack">
    <div class="panel">
      <h2>Connection</h2>
      <dl class="kv" id="conn-kv"></dl>
    </div>
    <div class="panel">
      <h2>Adventure Module</h2>
      <dl class="kv" id="adv-kv"></dl>
    </div>
    <div class="panel">
      <h2>Session Token Usage</h2>
      <dl class="kv" id="tok-kv"></dl>
    </div>
    <div class="panel">
      <h2>Party</h2>
      <dl class="kv" id="party-kv"></dl>
    </div>
  </div>
</div>
<script>
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
}
function kv(pairs) {
  return pairs.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
}
function renderState(s) {
  document.getElementById('header-sub').textContent =
    (s.botName || 'AI_GM') + ' · room ' + (s.room || '?') + ' · uptime ' + fmtDuration(s.uptimeMs || 0);
  const dot = document.getElementById('conn-dot');
  dot.className = 'dot ' + (s.connected ? 'on' : 'off');

  document.getElementById('conn-kv').innerHTML = kv([
    ['Status', s.connected ? '<span class="badge ok">connected</span>' : '<span class="badge bad">disconnected</span>'],
    ['Role', s.role === 'gm' ? '<span class="badge gm">GM</span>' : (s.role || 'player')],
    ['WS URL', s.wsUrl || '–'],
    ['Room', s.room || '–'],
    ['Driver', (s.driverName || '–') + (s.driverModel ? ' (' + s.driverModel + ')' : '')],
    ['Log level', s.logLevel || 'info'],
  ]);

  const adv = s.adventure;
  document.getElementById('adv-kv').innerHTML = adv && adv.title ? kv([
    ['Title', adv.title],
    ['Status', adv.status || '–'],
    ['Act', adv.act || '–'],
    ['Scene', adv.scene || '–'],
    ['Region', s.region || '–'],
  ]) : '<dd class="empty">No adventure loaded.</dd>';

  const u = s.tokenUsage || {};
  document.getElementById('tok-kv').innerHTML = kv([
    ['Prompt tokens', (u.promptTokens || 0).toLocaleString() + (u.estimated ? ' ~' : '')],
    ['Completion tokens', (u.completionTokens || 0).toLocaleString() + (u.estimated ? ' ~' : '')],
    ['Total tokens', (u.totalTokens || 0).toLocaleString() + (u.estimated ? ' ~' : '')],
    ['LLM calls', u.calls || 0],
  ]);
  document.getElementById('loglevel-note').textContent = '';

  const party = s.party || [];
  document.getElementById('party-kv').innerHTML = party.length
    ? kv(party.map(p => [p.name, p.summary || '']))
    : '<dd class="empty">No characters synced yet.</dd>';
}

function appendLine(entry) {
  const feed = document.getElementById('feed');
  if (feed.querySelector('.empty')) feed.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'line';
  const t = new Date(entry.time).toLocaleTimeString();
  const colorVar = entry.level === 'error' ? 'var(--err)' : entry.level === 'warn' ? 'var(--warn)' : 'var(--fg)';
  div.innerHTML = '<span class="time">' + t + '</span><span style="color:' + colorVar + '">' +
    entry.text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
  feed.appendChild(div);
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

async function bootstrap() {
  const res = await fetch('/api/state');
  const data = await res.json();
  renderState(data.state);
  (data.log || []).forEach(appendLine);
}
bootstrap().catch(() => {});

const es = new EventSource('/events');
es.addEventListener('state', e => renderState(JSON.parse(e.data)));
es.addEventListener('log', e => appendLine(JSON.parse(e.data)));
</script>
</body>
</html>`;
}

function broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        res.write(payload);
    }
}

/**
 * @param {Object} opts
 * @param {Function} opts.getState – () => plain-JSON-serializable snapshot
 *   of whatever ai-gm-bot.js wants shown (connection, role, adventure,
 *   token usage, party, etc.)
 * @param {number} [opts.port] – defaults to STATUS_PORT env or 4141
 * @param {number} [opts.pushIntervalMs] – how often to push a fresh state
 *   snapshot to connected dashboard tabs (default 4000ms)
 */
function start({ getState, port, pushIntervalMs = 4000 } = {}) {
    if (server) return server; // idempotent -- ai-gm-bot.js may call start() once at boot only, but don't blow up on a second call
    if (typeof getState === 'function') getStateFn = getState;
    startedAt = Date.now();
    const PORT = port || parseInt(process.env.STATUS_PORT || '4141', 10);
    // SECURITY FIX: `server.listen(PORT)` with no host binds to ALL
    // interfaces (0.0.0.0) by default -- this dashboard has zero
    // authentication and serves live campaign content (recent messages,
    // adventure state, token usage), so on a bare-metal/pm2 install that
    // silently exposed it to the whole LAN (and the public internet on a
    // cloud VPS with an open port), not just the "localhost" the startup
    // log claimed. Default to loopback-only; STATUS_HOST=0.0.0.0 opts back
    // in explicitly for anyone who wants LAN access, and the bot's own
    // docker-compose.yml sets it (containers need to bind all interfaces
    // internally for Docker's port publishing to work at all).
    const HOST = process.env.STATUS_HOST || '127.0.0.1';

    server = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderPage());
            return;
        }
        if (req.url === '/api/state') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ state: snapshot(), log: logger.recent(150) }));
            return;
        }
        if (req.url === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.write('\n');
            sseClients.push(res);
            req.on('close', () => {
                sseClients = sseClients.filter(c => c !== res);
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    });

    logger.on('entry', entry => broadcastSSE('log', entry));
    const pushTimer = setInterval(() => broadcastSSE('state', snapshot()), pushIntervalMs);
    server.on('close', () => clearInterval(pushTimer));

    server.listen(PORT, HOST, () => {
        console.log(`📊 Status dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (reachable on your LAN — STATUS_HOST=0.0.0.0)' : ''}`);
    });
    server.on('error', (e) => {
        console.warn(`⚠️  Status dashboard failed to start on port ${PORT}: ${e.message}`);
    });

    return server;
}

function snapshot() {
    const state = (getStateFn && getStateFn()) || {};
    return { ...state, uptimeMs: Date.now() - (startedAt || Date.now()), logLevel: logger.level };
}

function stop() {
    if (server) {
        server.close();
        server = null;
    }
    sseClients = [];
}

module.exports = { start, stop };
