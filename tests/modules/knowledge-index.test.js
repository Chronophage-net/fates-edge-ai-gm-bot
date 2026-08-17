const test = require('node:test');
const assert = require('node:assert');
const ki = require('../../modules/knowledge-index.js');

// Minimal in-memory fake of the @elastic/elasticsearch client surface
// this module actually uses, so these tests never need a real
// Elasticsearch cluster. Mirrors just enough of the real client's
// request/response shapes (indices.exists/create, index, search) to
// exercise knowledge-index.js's own logic.
function makeFakeClient() {
    const indices = new Map(); // indexName -> Map(id -> document)
    return {
        _indices: indices,
        indices: {
            exists: async ({ index }) => indices.has(index),
            create: async ({ index }) => { indices.set(index, new Map()); }
        },
        index: async ({ index, id, document }) => {
            indices.get(index).set(id, document);
        },
        get: async ({ index, id }) => {
            const doc = indices.get(index)?.get(id);
            if (!doc) {
                const err = new Error('Not Found');
                err.meta = { statusCode: 404 };
                throw err;
            }
            return { _source: doc };
        },
        search: async ({ index, query, size }) => {
            const docs = [...indices.get(index).values()];
            const q = query.bool.must[0].multi_match.query.toLowerCase();
            const types = query.bool.filter[0]?.terms?.type;
            let matches = docs.filter(d => d.text.toLowerCase().includes(q.toLowerCase()));
            if (types) matches = matches.filter(d => types.includes(d.type));
            return { hits: { hits: matches.slice(0, size).map((d, i) => ({ _score: 1 - i * 0.01, _source: d })) } };
        }
    };
}

test('isEnabled() is false with no client configured (default, no ES_URL)', () => {
    ki.configure({ client: null, enabled: false });
    assert.strictEqual(ki.isEnabled(), false);
});

test('search()/indexFact()/indexNpc()/indexSummary() are silent no-ops when disabled', async () => {
    ki.configure({ client: null, enabled: false });
    const result = await ki.search('ROOM1', 'anything');
    assert.deepStrictEqual(result, []);
    // Should resolve without throwing even though there's no real client.
    await ki.indexFact('ROOM1', 'k', 'v');
    await ki.indexNpc('ROOM1', { name: 'Nobody' });
    await ki.indexSummary('ROOM1', 'A summary.');
});

test('indexFact() + search() round-trips through a fake client', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexFact('ROOM1', 'well_cursed', 'The well in Thornwood is cursed.');
    const hits = await ki.search('ROOM1', 'Thornwood');

    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].type, 'fact');
    assert.strictEqual(hits[0].key, 'well_cursed');
});

test('indexNpc() builds searchable text from name/role/motivation/location/faction', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexNpc('ROOM1', {
        name: 'Kestrel', role: 'Informant', motivation: 'Wants out of debt',
        location: 'Thornwood docks', faction: 'ally'
    });
    const hits = await ki.search('ROOM1', 'Kestrel');

    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].type, 'npc');
    assert.strictEqual(hits[0].name, 'Kestrel');
    assert.match(hits[0].text, /Thornwood docks/);
});

test('indexSummary() creates a new doc per call rather than overwriting', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexSummary('ROOM1', 'First summary mentions the Salt Road.');
    await new Promise(r => setTimeout(r, 2)); // ensure distinct Date.now()-based ids
    await ki.indexSummary('ROOM1', 'Second summary also mentions the Salt Road.');

    const hits = await ki.search('ROOM1', 'Salt Road', { size: 10 });
    assert.strictEqual(hits.length, 2);
});

test('indexNpc() with no location is indexed fine, and search still finds it by name/role', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexNpc('ROOM1', { name: 'Wanderer', role: 'Vagabond', motivation: 'Seeks a lost sibling' });
    const hits = await ki.search('ROOM1', 'Wanderer');

    assert.strictEqual(hits.length, 1);
    assert.doesNotMatch(hits[0].text, /Located at/);
});

test('updateNpcLocation() merges a location into an existing NPC without losing role/motivation', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexNpc('ROOM1', { name: 'Kestrel', role: 'Informant', motivation: 'Wants out of debt' });
    await ki.updateNpcLocation('ROOM1', 'Kestrel', 'Thornwood docks');

    const hits = await ki.search('ROOM1', 'Kestrel');
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0].text, /Informant/);
    assert.match(hits[0].text, /Wants out of debt/);
    assert.match(hits[0].text, /Thornwood docks/);
});

test('updateNpcLocation() upserts from scratch for an NPC never indexed before', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.updateNpcLocation('ROOM1', 'Unindexed Guard', 'The east gate');
    const hits = await ki.search('ROOM1', 'Unindexed Guard');

    assert.strictEqual(hits.length, 1);
    assert.match(hits[0].text, /east gate/);
});

test('updateNpcLocation() with a falsy location clears a previously set one', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexNpc('ROOM1', { name: 'Drifter', role: 'Trader', location: 'The old mill' });
    await ki.updateNpcLocation('ROOM1', 'Drifter', null);

    const hits = await ki.search('ROOM1', 'Drifter');
    assert.strictEqual(hits.length, 1);
    assert.doesNotMatch(hits[0].text, /Located at/);
    assert.doesNotMatch(hits[0].text, /old mill/);
});

test('updateNpcLocation() is a no-op when disabled', async () => {
    ki.configure({ client: null, enabled: false });
    await ki.updateNpcLocation('ROOM1', 'Anyone', 'Anywhere'); // should resolve, not throw
});

test('search() respects the types filter', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });

    await ki.indexFact('ROOM1', 'road_status', 'The Salt Road is currently blocked.');
    await ki.indexNpc('ROOM1', { name: 'Salt Road Warden', role: 'Guard' });

    const factsOnly = await ki.search('ROOM1', 'Salt Road', { types: ['fact'] });
    assert.strictEqual(factsOnly.length, 1);
    assert.strictEqual(factsOnly[0].type, 'fact');
});

test('search() with an empty query returns [] without hitting the client', async () => {
    const client = makeFakeClient();
    ki.configure({ client, enabled: true });
    assert.deepStrictEqual(await ki.search('ROOM1', ''), []);
    assert.deepStrictEqual(await ki.search('ROOM1', '   '), []);
});

test('indexNameFor() namespaces by campaign code and sanitizes it', () => {
    // FIX: this test previously asserted 'gm-knowledge-AC12' (uppercase
    // preserved), which was simply wrong -- Elasticsearch index names
    // MUST be lowercase (the ES API itself rejects uppercase index
    // names), so indexNameFor()'s String(...).toLowerCase() is required
    // behavior, not a bug. The test was failing CI on every run; the
    // code was correct all along.
    assert.strictEqual(ki.indexNameFor('AC12'), 'gm-knowledge-ac12');
    assert.strictEqual(ki.indexNameFor(null), 'gm-knowledge-default');
});

test('a client error during search() is swallowed and returns []', async () => {
    const client = {
        indices: { exists: async () => true, create: async () => {} },
        search: async () => { throw new Error('cluster unreachable'); }
    };
    ki.configure({ client, enabled: true });
    const hits = await ki.search('ROOM1', 'anything');
    assert.deepStrictEqual(hits, []);
});

test.after(() => {
    // Leave the module in its real, unconfigured (no ES_URL) state so
    // it doesn't leak a fake client into any other test file's process
    // (node --test runs each file in its own process, but this is
    // cheap insurance either way).
    ki.configure({ client: null, enabled: false });
});
