// modules/commands/tag-repair.js
// Extracted from the original monolithic modules/commands.js.
// Fuzzy repair pass for AI-emitted [TAG ...] syntax drift, run before
// the strict per-tag regexes in process-tags.js get a chance to match.

const AI_TAG_KEYWORDS = [
    'ENCOUNTER START', 'ENCOUNTER RESOLVE', 'SCENE COMPLETE',
    'CALL FOR ROLL',
    'LOOKUP RULE', 'SET POSITION', 'SET DV', 'TICK TIMER',
    'NPC CAST', 'NPC CREATE', 'NPC LOCATION',
    'TOKEN MOVE', 'TOKEN REMOVE', 'SPEND SB',
    'APPLY', 'ADD', 'ROLL', 'TIMER', 'DRAW', 'CROWN', 'FACT', 'EFFECT',
    'REVEAL', 'HIDE',
].sort((a, b) => b.length - a.length);

// 1) Case repair: force the leading keyword of any recognized tag to
// its canonical uppercase form, wherever it appears with the wrong
// case or irregular internal whitespace ("tick   timer" -> "TICK
// TIMER"). Everything after the keyword (quoted names/args) keeps its
// original case -- only the command word itself is normalized. Most of
// the regexes below already carry an 'i' flag so this is partly a
// defensive no-op against today's code, but it keeps tags working
// correctly against any tag processor that isn't (or stops being)
// case-insensitive, and directly covers the "[Roll]" style drift.
function normalizeAITagCase(text) {
    let out = text;
    for (const kw of AI_TAG_KEYWORDS) {
        const pattern = new RegExp('\\[\\s*' + kw.split(' ').join('\\s+') + '\\b', 'gi');
        out = out.replace(pattern, '[' + kw);
    }
    return out;
}

// 2) Roll pool spacing repair: the pool expression in [ROLL "Name"
// <pool> DV <n> <position>] must be contiguous letters/plus signs
// (`[A-Za-z\+]+`) for rollRegex to match -- "Wits + Stealth" (spaces
// around the +, which is how a human -- and apparently the model --
// naturally writes an attribute+skill pool) fails to match at all.
// Squeeze whitespace out of just the `+` joins in that segment.
function tightenRollPoolSpacing(text) {
    // Covers both [ROLL "Name" ...] and [CALL FOR ROLL "Name" ...] --
    // same pool-expression shape, same spacing drift from the model.
    return text.replace(
        /(\[(?:CALL FOR ROLL|ROLL)\s+"[^"]*"\s+)([^\]]*?)(\s+DV\s+\d+)/gi,
        (full, prefix, pool, suffix) => prefix + pool.replace(/\s*\+\s*/g, '+').trim() + suffix
    );
}

// 3) Unterminated tag repair: if a recognized tag never got a closing
// "]" (cut off, or the model moved on to the next tag/sentence without
// finishing it), every regex below fails to match it and the tag leaks
// into chat as literal, unresolved bracket text. For each occurrence of
// a known "[KEYWORD" that isn't already properly closed before the next
// "[" or end of string, close it: append a closing '"' first if it has
// an odd number of quote characters (an unterminated quoted argument),
// then append "]".
function closeUnterminatedAITags(text) {
    let out = text;
    for (const kw of AI_TAG_KEYWORDS) {
        const opener = '[' + kw;
        let searchFrom = 0;
        while (true) {
            const start = out.indexOf(opener, searchFrom);
            if (start === -1) break;
            const nextClose = out.indexOf(']', start);
            const nextOpen = out.indexOf('[', start + 1);
            if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
                // Already properly closed before anything else starts --
                // nothing to repair. Keep scanning after it.
                searchFrom = nextClose + 1;
                continue;
            }
            const boundary = nextOpen !== -1 ? nextOpen : out.length;
            const span = out.slice(start, boundary).replace(/\s+$/, '');
            const quoteCount = (span.match(/"/g) || []).length;
            const fixedSpan = span + (quoteCount % 2 === 1 ? '"' : '') + ']';
            out = out.slice(0, start) + fixedSpan + out.slice(boundary);
            searchFrom = start + fixedSpan.length;
        }
    }
    return out;
}

// 0) Bare (unquoted) name repair: the model sometimes drops the required
// quotes around a roll tag's name entirely -- e.g. emits
// "[CALL FOR ROLL Asadef Wits+Stealth DV 3 Controlled]" instead of
// '[CALL FOR ROLL "Asadef" Wits+Stealth DV 3 Controlled]'. Every regex
// downstream of this (rollRegex, callForRollRegex, and even
// tightenRollPoolSpacing above) requires the name to already be quoted,
// so without this repair the whole tag leaks into chat as literal
// unresolved bracket text -- exactly what a first-time user saw running
// the demo against a small local model. Only fires when a pool
// expression containing "+" (Attribute+Skill) is found before "DV" --
// that's the one part of this syntax reliable enough to anchor on
// without risking mis-slicing a legitimate multi-word name.
function quoteBareRollName(text) {
    return text.replace(
        /\[(CALL FOR ROLL|ROLL)\s+(?!")([A-Za-z][A-Za-z '-]*?)\s+([A-Za-z]+\+[A-Za-z]+)(\s+DV\s+\d+)/gi,
        (full, kw, name, pool, suffix) => `[${kw} "${name.trim()}" ${pool}${suffix}`
    );
}

function repairAITagSyntax(text) {
    if (!text || typeof text !== 'string') return text;
    let repaired = normalizeAITagCase(text);
    repaired = quoteBareRollName(repaired);
    repaired = tightenRollPoolSpacing(repaired);
    repaired = closeUnterminatedAITags(repaired);
    return repaired;
}

// ─── Special tag processing ────────────────────────────────────────

module.exports = {
    AI_TAG_KEYWORDS,
    normalizeAITagCase,
    tightenRollPoolSpacing,
    closeUnterminatedAITags,
    quoteBareRollName,
    repairAITagSyntax,
};
