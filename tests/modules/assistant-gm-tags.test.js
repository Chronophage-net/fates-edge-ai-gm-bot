const test = require('node:test');
const assert = require('node:assert');
const { processSpecialTags } = require('../../modules/commands');
const assistantSuggestions = require('../../modules/assistant-suggestions.js');

// ------------------------------------------------------------------
// Assistant GM mode: narrative-authority tags ([FACT ...], [NPC CREATE
// ...], [SCENE COMPLETE ...]) must be *held* in assistant-suggestions.js's
// queue rather than applied immediately when context.myRole ===
// 'assistant-gm' -- see commands.js's `isAssistant` branches in
// processSpecialTags(). Full-GM mode (myRole: 'gm', the default in every
// other test file) must keep applying them immediately, unchanged.
// ------------------------------------------------------------------

function buildAssistantContext(overrides = {}) {
  const facts = {};
  const mockOrchestrator = {
    campaign: {
      state: { facts, scene: {} },
      save: async () => {},
      campaignCode: 'TEST01',
    },
  };
  return {
    orchestrator: mockOrchestrator,
    charactersModule: { get: () => null, getPool: () => 0, applyDelta: () => {} },
    apiRequest: async () => ({}),
    myRole: 'assistant-gm',
    facts, // exposed for assertions
    ...overrides,
  };
}

test.beforeEach(() => {
  assistantSuggestions._resetForTests();
});

test('[FACT ...] - assistant-gm mode queues instead of applying immediately', async () => {
  const context = buildAssistantContext();
  const output = await processSpecialTags('[FACT weather stormy]', context, 'AI_GM');

  // Tag is stripped from the visible narration either way...
  assert.doesNotMatch(output, /\[FACT/);
  // ...but the fact itself must NOT be live yet.
  assert.strictEqual(context.facts.weather, undefined);

  const pending = assistantSuggestions.list();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].kind, 'fact');
  assert.match(pending[0].label, /weather/);

  // Approving it now applies the exact same mutation full-GM mode would.
  const { ok } = await assistantSuggestions.approve(pending[0].id);
  assert.strictEqual(ok, true);
  assert.strictEqual(context.facts.weather, 'stormy');
});

test('[FACT ...] - full GM mode still applies immediately (unchanged)', async () => {
  const context = buildAssistantContext({ myRole: 'gm' });
  await processSpecialTags('[FACT weather stormy]', context, 'AI_GM');

  assert.strictEqual(context.facts.weather, 'stormy');
  assert.strictEqual(assistantSuggestions.count(), 0);
});

// apiRequest is also fire-and-forget-called by placeOrUpdateToken() for the
// same [NPC CREATE ...] tag (dropping a token on the whiteboard grid) --
// record every call rather than assuming the npc-registration one is the
// only (or last) one to land.
function findNpcRegistrationCall(calls) {
  return calls.find(c => Array.isArray(c.path) && c.path.join('/') === 'adventure/npc');
}

test('[NPC CREATE ...] - assistant-gm mode queues the registration', async () => {
  const calls = [];
  const context = buildAssistantContext({
    apiRequest: async (method, path, body) => { calls.push({ method, path, body }); return {}; },
  });
  const output = await processSpecialTags('[NPC CREATE "Kestrel" "Informant" "Owes a debt"]', context, 'AI_GM');

  assert.doesNotMatch(output, /\[NPC CREATE/);
  assert.strictEqual(findNpcRegistrationCall(calls), undefined); // not registered yet

  const pending = assistantSuggestions.list();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].kind, 'npc-create');
  assert.match(pending[0].label, /Kestrel/);

  const { ok } = await assistantSuggestions.approve(pending[0].id);
  assert.strictEqual(ok, true);
  const npcCall = findNpcRegistrationCall(calls);
  assert.ok(npcCall, 'expected an adventure/npc POST after approval');
  assert.strictEqual(npcCall.body.npc.name, 'Kestrel');
});

test('[NPC CREATE ...] - full GM mode still registers immediately (unchanged)', async () => {
  const calls = [];
  const context = buildAssistantContext({
    myRole: 'gm',
    apiRequest: async (method, path, body) => { calls.push({ method, path, body }); return {}; },
  });
  await processSpecialTags('[NPC CREATE "Kestrel" "Informant"]', context, 'AI_GM');

  const npcCall = findNpcRegistrationCall(calls);
  assert.ok(npcCall, 'expected an adventure/npc POST');
  assert.strictEqual(npcCall.body.npc.name, 'Kestrel');
  assert.strictEqual(assistantSuggestions.count(), 0);
});
