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
//   - GM Session Panel: Story Beats bank, campaign facts, recent AI
//     "memory" (conversation window), and Obligation totals per Patron
//     (see ai-gm-bot.js's buildStatusSnapshot())
//   - Assistant GM Suggestions: when this bot holds the 'assistant-gm'
//     role, narrative-authority tags it would otherwise apply immediately
//     are held in modules/assistant-suggestions.js's queue instead; this
//     panel lists them with one-click Approve/Reject (POST
//     /api/suggestions/:id/approve|reject below)
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
const assistantSuggestions = require('./assistant-suggestions');

let server = null;
let sseClients = [];
let getStateFn = () => ({});
let startedAt = null;

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
  .badge.sb { color: var(--warn); border-color: var(--warn); font-size: 14px; padding: 3px 10px; }
  .fact-list, .obligation-list { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .fact-list .fact-row { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; }
  .fact-list dt { color: var(--dim); }
  .obligation-row {
    display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid var(--border); padding-bottom: 4px;
  }
  .obligation-row:last-child { border-bottom: none; padding-bottom: 0; }
  .obligation-row .patron-name { font-weight: 600; }
  .obligation-row .patron-total { color: var(--warn); font-variant-numeric: tabular-nums; }
  .obligation-row .patron-chars { color: var(--dim); font-size: 11.5px; }
  #memory-feed {
    max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
  }
  .memory-turn { font-size: 12.5px; padding: 6px 8px; border-radius: 6px; background: #0b0d12; border: 1px solid var(--border); }
  .memory-turn .role { color: var(--accent); font-weight: 600; text-transform: uppercase; font-size: 10.5px; letter-spacing: .04em; margin-right: 6px; }
  .memory-summary { font-size: 12px; color: var(--dim); font-style: italic; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
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
  .suggestion-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    border-bottom: 1px solid var(--border); padding: 6px 0; font-size: 13px;
  }
  .suggestion-row:last-child { border-bottom: none; }
  .suggestion-row .kind { color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; margin-right: 6px; }
  .suggestion-row .actions { display: flex; gap: 6px; flex-shrink: 0; }
  .suggestion-row button {
    font-size: 12px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg); cursor: pointer;
  }
  .suggestion-row button.approve { color: var(--ok); border-color: var(--ok); }
  .suggestion-row button.reject { color: var(--err); border-color: var(--err); }
  .suggestion-row button:hover { filter: brightness(1.2); }
</style>
</head>
<body>
<header>
  <span class="dot off" id="conn-dot"></span>
  <h1>🤖 AI GM Bot Status</h1>
  <span class="sub" id="header-sub">connecting…</span>
</header>
<div class="grid">
  <div class="stack">
    <div class="panel">
      <h2>Latest Messages <span class="footer-note" id="loglevel-note"></span></h2>
      <div id="feed"><div class="empty">Waiting for log entries…</div></div>
      <div class="footer-note">Aggressive-sync / raw wire traffic is DEBUG-level and pruned from this feed by default. Set LOG_LEVEL=debug to see everything.</div>
    </div>
    <div class="panel">
      <h2>Recent AI Memory <span class="footer-note">— the model's actual conversation window</span></h2>
      <div id="memory-summary-box"></div>
      <div id="memory-feed"><div class="empty">No conversation yet.</div></div>
    </div>
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
    <div class="panel">
      <h2>Story Beats Bank</h2>
      <div id="sb-bank"><span class="badge sb">0 SB</span></div>
    </div>
    <div class="panel">
      <h2>Campaign Facts</h2>
      <dl class="fact-list" id="facts-list"></dl>
    </div>
    <div class="panel">
      <h2>Obligation by Patron</h2>
      <div class="obligation-list" id="obligation-list"></div>
    </div>
    <div class="panel" id="suggestions-panel" style="display:none;">
      <h2>Assistant GM — Pending Suggestions</h2>
      <div id="suggestions-list"></div>
    </div>
  </div>
</div>
<script>
function fmtDuration(ms) {
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
}

