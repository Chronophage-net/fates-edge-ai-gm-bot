const { test } = require('node:test');
const assert = require('node:assert/strict');
const turns = require('../../modules/turn-lifecycle');
const { processSpecialTags } = require('../../modules/commands/process-tags');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('invalidation frees a full queue even while old provider work remains blocked', async () => {
  const gate = deferred(), started = deferred();
  const old = [turns.run(async () => { started.resolve(); await gate.promise; })];
  await started.promise;
  for (let i = 1; i < 20; i++) old.push(turns.run(() => assert.fail('stale queued turn ran')));
  const settled = Promise.all(old.map(p => assert.rejects(p, /cancelled/)));
  await assert.rejects(turns.run(() => {}), /queue is full/);
  turns.invalidate();
  await turns.run(() => {});
  gate.resolve();
  await settled;
});

test('stored state never retains a cancelled turn proxy', async () => {
  const state = { rows: [{ name: 'A' }], saved: [] };
  await turns.run(() => {
    const context = turns.guard(state);
    context.saved = context.rows.map(row => ({ actor: row }));
    context.saved.push(context.rows[0]);
  });
  turns.invalidate();
  assert.deepEqual(JSON.parse(JSON.stringify(state.saved)), [{ actor: { name: 'A' } }, { name: 'A' }]);
});

test('an aborted parent cannot start a new deadline scope', async () => {
  await assert.rejects(turns.run(async () => {
    await assert.rejects(turns.wait(new Promise(() => {}), 5));
    await assert.rejects(turns.deadline(() => assert.fail('cancelled work ran'), 100), /cancelled/);
  }), /cancelled/);
});

test('required actions reject failures and unscoped timeouts', async () => {
  await assert.rejects(turns.wait(Promise.reject(new Error('write failed')), 100, null, true), /write failed/);
  await assert.rejects(turns.wait(new Promise(() => {}), 5, null, true), /timed out/);
});

test('turns are FIFO, and control invalidation discards old work without blocking a new session', async () => {
  const gate = deferred(), started = deferred(), order = [];
  const first = turns.run(async () => { started.resolve(); await gate.promise; turns.check(); order.push('old'); });
  const firstRejected = assert.rejects(first, /cancelled/);
  await started.promise;
  const queued = turns.run(() => order.push('stale queued'));
  const queuedRejected = assert.rejects(queued, /cancelled/);
  turns.invalidate();
  await turns.run(() => order.push('fresh'));
  gate.resolve(); await firstRejected; await queuedRejected;
  assert.deepEqual(order, ['fresh']);
  const a = turns.run(async () => { order.push('a'); });
  const b = turns.run(() => order.push('b'));
  await Promise.all([a, b]);
  assert.deepEqual(order, ['fresh', 'a', 'b']);
});

test('a deadline blocks late tag mutations after an awaited API result', async () => {
  const gate = deferred();
  const state = { scene: {}, facts: {} };
  let work;
  await assert.rejects(turns.run(() => turns.deadline(() => {
    work = processSpecialTags('[TIMER "Guard" 4 "Alarm"] [FACT secret leaked]', {
      charactersModule: {}, orchestrator: { campaign: { state, save: async () => {} } },
      myRole: 'gm', apiRequest: () => gate.promise,
    });
    return work;
  }, 10)), /deadline/);
  gate.resolve({ ok: true });
  await assert.rejects(work, /cancelled/);
  assert.deepEqual(state.facts, {});
});

test('per-action timeouts invalidate the remaining tag context', async () => {
  await turns.run(async () => {
    const guarded = turns.guard({ facts: {} });
    await assert.rejects(turns.wait(new Promise(() => {}), 5), /cancelled|timed out/);
    assert.throws(() => { guarded.facts.late = true; }, /cancelled/);
  }).catch(error => assert.equal(error.name, 'AbortError'));
});
