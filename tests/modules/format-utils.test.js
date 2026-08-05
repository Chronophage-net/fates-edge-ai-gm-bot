const test = require('node:test');
const assert = require('node:assert');
const { formatColumns, shortTitle } = require('../../modules/format-utils.js');

test('formatColumns - empty/undefined items returns empty string', () => {
  assert.strictEqual(formatColumns([]), '');
  assert.strictEqual(formatColumns(undefined), '');
});

test('formatColumns - column-major (ls-style) ordering across multiple columns', () => {
  // 6 short items, wide enough width/maxCols to allow multiple columns.
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const result = formatColumns(items, { width: 56, maxCols: 3 });
  const rows = result.split('\n');
  // 6 items / 3 cols -> 2 rows, column-major: col0=[a,b] col1=[c,d] col2=[e,f]
  assert.strictEqual(rows.length, 2);
  // Row 0 should read a, c, e in that column order; row 1: b, d, f
  const row0Items = rows[0].trim().split(/\s+/);
  const row1Items = rows[1].trim().split(/\s+/);
  assert.deepStrictEqual(row0Items, ['a', 'c', 'e']);
  assert.deepStrictEqual(row1Items, ['b', 'd', 'f']);
});

test('formatColumns - degrades to 1 column when items are wide relative to width', () => {
  const items = ['This is a very long label indeed', 'Another quite long label here', 'Yet another lengthy label'];
  const result = formatColumns(items, { width: 20, maxCols: 4 });
  const rows = result.split('\n');
  // With items wider than width, colWidth > width, so numCols should floor to 1 -> one item per row.
  assert.strictEqual(rows.length, items.length);
  rows.forEach((row, i) => {
    assert.strictEqual(row, items[i]);
  });
});

test('formatColumns - respects maxCols cap even when width would allow more', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const result = formatColumns(items, { width: 200, maxCols: 2 });
  const rows = result.split('\n');
  // 8 items / 2 cols -> 4 rows
  assert.strictEqual(rows.length, 4);
});

test('shortTitle - strips " — Subtitle" suffix', () => {
  assert.strictEqual(shortTitle('Black Banners — Condotta & Crowns'), 'Black Banners');
});

test('shortTitle - returns title unchanged when there is no em-dash subtitle', () => {
  assert.strictEqual(shortTitle('The Wilds'), 'The Wilds');
});

test('shortTitle - handles falsy input gracefully', () => {
  assert.strictEqual(shortTitle(''), '');
  assert.strictEqual(shortTitle(undefined), undefined);
  assert.strictEqual(shortTitle(null), null);
});
