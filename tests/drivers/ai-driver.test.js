const test = require('node:test');
const assert = require('node:assert');
const AIDriver = require('../../drivers/ai-driver.js');

test('estimateTokens - Math.ceil(len/4) for known strings', () => {
  const driver = new AIDriver();
  assert.strictEqual(driver.estimateTokens(''), 0);
  assert.strictEqual(driver.estimateTokens('abcd'), 1); // 4/4 = 1
  assert.strictEqual(driver.estimateTokens('abcde'), 2); // ceil(5/4) = 2
  assert.strictEqual(driver.estimateTokens('a'.repeat(100)), 25); // 100/4 = 25
  assert.strictEqual(driver.estimateTokens('a'.repeat(101)), 26); // ceil(101/4) = 26
});

test('trimToFit - system prompt under budget is returned unchanged', () => {
  const driver = new AIDriver();
  driver.contextWindow = 8192;
  const context = { systemPrompt: 'short system prompt', messages: [{ role: 'user', content: 'hi' }] };
  const result = driver.trimToFit(context);
  assert.strictEqual(result.systemPrompt, 'short system prompt');
  assert.strictEqual(result.messages.length, 1);
});

test('trimToFit - system prompt over budget is truncated with head+tail preserved', () => {
  const driver = new AIDriver();
  driver.contextWindow = 1000; // small window to force truncation
  driver.maxTokens = 100;
  const head = 'HEAD_MARKER_'.repeat(50);
  const tail = 'TAIL_MARKER_'.repeat(50);
  const middle = 'x'.repeat(5000);
  const systemPrompt = head + middle + tail;
  const context = { systemPrompt, messages: [] };
  const result = driver.trimToFit(context);
  assert.ok(result.systemPrompt.length < systemPrompt.length, 'system prompt should be shorter');
  assert.match(result.systemPrompt, /\[\.\.\.system context trimmed/);
  assert.ok(result.systemPrompt.startsWith('HEAD_MARKER_'), 'head text preserved');
  assert.ok(result.systemPrompt.endsWith('TAIL_MARKER_'.slice(-5)) || result.systemPrompt.includes('TAIL_MARKER_'), 'tail text preserved');
});

test('trimToFit - oldest messages dropped first, newest always kept even if it alone exceeds budget', () => {
  const driver = new AIDriver();
  driver.contextWindow = 300; // very small window
  driver.maxTokens = 50;
  const messages = [
    { role: 'user', content: 'old message 1 ' + 'a'.repeat(50) },
    { role: 'assistant', content: 'old message 2 ' + 'b'.repeat(50) },
    { role: 'user', content: 'newest message ' + 'z'.repeat(2000) }, // alone exceeds budget
  ];
  const context = { systemPrompt: '', messages };
  const result = driver.trimToFit(context);
  // The newest message must always be kept, even though it alone exceeds the remaining budget.
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].content, messages[2].content);
});

test('trimToFit - messages that all fit are all kept, in order', () => {
  const driver = new AIDriver();
  driver.contextWindow = 8192;
  const messages = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
  ];
  const context = { systemPrompt: '', messages };
  const result = driver.trimToFit(context);
  assert.deepStrictEqual(result.messages.map(m => m.content), ['one', 'two', 'three']);
});

test('_fetchWithRetries and _backoff exist as instance methods', () => {
  const driver = new AIDriver();
  assert.strictEqual(typeof driver._fetchWithRetries, 'function');
  assert.strictEqual(typeof driver._backoff, 'function');
});

test('generateResponse throws if not overridden by a subclass', async () => {
  const driver = new AIDriver();
  await assert.rejects(() => driver.generateResponse({ systemPrompt: '', messages: [] }), /generateResponse\(\) must be implemented/);
});
