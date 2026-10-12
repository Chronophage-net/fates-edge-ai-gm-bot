const test = require('node:test');
const assert = require('node:assert');
const wsCorrelator = require('../../modules/ws-correlator');

test.beforeEach(() => {
  wsCorrelator._resetForTests();
});

test('waitFor resolves when resolve() is called with a matching type', async () => {
  const p = wsCorrelator.waitFor('crown-spread', 1000);
  const resolved = wsCorrelator.resolve('crown-spread', { synthesis: 'hi' });
  assert.strictEqual(resolved, true);
  const data = await p;
  assert.strictEqual(data.synthesis, 'hi');
});

test('resolve() returns false when nothing is waiting', () => {
  assert.strictEqual(wsCorrelator.resolve('deck-drawn', {}), false);
});

test('request IDs isolate simultaneous draws and ignore unrelated broadcasts', async () => {
  const a = wsCorrelator.waitFor('crown-spread', 1000, 'a');
  const b = wsCorrelator.waitFor('crown-spread', 1000, 'b');
  assert.equal(wsCorrelator.resolve('crown-spread', {}), false);
  assert.equal(wsCorrelator.resolve('crown-spread', { requestId: 'other' }), false);
  wsCorrelator.resolve('crown-spread', { requestId: 'b' });
  wsCorrelator.resolve('crown-spread', { requestId: 'a' });
  assert.equal((await a).requestId, 'a');
  assert.equal((await b).requestId, 'b');
});

test('waitFor rejects on timeout', async () => {
  const p = wsCorrelator.waitFor('crown-spread', 20);
  await assert.rejects(p, /Timed out/);
});

test('a second waitFor for the same type supersedes (rejects) the first', async () => {
  const first = wsCorrelator.waitFor('crown-spread', 1000);
  const firstRejection = assert.rejects(first, /Superseded/);
  const second = wsCorrelator.waitFor('crown-spread', 1000);
  wsCorrelator.resolve('crown-spread', { ok: true });
  await firstRejection;
  const data = await second;
  assert.strictEqual(data.ok, true);
});

test('different response types do not interfere with each other', async () => {
  const crownP = wsCorrelator.waitFor('crown-spread', 1000);
  const deckP = wsCorrelator.waitFor('deck-drawn', 1000);
  wsCorrelator.resolve('deck-drawn', { which: 'deck' });
  wsCorrelator.resolve('crown-spread', { which: 'crown' });
  assert.strictEqual((await deckP).which, 'deck');
  assert.strictEqual((await crownP).which, 'crown');
});
