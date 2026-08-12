// modules/knowledge-index.js
//
// Optional long-term memory for the campaign: Facts (`!gm fact` / `[FACT
// ...]`), NPCs (`[NPC CREATE ...]` / `[NPC CAST ...]`), and periodic
// campaign summaries (see ai-gm-bot.js's summariseStory()) all get
// indexed into Elasticsearch as they're created, in addition to
// wherever they already live (campaignState.facts, the adventure's own
// npcs[] via the server API, orchestrator.campaign's summary field).
//
// Why this exists: campaignState.facts today gets dumped WHOLESALE into
// the system prompt every single turn (see ai-gm-bot.js) with no
// pruning -- fine for a short campaign with a handful of facts, but it
// grows unbounded over a long-running one and eventually crowds out
// everything else in the context window. NPCs registered via [NPC
// CREATE ...] have the same problem: no way to ask "who knows about the
// cursed well?" or "where does Kestrel live?" without either the model
// happening to remember from raw chat history (which gets pruned) or an
// operator manually grepping campaign state.
//
// This module makes that queryable: search() does a relevance-ranked
// full-text search across all three document types, so a handful of
// genuinely relevant facts/NPCs/summary snippets can be pulled into the
// prompt for the CURRENT turn instead of everything, all the time. See
// ai-gm-bot.js's handleMessage() for where that retrieval actually gets
// injected, and modules/commands.js's `!gm recall <query>` for the
// operator-facing manual version of the same search.
//
// Entirely optional and fails soft: with no ES_URL set, every exported
// function becomes a silent no-op (search() resolves to []) so the bot
// behaves exactly as it did before this module existed. This is a
// deliberate departure from the "fail fast on a broken required
// dependency" philosophy the AI drivers use (see ai-driver.js) --
// Elasticsearch is an enhancement layered on top of state that's
// already fully tracked elsewhere (campaignState.facts, the adventure
// npcs[] API, campaign.summary), never the only copy of anything, so a
// campaign should never be blocked on it being reachable.

const logger = require('./logger');

let client = null;
let enabled = false;
const ensuredIndices = new Set();

/**
 * (Re)initializes the ES client from environment variables. Called once
 * at module load; exported mainly so tests can re-init after changing
 * env vars, and so a test can inject a fake client via configure()
 * without ever touching a real Elasticsearch cluster.
 */
function init() {
    const node = process.env.ES_URL;
    ensuredIndices.clear();
    if (!node) {
        client = null;
        enabled = false;
        return;
    }
    try {
        // Lazily required so a bot that never sets ES_URL doesn't pay the
        // (small but nonzero) cost of loading the client library at all.
        const { Client } = require('@elastic/elasticsearch');
        const opts = { node };
        if (process.env.ES_API_KEY) {
            opts.auth = { apiKey: process.env.ES_API_KEY };
        } else if (process.env.ES_USERNAME && process.env.ES_PASSWORD) {
            opts.auth = { username: process.env.ES_USERNAME, password: process.env.ES_PASSWORD };
        }
        if (process.env.ES_TLS_REJECT_UNAUTHORIZED === 'false') {
            opts.tls = { rejectUnauthorized: false }; // self-signed cert, local/dev ES only
        }
        client = new Client(opts);
        enabled = true;
        logger.info(`🔎 Knowledge index: Elasticsearch enabled (${node})`);
    } catch (e) {
        logger.warn('⚠️  Knowledge index: failed to initialize Elasticsearch client:', e.message);
        client = null;
        enabled = false;
    }
}

/** Test-only hook: inject a fake client and force enabled on/off without a real ES cluster. */
function configure({ client: fakeClient, enabled: forceEnabled } = {}) {
    if (fakeClient !== undefined) client = fakeClient;
    if (forceEnabled !== undefined) enabled = forceEnabled;
    ensuredIndices.clear();
}

function isEnabled() {
    return enabled;
}

