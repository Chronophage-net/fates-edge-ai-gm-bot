const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('SIGTERM and SIGINT share idempotent save/cleanup without reconnect', async () => {
  const source = fs.readFileSync(require.resolve('../../ai-gm-bot.js'), 'utf8');
  const start = source.indexOf('async function shutdown()');
  const end = source.indexOf('\nmain().catch', start);
  const events = [], handlers = {};
  vm.runInNewContext(source.slice(start, end), {
    stopping: false, reconnectTimer: null,
    turns: { invalidate: () => events.push('invalidate') },
    cancelGmTakeoverTimer() {}, wsCorrelator: { cancelAll() {} },
    stopAggressiveSync() {}, statusServer: { stop() {} },
    orchestrator: { campaign: { save: async () => events.push('save') } },
    driver: { shutdown: async () => events.push('driver') },
    ws: { close: () => events.push('close') },
    console: { log() {} }, logger: { error() {} }, setTimeout, clearTimeout,
    process: { on: (name, fn) => { handlers[name] = fn; }, exit: code => events.push(`exit:${code}`) },
  });
  assert.equal(handlers.SIGTERM, handlers.SIGINT);
  await handlers.SIGTERM(); await handlers.SIGINT();
  assert.deepEqual(events, ['invalidate', 'save', 'driver', 'close', 'exit:0']);
});
