// modules/commands/characters-sync.js
// Extracted from the original monolithic modules/commands.js.
// Syncing/creating characters against the global (outside-room) API.

async function ensureCharacterOnServer(name, context) {
    try {
        const data = await context.apiRequest('GET', ['characters', encodeURIComponent(name)]);
        if (data && typeof data === 'object' && data.harm !== undefined) {
            return true;
        }
    } catch (e) {
        if (!e.message.includes('404')) {
            console.warn(`Failed to check character ${name} on server: ${e.message}`);
            return false;
        }
    }
    try {
        const updates = {
            harm: 0,
            fatigue: 0,
            obligation: 0,
            boons: 0,
            leash: 0,
            corruption: 0,
            tier: 1,
            xp: 0,
            attributes: { Body: 2, Wits: 2, Spirit: 2, Presence: 2 },
            skills: {
                Melee: 0, Ranged: 0, Unarmed: 0,
                Athletics: 0, Stealth: 0, Endurance: 0, Craft: 0,
                Sway: 0, Deception: 0, Subterfuge: 0, Performance: 0, Insight: 0,
                Lore: 0, Investigation: 0, Medicine: 0,
                Arcana: 0
            },
            talents: [],
            bonds: [],
            complications: [],
            assets: [],
            followers: [],
            active: true
        };
        await context.apiRequest('POST', ['characters', 'update'], { updates: { [name]: updates } });
        console.log(`✅ Created character ${name} on server.`);
        return true;
    } catch (e) {
        console.warn(`Failed to create character ${name} on server: ${e.message}`);
        return false;
    }
}

/**
 * NEW: extracted from the !gm discover command body so it can also be
 * used by index.js's performAggressiveSync() -- which previously did its
 * own SEPARATE, cruder implementation (a full wholesale replace via
 * characters.loadCharacters(), rather than this field-by-field merge).
 * Having the same logic live in two places is exactly the kind of
 * duplication that caused the case-sensitivity fragmentation bug a few
 * fixes back, and the wholesale-replace version was also strictly more
 * dangerous: it discards any local-only state that hasn't yet round-
 * tripped through the server between sync ticks. This is the one true
 * implementation now; both callers share it.
 *
 * @param {object} context - needs { apiRequest, charactersModule }
 * @returns {Promise<{synced: number, error?: string}>}
 */
async function syncCharactersFromServer(context) {
    const listData = await context.apiRequest('GET', ['characters']);
    if (!listData || !Array.isArray(listData.characters)) {
        return { synced: 0, error: 'No character data from server.' };
    }
    const serverChars = listData.characters;
    let synced = 0;
    for (const data of serverChars) {
        if (!data || !data.name) continue;
        const char = context.charactersModule.get(data.name);
        if (data.harm !== undefined) char.harm = data.harm;
        if (data.fatigue !== undefined) char.fatigue = data.fatigue;
        if (data.obligation !== undefined) char.obligation = data.obligation;
        if (data.boons !== undefined) char.boons = data.boons;
        if (data.leash !== undefined) char.leash = data.leash;
        if (data.corruption !== undefined) char.corruption = data.corruption;
        if (data.attributes) char.attributes = { ...char.attributes, ...data.attributes };
        if (data.skills) char.skills = { ...char.skills, ...data.skills };
        if (data.talents) char.talents = data.talents;
        if (data.bonds) char.bonds = data.bonds;
        if (data.complications) char.complications = data.complications;
        if (data.assets) char.assets = data.assets;
        if (data.followers) char.followers = data.followers;
        if (data.tier !== undefined) char.tier = data.tier;
        if (data.xp !== undefined) char.xp = data.xp;
        synced++;
    }
    return { synced };
}

// ─── Helper: NPC action resolver (unchanged) ──────────────────────

module.exports = { ensureCharacterOnServer, syncCharactersFromServer };
