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
        if (String(url).includes('/api/chat')) {
          return jsonResponse(404, { error: 'model "mistral" not found, try pulling it first' });
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

test('_chat retries on transient failures then succeeds', async () => {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls++;
      if (calls <= 2) return jsonResponse(503, { error: 'busy' });
      return jsonResponse(200, { message: { role: 'assistant', content: 'ok' }, done: true });
    },
    async () => {
      const driver = new OllamaDriver();
      driver.maxRetries = 2;
      driver._backoff = async () => {};
      assert.strictEqual(await driver._chat([{ role: 'user', content: 'Hello' }], 1), 'ok');
      assert.strictEqual(calls, 3);
    }
  );
});

test('uses /api/chat with the system prompt as a message, keep_alive, num_ctx and thinking off', async () => {
  let sent;
  await withMockFetch(
    async (url, opts) => {
      assert.ok(String(url).endsWith('/api/chat'));
      sent = JSON.parse(opts.body);
      return jsonResponse(200, { message: { content: 'The door creaks.' }, done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 5 });
    },
    async () => {
      const driver = new OllamaDriver();
      const reply = await driver.generateResponse({ systemPrompt: 'You are the GM.', messages: [{ role: 'user', content: 'I open the door.' }] });
      assert.strictEqual(reply, 'The door creaks.');
      assert.deepStrictEqual(sent.messages[0], { role: 'system', content: 'You are the GM.' });
      assert.deepStrictEqual(sent.messages[1], { role: 'user', content: 'I open the door.' });
      assert.strictEqual(sent.keep_alive, '30m');
      assert.strictEqual(sent.think, false);
      assert.strictEqual(sent.options.num_ctx, driver.contextWindow);
      assert.strictEqual(sent.options.num_predict, driver.maxTokens);
      assert.strictEqual(driver.getUsage().promptTokens, 50);
    }
  );
});

test('a model without the think switch is retried without it, and remembered', async () => {
  const bodies = [];
  await withMockFetch(
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if ('think' in body) return jsonResponse(400, { error: '"gemma3:12b" does not support thinking' });
      return jsonResponse(200, { message: { content: 'ok' }, done: true });
    },
    async () => {
      const driver = new OllamaDriver();
      assert.strictEqual(await driver._chat([{ role: 'user', content: 'hi' }], 5), 'ok');
      assert.strictEqual(await driver._chat([{ role: 'user', content: 'hi' }], 5), 'ok');
      assert.deepStrictEqual(bodies.map(b => 'think' in b), [true, false, false]);
    }
  );
});

test('<think> text a model writes into its reply is stripped', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { message: { content: '<think>plan the scene</think>\nRain hammers the gate.' }, done: true }),
    async () => {
      const driver = new OllamaDriver();
      assert.strictEqual(await driver._chat([{ role: 'user', content: 'go' }], 50), 'Rain hammers the gate.');
    }
  );
});

test('a server error is not treated as a missing model (no recovery)', async () => {
  let tags = false;
  await withMockFetch(
    async (url) => {
      if (String(url).includes('/api/tags')) { tags = true; return jsonResponse(200, { models: [] }); }
      return jsonResponse(500, { error: 'model runner has unexpectedly stopped' });
    },
    async () => {
      const driver = new OllamaDriver();
      driver.maxRetries = 0;
      await assert.rejects(() => driver.generateResponse({ systemPrompt: 's', messages: [{ role: 'user', content: 'u' }] }), /500/);
      assert.strictEqual(tags, false, 'recovery (and its terminal prompts) must not start');
    }
  );
});

test('NDJSON streaming: onToken fires per chunk, stops at done:true, correct final assembly', async () => {
  const lines = [
    JSON.stringify({ message: { content: 'Hel' }, done: false }) + '\n',
    JSON.stringify({ message: { content: 'lo ' }, done: false }) + '\n',
    JSON.stringify({ message: { content: 'world' }, done: true, done_reason: 'stop', eval_count: 3 }) + '\n',
    JSON.stringify({ message: { content: '!!!SHOULD NOT APPEAR!!!' }, done: true }) + '\n',
  ];
  async function* bodyStream() {
    const encoder = new TextEncoder();
    for (const line of lines) yield encoder.encode(line);
  }
  await withMockFetch(
    async () => ({ ok: true, status: 200, body: bodyStream() }),
    async () => {
      const driver = new OllamaDriver();
      const tokens = [];
      const result = await driver.generateResponse({ systemPrompt: 's', messages: [{ role: 'user', content: 'u' }] }, t => tokens.push(t));
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
        if (u.includes('/api/chat')) {
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
