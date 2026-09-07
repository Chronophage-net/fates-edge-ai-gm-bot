const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    loadManifest,
    normalizeEntries,
    loadBotEnv,
    seatKeyFor,
    seatLabelFor,
    logPathFor,
    readDiskIo,
    VALID_MODES,
} = require('../bot-manager.js');

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

// NOTE: rooms are no longer unique -- several bots share a room, one per seat
// (docs/two-seats-spec.md SS3.1). Two bare entries for one room no longer collide
// on a seat (the second auto-assigns to seat 1); what stops them is that both
// would default to mode 'gm', and a room may only have one GM chair.
test('loadManifest - two bare entries for one room are rejected as two GM seats', () => {
    const p = tmpFile('bots.json', JSON.stringify({ bots: [{ room: 'AC12' }, { room: 'AC12' }] }));
    assert.throws(() => loadManifest(p), /more than one "gm" seat/);
});

test('loadManifest - the same room twice is fine once the second is not a GM', () => {
    const p = tmpFile('bots.json', JSON.stringify({ bots: [{ room: 'AC12' }, { room: 'AC12', mode: 'player' }] }));
    const bots = loadManifest(p);
    assert.deepStrictEqual(bots.map(b => `${b.room}#${b.seat}:${b.mode}`), ['AC12#0:gm', 'AC12#1:player']);
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


// ============================================================
// Seats: mode / seat / roomId  (docs/two-seats-spec.md SS3.1-3.2, SS7.6-7.9)
// ============================================================

test('seats - several bots may share one room when their seats differ', () => {
    const p = tmpFile('bots.json', JSON.stringify({
        bots: [
            { room: 'AC12', mode: 'gm', seat: 0 },
            { room: 'AC12', mode: 'player', seat: 1 },
            { room: 'AC12', mode: 'passive', seat: 2 },
        ],
    }));
    const bots = loadManifest(p);
    assert.strictEqual(bots.length, 3);
    assert.deepStrictEqual(bots.map(b => b.seat), [0, 1, 2]);
    assert.deepStrictEqual(bots.map(b => b.mode), ['gm', 'player', 'passive']);
});

test('seats - omitted seats auto-assign in manifest order, per room', () => {
    const entries = normalizeEntries([
        { room: 'AC12', mode: 'gm' },
        { room: 'AC12', mode: 'player' },
        { room: 'XY99', mode: 'gm' },
        { room: 'AC12', mode: 'player' },
    ]);
    assert.deepStrictEqual(entries.map(e => `${e.room}#${e.seat}`), ['AC12#0', 'AC12#1', 'XY99#0', 'AC12#2']);
});

test('seats - an explicit seat is respected and does not disturb auto-assignment', () => {
    const entries = normalizeEntries([
        { room: 'AC12', mode: 'player', seat: 5 },
        { room: 'AC12', mode: 'gm' },
    ]);
    assert.deepStrictEqual(entries.map(e => e.seat), [5, 0]);
});

test('seats - rejects a duplicate explicit seat in the same room', () => {
    assert.throws(
        () => normalizeEntries([{ room: 'AC12', seat: 1, mode: 'player' }, { room: 'AC12', seat: 1, mode: 'passive' }]),
        /Duplicate seat 1 in room "AC12"/,
    );
});

test('seats - the same seat number in a DIFFERENT room is fine', () => {
    const entries = normalizeEntries([
        { room: 'AC12', seat: 1, mode: 'player' },
        { room: 'XY99', seat: 1, mode: 'player' },
    ]);
    assert.strictEqual(entries.length, 2);
});

test('seats - rejects a negative or non-integer seat', () => {
    assert.throws(() => normalizeEntries([{ room: 'A', seat: -1, mode: 'gm' }]), /Invalid "seat"/);
    assert.throws(() => normalizeEntries([{ room: 'A', seat: 1.5, mode: 'gm' }]), /Invalid "seat"/);
});

test('seats - rejects more than one gm seat per room', () => {
    assert.throws(
        () => normalizeEntries([{ room: 'AC12', mode: 'gm' }, { room: 'AC12', mode: 'gm', seat: 1 }]),
        /more than one "gm" seat/,
    );
});

test('seats - two gm seats in different rooms are fine', () => {
    const entries = normalizeEntries([{ room: 'AC12', mode: 'gm' }, { room: 'XY99', mode: 'gm' }]);
    assert.strictEqual(entries.length, 2);
});

test('seats - rejects an unknown mode and accepts every valid one', () => {
    assert.throws(() => normalizeEntries([{ room: 'A', mode: 'referee' }]), /Invalid "mode"/);
    for (const mode of VALID_MODES) {
        assert.doesNotThrow(() => normalizeEntries([{ room: 'A', mode }]));
    }
});

test('seats - rejects an empty or non-string roomId', () => {
    assert.throws(() => normalizeEntries([{ room: 'A', roomId: '   ' }]), /Invalid "roomId"/);
    assert.throws(() => normalizeEntries([{ room: 'A', roomId: 42 }]), /Invalid "roomId"/);
});

test('seats - roomId is trimmed and carried through', () => {
    const [entry] = normalizeEntries([{ room: 'A', roomId: '  0192f3a1-0000-7000-8000-000000000001  ' }]);
    assert.strictEqual(entry.roomId, '0192f3a1-0000-7000-8000-000000000001');
});

test('seats - normalizeEntries does not mutate the caller\'s objects', () => {
    const raw = [{ room: 'AC12' }];
    normalizeEntries(raw);
    assert.strictEqual(raw[0].seat, undefined);
    assert.strictEqual(raw[0].mode, undefined);
});

// ============================================================
// Legacy preservation  (SS7.14: the compatibility floor)
// ============================================================

test('legacy - an entry with no seat/mode/roomId keeps seat 0, mode gm', () => {
    const [entry] = normalizeEntries([{ room: 'AC12', envFile: '.env' }]);
    assert.strictEqual(entry.seat, 0);
    assert.strictEqual(entry.mode, 'gm');
    assert.strictEqual(entry._legacy, true);
});

test('legacy - a legacy entry keeps logs/<ROOM>.log, unqualified by seat', () => {
    const [entry] = normalizeEntries([{ room: 'AC12' }]);
    assert.match(logPathFor(entry), /[/\\]AC12\.log$/);
});

test('legacy - a seat-aware entry gets a seat-qualified log path', () => {
    const [entry] = normalizeEntries([{ room: 'AC12', mode: 'player', seat: 1 }]);
    assert.match(logPathFor(entry), /[/\\]AC12-s1\.log$/);
});

test('legacy - declaring ONLY a mode is enough to leave legacy mode', () => {
    const [entry] = normalizeEntries([{ room: 'AC12', mode: 'gm' }]);
    assert.strictEqual(entry._legacy, false);
    assert.match(logPathFor(entry), /[/\\]AC12-s0\.log$/);
});

test('legacy - a room name cannot escape the logs directory', () => {
    const [entry] = normalizeEntries([{ room: '../../etc/passwd', mode: 'gm' }]);
    const logPath = logPathFor(entry);
    // The property that matters is containment, not the absence of dots: the
    // result must resolve to a direct child of logs/.
    const logDir = path.resolve(__dirname, '..', 'logs');
    assert.strictEqual(path.dirname(path.resolve(logPath)), logDir);
    assert.ok(!path.basename(logPath).includes('..'), `basename should not contain "..": ${logPath}`);
});

// ============================================================
// Seat identity helpers
// ============================================================

test('seatKeyFor - room and seat together are the identity', () => {
    assert.strictEqual(seatKeyFor({ room: 'AC12', seat: 0 }), 'AC12#0');
    assert.strictEqual(seatKeyFor({ room: 'AC12', seat: 2 }), 'AC12#2');
});

test('seatLabelFor - legacy entries read as a bare room, seats read as "room sN"', () => {
    assert.strictEqual(seatLabelFor({ room: 'AC12', seat: 0, _legacy: true }), 'AC12');
    assert.strictEqual(seatLabelFor({ room: 'AC12', seat: 1, _legacy: false }), 'AC12 s1');
});

// ============================================================
// Env propagation  (SS7.10 and the MODE-override rule)
// ============================================================

test('env - BOT_SEAT is manager-assigned and overrides anything in the envFile', () => {
    const envPath = tmpFile('.env.seat', 'BOT_SEAT=99\n');
    const [entry] = normalizeEntries([{ room: 'AC12', mode: 'player', seat: 2, envFile: envPath }]);
    const env = loadBotEnv(entry, 0);
    assert.strictEqual(env.BOT_SEAT, '2');
});

test('env - a manifest mode overrides the envFile', () => {
    const envPath = tmpFile('.env.mode', 'MODE=gm\n');
    const [entry] = normalizeEntries([{ room: 'AC12', mode: 'passive', envFile: envPath }]);
    assert.strictEqual(loadBotEnv(entry, 0).MODE, 'passive');
});

test('env - an envFile MODE survives when the manifest does not declare one', () => {
    const envPath = tmpFile('.env.mode2', 'MODE=passive\n');
    const [entry] = normalizeEntries([{ room: 'AC12', envFile: envPath }]);
    assert.strictEqual(loadBotEnv(entry, 0).MODE, 'passive');
});

test('env - MODE defaults to gm when neither manifest nor envFile says otherwise', () => {
    const [entry] = normalizeEntries([{ room: 'AC12' }]);
    const saved = process.env.MODE;
    delete process.env.MODE;
    try {
        assert.strictEqual(loadBotEnv(entry, 0).MODE, 'gm');
    } finally {
        if (saved !== undefined) process.env.MODE = saved;
    }
});

test('env - ROOM_ID is set only when the manifest declares a roomId', () => {
    const [withId] = normalizeEntries([{ room: 'AC12', roomId: 'room-uuid-1' }]);
    assert.strictEqual(loadBotEnv(withId, 0).ROOM_ID, 'room-uuid-1');

    const [withoutId] = normalizeEntries([{ room: 'AC12' }]);
    const saved = process.env.ROOM_ID;
    delete process.env.ROOM_ID;
    try {
        assert.strictEqual(loadBotEnv(withoutId, 0).ROOM_ID, undefined);
    } finally {
        if (saved !== undefined) process.env.ROOM_ID = saved;
    }
});

test('env - seats sharing a room still get distinct status ports', () => {
    const entries = normalizeEntries([
        { room: 'AC12', mode: 'gm' },
        { room: 'AC12', mode: 'player' },
    ]);
    const ports = entries.map((e, i) => loadBotEnv(e, i).STATUS_PORT);
    assert.deepStrictEqual(ports, ['4150', '4151']);
    assert.notStrictEqual(ports[0], ports[1]);
});

// ============================================================
// The shipped example manifest
// ============================================================

test('bots.example.json - is valid, seats a full table, and ships two idle player seats', () => {
    const example = require('../bots.example.json');
    const entries = normalizeEntries(example.bots);

    const ac12 = entries.filter(e => e.room === 'AC12');
    assert.strictEqual(ac12.filter(e => e.mode === 'gm').length, 1);
    assert.strictEqual(ac12.filter(e => e.mode === 'player').length, 2, 'two idle player seats per the spec');
    assert.strictEqual(ac12.filter(e => e.mode === 'passive').length, 1);

    // every seat key is unique across the whole manifest
    const keys = entries.map(seatKeyFor);
    assert.strictEqual(new Set(keys).size, keys.length);

    // and the legacy-shaped second table still parses as a plain GM bot
    const xy99 = entries.find(e => e.room === 'XY99');
    assert.strictEqual(xy99.mode, 'gm');
    assert.strictEqual(xy99.seat, 0);
    assert.strictEqual(xy99._legacy, true);
});
