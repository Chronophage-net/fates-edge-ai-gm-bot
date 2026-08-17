// modules/commands/tokens.js
// Extracted from the original monolithic modules/commands.js.
// Whiteboard grid-combat token helpers (place/move/remove/clear) plus
// the small encounter-icon lookup used in chat replies.

const { DEFAULT_TYPE } = require('../objective-types');

const ENCOUNTER_ICON = {
    combat: '⚔️',
    obstruction: '🚧',
    skill_challenge: '🎯',
    trap_ward: '🪤',
    lockpick: '🔓',
    heist: '🕵️',
    social: '🤝',
};
function encounterIcon(type) {
    return ENCOUNTER_ICON[type] || ENCOUNTER_ICON[DEFAULT_TYPE];
}

function slugifyTokenId(name) {
    return 'npc-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Simple round-robin slot picker so tokens the AI places without an
// explicit position don't all stack on the same cell. Not persisted
// across process restarts -- purely a "spread them out a bit" default;
// the AI (or a human) can always reposition via [TOKEN MOVE ...] / drag.
let _autoTokenSlot = 0;
function nextAutoTokenCell() {
    const col = 2 + (_autoTokenSlot % 6);
    const row = 1 + Math.floor(_autoTokenSlot / 6);
    _autoTokenSlot++;
    return { col, row };
}

function inferFaction(role, motivation) {
    const text = `${role || ''} ${motivation || ''}`.toLowerCase();
    if (/\b(ally|allied|companion|friend|guide|helper|patron|mentor)\b/.test(text)) return 'ally';
    return 'enemy';
}

async function placeOrUpdateToken(context, { name, faction, col, row, vision, body }) {
    if (!context.apiRequest) return null;
    const id = slugifyTokenId(name);
    const pos = (Number.isFinite(col) && Number.isFinite(row)) ? { col, row } : nextAutoTokenCell();
    try {
        const result = await context.apiRequest('POST', ['whiteboard', 'tokens'], {
            token: {
                id,
                label: name,
                faction: faction || 'enemy',
                col: pos.col,
                row: pos.row,
                vision: Number.isFinite(vision) ? vision : (faction === 'ally' ? 3 : 0),
                body: Number.isFinite(body) ? body : 3
            }
        });
        return result;
    } catch (e) {
        console.warn(`[Whiteboard] Failed to place token for "${name}":`, e.message);
        return null;
    }
}

async function moveToken(context, name, col, row) {
    if (!context.apiRequest) return null;
    const id = slugifyTokenId(name);
    try {
        return await context.apiRequest('POST', ['whiteboard', 'tokens', encodeURIComponent(id), 'move'], { col, row });
    } catch (e) {
        console.warn(`[Whiteboard] Failed to move token "${name}":`, e.message);
        return null;
    }
}

async function removeToken(context, name) {
    if (!context.apiRequest) return null;
    const id = slugifyTokenId(name);
    try {
        return await context.apiRequest('DELETE', ['whiteboard', 'tokens', encodeURIComponent(id)]);
    } catch (e) {
        // Not fatal -- token may never have been placed (e.g. an NPC that
        // was only ever named, never actually put in a fight).
        return null;
    }
}

// Clear every enemy-faction token off the grid, e.g. once an encounter
// resolves. Deliberately scoped to faction:'enemy' only -- ally/PC
// tokens (which this bot never creates itself, only humans do via the
// whiteboard UI) are left alone, so resolving one fight can't silently
// wipe party tokens a human placed.
async function clearEnemyTokens(context) {
    if (!context.apiRequest) return;
    try {
        const board = await context.apiRequest('GET', ['whiteboard']);
        const tokens = board?.gridCombat?.tokens || [];
        const enemyIds = tokens.filter(t => t.faction === 'enemy').map(t => t.id);
        for (const id of enemyIds) {
            await context.apiRequest('DELETE', ['whiteboard', 'tokens', encodeURIComponent(id)]).catch(() => {});
        }
    } catch (e) {
        console.warn('[Whiteboard] Failed to clear enemy tokens after encounter resolve:', e.message);
    }
}

// ─── Command parser ────────────────────────────────────────────────

module.exports = {
    encounterIcon,
    slugifyTokenId,
    nextAutoTokenCell,
    inferFaction,
    placeOrUpdateToken,
    moveToken,
    removeToken,
    clearEnemyTokens,
};
