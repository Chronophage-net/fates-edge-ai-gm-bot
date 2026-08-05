/**
 * format-utils.js — small shared text-formatting helpers for chat output.
 */

/**
 * Lay out an array of short strings in a multi-column, `ls`-style grid:
 * fills DOWN each column before starting the next one (column-major,
 * matching the default behavior of the Unix `ls` command), sized to fit
 * within `width` monospace columns.
 *
 * Intentionally returns plain text only — no code-fence wrapping — so
 * callers can compose it with surrounding chat text and decide their own
 * fence/backtick styling. Discord (and most chat clients) only render
 * fixed-width alignment correctly inside a monospace/code block, so
 * callers should wrap the result in a ``` fence.
 *
 * @param {string[]} items - labels to lay out, already formatted (e.g. "3. Vhasia")
 * @param {object} [options]
 * @param {number} [options.width=56] - target line width in characters
 * @param {number} [options.maxCols=4] - hard cap on column count
 * @returns {string}
 */
function formatColumns(items, { width = 56, maxCols = 4 } = {}) {
    if (!items || items.length === 0) return '';

    const colWidth = Math.max(...items.map(s => s.length)) + 2; // 2-space gutter
    const numCols = Math.max(1, Math.min(items.length, maxCols, Math.floor(width / colWidth) || 1));
    const numRows = Math.ceil(items.length / numCols);

    const rows = [];
    for (let r = 0; r < numRows; r++) {
        const cells = [];
        for (let c = 0; c < numCols; c++) {
            const idx = c * numRows + r; // column-major, like `ls`
            if (idx < items.length) {
                const isLastCol = c === numCols - 1 || idx + numRows >= items.length;
                cells.push(isLastCol ? items[idx] : items[idx].padEnd(colWidth));
            }
        }
        rows.push(cells.join(''));
    }
    return rows.join('\n');
}

/**
 * Fate's Edge region (and similar) titles are "Name — Subtitle" (e.g.
 * "Black Banners — Condotta & Crowns"). The subtitle reads nicely in a
 * single detail view but makes a multi-column list collapse to one
 * column since every label is 30-60 characters wide. Strip it for
 * compact listing contexts; full titles remain available via a detail
 * lookup.
 *
 * @param {string} title
 * @returns {string}
 */
function shortTitle(title) {
    if (!title) return title;
    return title.split(/\s+—\s+/)[0];
}

module.exports = { formatColumns, shortTitle };
