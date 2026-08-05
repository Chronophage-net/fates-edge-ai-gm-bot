const test = require('node:test');
const assert = require('node:assert');

const OllamaDriver = require('../../drivers/ollama-driver.js');

function withMockFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return fn().finally(() => {
    global.fetch = original;
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('HEADLESS=true + broken model: initialize() throws and never touches readline', async () => {
  process.env.HEADLESS = 'true';
  try {
    await withMockFetch(
      async (url) => {
        if (String(url).includes('/api/generate')) {
          return jsonResponse(500, { error: 'model not found' });
        }
        if (String(url).includes('/api/tags')) {
          return jsonResponse(200, { models: [] });
        }
        throw new Error('unexpected fetch: ' + url);
      },
      async () => {
        const driver = new OllamaDriver();
        driver.maxRetries = 0;
        // If this test completes without hanging (no stdin input needed),
        // that is itself proof readline.createInterface was never invoked.
        await assert.rejects(
          () => driver.initialize(),
          /HEADLESS mode, no interactive recovery/
        );
      }
    );
  } finally {
    delete process.env.HEADLESS;
  }
});

test('_makeRequest retries on transient failures then succeeds', async () => {
  let calls = 0;
  await withMockFetch(
    async (url) => {
      calls++;
      if (calls <= 2) return jsonResponse(503, { error: 'busy' });
      return jsonResponse(200, { response: 'ok', done: true });
    },
    async () => {
      const driver = new OllamaDriver();
      driver.maxRetries = 2;
      const data = await driver._makeRequest('Hello', 1);
      assert.strictEqual(calls, 3);
      assert.strictEqual(data.response, 'ok');
    }
  );
});

test('NDJSON streaming: onToken fires per line, stops at done:true, correct final assembly', async () => {
  const lines = [
    JSON.stringify({ response: 'Hel', done: false }) + '\n',
    JSON.stringify({ response: 'lo ', done: false }) + '\n',
    JSON.stringify({ response: 'world', done: true }) + '\n',
    // A trailing extra line that should never be processed since streaming
    // returns as soon as done:true is seen.
    JSON.stringify({ response: '!!!SHOULD NOT APPEAR!!!', done: true }) + '\n',
  ];

  async function* bodyStream() {
    const encoder = new TextEncoder();
    for (const line of lines) {
      yield encoder.encode(line);
    }
  }

  await withMockFetch(
    async () => ({ ok: true, status: 200, body: bodyStream() }),
    async () => {
      const driver = new OllamaDriver();
      const tokens = [];
      const result = await driver._makeStreamingRequest('prompt', 400, 0.8, (t) => tokens.push(t));
      assert.deepStrictEqual(tokens, ['Hel', 'lo ', 'world']);
      assert.strictEqual(result, 'Hello world');
    }
  );
});

test('regression: wrong model name reaches _recoverModel; headless mode never calls ask()/readline', async () => {
  process.env.HEADLESS = 'true';
  try {
    let tagsFetched = false;
    await withMockFetch(
      async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/generate')) {
          return jsonResponse(404, { error: 'model "totally-wrong-model" not found' });
        }
        if (u.includes('/api/tags')) {
          tagsFetched = true;
          return jsonResponse(200, { models: [{ name: 'mistral' }] });
        }
        throw new Error('unexpected fetch: ' + u);
      },
      async () => {
        const driver = new OllamaDriver();
        driver.model = 'totally-wrong-model';
        driver.maxRetries = 0;
        await assert.rejects(() => driver.initialize(), /totally-wrong-model.*unavailable/s);
        // Recovery path was reached (it fetched the available-models list)...
        assert.strictEqual(tagsFetched, true);
        // ...and headless mode means it never got to the interactive
        // ask()/readline.createInterface() path (the test completed
        // synchronously without waiting on stdin).
      }
    );
  } finally {
    delete process.env.HEADLESS;
  }
});