function kv(pairs) {
  return pairs.map(function(p) { return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>'; }).join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderState(s) {
  document.getElementById('header-sub').textContent =
    (s.botName || 'AI_GM') + ' · room ' + (s.room || '?') + ' · uptime ' + fmtDuration(s.uptimeMs || 0);
  var dot = document.getElementById('conn-dot');
  dot.className = 'dot ' + (s.connected ? 'on' : 'off');

  document.getElementById('conn-kv').innerHTML = kv([
    ['Status', s.connected ? '<span class="badge ok">connected</span>' : '<span class="badge bad">disconnected</span>'],
    ['Role', s.role === 'gm' ? '<span class="badge gm">GM</span>' : (s.role || 'player')],
    ['WS URL', s.wsUrl || '–'],
    ['Room', s.room || '–'],
    ['Driver', (s.driverName || '–') + (s.driverModel ? ' (' + s.driverModel + ')' : '')],
    ['Log level', s.logLevel || 'info']
  ]);

  var adv = s.adventure;
  document.getElementById('adv-kv').innerHTML = (adv && adv.title) ? kv([
    ['Title', adv.title],
    ['Status', adv.status || '–'],
    ['Act', adv.act || '–'],
    ['Scene', adv.scene || '–'],
    ['Region', s.region || '–']
  ]) : '<dd class="empty">No adventure loaded.</dd>';

  var u = s.tokenUsage || {};
  var tokRows = [
    ['Prompt tokens', (u.promptTokens || 0).toLocaleString() + (u.estimated ? ' ~' : '')],
    ['Completion tokens', (u.completionTokens || 0).toLocaleString() + (u.estimated ? ' ~' : '')],
    ['Total tokens', (u.totalTokens || 0).toLocaleString() + (u.estimated ? ' ~' : '')],
    ['LLM calls', u.calls || 0],
    // NEW: how many of those calls the provider itself reported as
    // truncated/filtered (finish_reason/done_reason !== "stop") -- see
    // ai-driver.js's recordUsage(). Average completion length alone
    // can't tell you this (a handful of long calls and a handful of
    // short ones average out to something unremarkable), so surface the
    // real count directly instead of leaving it buried in console logs.
    ['Truncated replies', (u.truncatedCalls || 0) + (u.calls ? (' / ' + u.calls) : '')]
  ];
  // NEW: only DeepSeekDriver currently sets this (the empty-content-on-
  // truncation retry -- see drivers/deepseek-driver.js), so only show
  // the row when it's actually present rather than always printing 0
  // for drivers that don't have this failure mode at all.
  if (typeof u.emptyContentRetries === 'number') {
    tokRows.push(['Empty-content retries', u.emptyContentRetries + ' (re-sent whole prompt)']);
  }
  // NEW: approximate cost, only shown once the operator has configured
  // their actual rate card (see ai-gm-bot.js's buildTokenUsageForDashboard) --
  // otherwise this stays silent rather than implying a number nobody set.
  if (u.priceConfigured && typeof u.estimatedCostUSD === 'number') {
    tokRows.push(['Est. cost (configured rate)', '$' + u.estimatedCostUSD.toFixed(4) + (u.estimated ? ' ~' : '')]);
  }
  document.getElementById('tok-kv').innerHTML = kv(tokRows);
  document.getElementById('loglevel-note').textContent = '';

  var party = s.party || [];
  document.getElementById('party-kv').innerHTML = party.length
    ? kv(party.map(function(p) { return [p.name, p.summary || '']; }))
    : '<dd class="empty">No characters synced yet.</dd>';

  document.getElementById('sb-bank').innerHTML =
    '<span class="badge sb">' + (s.sbBank || 0) + ' SB</span>';

  var facts = s.facts || {};
  var factKeys = Object.keys(facts);
  document.getElementById('facts-list').innerHTML = factKeys.length
    ? factKeys.map(function(k) { return '<div class="fact-row"><dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(facts[k])) + '</dd></div>'; }).join('')
    : '<div class="empty">No facts recorded yet.</div>';

  var obligations = s.obligations || [];
  document.getElementById('obligation-list').innerHTML = obligations.length
    ? obligations.map(function(o) {
        return '<div class="obligation-row">' +
          '<div><div class="patron-name">' + escapeHtml(o.patron) + '</div>' +
          '<div class="patron-chars">' + (o.characters || []).map(function(c) { return escapeHtml(c.name) + ' (' + c.obligation + ')'; }).join(', ') + '</div></div>' +
          '<div class="patron-total">' + o.total + '</div>' +
        '</div>';
      }).join('')
    : '<div class="empty">No Obligation tracked yet.</div>';

  var suggestionsPanel = document.getElementById('suggestions-panel');
  var suggestions = s.pendingSuggestions || [];

  if (suggestions.length) {
    suggestionsPanel.style.display = 'block';
    document.getElementById('suggestions-list').innerHTML = suggestions.map(function(sug) {
      // preview is redundant with label for most kinds (see
      // assistant-suggestions.js's enqueue() doc comment) -- only show it
      // as its own line when it actually says something more, which today
      // means the two synthesis kinds' real proposed prose.
      var previewHtml = (sug.preview && sug.preview !== sug.label)
        ? '<div class="preview" style="white-space:pre-wrap;color:var(--dim);font-size:12px;margin-top:3px;">' + escapeHtml(sug.preview) + '</div>'
        : '';
      var groupHtml = sug.groupId
        ? '<span class="kind" title="Approving one option in this group auto-rejects the others">group</span>'
        : '';
      return '<div class="suggestion-row">' +
        '<div style="flex:1;min-width:0;"><span class="kind">' + escapeHtml(sug.kind) + '</span>' + groupHtml + escapeHtml(sug.label) + previewHtml + '</div>' +
        '<div class="actions">' +
          '<button class="approve" data-id="' + escapeHtml(sug.id) + '" data-action="approve">Approve</button>' +
          '<button class="reject" data-id="' + escapeHtml(sug.id) + '" data-action="reject">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    suggestionsPanel.style.display = 'none';
    document.getElementById('suggestions-list').innerHTML = '';
  }

  var memoryBox = document.getElementById('memory-summary-box');
  memoryBox.innerHTML = s.memorySummary
    ? '<div class="memory-summary">📝 ' + escapeHtml(s.memorySummary) + '</div>'
    : '';

  var memory = s.recentMemory || [];
  var memFeed = document.getElementById('memory-feed');
  memFeed.innerHTML = memory.length
    ? memory.map(function(m) { return '<div class="memory-turn"><span class="role">' + escapeHtml(m.role) + '</span>' + escapeHtml(m.content) + '</div>'; }).join('')
    : '<div class="empty">No conversation yet.</div>';
}

function appendLine(entry) {
  var feed = document.getElementById('feed');
  if (feed.querySelector('.empty')) feed.innerHTML = '';
  var div = document.createElement('div');
  div.className = 'line';
  var t = new Date(entry.time).toLocaleTimeString();
  var colorVar = entry.level === 'error' ? 'var(--err)' : entry.level === 'warn' ? 'var(--warn)' : 'var(--fg)';
  div.innerHTML = '<span class="time">' + t + '</span><span style="color:' + colorVar + '">' +
    escapeHtml(entry.text) + '</span>';
  feed.appendChild(div);
  var atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

// Event Delegation for Suggestions
document.getElementById('suggestions-list').addEventListener('click', function(e) {
  var btn = e.target.closest('button');
  if (!btn) return;
  var id = btn.getAttribute('data-id');
  var action = btn.getAttribute('data-action');
  if (id && action) {
    fetch('/api/suggestions/' + encodeURIComponent(id) + '/' + action, { method: 'POST' })
      .catch(function(err) { console.warn('Failed to ' + action + ' suggestion:', err); });
  }
});

function bootstrap() {
  fetch('/api/state')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      renderState(data.state);
      (data.log || []).forEach(appendLine);
    })
    .catch(function() {});
}
bootstrap();

var es = new EventSource('/events');
es.addEventListener('state', function(e) { renderState(JSON.parse(e.data)); });
es.addEventListener('log', function(e) { appendLine(JSON.parse(e.data)); });
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
  if (server) return server;
  if (typeof getState === 'function') getStateFn = getState;
  startedAt = Date.now();
  const PORT = port || parseInt(process.env.STATUS_PORT || '4141', 10);
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

    const suggestionMatch = req.method === 'POST' && req.url.match(/^\/api\/suggestions\/([^/]+)\/(approve|reject)$/);
    if (suggestionMatch) {
      const [, id, action] = suggestionMatch;
      (async () => {
        const result = action === 'approve'
          ? await assistantSuggestions.approve(id)
          : assistantSuggestions.reject(id);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        broadcastSSE('state', snapshot());
      })().catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
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