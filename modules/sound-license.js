/**
 * Freesound CC license classification -- shared by gm-commands.js's
 * `!gm soundsearch` (chat lookup) and adventure-context.js's
 * SOUNDSCAPE_AUTO_SEARCH fallback (automatic mood -> sound search), so the
 * two don't drift with their own copies. Mirrors the web client's
 * classifyLicense() (js/features/gm-tools/sound-search.js) -- matched by
 * CC license URL path segment, fails CLOSED (an unrecognized license reads
 * as restricted, never "safe") rather than defaulting to permissive.
 */

function classifySoundLicense(licenseUrl) {
    const url = String(licenseUrl || '').toLowerCase();
    if (url.includes('/publicdomain/zero') || url.includes('/publicdomain/')) {
        return { label: 'CC0 (Public Domain)', commercial: true, attribution: false };
    }
    if (url.includes('/by-nc-sa/')) return { label: 'CC BY-NC-SA (non-commercial, attribution)', commercial: false, attribution: true };
    if (url.includes('/by-nc/')) return { label: 'CC BY-NC (non-commercial, attribution)', commercial: false, attribution: true };
    if (url.includes('/by-sa/')) return { label: 'CC BY-SA (attribution)', commercial: true, attribution: true };
    if (url.includes('/by/')) return { label: 'CC BY (attribution)', commercial: true, attribution: true };
    if (url.includes('sampling+')) return { label: 'Sampling+ (attribution)', commercial: true, attribution: true };
    return { label: 'Unknown license (treat as restricted)', commercial: false, attribution: true };
}

/** Convenience for chat output -- just the label string. */
function soundLicenseLabel(licenseUrl) {
    return classifySoundLicense(licenseUrl).label;
}

module.exports = { classifySoundLicense, soundLicenseLabel };
