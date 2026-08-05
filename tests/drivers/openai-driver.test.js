const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
const OpenAIDriver = require('../../drivers/openai-driver.js');

test('constructor passes timeout/maxRetries through to the OpenAI SDK client', () => {
  process.env.OPENAI_TIMEOUT_MS = '12345';
  process.env.OPENAI_MAX_RETRIES = '4';
  try {
    const driver = new OpenAIDriver('test-key', 'gpt-4o-mini');
    assert.strictEqual(driver.client.timeout, 12345);
    assert.strictEqual(driver.client.maxRetries, 4);
  } finally {
    delete process.env.OPENAI_TIMEOUT_MS;
    delete process.env.OPENAI_MAX_RETRIES;
  }
});

test('generateResponse - non-streaming happy path, monkey-patched client', async () => {
  const driver = new OpenAIDriver('test-key', 'gpt-4o-mini');
  driver.client.chat.completions.create = async () => ({
    choices: [{ message: { content: 'hello there' } }],
  });
  const result = await driver.generateResponse({ systemPrompt: 'sys', messages: [] });
  assert.strictEqual(result, 'hello there');
});

test('generateResponse - streaming via async generator mock assembles onToken chunks', async () => {
  const driver = new OpenAIDriver('test-key', 'gpt-4o-mini');
  async function* fakeStream() {
    yield { choices: [{ delta: { content: 'Hel' } }] };
    yield { choices: [{ delta: { content: 'lo ' } }] };
    yield { choices: [{ delta: { content: 'world' } }] };
  }
  driver.client.chat.completions.create = async () => fakeStream();

  const tokens = [];
  const result = await driver.generateResponse({ systemPrompt: 'sys', messages: [] }, (t) => tokens.push(t));
  assert.deepStrictEqual(tokens, ['Hel', 'lo ', 'world']);
  assert.strictEqual(result, 'Hello world');
});

test('initialize() rethrows on failure (regression: used to silently swallow)', async () => {
  const driver = new OpenAIDriver('test-key', 'gpt-4o-mini');
  const authError = new Error('Invalid API key');
  authError.status = 401;
  driver.client.chat.completions.create = async () => { throw authError; };

  await assert.rejects(() => driver.initialize(), /Invalid API key/);
});

test('generateResponse - 401 error is reformatted to a clear message', async () => {
  const driver = new OpenAIDriver('test-key', 'gpt-4o-mini');
  const authError = new Error('nope');
  authError.status = 401;
  driver.client.chat.completions.create = async () => { throw authError; };

  await assert.rejects(
    () => driver.generateResponse({ systemPrompt: 'sys', messages: [] }),
    /OpenAI API key is invalid \(401\)/
  );
});
