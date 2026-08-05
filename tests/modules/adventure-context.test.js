const test = require('node:test');
const assert = require('node:assert');
const { isAdventureActive } = require('../../modules/adventure-context.js');

// ============================================================
// isAdventureActive() -- 2x3 table: moduleId present/absent x
// status in {'planned', 'active', 'completed'}
//
// Per this file's own header comment: the real status machine is
// 'planned' -> 'active' -> 'completed'. 'planned' is NOT "nothing
// loaded" (a reset adventure keeps its moduleId and goes back to
// 'planned', and should still be treated as active/resumable). Only
// a missing moduleId, or status === 'completed', means "nothing
// usable is loaded."
// ============================================================

test('isAdventureActive - moduleId present + status "planned" -> true (a reset adventure stays active)', () => {
  assert.strictEqual(isAdventureActive({ moduleId: 'mod1', status: 'planned' }), true);
});

test('isAdventureActive - moduleId present + status "active" -> true', () => {
  assert.strictEqual(isAdventureActive({ moduleId: 'mod1', status: 'active' }), true);
});

test('isAdventureActive - moduleId present + status "completed" -> false', () => {
  assert.strictEqual(isAdventureActive({ moduleId: 'mod1', status: 'completed' }), false);
});

test('isAdventureActive - moduleId absent + status "planned" -> false', () => {
  assert.strictEqual(isAdventureActive({ moduleId: null, status: 'planned' }), false);
});

test('isAdventureActive - moduleId absent + status "active" -> false (moduleId absence always wins)', () => {
  assert.strictEqual(isAdventureActive({ moduleId: null, status: 'active' }), false);
});

test('isAdventureActive - moduleId absent + status "completed" -> false', () => {
  assert.strictEqual(isAdventureActive({ moduleId: null, status: 'completed' }), false);
});

test('isAdventureActive - falsy/undefined state -> false', () => {
  assert.strictEqual(isAdventureActive(null), false);
  assert.strictEqual(isAdventureActive(undefined), false);
  assert.strictEqual(isAdventureActive({}), false);
});
