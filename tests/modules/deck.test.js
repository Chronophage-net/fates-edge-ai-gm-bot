const test = require('node:test');
const assert = require('node:assert');
const deck = require('../../modules/deck.js');

// ============================================================
// transformRegionData() -- not exported directly, so exercised
// indirectly via loadRegionData() against the real generator-schema
// region fixtures in data/regions/ (same shape TEST_TODO.md describes:
// overview/places/people_and_factions/complications/rewards).
// ============================================================

test('loadRegionData transforms generator-schema region JSON into the flat {spades,hearts,clubs,diamonds} shape', async () => {
  const region = await deck.loadRegionData('acasia');
  assert.ok(region, 'acasia region should load');
  assert.strictEqual(typeof region.spades, 'object');
  assert.strictEqual(typeof region.hearts, 'object');
  assert.strictEqual(typeof region.clubs, 'object');
  assert.strictEqual(typeof region.diamonds, 'object');
  assert.ok(!Array.isArray(region.spades), 'spades should be a rank->text map, not an array');
  // Every value under each suit should be keyed by a card rank and hold a string.
  for (const suit of ['spades', 'hearts', 'clubs', 'diamonds']) {
    const ranks = Object.keys(region[suit]);
    assert.ok(ranks.length > 0, `region.${suit} should have at least one rank entry`);
    for (const rank of ranks) {
      assert.strictEqual(typeof region[suit][rank], 'string');
    }
  }
});

test('loadRegionData returns null for an unknown region id', async () => {
  const region = await deck.loadRegionData('not_a_real_region_xyz');
  assert.strictEqual(region, null);
});

// ============================================================
// getCardMeaningFromRegion()
// ============================================================

test('getCardMeaningFromRegion - returns fallback text when regionData is missing', () => {
  const meaning = deck.getCardMeaningFromRegion('Spades', 'K', null);
  assert.strictEqual(meaning, 'A complication of Spades arises.');
});

test('getCardMeaningFromRegion - returns fallback text when rank is missing from region data', () => {
  const regionData = { spades: { '2': 'Some place.' } };
  const meaning = deck.getCardMeaningFromRegion('Spades', 'K', regionData);
  assert.strictEqual(meaning, 'A complication of Spades arises.');
});

test('getCardMeaningFromRegion - returns real text for a known rank', async () => {
  const region = await deck.loadRegionData('acasia');
  const rank = Object.keys(region.spades)[0];
  const meaning = deck.getCardMeaningFromRegion('Spades', rank, region);
  assert.strictEqual(meaning, region.spades[rank]);
});

// ============================================================
// getAceEffect()
// ============================================================

test('getAceEffect - region-specific effect when regionId matches ACE_EFFECTS exactly', () => {
  const effect = deck.getAceEffect('acasia', { rank: 'A' }, null);
  assert.ok(effect);
  assert.ok(deck.ACE_EFFECTS.acasia.some(e => e.text === effect.text));
});

test('getAceEffect - generic fallback when regionId has no match at all', () => {
  const effect = deck.getAceEffect('totally_unknown_region', { rank: 'A' }, null);
  assert.ok(effect);
  assert.ok(deck.ACE_EFFECTS.generic.some(e => e.text === effect.text));
});

test('getAceEffect - partial region-key match via regionKey.includes(key)', () => {
  // "acasia_something_else" includes "acasia" as a substring, so it
  // should match the acasia-specific effects rather than falling all
  // the way back to generic.
  const effect = deck.getAceEffect('acasia_something_else', { rank: 'A' }, null);
  assert.ok(effect);
  assert.ok(deck.ACE_EFFECTS.acasia.some(e => e.text === effect.text));
});

test('getAceEffect - regionData.ace_effects (from region JSON) takes priority over hardcoded ACE_EFFECTS', () => {
  const regionData = { ace_effects: [{ emoji: '🎯', text: 'Custom region-specific ace effect.' }] };
  const effect = deck.getAceEffect('acasia', { rank: 'A' }, regionData);
  assert.strictEqual(effect.text, 'Custom region-specific ace effect.');
  assert.strictEqual(effect.emoji, '🎯');
});
