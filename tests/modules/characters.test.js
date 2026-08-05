const test = require('node:test');
const assert = require('node:assert');
const characters = require('../../modules/characters.js');

// Module-level in-memory store persists across tests in this file (and
// process) -- reset it before each test so tests don't leak state into
// each other.
test.beforeEach(() => {
  characters.loadCharacters({});
});

test('get() creates a default character with the documented shape', () => {
  const char = characters.get('Levi');
  assert.strictEqual(char.name, 'Levi');
  assert.deepStrictEqual(char.attributes, { Body: 2, Wits: 2, Spirit: 2, Presence: 2 });
  assert.strictEqual(char.harm, 0);
  assert.strictEqual(char.fatigue, 0);
  assert.strictEqual(char.boons, 0);
  assert.strictEqual(char.obligation, 0);
  assert.strictEqual(char.corruption, 0);
  assert.strictEqual(char.leash, 0);
  for (const skill of characters.SKILL_NAMES) {
    assert.strictEqual(char.skills[skill], 0);
  }
});

test('get() is idempotent - repeated calls for the same name (any case) return the same object', () => {
  const a = characters.get('Levi');
  a.harm = 3;
  const b = characters.get('levi'); // case-insensitive
  assert.strictEqual(b.harm, 3);
  assert.strictEqual(a, b);
});

test('exists()/remove() reflect the in-memory store correctly', () => {
  assert.strictEqual(characters.exists('Levi'), false);
  characters.get('Levi');
  assert.strictEqual(characters.exists('Levi'), true);
  assert.strictEqual(characters.exists('LEVI'), true); // case-insensitive
  assert.strictEqual(characters.remove('Levi'), true);
  assert.strictEqual(characters.exists('Levi'), false);
  assert.strictEqual(characters.remove('Levi'), false); // already gone
});

// ============================================================
// getPool() -- case-insensitive attribute/skill resolution
// ============================================================

test('getPool() resolves canonical "Attribute+Skill" casing', () => {
  const char = characters.get('Levi');
  char.attributes.Body = 4;
  char.skills.Melee = 3;
  assert.strictEqual(characters.getPool('Levi', 'Body+Melee'), 7);
});

test('getPool() resolves lowercase / mixed-case attribute and skill names', () => {
  const char = characters.get('Levi');
  char.attributes.Body = 4;
  char.skills.Melee = 3;
  assert.strictEqual(characters.getPool('Levi', 'body+melee'), 7);
  assert.strictEqual(characters.getPool('Levi', 'BODY+MELEE'), 7);
});

test('getPool() handles whitespace around the "+"', () => {
  const char = characters.get('Levi');
  char.attributes.Body = 4;
  char.skills.Melee = 3;
  assert.strictEqual(characters.getPool('Levi', 'Body + Melee'), 7);
});

test('getPool() returns 0 for a malformed expression (not exactly two parts)', () => {
  characters.get('Levi');
  assert.strictEqual(characters.getPool('Levi', 'Body'), 0);
  assert.strictEqual(characters.getPool('Levi', 'Body+Melee+Extra'), 0);
});

// ============================================================
// applyDelta() -- clamping at HARM_MAX / BOONS_MAX, fatigue overflow
// ============================================================

test('applyDelta harm clamps at HARM_MAX and floors at 0', () => {
  const char = characters.get('Levi');
  characters.applyDelta('Levi', 'harm', 100);
  assert.strictEqual(char.harm, characters.HARM_MAX);
  characters.applyDelta('Levi', 'harm', -1000);
  assert.strictEqual(char.harm, 0);
});

test('applyDelta boons clamps at BOONS_MAX and floors at 0', () => {
  const char = characters.get('Levi');
  characters.applyDelta('Levi', 'boons', 100);
  assert.strictEqual(char.boons, characters.BOONS_MAX);
  characters.applyDelta('Levi', 'boons', -1000);
  assert.strictEqual(char.boons, 0);
});

test('applyDelta fatigue overflows into harm once fatigue reaches Body attribute value', () => {
  const char = characters.get('Levi');
  char.attributes.Body = 3;
  // Adding 5 fatigue with Body=3: fatigue=5 >= 3 -> fatigue -= 3 (2), harm += 1.
  characters.applyDelta('Levi', 'fatigue', 5);
  assert.strictEqual(char.fatigue, 2);
  assert.strictEqual(char.harm, 1);
});

test('applyDelta ignores non-finite deltas', () => {
  const char = characters.get('Levi');
  const before = char.harm;
  characters.applyDelta('Levi', 'harm', NaN);
  assert.strictEqual(char.harm, before);
});

test('applyDelta obligation overflows into fatigue once past Spirit+Presence capacity', () => {
  const char = characters.get('Levi');
  char.attributes.Spirit = 2;
  char.attributes.Presence = 2; // capacity = 4
  char.attributes.Body = 10; // avoid a second fatigue->harm overflow muddying the assertion
  characters.applyDelta('Levi', 'obligation', 6); // 6 > capacity(4) -> overflow 2 into fatigue
  assert.strictEqual(char.obligation, 4);
  assert.strictEqual(char.fatigue, 2);
});
