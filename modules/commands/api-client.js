// modules/commands/api-client.js
// Extracted from the original monolithic modules/commands.js.
// Small HTTP helpers used to reach the global (outside-room) API.

function getApiBaseUrl(wsUrl) {
    if (!wsUrl) return 'http://localhost:10000/api';
    const url = new URL(wsUrl);
    url.protocol = url.protocol.replace('ws', 'http');
    url.pathname = '/api';
    return url.toString().replace(/\/$/, '');
}

// ─── HTTP request helper (global API, outside room context) ──────
function globalApiRequest(path, method = 'GET', body = null) {
    const wsUrl = process.env.WS_URL || 'ws://localhost:10000';
    const apiBase = getApiBaseUrl(wsUrl);
    const fullUrl = apiBase + (path.startsWith('/') ? '' : '/') + path;
    const apiKey = process.env.API_KEY || '';

    return fetch(fullUrl, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
        // CHANGED: same fix as apiRequest() in index.js -- read as text
        // first so a non-JSON response (HTML fallback page from a route
        // that doesn't exist, proxy error page, etc.) reports what
        // actually went wrong instead of a bare JSON.parse crash.
        const raw = await res.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (e) {
            const snippet = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
            throw new Error(
                `API returned non-JSON response (HTTP ${res.status} ${res.statusText}) ` +
                `for ${method} ${fullUrl} -- likely a route that doesn't exist server-side. ` +
                `Body starts with: "${snippet}"`
            );
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    });
}

// ─── Whiteboard grid-combat token sync ────────────────────────────
// NEW: lets the AI GM actually WRITE to the whiteboard (previously
// `!gm whiteboard`/`!gm grid` could only read a summary). Tokens are
// addressed by a stable slug derived from the character/NPC name, so
// repeated tag calls for the same name update the same token instead of
// creating duplicates. Positions are grid CELLS (col/row), not pixels --
// the server converts using the room's cellSize, since the bot has no
// canvas of its own to reason about.

module.exports = { getApiBaseUrl, globalApiRequest };
