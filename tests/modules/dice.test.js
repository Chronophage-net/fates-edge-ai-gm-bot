const test = require('node:test');
const assert = require('node:assert');
const dice = require('../../modules/dice.js');

// ============================================================
// rollDice() — pool rolling
// ============================================================

test('rollDice - rolls the requested number of dice, each in [1,10]', () => {
  const result = dice.rollDice(10);
  assert.strictEqual(result.dice.length, 10);
  assert.strictEqual(result.count, 10);
  for (const d of result.dice) {
    assert.ok(d >= 1 && d <= 10, `die value ${d} out of range`);
  }
});

test('rollDice - successes/story-beats distribution properties hold over many rolls', () => {
  // 6+ counts as a success, 10 counts as 2 successes, 1s are Story Beats.
  // Verify these accounting rules against a large sample instead of
  // predicting exact dice (which we can't control).
  let totalSuccesses = 0, totalSB = 0, totalDice = 0, tens = 0, ones = 0, sixToNine = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i++) {
    const r = dice.rollDice(5);
    totalDice += r.dice.length;
    for (const d of r.dice) {
      if (d === 1) ones++;
      if (d === 10) tens++;
      if (d >= 6 && d <= 9) sixToNine++;
    }
    totalSuccesses += r.successes;
    totalSB += r.sb;
  }
  // successes should equal count(6-9) + 2*count(10)
  assert.strictEqual(totalSuccesses, sixToNine + tens * 2);
  // SB should equal count of 1s
  assert.strictEqual(totalSB, ones);
  // Rough sanity: with a fair d10, each face ~10% of totalDice (10000 dice here).
  assert.ok(ones > totalDice * 0.05 && ones < totalDice * 0.15, `ones=${ones} of ${totalDice} outside expected range`);
});

test('rollDice - uses existingDice instead of generating new rolls when provided', () => {
  const result = dice.rollDice(3, [1, 6, 10]);
  assert.deepStrictEqual(result.dice, [1, 6, 10]);
  assert.strictEqual(result.successes, 3); // 6 -> 1 success, 10 -> 2 successes
  assert.strictEqual(result.sb, 1); // the 1
});

// ============================================================
// determineOutcome() — Outcome Matrix
// ============================================================

test('determineOutcome - S >= DV and SB == 0 -> Clean Success', () => {
  const outcome = dice.determineOutcome(4, 3, 0);
  assert.strictEqual(outcome.outcome, 'Clean Success');
  assert.strictEqual(outcome.boonGain, 0);
});

test('determineOutcome - S >= DV and SB > 0 -> Success with SB', () => {
  const outcome = dice.determineOutcome(4, 3, 1);
  assert.strictEqual(outcome.outcome, 'Success with SB');
  assert.strictEqual(outcome.boonGain, 0);
});

test('determineOutcome - 0 < S < DV -> Partial', () => {
  const outcome = dice.determineOutcome(2, 3, 0);
  assert.strictEqual(outcome.outcome, 'Partial');
  assert.strictEqual(outcome.boonGain, 1);
});

test('determineOutcome - S == 0 -> Miss', () => {
  const outcome = dice.determineOutcome(0, 3, 0);
  assert.strictEqual(outcome.outcome, 'Miss');
  assert.strictEqual(outcome.boonGain, 2);
});

test('determineOutcome - Story Beat presence does not change Partial/Miss classification', () => {
  // The Outcome Matrix only differentiates Clean Success vs Success-with-SB
  // by SB; Partial and Miss are the same regardless of SB count.
  const partialWithSB = dice.determineOutcome(2, 3, 2);
  assert.strictEqual(partialWithSB.outcome, 'Partial');
  const missWithSB = dice.determineOutcome(0, 3, 2);
  assert.strictEqual(missWithSB.outcome, 'Miss');
});

// ============================================================
// applyPosition() — Dominant/Desperate re-rolls, Controlled = no-op
// ============================================================

test('applyPosition - Controlled makes no changes', () => {
  const base = dice.rollDice(5, [1, 5, 6, 7, 10]);
  const result = dice.applyPosition(base, 'Controlled');
  assert.deepStrictEqual(result.dice, base.dice);
  assert.strictEqual(result.successes, base.successes);
  assert.strictEqual(result.sb, base.sb);
});

test('applyPosition - Dominant re-rolls one failing die (< 6)', () => {
  const base = dice.rollDice(3, [2, 3, 4]); // all failures
  const result = dice.applyPosition(base, 'Dominant');
  assert.strictEqual(result.reRolled.length, 1);
  // Exactly one die should have changed from the original set.
  const changedCount = result.dice.filter((d, i) => d !== base.dice[i]).length;
  assert.strictEqual(changedCount, 1);
});

test('applyPosition - Dominant is a no-op when there is no failing die to re-roll', () => {
  const base = dice.rollDice(2, [6, 10]); // all successes, nothing < 6
  const result = dice.applyPosition(base, 'Dominant');
  assert.strictEqual(result.reRolled.length, 0);
  assert.deepStrictEqual(result.dice, base.dice);
});

test('applyPosition - Desperate re-rolls one successful die (>= 6)', () => {
  const base = dice.rollDice(3, [2, 3, 6]);
  const result = dice.applyPosition(base, 'Desperate');
  assert.strictEqual(result.reRolled.length, 1);
  const changedCount = result.dice.filter((d, i) => d !== base.dice[i]).length;
  assert.strictEqual(changedCount, 1);
});
