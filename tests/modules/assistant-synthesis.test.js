const test = require('node:test');
const assert = require('node:assert');
const assistantSynthesis = require('../../modules/assistant-synthesis');

function fakeDriver(response) {
  return { generateResponse: async () => response };
}

test.beforeEach(() => {
  delete process.env.ASSISTANT_SYNTHESIS_ENABLED;
});

test('isSynthesisEnabled defaults to true', () => {
  assert.strictEqual(assistantSynthesis.isSynthesisEnabled(), true);
});

test('isSynthesisEnabled respects ASSISTANT_SYNTHESIS_ENABLED=false', () => {
  process.env.ASSISTANT_SYNTHESIS_ENABLED = 'false';
  assert.strictEqual(assistantSynthesis.isSynthesisEnabled(), false);
});

test('synthesizeSbSpend - table mode, raw:true skips the LLM call entirely', async () => {
  const { text, synthesized } = await assistantSynthesis.synthesizeSbSpend({
    n: 2, mode: 'table', driver: fakeDriver('should not be used'), raw: true,
  });
  assert.strictEqual(synthesized, false);
  assert.match(text, /moderate/);
});

test('synthesizeSbSpend - table mode, ASSISTANT_SYNTHESIS_ENABLED=false skips the LLM call', async () => {
  process.env.ASSISTANT_SYNTHESIS_ENABLED = 'false';
  const { synthesized } = await assistantSynthesis.synthesizeSbSpend({
    n: 1, mode: 'table', driver: fakeDriver('should not be used'),
  });
  assert.strictEqual(synthesized, false);
});

test('synthesizeSbSpend - table mode, synthesis on and driver present calls the LLM', async () => {
  const { text, synthesized } = await assistantSynthesis.synthesizeSbSpend({
    n: 3, mode: 'table', driver: fakeDriver('The bridge collapses behind them.'),
  });
  assert.strictEqual(synthesized, true);
  assert.strictEqual(text, 'The bridge collapses behind them.');
});

test('synthesizeSbSpend - falls back to raw text if the driver throws', async () => {
  const throwingDriver = { generateResponse: async () => { throw new Error('LLM down'); } };
  const { text, synthesized } = await assistantSynthesis.synthesizeSbSpend({
    n: 1, mode: 'table', driver: throwingDriver,
  });
  assert.strictEqual(synthesized, false);
  assert.match(text, /minor/);
});

test('synthesizeSbSpend - no driver at all falls back to raw text', async () => {
  const { synthesized } = await assistantSynthesis.synthesizeSbSpend({ n: 1, mode: 'table', driver: null });
  assert.strictEqual(synthesized, false);
});

test('synthesizeCrownInterpretations - raw:true returns a single fallback text', async () => {
  const { texts, synthesized } = await assistantSynthesis.synthesizeCrownInterpretations({
    crownSpreadResult: { synthesis: 'templated reading' },
    driver: fakeDriver('unused'),
    raw: true,
  });
  assert.strictEqual(synthesized, false);
  assert.deepStrictEqual(texts, ['templated reading']);
});

test('synthesizeCrownInterpretations - parses numbered LLM output into separate interpretations', async () => {
  const llmOutput = '1. The rebels strike first.\n2. A hidden ally is revealed.\n3. The weather turns against everyone.';
  const { texts, synthesized } = await assistantSynthesis.synthesizeCrownInterpretations({
    crownSpreadResult: { synthesis: 'fallback', positions: [] },
    driver: fakeDriver(llmOutput),
    count: 3,
  });
  assert.strictEqual(synthesized, true);
  assert.strictEqual(texts.length, 3);
  assert.strictEqual(texts[0], 'The rebels strike first.');
  assert.strictEqual(texts[2], 'The weather turns against everyone.');
});

test('synthesizeCrownInterpretations - falls back to templated synthesis if the driver throws', async () => {
  const throwingDriver = { generateResponse: async () => { throw new Error('LLM down'); } };
  const { texts, synthesized } = await assistantSynthesis.synthesizeCrownInterpretations({
    crownSpreadResult: { synthesis: 'templated reading' },
    driver: throwingDriver,
  });
  assert.strictEqual(synthesized, false);
  assert.deepStrictEqual(texts, ['templated reading']);
});
