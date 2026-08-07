const test = require('node:test');
const assert = require('node:assert');
const { isAdventureActive, getSceneContextForPrompt, invalidate } = require('../../modules/adventure-context.js');

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

// ============================================================
// getSceneContextForPrompt() -- active-encounter type/vocabulary block.
// Encounters may carry an optional `type` (combat/obstruction/
// skill_challenge/trap_ward/lockpick/heist/social), defaulting to
// 'combat' when absent -- exactly current back-compat behavior.
// ============================================================

function buildContext(state) {
  invalidate(); // module-level cache -- avoid cross-test leakage
  return {
    apiRequest: async (method, path) => {
      if (path[0] === 'adventure' && path.length === 1) return state;
      if (path[0] === 'adventure' && path[1] === 'reference') return null;
      return null;
    },
  };
}

test('getSceneContextForPrompt - active encounter with no type defaults to combat vocabulary (back-compat)', async () => {
  const state = {
    moduleId: 'mod1',
    status: 'active',
    title: 'Test Adventure',
    activeEncounter: { name: 'Bandit Ambush', dv: 3, position: 'Controlled' },
  };
  const block = await getSceneContextForPrompt(buildContext(state));
  assert.match(block, /Type: combat/);
  assert.match(block, /progress = "Harm"/);
  assert.match(block, /setback = "Heal"/);
  assert.match(block, /This is a fight/);
});

test('getSceneContextForPrompt - active encounter with type "lockpick" surfaces lockpick vocabulary, not Harm/Heal', async () => {
  const state = {
    moduleId: 'mod1',
    status: 'active',
    title: 'Test Adventure',
    activeEncounter: { name: 'The Vault Door', dv: 2, position: 'Controlled', type: 'lockpick' },
  };
  const block = await getSceneContextForPrompt(buildContext(state));
  assert.match(block, /Type: lockpick/);
  assert.match(block, /progress = "Tumblers"/);
  assert.match(block, /setback = "Jam"/);
  assert.match(block, /NOT a fight/);
  assert.doesNotMatch(block, /progress = "Harm"/);
});

test('getSceneContextForPrompt - active encounter with type "custom" and GM-supplied customLabel/customTickLabel surfaces those exact words', async () => {
  const state = {
    moduleId: 'mod1',
    status: 'active',
    title: 'Test Adventure',
    activeEncounter: {
      name: 'The Chanting Ritual', dv: 4, position: 'Controlled', type: 'custom',
      customLabel: 'Ritual Completion', customTickLabel: 'chant',
    },
  };
  const block = await getSceneContextForPrompt(buildContext(state));
  assert.match(block, /Type: custom/);
  assert.match(block, /progress = "Ritual Completion" \(chant\)/);
  assert.match(block, /This is a custom encounter: Ritual Completion \(advances by: chant\)/);
  assert.doesNotMatch(block, /progress = "Timer"/);
});

test('getSceneContextForPrompt - active encounter with type "custom" and no override falls back to generic Timer/tick', async () => {
  const state = {
    moduleId: 'mod1',
    status: 'active',
    title: 'Test Adventure',
    activeEncounter: { name: 'A Countdown', dv: 4, position: 'Controlled', type: 'custom' },
  };
  const block = await getSceneContextForPrompt(buildContext(state));
  assert.match(block, /Type: custom/);
  assert.match(block, /progress = "Timer" \(tick\)/);
  assert.match(block, /This is a custom encounter: Timer \(advances by: tick\)/);
});

test('getSceneContextForPrompt - no active encounter -> no "Active Encounter" line at all', async () => {
  const state = { moduleId: 'mod1', status: 'active', title: 'Test Adventure' };
  const block = await getSceneContextForPrompt(buildContext(state));
  assert.doesNotMatch(block, /Active Encounter/);
});
