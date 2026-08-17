const test = require('node:test');
const assert = require('node:assert');
const { handleBotCommand } = require('../../modules/commands');
const assistantSuggestions = require('../../modules/assistant-suggestions');

// ------------------------------------------------------------------
// Regression test for a bug found while modularizing commands.js:
// the blanket "Only the Game Master can run resource commands" gate
// ran ahead of the suggestions/approve/reject/confirm-takeover block,
// which itself requires myRole === 'assistant-gm'. Since a caller can
// never be both 'gm' and 'assistant-gm' at once, those four commands
// were unreachable dead code -- an Assistant GM's own suggestion-queue
// commands could never actually run via chat for anyone.
// ------------------------------------------------------------------
function buildMockContext(myRole) {
    return {
        myRole,
        charactersModule: { get: () => null, getPool: () => 0, applyDelta: () => {} },
        orchestrator: {
            campaign: {
                state: { scene: {} },
                save: async () => {},
            },
        },
        apiRequest: async () => ({}),
    };
}

test('handleBotCommand - !gm suggestions is reachable for an Assistant GM (was previously dead code)', async () => {
    const context = buildMockContext('assistant-gm');
    const result = await handleBotCommand('Tester', '!gm suggestions', context);
    // Previously this returned 'Only the Game Master can run resource commands.'
    // regardless of role, because the blanket gate ran first.
    assert.notStrictEqual(result, 'Only the Game Master can run resource commands.');
    assert.match(result, /pending suggestion/i);
});

test('handleBotCommand - !gm suggestions still rejects a plain player (not gm, not assistant-gm)', async () => {
    const context = buildMockContext('player');
    const result = await handleBotCommand('Tester', '!gm suggestions', context);
    // The blanket "resource commands" gate exempts these four commands so
    // they're reachable at all, but the command's own inner role check
    // (myRole === 'assistant-gm') still applies and still rejects a
    // plain player -- only the specific error message differs from the
    // blanket gate's.
    assert.strictEqual(result, "I only hold pending suggestions while I'm the Assistant GM.");
});

test('handleBotCommand - resource commands (e.g. !gm harm) still gated to gm only', async () => {
    const context = buildMockContext('assistant-gm');
    const result = await handleBotCommand('Tester', '!gm harm SomeName 1', context);
    assert.strictEqual(result, 'Only the Game Master can run resource commands.');
});
