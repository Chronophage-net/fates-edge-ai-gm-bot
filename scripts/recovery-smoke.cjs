'use strict';
// Cross-repository smoke test: real HTTP, WebSocket handshakes, SQLite, and killed processes.
// Uses only temporary data and a deterministic adventure; no API keys or LLM calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { CampaignManager } = require('../modules/world-manager');
const { AdventureRecovery } = require('../modules/adventure-recovery');
const { snapshotAdventure } = require('../modules/adventure-context');
const serverPath = process.env.RECOVERY_SERVER_PATH || path.resolve(__dirname, '../../fates-edge-apps/utilities/javascript/fates-edge-socket-server');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fates-recovery-'));
const key = 'isolated-recovery-test';
let child; let socket; let base; let roomId; let logs = '';
const code = `
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const rooms = require('./server/room');
rooms.configureDirectory(process.env.RECOVERY_DIRECTORY);
const app = express(); app.use(express.json({limit:'5mb'}));
app.use(require('./server/api').createApiRouter({apiKey:'${key}',healthEndpoint:'/health'}));
const server = http.createServer(app);
require('./server/ws-handlers').setupWSS(new WebSocketServer({server}), {apiKey:'${key}'});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
`;
async function start() {
    child = spawn(process.execPath, ['-e', code], { cwd: serverPath, env: { ...process.env, DATABASE_TYPE: 'sqlite', DATABASE_URL: path.join(temp, 'campaigns.db'), RECOVERY_DIRECTORY: path.join(temp, 'rooms.json'), REDIS_URL: '', CLUSTER_WORKERS: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Test server startup timed out')), 30000);
        child.once('message', value => { clearTimeout(timer); resolve(value); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Test server exited: ' + logs)); });
        child.once('error', reject);
    });
    base = `http://127.0.0.1:${ready.port}`;
    console.log(`Test server listening on ${ready.port}`);
    return ready.port;
}
async function connect(port, locator) {
    socket = new WebSocket(`ws://127.0.0.1:${port}/?room=${locator}`);
    const ack = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Handshake timed out')), 10000);
        socket.on('message', bytes => { const msg = JSON.parse(String(bytes)); if (msg.type === 'handshake_ack') { clearTimeout(timer); resolve(msg); } });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'handshake', clientName: 'Recovery test GM', role: 'gm', botMode: 'gm', botSeat: 0, botKey: key }));
    const msg = await ack; assert.equal(msg.success, true); roomId = msg.room_id; return msg;
}
async function apiRequest(method, segments, body) {
    const result = await fetch(`${base}/api/rooms/${roomId}/${segments.join('/')}`, { method, headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    const data = await result.json(); if (!result.ok) throw new Error(`HTTP ${result.status}: ${data.error}`); return data;
}
function manager() {
    const campaign = new CampaignManager({}, 'RECOV1', base, key, { roomId, snapshotProvider: () => snapshotAdventure({ apiRequest }) });
    const context = { orchestrator: { campaign }, apiRequest, logger: console };
    return { campaign, controller: new AdventureRecovery(context) };
}
async function kill() {
    if (!child || child.exitCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
}
(async () => {
    let port = await start(); await connect(port, 'RECOV1');
    const originalRoomId = roomId;
    const first = manager(); await first.campaign.load(); assert.equal(first.campaign.loadFailed, false);
    first.campaign.state = { conversation: [{ role: 'user', content: 'We have reached the third scene.' }], facts: { gate: 'opened' }, adventureDirector: { pendingSelection: null, abandonVotes: [] } };
    first.campaign.setNarrativeSummary('A pact was made at the gate.');
    const content = { title: 'Crown recovery fixture', acts: [{ title: 'First act', scenes: [1,2,3,4].map(n => ({ title: `Scene ${n}`, timers: [{ name: 'Watch', segments: 4, current: 0 }], encounters: [{ name: 'Gate keeper', dv: 2 }] })) }], knowledge: [{ id: 'key', gm: 'The keeper has the key.', player: null, revealed: false }], campaignTimers: [{ name: 'Pursuit', segments: 6, current: 0 }] };
    await apiRequest('POST', ['adventure','load-custom'], { content, id: 'custom_crash_test', dynamicGrowth: true });
    await apiRequest('POST', ['adventure','scene'], {}); await apiRequest('POST', ['adventure','scene'], {});
    await apiRequest('POST', ['adventure','knowledge','reveal'], { id: 'key' });
    await first.campaign.save();
    const captured = first.campaign.state.adventureSnapshot;
    assert.equal(captured.currentScene, 2);
    await apiRequest('POST', ['rotate-code'], { code: 'RECOV2' });
    const closed = once(socket, 'close'); await kill(); await closed; first.controller.disconnect();
    port = await start(); const ack = await connect(port, originalRoomId);
    assert.equal(ack.room_id, originalRoomId);
    assert.equal(await apiRequest('GET', ['adventure','full']), null);
    // New bot process equivalent: load a new CampaignManager from persisted SQLite.
    const restarted = manager(); await restarted.campaign.load();
    assert.deepEqual(restarted.campaign.pendingAdventureSnapshot, captured);
    assert.equal(await restarted.controller.handshake(ack.room_id), true);
    const recovered = await apiRequest('GET', ['adventure','full']);
    assert.deepEqual({ ...recovered, savedAt: captured.savedAt }, captured);
    assert.equal(restarted.campaign.getNarrativeSummary(), 'A pact was made at the gate.');
    assert.equal(restarted.campaign.state.facts.gate, 'opened');
    await apiRequest('POST', ['adventure','scene'], {});
    assert.equal((await apiRequest('GET', ['adventure'])).currentSceneIndex, 3);
    // Total persistence loss: remove only this test's temporary DB after stopping the server.
    await kill();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(temp, 'campaigns.db' + suffix), { force: true });
    port = await start(); await connect(port, originalRoomId);
    const lost = manager(); await lost.campaign.load();
    assert.equal(lost.campaign.pendingAdventureSnapshot, null);
    assert.equal(await lost.controller.handshake(roomId), false);
    assert.equal(await apiRequest('GET', ['adventure','full']), null);
    await apiRequest('POST', ['adventure','load-custom'], { content, id: 'custom_fresh' });
    assert.equal((await apiRequest('GET', ['adventure'])).moduleId, 'custom_fresh');
    console.log('PASS: killed-server recovery, SQLite persistence, stable identity after rotation, continued advancement, and total-loss fresh start.');
})().catch(error => { console.error(error, logs.slice(-4000)); process.exitCode = 1; }).finally(async () => {
    socket?.terminate(); await kill(); fs.rmSync(temp, { recursive: true, force: true });
});
