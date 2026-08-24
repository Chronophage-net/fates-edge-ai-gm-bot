const test = require('node:test');
const assert = require('node:assert');
const assistantSuggestions = require('../../modules/assistant-suggestions.js');

// Covers the two additions from ROADMAP.md item 2: the setBroadcaster()
// hook (assistant-suggestion-created/-resolved) and groupId-based
// auto-reject (approving one Crown Spread interpretation drops its
// siblings). See assistant-suggestions.test.js for the pre-existing
// enqueue/approve/reject/clear coverage this deliberately doesn't repeat.

test.beforeEach(() => {
  assistantSuggestions._resetForTests();
});

test('enqueue - broadcasts assistant-suggestion-created with preview defaulted from label', () => {
  const events = [];
  assistantSuggestions.setBroadcaster((event, payload) => events.push({ event, payload }));
  assistantSuggestions.enqueue({ kind: 'fact', label: 'New fact — x: y', apply: async () => {} });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'assistant-suggestion-created');
  assert.strictEqual(events[0].payload.preview, 'New fact — x: y');
  assert.strictEqual(events[0].payload.groupId, null);
});

test('enqueue - preview and groupId pass through when explicitly given', () => {
  const events = [];
  assistantSuggestions.setBroadcaster((event, payload) => events.push({ event, payload }));
  assistantSuggestions.enqueue({ kind: 'crown-synthesis', label: 'Interp 1/2', preview: 'The bridge falls.', groupId: 'grp_1', apply: async () => {} });
  assert.strictEqual(events[0].payload.preview, 'The bridge falls.');
  assert.strictEqual(events[0].payload.groupId, 'grp_1');
});

test('approve - broadcasts assistant-suggestion-resolved with outcome approved', async () => {
  const events = [];
  const entry = assistantSuggestions.enqueue({ kind: 'fact', label: 'x', apply: async () => 'ok text' });
  assistantSuggestions.setBroadcaster((event, payload) => events.push({ event, payload }));
  await assistantSuggestions.approve(entry.id);
  const resolved = events.find(e => e.event === 'assistant-suggestion-resolved');
  assert.ok(resolved);
  assert.strictEqual(resolved.payload.outcome, 'approved');
  assert.strictEqual(resolved.payload.result, 'ok text');
});

test('reject - broadcasts assistant-suggestion-resolved with outcome rejected', () => {
  const events = [];
  const entry = assistantSuggestions.enqueue({ kind: 'fact', label: 'x', apply: async () => {} });
  assistantSuggestions.setBroadcaster((event, payload) => events.push({ event, payload }));
  assistantSuggestions.reject(entry.id);
  const resolved = events.find(e => e.event === 'assistant-suggestion-resolved');
  assert.strictEqual(resolved.payload.outcome, 'rejected');
});

test('approve - approving one member of a groupId auto-rejects its still-pending siblings', async () => {
  const events = [];
  const a = assistantSuggestions.enqueue({ kind: 'crown-synthesis', label: '1', groupId: 'grp_1', apply: async () => 'A wins' });
  const b = assistantSuggestions.enqueue({ kind: 'crown-synthesis', label: '2', groupId: 'grp_1', apply: async () => 'B wins' });
  const c = assistantSuggestions.enqueue({ kind: 'crown-synthesis', label: '3', groupId: 'grp_1', apply: async () => 'C wins' });
  assistantSuggestions.setBroadcaster((event, payload) => events.push({ event, payload }));

  const { ok, result, autoRejected } = await assistantSuggestions.approve(a.id);
  assert.strictEqual(ok, true);
  assert.strictEqual(result, 'A wins');
  assert.deepStrictEqual(autoRejected.sort(), [b.id, c.id].sort());
  assert.strictEqual(assistantSuggestions.count(), 0);

  const autoRejectedEvents = events.filter(e => e.event === 'assistant-suggestion-resolved' && e.payload.outcome === 'auto-rejected');
  assert.strictEqual(autoRejectedEvents.length, 2);
});

test('approve - a suggestion outside the groupId is untouched by a sibling auto-reject', async () => {
  const a = assistantSuggestions.enqueue({ kind: 'crown-synthesis', label: '1', groupId: 'grp_1', apply: async () => {} });
  const other = assistantSuggestions.enqueue({ kind: 'fact', label: 'unrelated', apply: async () => {} });
  await assistantSuggestions.approve(a.id);
  assert.strictEqual(assistantSuggestions.count(), 1);
  assert.strictEqual(assistantSuggestions.find(other.id).id, other.id);
});

test('approve - no groupId means no auto-reject side effects', async () => {
  const a = assistantSuggestions.enqueue({ kind: 'fact', label: 'a', apply: async () => {} });
  const b = assistantSuggestions.enqueue({ kind: 'fact', label: 'b', apply: async () => {} });
  const { autoRejected } = await assistantSuggestions.approve(a.id);
  assert.deepStrictEqual(autoRejected, []);
  assert.strictEqual(assistantSuggestions.count(), 1);
  assert.strictEqual(assistantSuggestions.find(b.id).id, b.id);
});

test('setBroadcaster(null) disables broadcasting again', () => {
  const events = [];
  assistantSuggestions.setBroadcaster((event, payload) => events.push({ event, payload }));
  assistantSuggestions.setBroadcaster(null);
  assistantSuggestions.enqueue({ kind: 'fact', label: 'x', apply: async () => {} });
  assert.strictEqual(events.length, 0);
});

test('a throwing broadcaster does not break enqueue/approve/reject', async () => {
  assistantSuggestions.setBroadcaster(() => { throw new Error('boom'); });
  const entry = assistantSuggestions.enqueue({ kind: 'fact', label: 'x', apply: async () => 'fine' });
  const { ok, result } = await assistantSuggestions.approve(entry.id);
  assert.strictEqual(ok, true);
  assert.strictEqual(result, 'fine');
});
