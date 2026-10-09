'use strict';
// Never log malformed wire content: it may contain private room data.
function decodeFrames(raw, invalid = () => {}) {
    const messages = [];
    for (const line of raw.toString().split('\n').filter(line => line.trim())) {
        try {
            const message = JSON.parse(line);
            if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') throw new Error('Invalid message');
            messages.push(message);
        } catch { invalid(); }
    }
    return messages;
}
function roomSocketUrl(base, room) {
    const url = new URL(base);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('WS_URL must be a WebSocket URL without embedded credentials or fragment');
    url.searchParams.set('room', room);
    return url.toString();
}
module.exports = { decodeFrames, roomSocketUrl };
