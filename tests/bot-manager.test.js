const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadManifest, loadBotEnv, readDiskIo } = require('../bot-manager.js');

function tmpFile(name, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-manager-test-'));
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
}

test('loadManifest - parses a valid bots.json', () => {
    const p = tmpFile('bots.json', JSON.stringify({ bots: [{ room: 'AC12' }, { room: 'XY99' }] }));
    const bots = loadManifest(p);
    assert.strictEqual(bots.length, 2);
    assert.strictEqual(bots[0].room, 'AC12');
});

test('loadManifest - throws on an empty bots[] array', () => {
    const p = tmpFile('bots.json', JSON.stringify({ bots: [] }));
    assert.throws(() => loadManifest(p), /no bots/);
});

test('loadManifest - throws on a missing "room" field', () => {
    const p = tmpFile('bots.json', JSON.stringify({ bots: [{ envFile: '.env' }] }));
    assert.throws(() => loadManifest(p), /missing a "room"/);
});

test('loadManifest - throws on a duplicate room', () => {
    const p = tmpFile('bots.json', JSON.stringify({ bots: [{ room: 'AC12' }, { room: 'AC12' }] }));
    assert.throws(() => loadManifest(p), /Duplicate room/);
});

test('loadManifest - truncates to MAX_BOTS and warns rather than throwing', () => {
    const originalMax = process.env.MAX_BOTS;
    process.env.MAX_BOTS = '2';
    delete require.cache[require.resolve('../bot-manager.js')];
    const { loadManifest: loadManifestWithCap } = require('../bot-manager.js');
    const p = tmpFile('bots.json', JSON.stringify({ bots: [{ room: 'A' }, { room: 'B' }, { room: 'C' }] }));
    const bots = loadManifestWithCap(p);
    assert.strictEqual(bots.length, 2);
    if (originalMax === undefined) delete process.env.MAX_BOTS; else process.env.MAX_BOTS = originalMax;
    delete require.cache[require.resolve('../bot-manager.js')];
});

test('loadManifest - MAX_BOTS defaults to 12', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({ room: `R${i}` }));
    const p = tmpFile('bots.json', JSON.stringify({ bots: entries }));
    const bots = loadManifest(p);
    assert.strictEqual(bots.length, 12);
});

test('loadBotEnv - merges envFile over process.env and force-sets ROOM/STATUS_PORT', () => {
    const envPath = tmpFile('.env.test', 'AI_PROVIDER=deepseek\nROOM=WRONG\nSTATUS_PORT=9999\n');
    const env = loadBotEnv({ room: 'AC12', envFile: envPath }, 3);
    assert.strictEqual(env.AI_PROVIDER, 'deepseek');
    assert.strictEqual(env.ROOM, 'AC12'); // manifest room wins over whatever the envFile said
    assert.strictEqual(env.STATUS_PORT, String(4150 + 3)); // BASE_BOT_STATUS_PORT default + index, not the envFile's value
});

test('loadBotEnv - an explicit statusPort in the manifest entry wins over the index-based default', () => {
    const env = loadBotEnv({ room: 'AC12', statusPort: 5555 }, 0);
    assert.strictEqual(env.STATUS_PORT, '5555');
});

test('loadBotEnv - falls back to process.env only when envFile is missing/absent, without throwing', () => {
    const env = loadBotEnv({ room: 'AC12' }, 0);
    assert.strictEqual(env.ROOM, 'AC12');
});

test('readDiskIo - returns null for a nonexistent pid rather than throwing', () => {
    assert.strictEqual(readDiskIo(999999999), null);
});
