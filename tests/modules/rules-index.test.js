const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseSections, buildIndex, findSection } = require('../../modules/rules-index.js');

const rulesPath = path.join(__dirname, '..', '..', 'data', 'rules.txt');
const rulesText = fs.readFileSync(rulesPath, 'utf-8');

test('parseSections finds the expected section count against the real data/rules.txt', () => {
  const sections = parseSections(rulesText);
  // As of the file at time of writing, data/rules.txt has 15 top-level
  // sections. If this drifts, that's a signal the file's structure
  // changed -- worth investigating, not just bumping the number blindly.
  assert.strictEqual(sections.length, 15);
});

test('buildIndex output contains every section title and the LOOKUP RULE instruction text', () => {
  const sections = parseSections(rulesText);
  const index = buildIndex(rulesText);
  assert.match(index, /\[LOOKUP RULE "Section Title or keyword"\]/);
  for (const s of sections) {
    assert.ok(index.includes(s.title), `index should include section title "${s.title}"`);
  }
});

test('findSection("Outcome Matrix") matches the title exactly (substring match)', () => {
  const section = findSection(rulesText, 'Outcome Matrix');
  assert.ok(section);
  assert.strictEqual(section.title, 'II. OUTCOME MATRIX');
});

test('findSection("grapple") falls through to body-text match', () => {
  // "grapple" is not a section title -- it should be found via the
  // last-resort body-text fallback, landing on the scenario-handling
  // section that actually discusses grappling.
  const section = findSection(rulesText, 'grapple');
  assert.ok(section);
  assert.strictEqual(section.title, 'V. HANDLING DIFFERENT SCENARIO TYPES');
});

test('findSection("totally not a real rule") returns null', () => {
  const section = findSection(rulesText, 'totally not a real rule');
  assert.strictEqual(section, null);
});

test('parseSections returns [] for empty/falsy input', () => {
  assert.deepStrictEqual(parseSections(''), []);
  assert.deepStrictEqual(parseSections(undefined), []);
});

test('findSection returns null for empty query', () => {
  assert.strictEqual(findSection(rulesText, ''), null);
  assert.strictEqual(findSection(rulesText, undefined), null);
});
