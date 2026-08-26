// modules/world-manager.js
/**
 * World Manager Module for AI GM Bot
 * 
 * Loads and manages world data (regions, factions, trusts, assets, rules).
 * Provides campaign state management with persistence via the socket server.
 * Integrates with the deck module for regional generation.
 * 
 * Updated to load data/rules.txt for LLM context.
 *
 * v2 (this pass) -- TWO PERSISTENCE FIXES, see CampaignManager below:
 *   1. `this.state` (conversation history, facts, scene, Story Beats, and
 *      all of adventure-director.js's own bookkeeping -- pendingSelection,
 *      customAdventures, adventureArchive) is bolted onto CampaignManager
 *      instances from OUTSIDE this class, by Orchestrator's own `get
 *      state()` getter in gm-orchestrator.js. This class's save()/load()
 *      never knew that property existed, so it was NEVER persisted or
 *      restored -- every single orchestrator.campaign.save() call (which
 *      fires after nearly every command) silently discarded conversation
 *      history, facts, and all adventure state. This explains a
 *      previously-reported symptom exactly: the welcome message and
 *      "no adventure loaded" menu re-firing mid-session, as if a full
 *      restart had wiped everything -- it effectively had, every time,
 *      just via this specific gap rather than the filesystem.
 *   2. save() used to generate a brand NEW random campaign code on every
 *      single call, tracking "which one is current" only via a local
 *      file (campaigns/{ROOM}_code.txt). If that file lives on ephemeral
 *      disk (common for containerized deployments), a restart loses the
 *      pointer to the latest save entirely, orphaning it -- a second,
 *      independent point of fragility on top of (1). Now saves/loads
 *      through a deterministic per-room "auto-save" slot (keyed by room
 *      code itself, not a random code), so there's no separate pointer
 *      file to lose at all. The old random-code endpoints are still used,
 *      but only for the EXPLICIT manual share flow (!gm upload / !gm load
 *      <code>), which is a deliberately different, opt-in mechanism from
 *      automatic restart-survival persistence.
 */

const fs = require('fs');           // synchronous methods (existsSync, mkdirSync, writeFileSync)
const fsPromises = fs.promises;     // promise-based methods (readFile, writeFile, readdir)
const path = require('path');

// Ensure world data directory exists (synchronous check at module load)
const WORLD_DATA_DIR = path.resolve(process.cwd(), 'data', 'world');
if (!fs.existsSync(WORLD_DATA_DIR)) {
    fs.mkdirSync(WORLD_DATA_DIR, { recursive: true });
    // Write default empty files if needed
    const defaultFiles = ['factions.json', 'settlements.json', 'patrons.json'];
    for (const file of defaultFiles) {
        const filePath = path.join(WORLD_DATA_DIR, file);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '[]', 'utf-8');
        }
    }
    console.log('📁 Created data/world directory with empty JSON files.');
}

// ============================================================
// CONSTANTS
// ============================================================

const REGION_DATA_DIR = path.resolve(process.cwd(), 'data', 'regions');
const FACTION_DATA_DIR = path.resolve(process.cwd(), 'data', 'factions');
const PATRON_DATA_DIR = path.resolve(process.cwd(), 'data', 'patrons');
const RULES_FILE_PATH = path.resolve(process.cwd(), 'data', 'rules.txt');

// ============================================================
// HELPER: derive HTTP API base from WebSocket URL
// ============================================================

function getApiBaseUrl(wsUrl) {
    if (!wsUrl) return 'http://localhost:10000/api';
    const url = new URL(wsUrl);
    // Convert ws(s) → http(s)
    url.protocol = url.protocol.replace('ws', 'http');
    // Remove any path segments (like /campaign)
    url.pathname = '/api';
    return url.toString().replace(/\/$/, '');
}

// ============================================================
// HELPER: loadJSON
// ============================================================

async function loadJSON(filePath) {
    try {
        const data = await fsPromises.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        // Silent fail for optional files; log only if not ENOENT
        if (e.code !== 'ENOENT') {
            console.warn(`Failed to load ${filePath}:`, e.message);
        }
        return null;
    }
}

// ============================================================
// HELPER: loadTextFile
// ============================================================

async function loadTextFile(filePath) {
    try {
        return await fsPromises.readFile(filePath, 'utf-8');
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.warn(`Failed to load text file ${filePath}:`, e.message);
        }
        return null;
    }
}

