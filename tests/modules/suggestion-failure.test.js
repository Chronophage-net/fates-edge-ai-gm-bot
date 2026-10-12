const { test } = require('node:test');
const assert = require('node:assert/strict');
const suggestions = require('../../modules/assistant-suggestions');
const { processSpecialTags } = require('../../modules/commands/process-tags');
test('NPC and knowledge suggestions propagate backend failures instead of approving', async () => {
  for (const tag of ['[NPC CREATE "Guide" "Scout"]', '[REVEAL "secret"]', '[HIDE "secret"]']) {
    suggestions._resetForTests();
    const events = [];
    suggestions.setBroadcaster((event, data) => events.push({ event, ...data }));
    await processSpecialTags(tag, {
      charactersModule: {}, orchestrator: { campaign: { state: {}, save: async () => {} } },
      myRole: 'assistant-gm', apiRequest: async () => { throw new Error('private backend detail'); },
    });
    assert.equal(suggestions.count(), 1);
    assert.equal((await suggestions.approve(suggestions.list()[0].id)).ok, false);
    assert.equal(events.at(-1).outcome, 'failed');
    assert(!JSON.stringify(events).includes('private backend detail'));
  }
});
test('failed application is never reported as approved', async () => {
  suggestions._resetForTests();
  const events = [];
  suggestions.setBroadcaster((event, data) => events.push({ event, ...data }));
  const item = suggestions.enqueue({ kind: 'fact', apply: async () => { throw new Error('private backend detail'); } });
  assert.equal((await suggestions.approve(item.id)).ok, false);
  assert.equal(events.at(-1).outcome, 'failed');
  assert(!JSON.stringify(events).includes('private backend detail'));
  assert.equal(suggestions.count(), 0);
});
