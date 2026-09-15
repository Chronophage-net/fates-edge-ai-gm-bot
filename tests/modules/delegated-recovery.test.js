'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DelegatedTasks } = require('../../modules/delegated-tasks');
const owner = { senderUserId: 'human-gm', senderClientId: 'gm-client' };
function tasks(overrides = {}) { return new DelegatedTasks({ url: 'ws://localhost:1234', room: 'ROOM', driver: { generateResponse: async () => 'A reply' }, source: () => null, acceptOutcome: async () => {}, ...overrides }); }
test('a persisted paused task resumes after server loss with a newly assigned room and token', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'tasks.json');
    const first = tasks({ file });
    first.tasks.set('task-one', { id: 'task-one', supervisor: 'human-gm', participants: ['player'], status: 'active', room: 'OLD', token: 'old-token', brief: 'Find the guide', history: [], turns: 1 }); first.save();
    const restarted = tasks({ file }); const task = restarted.tasks.get('task-one');
    assert.equal(task.status, 'paused');
    const requests = [];
    restarted.request = async data => { requests.push(data); return data.action === 'open' ? { room: 'NEW', delegationToken: 'fresh-token' } : {}; };
    restarted.connectSide = async value => { assert.equal(value.token, 'fresh-token'); value.status = 'active'; };
    await restarted.command({ ...owner, text: '!gm delegate resume task-one' });
    assert.equal(task.room, 'NEW'); assert.equal(task.status, 'active');
    assert.equal(requests.find(r => r.action === 'invite').delegationToken, 'fresh-token');
    assert.equal(JSON.parse(fs.readFileSync(file))[0].token, 'fresh-token');
});
test('cancelling an opening task never revives it as paused when the open request returns', async () => {
    const manager = tasks(); let resolveOpen;
    manager.request = data => data.action === 'open' ? new Promise(resolve => { resolveOpen = resolve; }) : Promise.resolve({});
    const opening = manager.command({ ...owner, text: '!gm delegate start player "Find a guide"' });
    const task = [...manager.tasks.values()][0];
    await manager.command({ ...owner, text: `!gm delegate cancel ${task.id}` });
    resolveOpen({ room: 'SIDE', delegationToken: 'token' });
    await assert.rejects(opening, /cancelled/);
    assert.equal(task.status, 'cancelled');
});
test('failed invitations pause and close the connected bot, rather than leaving it active', async () => {
    const manager = tasks(); let closed = false;
    manager.request = async data => { if (data.action === 'invite') throw Error('disconnected'); return { room: 'SIDE', delegationToken: 'token' }; };
    manager.connectSide = async task => { task.status = 'active'; task.socket = { close() { closed = true; } }; };
    await assert.rejects(manager.command({ ...owner, text: '!gm delegate start player "Find a guide"' }), /paused/);
    assert.equal([...manager.tasks.values()][0].status, 'paused'); assert.equal(closed, true);
});
test('private player messages cannot enter group narration or a shared recap', async () => {
    let calls = 0; const manager = tasks({ driver: { generateResponse: async () => { calls++; return 'reply'; } } });
    const task = { status: 'active', history: [], turns: 0 };
    await manager.playerTurn(task, { text: 'Secret', whisper: true });
    await manager.playerTurn(task, { text: 'Secret', privateOnly: true });
    assert.equal(calls, 0); assert.deepEqual(task.history, []);
});