// ============================================================
// WORLD MANAGER
// ============================================================

class WorldManager {
    /**
     * Loads all world data: regions, factions, settlements, patrons, NPCs, spells, wiki, and rules.
     */
    constructor() {
        this.regions = {};          // regionId -> region data
        this.factions = {};         // factionId -> faction data (from data/factions and data/world/factions.json)
        this.settlements = {};      // settlementId -> settlement data
        this.patrons = {};          // patronId -> patron data (from data/patrons and data/world/patrons.json)
        this.npcs = {};             // npcs from data/npcs.json
        this.spells = {};           // spells from data/spells.json
        this.wiki = {};             // wiki data from data/wiki.json
        this.rules = null;          // rules.txt content as string
        this.loaded = false;
    }

    /**
     * Load all JSON files from data/regions, data/factions, data/patrons, data/world, and root data files.
     */
    async loadAll() {
        // --- Load rules.txt ---
        const rulesContent = await loadTextFile(RULES_FILE_PATH);
        if (rulesContent) {
            this.rules = rulesContent;
            console.log(`📖 Loaded rules.txt (${this.rules.length} characters).`);
        } else {
            this.rules = '# FATE\'S EDGE — AI GM RULES\n\nNo rules file found. Use default GM behavior.';
            console.warn('⚠️  rules.txt not found. Using fallback rules.');
        }

        // --- Load regions ---
        //
        // BUGFIX: this used to key this.regions off each file's own
        // top-level `id` field. But that field is a full slug of the
        // region's *title including its subtitle*
        // (data/regions/acasia.json's `id` is "acasia-broken-marches",
        // black_banners.json's is "black-banners-condotta-crowns") -- NOT
        // the filename. Every other consumer of region data in this
        // codebase (deck.js's file-path fallback, the socket server's
        // loadRegionDataSync, the web client) locates a region by
        // filename stem (e.g. "acasia", "black_banners"), so keying this
        // map by the internal `id` field meant getRegion()/listRegions()
        // could never agree with the rest of the pipeline on what a
        // region's id even was -- every lookup by filename-shaped id
        // missed. Key by filename stem instead, so this module's notion
        // of "region id" is the same one everything else already uses.
        try {
            const regionFiles = await fsPromises.readdir(REGION_DATA_DIR);
            for (const file of regionFiles) {
                if (!file.endsWith('.json') || file === 'manifest.json') continue;
                const stem = file.slice(0, -'.json'.length);
                const data = await loadJSON(path.join(REGION_DATA_DIR, file));
                if (data) {
                    this.regions[stem] = data;
                }
            }
            console.log(`Loaded ${Object.keys(this.regions).length} regions.`);
        } catch (e) {
            console.warn('Could not load region data:', e.message);
        }

        // --- Load individual factions from data/factions ---
        try {
            const factionFiles = await fsPromises.readdir(FACTION_DATA_DIR);
            for (const file of factionFiles) {
                if (file.endsWith('.json')) {
                    const data = await loadJSON(path.join(FACTION_DATA_DIR, file));
                    if (data) {
                        if (Array.isArray(data)) {
                            for (const item of data) {
                                if (item.id) this.factions[item.id] = item;
                            }
                        } else if (data.id) {
                            this.factions[data.id] = data;
                        } else if (data.name) {
                            const id = data.name.toLowerCase().replace(/\s+/g, '-');
                            this.factions[id] = data;
                        }
                    }
                }
            }
            console.log(`Loaded ${Object.keys(this.factions).length} factions (from data/factions).`);
        } catch (e) {
            console.warn('Could not load faction data:', e.message);
        }

        // --- Load individual patrons from data/patrons ---
        try {
            const patronFiles = await fsPromises.readdir(PATRON_DATA_DIR);
            for (const file of patronFiles) {
                if (file.endsWith('.json')) {
                    const data = await loadJSON(path.join(PATRON_DATA_DIR, file));
                    if (data) {
                        if (Array.isArray(data)) {
                            for (const item of data) {
                                if (item.id) this.patrons[item.id] = item;
                            }
                        } else if (data.id) {
                            this.patrons[data.id] = data;
                        } else if (data.name) {
                            const id = data.name.toLowerCase().replace(/\s+/g, '-');
                            this.patrons[id] = data;
                        }
                    }
                }
            }
            console.log(`Loaded ${Object.keys(this.patrons).length} patrons (from data/patrons).`);
        } catch (e) {
            console.warn('Could not load patron data:', e.message);
        }

        // --- Load data/world aggregate files (settlements, plus merge factions/patrons) ---
        try {
            const worldFiles = await fsPromises.readdir(WORLD_DATA_DIR);
            for (const file of worldFiles) {
                if (file.endsWith('.json')) {
                    const data = await loadJSON(path.join(WORLD_DATA_DIR, file));
                    if (data) {
                        let type = data.type;
                        if (!type) {
                            if (file === 'factions.json') type = 'faction';
                            else if (file === 'settlements.json') type = 'settlement';
                            else if (file === 'patrons.json') type = 'patron';
                        }
                        if (type === 'faction' || file === 'factions.json') {
                            if (Array.isArray(data)) {
                                for (const item of data) {
                                    if (item.id && !this.factions[item.id]) {
                                        this.factions[item.id] = item;
                                    }
                                }
                            } else if (data.id && !this.factions[data.id]) {
                                this.factions[data.id] = data;
                            }
                        } else if (type === 'settlement' || file === 'settlements.json') {
                            if (Array.isArray(data)) {
                                for (const item of data) {
                                    if (item.id) this.settlements[item.id] = item;
                                }
                            } else if (data.id) {
                                this.settlements[data.id] = data;
                            }
                        } else if (type === 'patron' || file === 'patrons.json') {
                            if (Array.isArray(data)) {
                                for (const item of data) {
                                    if (item.id && !this.patrons[item.id]) {
                                        this.patrons[item.id] = item;
                                    }
                                }
                            } else if (data.id && !this.patrons[data.id]) {
                                this.patrons[data.id] = data;
                            }
                        }
                    }
                }
            }
            console.log(`Loaded ${Object.keys(this.settlements).length} settlements (from data/world).`);
        } catch (e) {
            console.warn('Could not load world aggregate data:', e.message);
        }

        // --- Load npcs.json ---
        const npcsPath = path.resolve(process.cwd(), 'data', 'npcs.json');
        const npcsData = await loadJSON(npcsPath);
        if (npcsData) {
            if (Array.isArray(npcsData)) {
                for (const npc of npcsData) {
                    if (npc.id) this.npcs[npc.id] = npc;
                    else if (npc.name) {
                        const id = npc.name.toLowerCase().replace(/\s+/g, '-');
                        this.npcs[id] = npc;
                    }
                }
            } else if (npcsData.id) {
                this.npcs[npcsData.id] = npcsData;
            } else {
                Object.assign(this.npcs, npcsData);
            }
            console.log(`Loaded ${Object.keys(this.npcs).length} NPCs from npcs.json.`);
        }

        // --- Load spells.json ---
        const spellsPath = path.resolve(process.cwd(), 'data', 'spells.json');
        const spellsData = await loadJSON(spellsPath);
        if (spellsData) {
            if (Array.isArray(spellsData)) {
                for (const spell of spellsData) {
                    if (spell.id) this.spells[spell.id] = spell;
                    else if (spell.name) {
                        const id = spell.name.toLowerCase().replace(/\s+/g, '-');
                        this.spells[id] = spell;
                    }
                }
            } else if (spellsData.id) {
                this.spells[spellsData.id] = spellsData;
            } else {
                Object.assign(this.spells, spellsData);
            }
            console.log(`Loaded ${Object.keys(this.spells).length} spells from spells.json.`);
        }

        // --- Load wiki.json ---
        const wikiPath = path.resolve(process.cwd(), 'data', 'wiki.json');
        const wikiData = await loadJSON(wikiPath);
        if (wikiData) {
            if (Array.isArray(wikiData)) {
                for (const entry of wikiData) {
                    if (entry.id) this.wiki[entry.id] = entry;
                    else if (entry.title) {
                        const id = entry.title.toLowerCase().replace(/\s+/g, '-');
                        this.wiki[id] = entry;
                    }
                }
            } else if (wikiData.id) {
                this.wiki[wikiData.id] = wikiData;
            } else {
                Object.assign(this.wiki, wikiData);
            }
            console.log(`Loaded ${Object.keys(this.wiki).length} wiki entries from wiki.json.`);
        }

        this.loaded = true;
        return this;
    }