/** One index per campaign, so campaigns never bleed facts/NPCs into each other's search results. */
function indexNameFor(campaignCode) {
    const prefix = process.env.ES_INDEX_PREFIX || 'gm-knowledge';
    const safe = String(campaignCode || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return `${prefix}-${safe}`;
}

async function ensureIndex(campaignCode) {
    if (!enabled) return;
    const index = indexNameFor(campaignCode);
    if (ensuredIndices.has(index)) return;
    try {
        const exists = await client.indices.exists({ index });
        if (!exists) {
            await client.indices.create({
                index,
                mappings: {
                    properties: {
                        type: { type: 'keyword' },   // 'fact' | 'npc' | 'summary'
                        key: { type: 'keyword' },
                        name: { type: 'text' },
                        text: { type: 'text' },       // the field search() actually queries
                        metadata: { type: 'object', enabled: true },
                        updatedAt: { type: 'date' }
                    }
                }
            });
        }
        ensuredIndices.add(index);
    } catch (e) {
        logger.warn(`⚠️  Knowledge index: ensureIndex(${index}) failed:`, e.message);
    }
}

async function indexDoc(campaignCode, { id, type, key, name, text, metadata }) {
    if (!enabled || !text) return;
    try {
        await ensureIndex(campaignCode);
        await client.index({
            index: indexNameFor(campaignCode),
            id: id || `${type}:${key || name}`,
            document: {
                type,
                key: key || null,
                name: name || null,
                text,
                metadata: metadata || {},
                updatedAt: new Date().toISOString()
            }
        });
    } catch (e) {
        logger.warn(`⚠️  Knowledge index: indexDoc failed (${type} ${key || name}):`, e.message);
    }
}

/** Index (or re-index) one campaignState.facts entry. Fire-and-forget from callers. */
async function indexFact(campaignCode, key, value) {
    return indexDoc(campaignCode, {
        type: 'fact',
        key,
        text: `${key}: ${value}`,
        metadata: { key, value }
    });
}

/**
 * Index (or re-index) an NPC — {name, role, motivation, location?,
 * faction?, source?}. `location` is intentionally optional: plenty of
 * NPCs wander, travel with the party, or simply have no fixed address
 * worth recording, and forcing one would just invite a made-up value.
 * Omit it (or pass null/'') and the NPC is indexed exactly the same,
 * just without a location claim in its searchable text.
 */
async function indexNpc(campaignCode, npc) {
    if (!npc || !npc.name) return;
    const text = [
        npc.name,
        npc.role ? `Role: ${npc.role}` : null,
        npc.motivation ? `Motivation: ${npc.motivation}` : null,
        npc.location ? `Located at: ${npc.location}` : null,
        npc.faction ? `Faction: ${npc.faction}` : null
    ].filter(Boolean).join('. ');
    return indexDoc(campaignCode, { type: 'npc', key: npc.name, name: npc.name, text, metadata: npc });
}

/**
 * Update just an NPC's location (an NPC who wanders, relocates, or is
 * later found somewhere new) without clobbering their role/motivation/
 * faction. Fetches whatever's currently indexed for that name, merges
 * in the new location, and re-indexes the full document under the same
 * id (`npc:<name>`) so it overwrites in place rather than creating a
 * duplicate. Upserts: works even if the NPC was never indexed before
 * (e.g. one pre-authored in the adventure module rather than created
 * via `[NPC CREATE ...]`) — starts from an empty record with just the
 * name and location.
 *
 * Pass a falsy `location` (null/'') to explicitly CLEAR a previously
 * set location — e.g. the NPC has left, or their whereabouts are no
 * longer known — rather than leaving stale location data searchable.
 */
async function updateNpcLocation(campaignCode, name, location) {
    if (!enabled || !name) return;
    try {
        await ensureIndex(campaignCode);
        const index = indexNameFor(campaignCode);
        const id = `npc:${name}`;
        let existing = {};
        try {
            const got = await client.get({ index, id });
            existing = got._source || got.body?._source || {};
        } catch (e) {
            // Not indexed yet -- fine, we upsert from scratch below.
        }
        const npc = { ...(existing.metadata || {}), name };
        if (location) npc.location = location;
        else delete npc.location;
        return indexNpc(campaignCode, npc);
    } catch (e) {
        logger.warn(`⚠️  Knowledge index: updateNpcLocation("${name}") failed:`, e.message);
    }
}

/** Index one campaign-summary snapshot (see ai-gm-bot.js's summariseStory()). Each call creates a new doc rather than overwriting, so search can surface older summaries too. */
async function indexSummary(campaignCode, summaryText, extra = {}) {
    if (!summaryText || !summaryText.trim()) return;
    return indexDoc(campaignCode, {
        id: `summary:${Date.now()}`,
        type: 'summary',
        text: summaryText,
        metadata: extra
    });
}

/**
 * Relevance-ranked full-text search across facts/NPCs/summaries for one
 * campaign. Returns [] (never throws) if disabled, unconfigured, or the
 * query fails -- callers should always be able to treat this as "maybe
 * nothing came back" rather than a hard dependency.
 *
 * @param {string} campaignCode
 * @param {string} queryText — free text, e.g. "who knows about the cursed well"
 * @param {{size?: number, types?: string[]}} [opts] — types filters to a subset of 'fact'|'npc'|'summary'
 */
async function search(campaignCode, queryText, { size = 5, types = null } = {}) {
    if (!enabled || !queryText || !queryText.trim()) return [];
    try {
        await ensureIndex(campaignCode);
        const must = [{
            multi_match: {
                query: queryText,
                fields: ['text^2', 'name^3', 'key^2'],
                fuzziness: 'AUTO'
            }
        }];
        const filter = types && types.length ? [{ terms: { type: types } }] : [];
        const result = await client.search({
            index: indexNameFor(campaignCode),
            size,
            query: { bool: { must, filter } }
        });
        const hits = result.hits?.hits || result.body?.hits?.hits || [];
        return hits.map(h => ({
            score: h._score,
            type: h._source.type,
            name: h._source.name,
            key: h._source.key,
            text: h._source.text
        }));
    } catch (e) {
        logger.warn('⚠️  Knowledge index: search failed:', e.message);
        return [];
    }
}

init();

module.exports = {
    init,
    configure,
    isEnabled,
    indexNameFor,
    indexFact,
    indexNpc,
    updateNpcLocation,
    indexSummary,
    search
};
