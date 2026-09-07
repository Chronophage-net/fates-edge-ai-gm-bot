'use strict';
// Regression tests for the read-only review findings on the two-seats feature.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TableSeats } = require('../../modules/table-seats');
const { PlayerSeat } = require('../../modules/player-seat');

const driver = { generateResponse: async () => '{}' };
const seat = (over = {}) => new TableSeats({
  mode: 'passive', seat: 1, room: 'AC12', driver,
  send: () => {}, api: async () => ({}), ...over,
});

test('P5: a failed public-context refresh keeps the last good revealed projection', async () => {
  const events = [];
  let fail = false;
  const s = seat({
    audit: e => events.push(e),
    api: async () => { if (fail) throw new Error('network'); return { knowledge: [{ id: 'k1', revealed: true, text: 'The bridge is out.' }], chat: [] }; },
  });
  await s.refreshPublic();
  const before = s.memory.entries().length;
  assert.ok(before > 0, 'revealed knowledge should be present after a good refresh');

  fail = true;
  await s.refreshPublic();
  assert.strictEqual(s.memory.entries().length, before, 'a transient failure must not erase revealed truth');
  assert.ok(events.includes('public-context-refresh-failed'), 'the failure is audited rather than silent');
});

test('P2: the own-sheet lookup is claim-authenticated, never the client-supplied selection', async () => {
  const calls = [];
  const s = seat({ api: async (method, segments) => { calls.push(segments.join('/')); return {}; } });
  s.id = 'self';
  s.roster = [
    { id: 'self', role: 'player', botMode: 'passive', botSeat: 1 },
    { id: 'attacker', role: 'player', userId: 'u1', selectedCharacter: 'Someone Elses PC' },
  ];
  await s.handle({ type: 'chat-message', message: { text: '!gm look armor', senderClientId: 'attacker' } });

  assert.ok(calls.some(c => c.startsWith('public-sheet/')), 'reads through the claim-authenticated endpoint');
  assert.ok(!calls.some(c => c.startsWith('characters/')), 'never dereferences the spoofable selectedCharacter');
  assert.ok(calls.includes('public-sheet/attacker'), 'asks about the sender, by client id');
});

const playerSeat = (over = {}) => {
  const p = new PlayerSeat({
    file: null, driver, memory: { entries: () => [] },
    say: () => {}, whisper: () => {}, announce: () => {}, publishSheet: async () => {}, ...over,
  });
  p.state = { sheet: { name: 'Vessa Corrin 9a1' }, dossier: {}, leash: 'normal',
              timer: { filled: 0, segments: 4 }, held: false, pending: false, retired: false };
  return p;
};

test('P6: a nudge parses with the character name quoted, bare, or absent', () => {
  const p = playerSeat();
  assert.strictEqual(p.stripName('"Vessa Corrin 9a1" tight'), 'tight');
  assert.strictEqual(p.stripName('Vessa Corrin 9a1 tight'), 'tight');
  assert.strictEqual(p.stripName('tight'), 'tight', 'a bare argument is the whole nudge');
});

test('P6: !gm player leash without the character name still sets the leash', async () => {
  const said = [];
  const p = playerSeat({ whisper: (_id, text) => said.push(text) });
  await p.command('!gm player leash loose', { id: 'g', role: 'gm' }, ['g']);
  assert.strictEqual(p.state.leash, 'loose');
  assert.ok(said.some(t => /Leash: loose/.test(t)));
});

test('minor: an undeliverable dossier is audited, never dropped in silence', () => {
  const events = [];
  const whispered = [];
  const p = playerSeat({ audit: e => events.push(e), whisper: (_id, t) => whispered.push(t) });
  p.notifyGms([], 'DOSSIER · x', 'dossier-undelivered-no-gm');
  assert.deepStrictEqual(whispered, []);
  assert.deepStrictEqual(events, ['dossier-undelivered-no-gm']);

  p.notifyGms(['gm1', 'gm2'], 'DOSSIER · x', 'dossier-undelivered-no-gm');
  assert.strictEqual(whispered.length, 2, 'every supervising GM receives it');
});

test('P7: a state file with widened permissions is refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ sheet: { name: 'x' } }), { mode: 0o644 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => new PlayerSeat({ file, driver, memory: { entries: () => [] },
    say: () => {}, whisper: () => {}, announce: () => {}, publishSheet: async () => {} }),
    /private file permissions/);
});
