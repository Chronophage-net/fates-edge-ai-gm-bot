const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeFrames, roomSocketUrl } = require('../modules/socket-input');
const correlator = require('../modules/ws-correlator');
test('invalid server messages are discarded without leaking their contents', () => {
    let invalid = 0;
    const result = decodeFrames('null\n[]\n{"password":"private"}\nnot-json\n{"type":"ping"}', (...args) => { assert.equal(args.length, 0); invalid++; });
    assert.deepEqual(result, [{ type: 'ping' }]); assert.equal(invalid, 4);
});
test('room URLs retain existing parameters and encode the locator', () => {
    const url = new URL(roomSocketUrl('ws://localhost:10000/?existing=yes', 'LIVE&other=value'));
    assert.equal(url.searchParams.get('existing'), 'yes');
    assert.equal(url.searchParams.get('room'), 'LIVE&other=value');
    assert.equal(url.searchParams.get('other'), null);
    assert.throws(() => roomSocketUrl('https://localhost/', 'LIVE'));
    assert.throws(() => roomSocketUrl('ws://user:secret@localhost/', 'LIVE'));
});
test('disconnect rejects all pending requests immediately and permits fresh requests', async () => {
    const first = correlator.waitFor('deck-drawn'); const second = correlator.waitFor('crown-spread');
    const checks = [assert.rejects(first, /Connection closed/), assert.rejects(second, /Connection closed/)];
    correlator.cancelAll(); await Promise.all(checks);
    assert.equal(correlator.resolve('deck-drawn', {}), false);
    const fresh = correlator.waitFor('deck-drawn');correlator.resolve('deck-drawn', { fresh: true });
    assert.deepEqual(await fresh, { fresh: true });
});
