const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const vm = require('node:vm');
const http = require('node:http');
const { dashboardGuard } = require('../modules/dashboard-security');
const status = require('../modules/status-server');
const logger = require('../modules/logger');
const suggestions = require('../modules/assistant-suggestions');
const manager = require('../bot-manager');

function scriptContext(html) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, classList: { remove() {}, add() {} }, addEventListener() {} });
        return elements.get(id);
    };
    const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] }, window: {}, fetch: () => new Promise(() => {}), EventSource: class { addEventListener() {} }, setInterval() {}, console });
    vm.runInContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], context);
    return { context, element };
}
async function listening(server) { if (!server.listening) await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }

test('status dashboard escapes room data, protects actions and releases live streams on stop', async t => {
    const listeners = logger.listenerCount('entry');
    const server = status.start({ port: 0, getState: () => ({ connected: true }), pushIntervalMs: 100 });
    t.after(() => status.stop());
    const base = await listening(server);
    const response = await fetch(base);
    assert.match(response.headers.get('content-security-policy'), /script-src 'nonce-/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { context, element } = scriptContext(await response.text());
    context.state = { role: '<img src=x onerror=alert(1)>', wsUrl: '<script>bad</script>', adventure: { title: '<img src=x>' }, party: [{ name: '<svg onload=alert(1)>', summary: '<b>bad</b>' }], sbBank: '<img>', obligations: [{ patron: 'Test', total: '<img>', characters: [{ name: 'A', obligation: '<img>' }] }] };
    vm.runInContext('renderState(state)', context);
    for (const id of ['conn-kv', 'adv-kv', 'party-kv', 'sb-bank', 'obligation-list']) {
        assert(!element(id).innerHTML.includes('<img'), id);
        assert(!element(id).innerHTML.includes('<svg'), id);
        assert(element(id).innerHTML.includes('&lt;'), id);
    }
    let applied = 0;
    const entry = suggestions.enqueue({ label: 'test', apply: async () => applied++ });
    const path = `${base}/api/suggestions/${entry.id}/approve`;
    assert.equal((await fetch(path, { method: 'POST' })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers: { 'X-Dashboard-Request': '1', Origin: 'https://attacker.example' } })).status, 403);
    assert.equal(applied, 0);
    assert.equal((await fetch(path, { method: 'POST', headers: { 'X-Dashboard-Request': '1', Origin: base } })).status, 200);
    assert.equal(applied, 1);
    const hostileHostStatus = await new Promise((resolve, reject) => {
        const req = http.get(base, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
    const feed = await fetch(`${base}/events`); const reader = feed.body.getReader(); await reader.read();
    const closed = once(server, 'close'); status.stop(); await closed;
    while (!(await reader.read()).done) {};
    assert.equal(logger.listenerCount('entry'), listeners);
    const second = status.start({ port: 0 }); await listening(second);
    const secondClosed = once(second, 'close'); status.stop(); await secondClosed;
    assert.equal(logger.listenerCount('entry'), listeners);
});

test('supervisor dashboard escapes identifiers and rejects cross-site restart and malformed paths', async t => {
    const server = manager.startDashboard({ port: 0 });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = await listening(server);
    const { context, element } = scriptContext(await (await fetch(base)).text());
    context.data = { manager: { botCount: 1, maxBots: 12, loadAvg: [0], totalMemMb: 1, freeMemMb: 1 }, bots: [{ room: '<img src=x>', roomId: '<svg onload=alert(1)>', key: "bad' onclick='alert(1)", mode: 'gm', status: 'running', statusPort: 4150 }] };
    vm.runInContext('renderOverview(data)', context);
    assert(!element('content').innerHTML.includes('<img'));
    assert(!element('content').innerHTML.includes('<svg'));
    assert(!element('content').innerHTML.includes('onclick="'));
    assert.equal((await fetch(`${base}/api/bots/test/restart`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/api/bots/%ZZ/log`)).status, 400);
});

test('remote dashboard binding requires authentication before exposing state', async t => {
    assert.throws(() => dashboardGuard({ host: '0.0.0.0' }), /token/);
    const token = 'x'.repeat(32), guard = dashboardGuard({ host: '0.0.0.0', token });
    const server = http.createServer((req, res) => { if (guard(req, res)) res.end('private'); });
    server.listen(0, '127.0.0.1');const base = await listening(server);
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    assert.equal((await fetch(base)).status, 401);
    const response = await fetch(base, { headers: { Authorization: `Basic ${Buffer.from(`operator:${token}`).toString('base64')}` } });
    assert.equal(await response.text(), 'private');
});

test('restarts wait for the old child to exit and coalesce overlapping requests', async () => {
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    let kills = 0, starts = 0;
    child.kill = () => { kills++; setImmediate(() => { child.exitCode = 0; child.emit('exit', 0); }); };
    manager.bots.set('LIVE#0', { child, entry: { room: 'LIVE', seat: 0 }, restarts: 0 });
    try {
        const launch = () => { assert.equal(child.exitCode, 0); starts++; };
        await Promise.all([manager.restartBot('LIVE#0', launch), manager.restartBot('LIVE#0', launch)]);
        assert.equal(kills, 1); assert.equal(starts, 1);
    } finally { manager.bots.clear(); }
});