    /**
     * Get a region by ID or name.
     *
     * BUGFIX: region ids/filenames use underscores for multi-word regions
     * (e.g. "black_banners", "the_wilds", "midh_ahkaz", "the_ways_between"
     * -- see loadAll() above, which keys this.regions off each file's own
     * `id` field). This used to normalize display names to HYPHENS
     * ("Black Banners" -> "black-banners"), which never matched any key
     * in this.regions, so every multi-word region silently missed here
     * and fell back to "no detailed data available" everywhere this is
     * called from. Single-word regions (Acasia, Ecktoria, ...) were
     * unaffected, which is why this went unnoticed.
     */
    getRegion(idOrName) {
        idOrName = idOrName.toLowerCase().trim().replace(/\s+/g, '_');
        return this.regions[idOrName] || null;
    }

    /**
     * List all loaded regions as sorted {id, title} pairs, for
     * presentation (e.g. a multi-column region picker). `id` is the
     * filename-stem key this.regions is keyed by (see loadAll() above) --
     * the same id deck.js/the socket server expect back — NOT each
     * file's own internal `id` field, which is a full slug of the title
     * and subtitle and won't resolve to any actual file.
     */
    listRegions() {
        return Object.entries(this.regions)
            .map(([id, r]) => ({ id, title: r.title || r.label || id }))
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    /**
     * Get a faction by ID.
     */
    getFaction(id) {
        return this.factions[id] || null;
    }

    /**
     * Get a settlement by ID.
     */
    getSettlement(id) {
        return this.settlements[id] || null;
    }

    /**
     * Get a patron by ID.
     */
    getPatron(id) {
        return this.patrons[id] || null;
    }

    /**
     * Get an NPC by ID or name.
     */
    getNPC(idOrName) {
        const id = idOrName.toLowerCase().replace(/\s+/g, '-');
        return this.npcs[id] || null;
    }

    /**
     * Get a spell by ID or name.
     */
    getSpell(idOrName) {
        // Try direct id match
        const id = idOrName.toLowerCase().replace(/\s+/g, '-');
        if (this.spells[id]) return this.spells[id];
        // Try case‑insensitive name match
        for (const [key, spell] of Object.entries(this.spells)) {
            if (spell.name && spell.name.toLowerCase() === idOrName.toLowerCase()) {
                return spell;
            }
        }
        return null;
    }

    /**
     * Get a wiki entry by ID or title.
     */
    getWiki(idOrName) {
        const id = idOrName.toLowerCase().replace(/\s+/g, '-');
        return this.wiki[id] || null;
    }

    /**
     * Get the loaded rules text.
     */
    getRules() {
        return this.rules || null;
    }

    /**
     * List all factions (optionally filtered by region).
     */
    listFactions(regionId = null) {
        const factions = Object.values(this.factions);
        if (regionId) {
            return factions.filter(f => f.region === regionId);
        }
        return factions;
    }

    /**
     * List all settlements (optionally filtered by region).
     */
    listSettlements(regionId = null) {
        const settlements = Object.values(this.settlements);
        if (regionId) {
            return settlements.filter(s => s.region === regionId);
        }
        return settlements;
    }

    /**
     * List all patrons.
     */
    listPatrons() {
        return Object.values(this.patrons);
    }

    /**
     * List all NPCs (optionally filtered by region if the NPC has a region field).
     */
    listNPCs(regionId = null) {
        const npcs = Object.values(this.npcs);
        if (regionId) {
            return npcs.filter(n => n.region === regionId);
        }
        return npcs;
    }

    /**
     * List all spells.
     */
    listSpells() {
        return Object.values(this.spells);
    }

    /**
     * List all wiki entries.
     */
    listWiki() {
        return Object.values(this.wiki);
    }
}

// ============================================================
// CAMPAIGN MANAGER
// ============================================================

class CampaignManager {
    /**
     * @param {WorldManager} world - The world data provider.
     * @param {string} roomCode - The room code for the socket server.
     * @param {string} wsUrl - The WebSocket URL (e.g., 'ws://localhost:10000') – used to derive HTTP API base.
     * @param {string} apiKey - The API key for authentication.
     */
    constructor(world, roomCode, wsUrl = null, apiKey = '') {
        this.world = world;
        this.roomCode = roomCode.toUpperCase();

        // Derive HTTP API base from WebSocket URL, or fallback to env or default
        if (!wsUrl) {
            wsUrl = process.env.WS_URL || 'ws://localhost:10000';
        }
        this.apiBase = getApiBaseUrl(wsUrl);
        this.apiKey = apiKey || process.env.API_KEY || '';

        this.campaignCode = null;
        this.codeFilePath = path.join(__dirname, '..', 'campaigns', `${this.roomCode}_code.txt`);

        // Campaign state
        this.characters = {};
        this.loaded = false;
        // NEW: the free-text, LLM-generated narrative recap used by
        // ai-gm-bot.js's summariseStory() / adventure-director.js's
        // context-building (fed into the system prompt as "Campaign
        // Summary:"/"Previous summary:"). Kept as its OWN field, distinct
        // from getSummary()/below -- that pre-existing method returns a
        // computed Mandate/Crisis/Factions/Trusts/Timers snapshot for the
        // status dashboard's "Recent AI Memory" panel, a completely
        // different thing that happened to share a name with what
        // several callers actually wanted (a stored narrative summary).
        // Those callers were invoking a `setSummary()` that never
        // existed on this class at all -- "orchestrator.campaign.
        // setSummary is not a function" -- and silently reading the
        // wrong (mandate/crisis) text back from `getSummary()` instead
        // of an actual story recap. See getNarrativeSummary()/
        // setNarrativeSummary() below.
        this.narrativeSummary = '';

        // NOTE: `this.state` is NOT declared here -- it's bolted on
        // dynamically from OUTSIDE this class by Orchestrator's own
        // `get state()` getter in gm-orchestrator.js (`this.campaign.state
        // = this._defaultCampaignState()`). It holds conversation history,
        // facts, scene position, Story Beats, and adventure-director.js's
        // own bookkeeping (pendingSelection, customAdventures,
        // adventureArchive). save()/load() below now explicitly persist
        // and restore it, since that never happened before -- see the
        // file-header comment for the full explanation of what broke and
        // why.
    }

