'use strict';
const { createHash } = require('node:crypto');
const isPublic = m => !!m && !m.whisper && !m.recipient && !m.privateOnly && typeof m.text === 'string' && !/^!gm\b/i.test(m.text);
// This corpus has no API that accepts GM facts, NPCs, dossiers or full adventure state.
class PublicMemory {
  constructor({ retentionDays = 30, maxMessages = 2000, now = Date.now } = {}) {
    this.retentionMs = Math.max(1, retentionDays) * 86400000; this.maxMessages = maxMessages; this.now = now;
    this.chat = new Map(); this.knowledge = new Map();
  }
  prune() { for (const [id, m] of this.chat) if (m.at < this.now() - this.retentionMs) this.chat.delete(id); }
  add(message) {
    if (!isPublic(message)) return false;
    this.prune();
    const at = Number(message.timestamp) || this.now();
    if (at < this.now() - this.retentionMs) return false;
    const id = message.id || createHash('sha256').update(JSON.stringify([at, message.sender, message.text])).digest('hex');
    this.chat.set(id, { id, at, source: 'Public table chat', text: `${message.sender || 'Player'}: ${message.text.slice(0, 6000)}` });
    while (this.chat.size > this.maxMessages) this.chat.delete(this.chat.keys().next().value);
    return true;
  }
  reveal(entry) {
    if (!entry?.id) return;
    if (entry.revealed !== true) { this.knowledge.delete(entry.id); return; }
    this.knowledge.set(entry.id, { id: entry.id, source: 'Your GM has established', text: String(entry.truth || entry.text || entry.description || '').slice(0, 6000) });
  }
  replaceRevealed(entries) { this.knowledge.clear(); for (const entry of entries || []) this.reveal(entry); }
  entries({ since = 0, chatOnly = false } = {}) {
    this.prune(); return [...(chatOnly ? [] : this.knowledge.values()), ...[...this.chat.values()].filter(m => m.at >= since)];
  }
  forget(query) {
    const q = query.trim().toLowerCase(); if (!q) return 0;
    let count = 0; for (const [id, m] of this.chat) if (m.text.toLowerCase().includes(q)) { this.chat.delete(id); count++; } return count;
  }
}
module.exports = { PublicMemory, isPublic };
