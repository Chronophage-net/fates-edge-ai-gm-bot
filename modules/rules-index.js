// modules/rules-index.js
/**
 * Splits data/rules.txt into named sections and provides a compact
 * index + keyword lookup, so the AI GM doesn't need the entire file
 * re-sent in every system prompt (see ai-gm-bot.js's system-prompt
 * construction and commands.js's [LOOKUP RULE "..."] tag handling).
 *
 * This is plain in-memory keyword lookup against a small (~600-line)
 * structured file -- not retrieval-augmented generation. The file is
 * small enough to hold in memory in full; the point is only to avoid
 * re-sending all of it on every turn when a given turn only needs one
 * section (or none at all).
 *
 * rules.txt format (see the file itself):
 *   ================================================================================
 *   I. SECTION TITLE
 *   ================================================================================
 *   <body text until the next divider>
 */

const DIVIDER_RE = /^=+\s*$/;

/**
 * @param {string} rulesText
 * @returns {Array<{title: string, body: string}>}
 */
function parseSections(rulesText) {
    if (!rulesText) return [];
    const lines = rulesText.split(/\r?\n/);
    const sections = [];
    let i = 0;
    while (i < lines.length) {
        if (DIVIDER_RE.test(lines[i]) && lines[i + 1] && lines[i + 1].trim() && DIVIDER_RE.test(lines[i + 2] || '')) {
            const title = lines[i + 1].trim();
            let j = i + 3;
            const bodyLines = [];
            while (j < lines.length && !DIVIDER_RE.test(lines[j])) {
                bodyLines.push(lines[j]);
                j++;
            }
            sections.push({ title, body: bodyLines.join('\n').trim() });
            i = j;
        } else {
            i++;
        }
    }
    return sections;
}

/**
 * A compact index for the system prompt: just the section titles, plus
 * instructions for how to request one in full.
 */
function buildIndex(rulesText) {
    const sections = parseSections(rulesText);
    if (sections.length === 0) {
        // Fallback: no parseable sections (unexpected format) -- better to
        // send the raw text than silently drop all rules guidance.
        return rulesText || '';
    }
    const lines = [
        "FATE'S EDGE RULES -- SECTION INDEX",
        'The full rules are organized into these sections. You already know the core loop ' +
        '(Position/DV/roll/Outcome Matrix) from your instructions below. When a scene needs the FULL ' +
        'text of a specific rule (e.g. exact Grapple mechanics, Ward costs, Downtime procedures), ' +
        'request it with `[LOOKUP RULE "Section Title or keyword"]` and its text will be inserted in place of the tag.',
        '',
        ...sections.map(s => `- ${s.title}`)
    ];
    return lines.join('\n');
}

/**
 * Finds the best-matching section for a free-text query (case-insensitive
 * substring match against the title, falling back to a body match).
 * @returns {{title: string, body: string} | null}
 */
function findSection(rulesText, query) {
    if (!query) return null;
    const sections = parseSections(rulesText);
    const q = query.trim().toLowerCase();
    if (!q) return null;

    // Exact or substring title match first.
    let hit = sections.find(s => s.title.toLowerCase() === q);
    if (!hit) hit = sections.find(s => s.title.toLowerCase().includes(q));
    if (!hit) hit = sections.find(s => q.includes(s.title.toLowerCase()));
    // Last resort: query text appears somewhere in the section body.
    if (!hit) hit = sections.find(s => s.body.toLowerCase().includes(q));

    return hit || null;
}

module.exports = { parseSections, buildIndex, findSection };
