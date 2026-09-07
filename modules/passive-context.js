'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseSections } = require('./rules-index');
const allowed = new Set(['rulesText', 'references', 'publicEntries', 'ownSheet']);
function buildPassiveContext(options = {}) {
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`Passive context does not accept ${key}`);
  const { rulesText = '', references = [], publicEntries = [], ownSheet } = options;
  return [
    ...parseSections(rulesText).map(s => ({ name: s.title, source: `Rules: ${s.title}`, text: s.body })),
    ...references.map(r => ({ name: r.name, source: r.source, text: r.text })),
    ...publicEntries.map(r => ({ name: r.source, source: r.source, text: r.text })),
    ...(ownSheet ? [{ name: ownSheet.name, source: 'Your character sheet', text: JSON.stringify(ownSheet) }] : [])
  ];
}
function loadReferences(root = path.join(__dirname, '..', 'data')) {
  const read = file => { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
  const refs = [];
  const add = (kind, name, obj, fields) => {
    if (!name) return;
    const clean = Object.fromEntries(fields.filter(f => obj[f] !== undefined).map(f => [f, obj[f]]));
    refs.push({ name, source: `${kind}: ${name}`, text: JSON.stringify(clean) });
  };
  for (const s of read('spells.json')?.spells || []) add('Spell', s.name, s, ['category', 'tags', 'dv', 'effect', 'notes']);
  for (const row of read('bestiary.json') || []) for (const [name, value] of Object.entries(row)) add('Bestiary', name, value, ['summary', 'resilience', 'clock', 'resolution', 'armor', 'tl', 'harm', 'fatigue']);
  for (const folder of ['talents', 'regions']) {
    let files = []; try { files = fs.readdirSync(path.join(root, folder)); } catch {}
    for (const file of files.filter(f => f.endsWith('.json') && !f.includes('manifest'))) {
      const value = read(`${folder}/${file}`); if (!value || Array.isArray(value)) continue;
      add(folder === 'talents' ? 'Talent' : 'Region', value.name || file.replace('.json', '').replaceAll('_', ' '), value,
        folder === 'talents' ? ['description', 'effect', 'cost', 'requirements', 'tier'] : ['description', 'culture', 'names', 'subgenre']);
    }
  }
  return refs;
}
module.exports = { buildPassiveContext, loadReferences };
