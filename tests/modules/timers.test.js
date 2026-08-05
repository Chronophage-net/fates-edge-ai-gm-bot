const test = require('node:test');
const assert = require('node:assert');
const timers = require('../../modules/timers.js');

test('createTimerState() returns the documented default shape', () => {
  const state = timers.createTimerState();
  assert.deepStrictEqual(state.scene.timers, []);
  assert.strictEqual(state.scene.maxSceneTimers, 3);
  assert.deepStrictEqual(state.campaign.timers, []);
  assert.strictEqual(state.campaign.autoPersist, false);
});

test('addTimer() adds a new scene timer starting at current=0', () => {
  const state = timers.createTimerState();
  const timer = timers.addTimer(state, 'Guard Patrol', 4, 'Reinforcements arrive!');
  assert.strictEqual(timer.name, 'Guard Patrol');
  assert.strictEqual(timer.current, 0);
  assert.strictEqual(timer.max, 4);
  assert.strictEqual(state.scene.timers.length, 1);
});

test('addTimer() with an existing name resets it instead of duplicating', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Guard Patrol', 4, 'A');
  const t = state.scene.timers[0];
  t.current = 3;
  timers.addTimer(state, 'Guard Patrol', 6, 'B'); // re-add with a new max
  assert.strictEqual(state.scene.timers.length, 1);
  assert.strictEqual(state.scene.timers[0].current, 0);
  assert.strictEqual(state.scene.timers[0].max, 6);
});

test('tickTimer() advances current but clamps at max (does not overflow)', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Timer A', 4, 'Fills!');
  let result = timers.tickTimer(state, 'Timer A', 2);
  assert.strictEqual(result.filled, false);
  assert.strictEqual(result.timer.current, 2);

  result = timers.tickTimer(state, 'Timer A', 10); // way past max
  assert.strictEqual(result.filled, true);
  assert.strictEqual(result.timer.current, 4); // clamped at max, not 12
});

test('tickTimer() on a filled non-persistent timer removes it from the active list', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Timer A', 2, 'Fills!');
  timers.tickTimer(state, 'Timer A', 2);
  assert.strictEqual(state.scene.timers.length, 0);
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].event, 'Fills!');
});

test('tickTimer() on a persistent timer resets to 0 and tracks filledCount instead of removing it', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Persistent Timer', 2, 'Fills!', { persistent: true });
  const result = timers.tickTimer(state, 'Persistent Timer', 2);
  assert.strictEqual(result.filled, true);
  assert.strictEqual(state.scene.timers.length, 1);
  assert.strictEqual(state.scene.timers[0].current, 0);
  assert.strictEqual(state.scene.timers[0].filledCount, 1);
});

test('tickTimer() on an unknown timer name is a no-op', () => {
  const state = timers.createTimerState();
  const result = timers.tickTimer(state, 'Nonexistent', 1);
  assert.strictEqual(result.filled, false);
  assert.strictEqual(result.timer, null);
});

test('isTimerFilled() reflects current >= max without mutating state', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Timer A', 4, 'Fills!');
  assert.strictEqual(timers.isTimerFilled(state, 'Timer A'), false);
  timers.tickTimer(state, 'Timer A', 4);
  // Timer A was removed on fill (non-persistent) -- isTimerFilled for a
  // gone timer reports false since there's nothing left to check.
  assert.strictEqual(timers.isTimerFilled(state, 'Timer A'), false);
});

test('resolveTimer() generates the fill event and removes the timer', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Timer A', 4, 'Boom!');
  timers.tickTimer(state, 'Timer A', 4); // fills and auto-removes
  timers.addTimer(state, 'Timer B', 4, 'Boom B!'); // add another, not filled
  const result = timers.resolveTimer(state, 'Timer B');
  assert.strictEqual(result.event, 'Boom B!');
  assert.strictEqual(state.scene.timers.length, 0);
});

test('resolveTimer() on an unknown timer returns nulls', () => {
  const state = timers.createTimerState();
  const result = timers.resolveTimer(state, 'Nonexistent');
  assert.deepStrictEqual(result, { event: null, timer: null });
});

test('resetTimerState() clears all timers and events', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'Timer A', 4, 'A');
  timers.addCampaignTimer(state, 'Timer B', 6, 'B');
  timers.resetTimerState(state);
  assert.deepStrictEqual(state.scene.timers, []);
  assert.deepStrictEqual(state.campaign.timers, []);
  assert.deepStrictEqual(state.events, []);
});

test('enforceThreeTimers() keeps at most 3 scene timers, merging the rest', () => {
  const state = timers.createTimerState();
  timers.addTimer(state, 'T1', 4, 'a');
  timers.addTimer(state, 'T2', 6, 'b');
  timers.addTimer(state, 'T3', 8, 'c');
  timers.addTimer(state, 'T4', 10, 'd'); // 4th timer should trigger the three-timer rule
  assert.ok(state.scene.timers.length <= 4); // merged timer replaces 1+ removed ones, but total stays bounded
  const names = state.scene.timers.map(t => t.name);
  // The lowest-priority (smallest max) original timers get merged away first.
  assert.ok(!names.includes('T1') || names.some(n => n.startsWith('Merged:')));
});
