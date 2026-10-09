'use strict';
const { timingSafeEqual, randomBytes } = require('node:crypto');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// Local dashboards still need Host validation (DNS rebinding) and mutation
// protection (cross-site forms). Remote binding additionally requires a password.
function dashboardGuard({ host = '127.0.0.1', token = '', frame = false } = {}) {
    const local = LOOPBACK.has(host);
    if (!local && token.length < 32) throw new Error('Remote dashboards require a dashboard token of at least 32 characters');
    return (req, res) => {
        const nonce = randomBytes(18).toString('base64');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; frame-ancestors ${frame ? "'self' http://127.0.0.1:* http://localhost:*" : "'none'"}; base-uri 'none'; form-action 'self'`);
        const reject = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); return null; };
        let url;
        try { url = new URL(`http://${req.headers.host}`); } catch { return reject(400, 'Invalid host'); }
        if (url.username || url.password || (local && !LOOPBACK.has(url.hostname))) return reject(403, 'Host rejected');
        if (token) {
            const header = req.headers.authorization || '';
            const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '';
            const supplied = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
            const expected = Buffer.from(token);
            if (!decoded.includes(':') || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                res.setHeader('WWW-Authenticate', 'Basic realm="Fates Edge dashboard", charset="UTF-8"');
                return reject(401, 'Dashboard sign-in required');
            }
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
            if (req.headers['x-dashboard-request'] !== '1') return reject(403, 'Dashboard request required');
            if (req.headers.origin) {
                let origin;
                try { origin = new URL(req.headers.origin); } catch { return reject(403, 'Origin rejected'); }
                if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== url.host) return reject(403, 'Origin rejected');
            }
        }
        return nonce;
    };
}
module.exports = { dashboardGuard };