    /**
     * Load campaign state.
     *
     * FIXED (two issues):
     *   1. Now restores `this.state` from the saved payload (previously
     *      never touched at all -- conversation/facts/scene/adventure-
     *      director bookkeeping was silently lost on every load).
     *   2. When called with NO explicit campaignCode (the normal
     *      startup path), now loads from a DETERMINISTIC per-room
     *      auto-save slot instead of depending on a local
     *      `{ROOM}_code.txt` pointer file to know which random code is
     *      "current" -- removing a second, independent point of fragility
     *      (that file living on disk that might not survive a restart).
     *      Passing an explicit campaignCode (e.g. from `!gm load <code>`,
     *      importing someone else's shared snapshot) still uses the old
     *      random-code lookup -- that's a deliberately different, opt-in
     *      mechanism from automatic restart-survival persistence.
     *
     * @param {string} campaignCode - Optional. Only for importing an
     *   explicitly shared snapshot code; omit for normal auto-load.
     * @returns {Promise<CampaignManager>} - this instance.
     */
    async load(campaignCode) {
        if (campaignCode) {
            return this._loadByCode(campaignCode);
        }
        return this._loadAutoSave();
    }

    /** NEW: load from the deterministic per-room auto-save slot. */
    async _loadAutoSave() {
        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns/auto-save`;
        try {
            const response = await fetch(url, {
                headers: { 'x-api-key': this.apiKey }
            });
            if (!response.ok) {
                if (response.status === 404) {
                    console.log(`📭 No auto-saved campaign found for room ${this.roomCode}. Starting fresh.`);
                    this.loaded = true;
                    return this;
                }
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            const data = await response.json();
            this._applyLoadedData(data);
            console.log(`✅ Auto-loaded campaign for room ${this.roomCode}`);
            return this;
        } catch (e) {
            console.error('Failed to auto-load campaign:', e.message);
            // Don't block bot startup on a persistence hiccup -- start
            // fresh rather than crash.
            this.loaded = true;
            return this;
        }
    }

    /** Old path: load an explicitly-shared snapshot by its random code. */
    async _loadByCode(campaignCode) {
        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns/${campaignCode}`;
        try {
            const response = await fetch(url, {
                headers: { 'x-api-key': this.apiKey }
            });
            if (!response.ok) {
                if (response.status === 404) {
                    console.log(`📭 No campaign found for code ${campaignCode}. Starting fresh.`);
                    this.loaded = true;
                    return this;
                }
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            const data = await response.json();
            this.campaignCode = campaignCode;
            this._applyLoadedData(data);
            console.log(`✅ Loaded campaign ${campaignCode} for room ${this.roomCode}`);
            return this;
        } catch (e) {
            console.error('Failed to load campaign:', e.message);
            throw e;
        }
    }

    /** Shared field-restoration logic for both load paths above. */
    _applyLoadedData(data) {
        this.characters = data.characters || {};
        this.narrativeSummary = data.narrativeSummary || '';
        // FIXED: this.state was never restored before at all.
        if (data.state) {
            this.state = data.state;
        }
        this.loaded = true;
    }

    /**
     * Save current campaign state.
     *
     * FIXED (two issues):
     *   1. Payload now includes `this.state` (see file header) -- it was
     *      silently omitted before, so conversation history, facts, scene
     *      position, and all adventure-director bookkeeping never
     *      actually persisted despite this method being called after
     *      nearly every single command.
     *   2. Now saves to the SAME deterministic per-room auto-save slot
     *      every time, instead of generating a brand-new random code on
     *      every call and relying on a local pointer file to track which
     *      one is current. Removes that pointer file as a separate point
     *      of failure entirely for automatic persistence.
     *
     * @returns {Promise<void>}
     */
    async save() {
        const payload = {
            characters: this.characters,
            narrativeSummary: this.narrativeSummary,
            state: this.state, // FIXED: previously omitted entirely
            timestamp: Date.now()
        };

        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns/auto-save`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
        } catch (e) {
            console.error('Failed to auto-save campaign:', e.message);
            throw e;
        }
    }

    /**
     * NEW: explicit manual snapshot export for sharing -- generates a
     * random shareable code via the OLD (unchanged) random-code endpoint.
     * This is a deliberately different, opt-in mechanism from the
     * automatic auto-save above (e.g. "give this code to a friend to
     * import your campaign into a different room"), not something that
     * needs to survive this bot's own restarts on its own.
     * @returns {Promise<string>} the shareable campaign code.
     */
    async exportSnapshot() {
        const payload = {
            characters: this.characters,
            narrativeSummary: this.narrativeSummary,
            state: this.state,
            timestamp: Date.now()
        };
        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        const result = await response.json();
        if (!result.code) throw new Error('Server did not return a campaign code');
        this.campaignCode = result.code;
        console.log(`✅ Campaign snapshot exported with code ${this.campaignCode}`);
        return this.campaignCode;
    }

    /**
     * NEW: explicit manual snapshot import by a shared code (e.g. !gm
     * load <code>). Distinct from the automatic auto-save load path.
     */
    async importSnapshot(campaignCode) {
        return this._loadByCode(campaignCode);
    }

    /**
     * Delete the campaign from the server.
     */
    async delete() {
        if (!this.campaignCode) return;
        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns/${this.campaignCode}`;
        try {
            const response = await fetch(url, { method: 'DELETE' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            this.campaignCode = null;
            console.log(`Campaign deleted.`);
        } catch (e) {
            console.error('Failed to delete campaign:', e.message);
            throw e;
        }
    }


    /**
     * Get the stored free-text narrative summary (an LLM-generated recap
     * of the story so far -- see ai-gm-bot.js's summariseStory()). NOT
     * the same thing as getSummary() above (that's a computed Mandate/
     * Crisis/Factions/Trusts/Timers snapshot for the dashboard).
     * @returns {string} the summary, or '' if none has been generated yet.
     */
    getNarrativeSummary() {
        return this.narrativeSummary || '';
    }

    /**
     * Store a fresh narrative summary, replacing whatever was there
     * before. `text` is expected to already be trimmed/finalized (see
     * summariseStory()); an empty/falsy value clears it, e.g. when a new
     * adventure starts and stale narration shouldn't carry over (see
     * adventure-director.js's resetNarrativeState()).
     * @param {string} text
     */
    setNarrativeSummary(text) {
        this.narrativeSummary = text || '';
    }

}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    WorldManager,
    CampaignManager,
    REGION_DATA_DIR,
    WORLD_DATA_DIR
};
