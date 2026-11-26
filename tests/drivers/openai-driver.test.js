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

test('default model is current and reasons at "none" for fast narration', () => {
  delete process.env.OPENAI_MODEL;
  const driver = new OpenAIDriver('test-key');
  assert.strictEqual(driver.model, 'gpt-6.1-terra');
  assert.strictEqual(driver.reasoningEffort, 'none');
});

test('reasoning models get max_completion_tokens and an effort; legacy models get temperature', async () => {
  const sent = [];
  const make = model => {
    const d = new OpenAIDriver('test-key', model);
    d.client.chat.completions.create = async body => { sent.push(body); return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }; };
    return d;
  };
  await make('gpt-6.2-sol').generateResponse({ systemPrompt: 's', messages: [] });
  await make('gpt-4o-mini').generateResponse({ systemPrompt: 's', messages: [] });
  const [sol, legacy] = sent;
  assert.strictEqual(sol.reasoning_effort, 'low', 'Sol does not accept "none"');
  assert.ok(sol.max_completion_tokens > 1200, 'reasoning tokens get room on top of the reply');
  assert.ok(!('temperature' in sol));
  assert.ok(!('max_tokens' in sol));
  assert.strictEqual(legacy.temperature, 0.8);
  assert.ok(!('reasoning_effort' in legacy));
});

test('a rejected parameter is dropped once and remembered', async () => {
  const driver = new OpenAIDriver('test-key', 'gpt-6-luna');
  const sent = [];
  driver.client.chat.completions.create = async body => {
    sent.push(body);
    if ('temperature' in body) { const e = new Error("Unsupported parameter: 'temperature'"); e.status = 400; throw e; }
    return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
  };
  assert.strictEqual(await driver.generateResponse({ systemPrompt: 's', messages: [] }), 'ok');
  assert.strictEqual(await driver.generateResponse({ systemPrompt: 's', messages: [] }), 'ok');
  assert.deepStrictEqual(sent.map(b => 'temperature' in b), [true, false, false]);
});

test('an empty reply that hit the budget is retried with more room', async () => {
  const driver = new OpenAIDriver('test-key', 'gpt-6.2-sol');
  const budgets = [];
  driver.client.chat.completions.create = async body => {
    budgets.push(body.max_completion_tokens);
    return budgets.length === 1
      ? { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
      : { choices: [{ message: { content: 'The gate opens.' }, finish_reason: 'stop' }] };
  };
  assert.strictEqual(await driver.generateResponse({ systemPrompt: 's', messages: [] }), 'The gate opens.');
  assert.ok(budgets[1] > budgets[0]);
});

test('the GM turn\'s abort signal is passed to the SDK', async () => {
  const turns = require('../../modules/turn-lifecycle');
  const driver = new OpenAIDriver('test-key', 'gpt-6.1-terra');
  let options;
  driver.client.chat.completions.create = async (body, opts) => { options = opts; return { choices: [{ message: { content: 'ok' } }] }; };
  await turns.run(() => driver.generateResponse({ systemPrompt: 's', messages: [] }));
  assert.ok(options.signal instanceof AbortSignal);
});
