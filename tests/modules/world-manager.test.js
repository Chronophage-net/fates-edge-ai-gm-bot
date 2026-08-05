const test = require('node:test');
const assert = require('node:assert');
const { WorldManager } = require('../../modules/world-manager.js');

// ============================================================
// getRegion() -- id normalization against a small fixture map
// ============================================================

test('getRegion() normalizes spaces to underscores and lowercases before lookup', () => {
  const world = new WorldManager();
  world.regions = {
    black_banners: { title: 'Black Banners — Condotta & Crowns' },
    the_wilds: { title: 'The Wilds' },
  };
  assert.strictEqual(world.getRegion('Black Banners'), world.regions.black_banners);
  assert.strictEqual(world.getRegion('black banners'), world.regions.black_banners);
  assert.strictEqual(world.getRegion('BLACK_BANNERS'), world.regions.black_banners);
  assert.strictEqual(world.getRegion('  the wilds  '), world.regions.the_wilds);
});

test('getRegion() returns null for an id that is not loaded', () => {
  const world = new WorldManager();
  world.regions = { acasia: { title: 'Acasia' } };
  assert.strictEqual(world.getRegion('midh_ahkaz'), null);
});

// Regression case from this codebase's cross-cutting bug pattern: a
// display name converted to a lookup key with HYPHENS instead of the
// underscores the actual data/regions/*.json filenames use.
test('getRegion() resolves real multi-word region names against real data/regions/*.json filename stems', async () => {
  const world = new WorldManager();
  await world.loadAll();
  const cases = ['Black Banners', 'The Wilds', 'Midh Ahkaz'];
  for (const name of cases) {
    const region = world.getRegion(name);
    assert.ok(region, `getRegion("${name}") should resolve to a loaded region`);
  }
});

// ============================================================
// listRegions() -- sort order
// ============================================================

test('listRegions() returns {id, title} pairs sorted by title', () => {
  const world = new WorldManager();
  world.regions = {
    zakov: { title: 'Zakov' },
    acasia: { title: 'Acasia' },
    mistlands: { title: 'Mistlands' },
  };
  const list = world.listRegions();
  assert.deepStrictEqual(list.map(r => r.id), ['acasia', 'mistlands', 'zakov']);
});

test('listRegions() falls back to label then id when title is missing', () => {
  const world = new WorldManager();
  world.regions = {
    foo: { label: 'Foo Label' },
    bar: {},
  };
  const list = world.listRegions();
  const byId = Object.fromEntries(list.map(r => [r.id, r.title]));
  assert.strictEqual(byId.foo, 'Foo Label');
  assert.strictEqual(byId.bar, 'bar');
});
