const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// adventure-context.js looks up manifest[moduleId].docFile to find the text the
// GM narrates from. The docs sync once overwrote this file with a flat array of
// stems, which made every lookup undefined and left the AI GM without its
// adventure text, silently. These checks fail loudly if that comes back.

const DATA = path.resolve(__dirname, '..', '..', 'data');
const MANIFEST = path.join(DATA, 'adventures', 'manifest.json');

test('adventure manifest is keyed by adventure id, not a stem list', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest),
        'manifest.json must be an object keyed by adventure id');
});

test('every adventure has a manifest entry whose documents exist', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    const ids = fs.readdirSync(path.join(DATA, 'adventures'))
        .filter(f => f.endsWith('.json') && f !== 'manifest.json')
        .map(f => f.slice(0, -5));
    for (const id of ids) {
        const entry = manifest[id];
        assert.ok(entry, `no manifest entry for adventure "${id}"`);
        const files = entry.docFiles || [entry.docFile];
        assert.strictEqual(entry.docFile, files[0], `${id}: docFile must be the first of docFiles`);
        for (const f of files) {
            assert.ok(fs.existsSync(path.join(DATA, 'docs', 'adventures', f)), `${id}: missing document ${f}`);
        }
    }
    for (const key of Object.keys(manifest)) {
        assert.ok(ids.includes(key), `manifest key "${key}" has no adventure file`);
    }
});
