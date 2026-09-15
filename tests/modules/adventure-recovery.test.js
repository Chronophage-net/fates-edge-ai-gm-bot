'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CampaignManager } = require('../../modules/world-manager');
const { AdventureRecovery } = require('../../modules/adventure-recovery');
const adventure = require('../../modules/adventure-context');
const director = require('../../modules/adventure-director');
const legacy = require('../../modules/legacy-tracker');
const snapshot = () => ({ snapshotVersion: 1, roomId: 'stable-room', savedAt: Date.now(), moduleId: 'custom_test', startedAt: 50, currentAct: 2, currentScene: 1, module: { title: 'Test', acts: [] }, sessionsPlayed: 2, climaxAfterSessions: 4, adhocTimers: { list: [] } });
function fixture(options = {}) {
    const campaign = new CampaignManager({}, 'OLD-CODE', 'ws://localhost:1234', '', { roomId: 'stable-room', ...options });
    campaign.state = { conversation: [{ role: 'user', content: 'We found the key.' }], facts: { key: 'found' }, adventureDirector: { pendingSelection: {}, abandonVotes: ['Alice'], customAdventures: [] } };
    campaign.setNarrativeSummary('The party reached the gate.');
    const context = { orchestrator: { campaign }, logger: { info() {}, warn() {}, debug() {} }, apiRequest: async () => ({ ok: true }) };
    return { campaign, context };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('capture and restore fail softly on HTTP and network errors', async () => {
    const value = snapshot();
    assert.deepEqual(await adventure.snapshotAdventure({ apiRequest: async () => value }), value);
    for (const message of ['HTTP 400', 'HTTP 404', 'HTTP 500', 'network error']) {
        const context = { apiRequest: async () => { throw new Error(message); } };
        assert.equal(await adventure.snapshotAdventure(context), null);
        assert.equal(await adventure.recoverAdventure(context, value), false);
    }
    assert.equal(await adventure.recoverAdventure({ apiRequest: async () => ({ ok: true }) }, value), true);
    assert.equal(await adventure.recoverAdventure({ apiRequest: async () => ({ ok: false }) }, value), false);
});
test('save, restart, auto-load and handshake restore preserve narrative and clear obsolete selection state', async t => {
    let stored; const value = snapshot(); const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push(url);
        if (options.method === 'POST') stored = JSON.parse(options.body);
        return { ok: true, json: async () => stored };
    });
    const { campaign } = fixture({ snapshotProvider: async () => value });
    await campaign.save();
    assert.deepEqual(stored.state.adventureSnapshot, value);
    const restarted = fixture(); await restarted.campaign.load();
    const restored = [];
    restarted.context.apiRequest = async (method, segments, body) => { restored.push(body); return { ok: true }; };
    const controller = new AdventureRecovery(restarted.context);
    assert.equal(await controller.handshake('stable-room'), true);
    assert.deepEqual(restored[0].snapshot, value);
    assert.equal(restarted.campaign.pendingAdventureSnapshot, null);
    assert.deepEqual(restarted.campaign.state.conversation, campaign.state.conversation);
    assert.deepEqual(restarted.campaign.state.facts, campaign.state.facts);
    assert.equal(restarted.campaign.getNarrativeSummary(), campaign.getNarrativeSummary());
    assert.equal(restarted.campaign.state.adventureDirector.pendingSelection, null);
    assert.deepEqual(restarted.campaign.state.adventureDirector.abandonVotes, []);
    assert.ok(calls.every(url => url.includes('/rooms/stable-room/')));
});
test('save and restore share one queue, including a disconnect during snapshot capture', async t => {
    const capture = deferred(); const restore = deferred(); const order = [];
    t.mock.method(globalThis, 'fetch', async () => { order.push('saved'); return { ok: true }; });
    const { campaign, context } = fixture({ snapshotProvider: () => capture.promise });
    const controller = new AdventureRecovery(context);
    const saving = campaign.save(); await Promise.resolve();
    controller.disconnect();
    context.apiRequest = async () => { order.push('restore'); await restore.promise; return { ok: true }; };
    const recovering = controller.handshake('stable-room');
    capture.resolve(snapshot()); await saving;
    while (!order.includes('restore')) await new Promise(resolve => setImmediate(resolve));
    const nextSave = campaign.save(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['saved', 'restore']);
    restore.resolve(); assert.equal(await recovering, true); await nextSave;
    assert.deepEqual(order, ['saved', 'restore', 'saved']);
});
test('failed automatic recovery retries once, retains the snapshot, and later succeeds manually', async () => {
    const { campaign, context } = fixture(); const value = snapshot(); campaign.pendingAdventureSnapshot = value;
    let attempts = 0; const scheduled = [];
    context.apiRequest = async () => { attempts++; throw new Error('offline'); };
    const controller = new AdventureRecovery(context, { schedule: fn => { scheduled.push(fn); return 1; }, cancel() {} });
    assert.equal(await controller.handshake('stable-room'), false);
    assert.equal(scheduled.length, 1);
    scheduled[0](); await controller.inFlight;
    assert.equal(attempts, 2); assert.equal(scheduled.length, 1);
    assert.equal(campaign.pendingAdventureSnapshot, value);
    context.apiRequest = async () => ({ ok: true });
    assert.equal(await controller.attempt(), true);
    assert.equal(controller.attempts, 0);
});
test('room mismatch and archive conflict reject without touching narrative; force never bypasses identity', async () => {
    const { campaign, context } = fixture(); const controller = new AdventureRecovery(context);
    let requests = 0; context.apiRequest = async () => { requests++; return { ok: true }; };
    campaign.pendingAdventureSnapshot = { ...snapshot(), roomId: 'another-room' };
    assert.equal(await controller.attempt({ force: true }), false); assert.equal(requests, 0);
    campaign.pendingAdventureSnapshot = snapshot();
    campaign.state.adventureArchive = [{ moduleId: 'custom_test', startedAt: 50 }];
    assert.equal(await controller.attempt(), false); assert.equal(requests, 0);
    assert.equal(await controller.attempt({ force: true }), true); assert.equal(requests, 1);
});
test('capture is throttled, invalidations refresh it, failures back off and never erase the last good capture', async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true }));
    let captures = 0; let revision = 0; let fail = false;
    const value = snapshot();
    const { campaign } = fixture({ snapshotProvider: async () => { captures++; return fail ? null : value; }, snapshotRevision: () => revision });
    await campaign.save(); await campaign.save(); assert.equal(captures, 1);
    revision++; await campaign.save(); assert.equal(captures, 2);
    fail = true;
    for (let i = 0; i < 3; i++) { campaign.lastSnapshotAt = 0; await campaign.save(); }
    revision++; await campaign.save(); assert.equal(captures, 5);
    assert.equal(campaign.state.adventureSnapshot, value);
    fail = false; campaign.lastSnapshotAt = 0; await campaign.save(); assert.equal(campaign.snapshotFailures, 0);
});
test('no snapshot provider or failed first capture omits the snapshot field', async t => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true }; });
    await fixture().campaign.save(); await fixture({ snapshotProvider: async () => null }).campaign.save();
    assert.ok(bodies.every(body => !Object.hasOwn(body.state, 'adventureSnapshot')));
});
test('fresh narrative resets discard stale recovery, while the recovering option preserves it', () => {
    const { campaign, context } = fixture(); campaign.pendingAdventureSnapshot = snapshot();
    campaign.state.adventureSnapshot = campaign.pendingAdventureSnapshot;
    director.resetNarrativeState(context.orchestrator, { recovering: true });
    assert.equal(campaign.state.conversation.length, 1);
    director.resetNarrativeState(context.orchestrator);
    assert.equal(campaign.pendingAdventureSnapshot, null);
    assert.equal(campaign.state.adventureSnapshot, undefined);
    assert.deepEqual(campaign.state.conversation, []);
});
test('snapshot and recover commands require the sender to be a verified GM', async () => {
    const { campaign, context } = fixture(); campaign.pendingAdventureSnapshot = snapshot();
    context.myRole = 'gm'; context.adventureRecovery = new AdventureRecovery(context);
    assert.match(await director.handleAdventureCommand('Player', ['recover', '--force'], context), /verified GM/);
    assert.match(await director.handleAdventureCommand('Player', ['snapshot'], context), /verified GM/);
    context.senderIsGM = true;
    assert.match(await director.handleAdventureCommand('GM', ['snapshot'], context), /Pending recovery.*custom_test[\s\S]*Saved:/);
    assert.match(await director.handleAdventureCommand('GM', ['recover'], context), /Recovered/);
});
test('custom retention evicts the oldest unpinned adventure and refuses an all-pinned collection', () => {
    const { context } = fixture(); const dir = context.orchestrator.campaign.state.adventureDirector;
    dir.customAdventures = Array.from({ length: 5 }, (_, i) => ({ id: i, pinned: i === 4 }));
    director.pushCustomAdventure(context.orchestrator, { id: 5 });
    assert.ok(dir.customAdventures.some(item => item.id === 4));
    assert.ok(!dir.customAdventures.some(item => item.id === 3));
    for (const item of dir.customAdventures) item.pinned = true;
    assert.throws(() => director.pushCustomAdventure(context.orchestrator, { id: 6 }), /pinned/);
    assert.equal(dir.customAdventures.length, 5);
});
test('legacy finalization is idempotent for one adventure run, including a later GM override', async () => {
    const { campaign, context } = fixture();
    context.apiRequest = async () => ({ persistence: { schema: 'reputation', carryover: [{ key: 'score', default: 2 }] } });
    const finished = { moduleId: 'custom_test', title: 'Test', startedAt: 50 };
    await legacy.finalizeLegacy(context, finished);
    legacy.setLegacyValue(context.orchestrator, 'reputation', 'score', '9');
    await legacy.finalizeLegacy(context, finished);
    assert.equal(legacy.getLegacyState(context.orchestrator).reputation.values.score, 9);
    assert.equal(campaign.state.finalizedLegacy.length, 1);
});
