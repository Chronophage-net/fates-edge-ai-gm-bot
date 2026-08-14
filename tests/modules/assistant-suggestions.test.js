const test = require('node:test');
const assert = require('node:assert');
const assistantSuggestions = require('../../modules/assistant-suggestions.js');

test.beforeEach(() => {
  assistantSuggestions._resetForTests();
});

test('enqueue/list - returns plain JSON, never leaks the apply() closure', () => {
  assistantSuggestions.enqueue({ kind: 'fact', label: 'Test fact', apply: async () => 'done' });
  const list = assistantSuggestions.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].kind, 'fact');
  assert.strictEqual(list[0].label, 'Test fact');
  assert.strictEqual(list[0].apply, undefined);
  assert.ok(list[0].id);
  assert.ok(list[0].createdAt);
});

test('enqueue - throws without an apply() function', () => {
  assert.throws(() => assistantSuggestions.enqueue({ kind: 'fact', label: 'x' }));
});

test('approve - runs apply(), removes from queue, returns its result', async () => {
  let applied = false;
  const entry = assistantSuggestions.enqueue({
    kind: 'npc-create',
    label: 'New NPC — Kestrel',
    apply: async () => { applied = true; return 'NPC registered'; },
  });
  assert.strictEqual(assistantSuggestions.count(), 1);
  const { ok, result } = await assistantSuggestions.approve(entry.id);
  assert.strictEqual(ok, true);
  assert.strictEqual(applied, true);
  assert.strictEqual(result, 'NPC registered');
  assert.strictEqual(assistantSuggestions.count(), 0);
});

test('approve - unknown id returns an error, does not throw', async () => {
  const { ok, error } = await assistantSuggestions.approve('sugg_nope');
  assert.strictEqual(ok, false);
  assert.match(error, /No pending suggestion/);
});

test('approve - a throwing apply() still removes the entry from the queue', async () => {
  const entry = assistantSuggestions.enqueue({
    kind: 'scene-complete',
    label: 'Advance the scene',
    apply: async () => { throw new Error('boom'); },
  });
  const { ok, error } = await assistantSuggestions.approve(entry.id);
  assert.strictEqual(ok, false);
  assert.strictEqual(error, 'boom');
  assert.strictEqual(assistantSuggestions.count(), 0);
});

test('reject - removes without ever calling apply()', () => {
  let applied = false;
  const entry = assistantSuggestions.enqueue({ kind: 'fact', label: 'x', apply: async () => { applied = true; } });
  const { ok } = assistantSuggestions.reject(entry.id);
  assert.strictEqual(ok, true);
  assert.strictEqual(applied, false);
  assert.strictEqual(assistantSuggestions.count(), 0);
});

test('clear - drops everything and reports how many were cleared', () => {
  assistantSuggestions.enqueue({ kind: 'fact', label: 'a', apply: async () => {} });
  assistantSuggestions.enqueue({ kind: 'fact', label: 'b', apply: async () => {} });
  const cleared = assistantSuggestions.clear();
  assert.strictEqual(cleared, 2);
  assert.strictEqual(assistantSuggestions.count(), 0);
});
