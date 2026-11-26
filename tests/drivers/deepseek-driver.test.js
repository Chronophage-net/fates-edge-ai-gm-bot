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

test('thinking is off by default and temperature is sent; legacy flash name is mapped', async () => {
  let body, url;
  process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
  try {
    await withMockFetch(
      async (u, opts) => { url = u; body = JSON.parse(opts.body); return makeJsonResponse(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }); },
      async () => {
        const driver = new DeepSeekDriver();
        await driver.generateResponse({ systemPrompt: 'sys', messages: [] });
      }
    );
  } finally { delete process.env.DEEPSEEK_MODEL; }
  assert.strictEqual(url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(body.model, 'deepseek-flash');
  assert.deepStrictEqual(body.thinking, { type: 'disabled' });
  assert.strictEqual(body.temperature, 0.8);
  assert.ok(!('reasoning_effort' in body));
});

test('thinking enabled sends effort, drops temperature and adds reasoning room', async () => {
  let body;
  process.env.DEEPSEEK_THINKING = 'enabled';
  try {
    await withMockFetch(
      async (u, opts) => { body = JSON.parse(opts.body); return makeJsonResponse(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }); },
      async () => { await new DeepSeekDriver().generateResponse({ systemPrompt: 'sys', messages: [] }); }
    );
  } finally { delete process.env.DEEPSEEK_THINKING; }
  assert.deepStrictEqual(body.thinking, { type: 'enabled' });
  assert.strictEqual(body.reasoning_effort, 'low');
  assert.ok(!('temperature' in body));
  assert.ok(body.max_tokens > 1200);
});

test('streaming handles CRLF frames and a stream longer than the idle timeout', async () => {
  const frames = ['Rain ', 'on ', 'the ', 'gate.'].map(t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\r\n\r\n`);
  frames.push('data: [DONE]\r\n\r\n');
  async function* body() {
    const enc = new TextEncoder();
    for (const f of frames) { await new Promise(r => setTimeout(r, 40)); yield enc.encode(f); }
  }
  await withMockFetch(
    async () => ({ ok: true, status: 200, body: body(), headers: new Map() }),
    async () => {
      const driver = new DeepSeekDriver();
      driver.timeoutMs = 100; // shorter than the whole stream, longer than any gap
      const tokens = [];
      const out = await driver.generateResponse({ systemPrompt: 's', messages: [] }, t => tokens.push(t));
      assert.strictEqual(out, 'Rain on the gate.');
      assert.strictEqual(tokens.length, 4);
    }
  );
});
