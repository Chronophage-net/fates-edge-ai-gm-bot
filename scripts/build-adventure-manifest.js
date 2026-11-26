#!/usr/bin/env node

/**
 * Build Adventure Manifest
 *
 * Writes data/adventures/manifest.json, keyed by adventure id (the stem of each
 * data/adventures/*.json file), mapping each adventure to the document(s) in
 * data/docs/adventures/ that adventure-context.js narrates from:
 *
 *   { "<id>": { "title", "docFile", "docPath", "docFiles"? } }
 *
 * docFiles appears only for a saga documented as its parts, in story order;
 * docFile is always the first of them.
 *
 * This mirrors write_bot_adventure_manifest() in fates-edge-docs'
 * tools/sync_data_to_consumers.py, which writes the same file on every sync, so
 * running this by hand produces the same manifest. Documents are matched to
 * adventures by title words, not by guessing ids from document filenames:
 * the old filename rule produced keys like "ashes_of_the_infernal_accord" for
 * the adventure "ashes_of_infernal_accord", and every such lookup failed.
 *
 * Usage: node scripts/build-adventure-manifest.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.cwd(), 'data', 'adventures');
const DOCS_DIR = path.resolve(process.cwd(), 'data', 'docs', 'adventures');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'in']);

function titleTokens(text) {
    const parts = String(text || '').replace(/[’']/g, '').toLowerCase().split(/[^a-z0-9]+/);
    return new Set(parts.filter(p => p && !STOPWORDS.has(p)));
}

function docTokens(file) {
    const stem = path.basename(file, '.html').replace(/^Fates\s*_?-_?\s*Edge\s*_?-_?\s*-?/, '');
    return titleTokens(stem);
}

const isSubset = (a, b) => [...a].every(x => b.has(x));

// Same scoring as the docs sync: exact match wins; otherwise one title must
// contain the other, with at least two words of signal.
function score(tt, dt) {
    if (!tt.size || !dt.size) return -1;
    const same = tt.size === dt.size && isSubset(tt, dt);
    if (same) return 100;
    if (!(isSubset(dt, tt) || isSubset(tt, dt))) return -1;
    if (Math.min(tt.size, dt.size) < 2) return -1;
    const inter = [...tt].filter(x => dt.has(x)).length;
    const sym = tt.size + dt.size - 2 * inter;
    return 10 * inter - sym;
}

// Every adventure is listed when this script is run on its own (or at
// LOG_LEVEL=debug); at bot startup a one-line summary is enough.
const VERBOSE = require.main === module || String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug';

function buildManifest() {
    if (VERBOSE) console.log('📚 Building adventure manifest...');
    if (!fs.existsSync(DATA_DIR) || !fs.existsSync(DOCS_DIR)) {
        console.warn(`⚠️ Missing ${!fs.existsSync(DATA_DIR) ? DATA_DIR : DOCS_DIR}`);
        return;
    }

    const docs = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.html'));
    const ids = fs.readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.json') && f !== 'manifest.json')
        .map(f => f.slice(0, -5))
        .sort();

    const manifest = {};
    for (const id of ids) {
        let adv = {};
        try { adv = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${id}.json`), 'utf-8')); } catch { /* keep id */ }
        const parts = (adv.sagaParts || []).map(p => titleTokens(String(p).replace(/[-_]/g, ' ')));
        const sets = [titleTokens(adv.title), ...parts].filter(s => s.size);

        let files;
        if (parts.length) {
            // A saga takes every document one of its titles matches, in part order.
            files = docs.filter(d => sets.some(t => score(t, docTokens(d)) > 0));
            const partIndex = d => {
                const dt = docTokens(d);
                let best = 0, bestOverlap = -1;
                parts.forEach((pt, i) => {
                    const o = [...pt].filter(x => dt.has(x)).length;
                    if (o > bestOverlap) { bestOverlap = o; best = i; }
                });
                return best;
            };
            files.sort((a, b) => partIndex(a) - partIndex(b));
        } else {
            let best = null, bestScore = 0;
            for (const t of sets) for (const d of docs) {
                const s = score(t, docTokens(d));
                if (s > bestScore) { best = d; bestScore = s; }
            }
            files = best ? [best] : [];
        }

        if (!files.length) {
            console.warn(`  ⚠️ ${id}: no document matches "${adv.title || id}"`);
            continue;
        }
        const entry = { title: adv.title || id, docFile: files[0], docPath: `/data/docs/adventures/${files[0]}` };
        if (files.length > 1) entry.docFiles = files;
        manifest[id] = entry;
        if (VERBOSE) console.log(`  ✅ ${id} → ${files.join(', ')}`);
    }

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(VERBOSE ? `✅ Manifest written to ${MANIFEST_PATH} (${Object.keys(manifest).length} entries)`
        : `📚 Adventure manifest: ${Object.keys(manifest).length} adventures`);
    return manifest;
}

// The bot requires this module and calls buildManifest() itself; it used to
// run on load and export nothing, so that call threw.
module.exports = { buildManifest };
if (require.main === module) buildManifest();
