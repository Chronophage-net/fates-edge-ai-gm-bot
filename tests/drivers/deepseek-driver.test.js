const test = require('node:test');
const assert = require('node:assert');

process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
const DeepSeekDriver = require('../../drivers/deepseek-driver.js');

function makeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function withMockFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return fn().finally(() => {
    global.fetch = original;
  });
}

test('generateResponse - non-streaming happy path returns message content', async () => {
  await withMockFetch(
    async () => makeJsonResponse(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    async () => {
      const driver = new DeepSeekDriver();
      const result = await driver.generateResponse({ systemPrompt: 'sys', messages: [] });
      assert.strictEqual(result, 'x');
    }
  );
});

test('generateResponse - retries on 503 twice then succeeds on 200', async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls++;
      if (calls <= 2) return makeJsonResponse(503, { error: 'unavailable' });
      return makeJsonResponse(200, { choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }] });
    },
    async () => {
      const driver = new DeepSeekDriver();
      driver.maxRetries = 2;
      const result = await driver.generateResponse({ systemPrompt: 'sys', messages: [] });
      assert.strictEqual(calls, 3);
      assert.strictEqual(result, 'recovered');
    }
  );
});

test('generateResponse - streaming assembles onToken chunks into final string', async () => {
  const sseFrames = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  async function* bodyStream() {
    const encoder = new TextEncoder();
    for (const frame of sseFrames) {
      yield encoder.encode(frame);
    }
  }

  await withMockFetch(
    async () => ({
      ok: true,
      status: 200,
      body: bodyStream(),
    }),
    async () => {
      const driver = new DeepSeekDriver();
      const tokens = [];
      const result = await driver.generateResponse({ systemPrompt: 'sys', messages: [] }, (t) => tokens.push(t));
      assert.deepStrictEqual(tokens, ['Hel', 'lo ', 'world']);
      assert.strictEqual(result, 'Hello world');
    }
  );
});

test('_describeError - formats 401 and 429 messages', () => {
  const driver = new DeepSeekDriver();
  assert.match(driver._describeError(401, 'nope'), /invalid \(401\)/);
  assert.match(driver._describeError(429, 'slow down'), /rate limit exceeded \(429\)/);
});
