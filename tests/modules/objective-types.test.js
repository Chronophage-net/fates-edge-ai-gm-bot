const test = require('node:test');
const assert = require('node:assert');
const { normalizeType, getVocab, encounterType, isCustomType, DEFAULT_TYPE, VOCAB } = require('../../modules/objective-types.js');

test('DEFAULT_TYPE is combat', () => {
  assert.strictEqual(DEFAULT_TYPE, 'combat');
});

test('normalizeType - missing/undefined/null all default to combat (back-compat)', () => {
  assert.strictEqual(normalizeType(undefined), 'combat');
  assert.strictEqual(normalizeType(null), 'combat');
  assert.strictEqual(normalizeType(''), 'combat');
});

test('normalizeType - unrecognized string defaults to combat', () => {
  assert.strictEqual(normalizeType('not_a_real_type'), 'combat');
});

test('normalizeType - recognized types pass through unchanged', () => {
  for (const t of Object.keys(VOCAB)) {
    assert.strictEqual(normalizeType(t), t);
  }
});

test('encounterType - reads .type off an encounter object, defaulting to combat', () => {
  assert.strictEqual(encounterType({ name: 'Old Data', dv: 3 }), 'combat'); // no type field at all
  assert.strictEqual(encounterType({ name: 'A Lock', type: 'lockpick' }), 'lockpick');
  assert.strictEqual(encounterType(null), 'combat');
});

test('getVocab - combat uses Harm/Heal', () => {
  const v = getVocab('combat');
  assert.strictEqual(v.progress, 'Harm');
  assert.strictEqual(v.setback, 'Heal');
});

test('getVocab - lockpick uses Tumblers/Jam', () => {
  const v = getVocab('lockpick');
  assert.strictEqual(v.progress, 'Tumblers');
  assert.strictEqual(v.setback, 'Jam');
});

test('getVocab - heist uses Heat/Cover', () => {
  const v = getVocab('heist');
  assert.strictEqual(v.progress, 'Heat');
  assert.strictEqual(v.setback, 'Cover');
});

test('getVocab - social uses Leverage/Resistance', () => {
  const v = getVocab('social');
  assert.strictEqual(v.progress, 'Leverage');
  assert.strictEqual(v.setback, 'Resistance');
});

test('getVocab - obstruction and skill_challenge both use Progress/Setback', () => {
  assert.strictEqual(getVocab('obstruction').progress, 'Progress');
  assert.strictEqual(getVocab('skill_challenge').progress, 'Progress');
  assert.strictEqual(getVocab('obstruction').setback, 'Setback');
  assert.strictEqual(getVocab('skill_challenge').setback, 'Setback');
});

test('getVocab - trap_ward uses Disarm Progress/Trigger', () => {
  const v = getVocab('trap_ward');
  assert.strictEqual(v.progress, 'Disarm Progress');
  assert.strictEqual(v.setback, 'Trigger');
});

test('getVocab - unrecognized/missing type falls back to the combat vocab object', () => {
  assert.deepStrictEqual(getVocab('bogus'), getVocab('combat'));
  assert.deepStrictEqual(getVocab(undefined), getVocab('combat'));
});

test('isCustomType - true only for the custom/freeform entry', () => {
  assert.strictEqual(isCustomType('custom'), true);
  assert.strictEqual(isCustomType('combat'), false);
  assert.strictEqual(isCustomType(undefined), false);
});

test('getVocab - custom type with customLabel/customTickLabel on the source overlays the generic Timer/tick vocab', () => {
  const v = getVocab('custom', { customLabel: 'Ritual Completion', customTickLabel: 'chant' });
  assert.strictEqual(v.progress, 'Ritual Completion');
  assert.strictEqual(v.progressVerb, 'chant');
  assert.strictEqual(v.setback, 'Ritual Completion (Back)');
  assert.strictEqual(v.setbackVerb, 'chant');
});

test('getVocab - custom type with no source (or a source with no override) falls back to Timer/tick', () => {
  const bare = getVocab('custom');
  assert.strictEqual(bare.progress, 'Timer');
  assert.strictEqual(bare.progressVerb, 'tick');

  const blank = getVocab('custom', { customLabel: '', customTickLabel: '  ' });
  assert.strictEqual(blank.progress, 'Timer');
  assert.strictEqual(blank.progressVerb, 'tick');
});

test('getVocab - a non-custom type ignores customLabel/customTickLabel present on the source object', () => {
  const v = getVocab('combat', { customLabel: 'Ritual Completion', customTickLabel: 'chant' });
  assert.deepStrictEqual(v, getVocab('combat'));
  assert.strictEqual(v.progress, 'Harm');
  assert.strictEqual(v.setback, 'Heal');
});
