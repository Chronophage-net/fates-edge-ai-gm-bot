// modules/world-manager.js
/**
 * World Manager Module for AI GM Bot
 * 
 * Loads and manages world data (regions, factions, trusts, assets, rules).
 * Provides campaign state management with persistence via the socket server.
 * Integrates with the deck module for regional generation.
 * 
 * Updated to load data/rules.txt for LLM context.
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
const DEFAULT_TIMER_SEGMENTS = 6;
const MAX_BOONS_CARRYOVER = 2;
const MAX_XP_FROM_BOONS_PER_SESSION = 2;

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
            this.rules = '# FATE\'S EDGE — AI GM RULES\n\nNo rules file found. Use default GM behaviour.';
            console.warn('⚠️  rules.txt not found. Using fallback rules.');
        }

        // --- Load regions ---
        try {
            const regionFiles = await fsPromises.readdir(REGION_DATA_DIR);
            for (const file of regionFiles) {
                if (file.endsWith('.json')) {
                    const data = await loadJSON(path.join(REGION_DATA_DIR, file));
                    if (data && data.id) {
                        this.regions[data.id] = data;
                    } else if (data && data.name) {
                        // Use name as id if no id field
                        const id = data.name.toLowerCase().replace(/\s+/g, '-');
                        this.regions[id] = data;
                    }
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
     */
    getRegion(idOrName) {
        idOrName = idOrName.toLowerCase().replace(/\s+/g, '-');
        return this.regions[idOrName] || null;
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
        this.factions = {};
        this.trusts = {};
        this.assets = {};
        this.timers = {};
        this.mandate = 0;
        this.crisis = 0;
        this.meta = {};
        this.characters = {};
        this.loaded = false;

        // Track faction events for reporting
        this.factionEvents = [];
    }

    /**
     * Load campaign state from the socket server or local file.
     * @param {string} campaignCode - Optional 6-character campaign code.
     * @returns {Promise<CampaignManager>} - this instance on success, or null if no campaign.
     */
    async load(campaignCode) {
        // If no code provided, try to read from local file
        if (!campaignCode) {
            try {
                if (fs.existsSync(this.codeFilePath)) {
                    campaignCode = fs.readFileSync(this.codeFilePath, 'utf-8').trim();
                }
            } catch (e) { /* ignore */ }
        }
        if (!campaignCode) {
            this.loaded = true;
            console.log('No campaign code found. Starting new campaign.');
            return this;
        }

        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns/${campaignCode}`;
        try {
            const response = await fetch(url, {
                headers: { 'x-api-key': this.apiKey }
            });
            if (!response.ok) {
                // If 404, treat as "no campaign" rather than throwing
                if (response.status === 404) {
                    console.log(`📭 No campaign found for code ${campaignCode}. Starting fresh.`);
                    this.loaded = true;
                    return this;
                }
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            const data = await response.json();
            this.campaignCode = campaignCode;
            this.factions = data.factions || {};
            this.trusts = data.trusts || {};
            this.assets = data.assets || {};
            this.timers = data.timers || {};
            this.mandate = data.mandate || 0;
            this.crisis = data.crisis || 0;
            this.meta = data.meta || {};
            this.characters = data.characters || {};
            this.loaded = true;
            console.log(`✅ Loaded campaign ${campaignCode} for room ${this.roomCode}`);
            return this;
        } catch (e) {
            console.error('Failed to load campaign:', e.message);
            // Re-throw only if it's not a 404 (which we already handle)
            throw e;
        }
    }

    /**
     * Save current campaign state to the socket server.
     * @returns {Promise<string>} The campaign code.
     */
    async save() {
        const payload = {
            factions: this.factions,
            trusts: this.trusts,
            assets: this.assets,
            timers: this.timers,
            mandate: this.mandate,
            crisis: this.crisis,
            meta: this.meta,
            characters: this.characters,
            factionEvents: this.factionEvents.slice(-20), // keep last 20 events
            timestamp: Date.now()
        };

        const url = `${this.apiBase}/rooms/${this.roomCode}/campaigns`;
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
            const result = await response.json();
            if (result.code) {
                this.campaignCode = result.code;
                // Write to local file
                try {
                    const dir = path.dirname(this.codeFilePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(this.codeFilePath, result.code);
                } catch (e) { /* ignore */ }
                console.log(`✅ Campaign saved with code ${this.campaignCode}`);
                return this.campaignCode;
            } else {
                throw new Error('Server did not return a campaign code');
            }
        } catch (e) {
            console.error('Failed to save campaign:', e.message);
            throw e;
        }
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

    // ============================================================
    // FACTION MANAGEMENT
    // ============================================================

    /**
     * Initialize a faction in the campaign with default timers.
     * @param {string} factionId - ID from WorldManager.factions.
     * @param {number} initialStanding - -3 to +3.
     * @param {object} timerOverrides - Override timer segments.
     */
    initFaction(factionId, initialStanding = 0, timerOverrides = {}) {
        const factionTemplate = this.world.getFaction(factionId);
        if (!factionTemplate) {
            throw new Error(`Faction ${factionId} not found in world data.`);
        }
        this.factions[factionId] = {
            standing: Math.max(-3, Math.min(3, initialStanding)),
            timers: {
                agenda: {
                    segments: timerOverrides.agenda || DEFAULT_TIMER_SEGMENTS,
                    current: 0
                },
                crisis: {
                    segments: timerOverrides.crisis || 6,
                    current: 0
                },
                // Add any additional timers from template
                ...timerOverrides
            },
            // Store template reference for future use
            template: factionTemplate,
            events: [], // list of triggered events
            lastUpdated: Date.now()
        };
        return this.factions[factionId];
    }

    /**
     * Tick a faction's timer.
     * @param {string} factionId
     * @param {string} timerName - e.g., 'agenda', 'crisis'
     * @param {number} amount - ticks to add (default 1)
     * @returns {boolean} - true if timer filled.
     */
    tickFactionTimer(factionId, timerName, amount = 1) {
        const faction = this.factions[factionId];
        if (!faction) return false;
        const timer = faction.timers[timerName];
        if (!timer) return false;
        timer.current += amount;
        if (timer.current >= timer.segments) {
            timer.current = timer.segments; // clamp
            return true; // timer filled
        }
        return false;
    }

    /**
     * Reset a faction's timer (set current to 0).
     */
    resetFactionTimer(factionId, timerName) {
        const faction = this.factions[factionId];
        if (!faction) return;
        const timer = faction.timers[timerName];
        if (timer) timer.current = 0;
    }

    /**
     * Adjust faction standing.
     */
    adjustFactionStanding(factionId, delta) {
        const faction = this.factions[factionId];
        if (!faction) return;
        faction.standing = Math.max(-3, Math.min(3, faction.standing + delta));
        faction.lastUpdated = Date.now();
        return faction.standing;
    }

    /**
     * Get all factions and their current states.
     */
    getFactionStates() {
        return Object.entries(this.factions).map(([id, state]) => ({
            id,
            name: state.template?.name || id,
            standing: state.standing,
            timers: state.timers,
            events: state.events || []
        }));
    }

    // ============================================================
    // FACTION TURN – PROGRESS ALL FACTIONS
    // ============================================================

    /**
     * Advance all faction timers by a given amount.
     * @param {number} ticks - number of ticks to add to each faction's agenda timer (default 1).
     * @param {object} options - optional: { skipCrisis: false, standingModifiers: {} }
     * @returns {Array} - list of triggered events { factionId, timerName, event: 'filled' }
     */
    tickFactions(ticks = 1, options = {}) {
        const events = [];
        const factionIds = Object.keys(this.factions);
        for (const id of factionIds) {
            const faction = this.factions[id];
            if (!faction) continue;

            // Tick agenda timer
            const agendaFilled = this.tickFactionTimer(id, 'agenda', ticks);
            if (agendaFilled) {
                const event = {
                    factionId: id,
                    factionName: faction.template?.name || id,
                    timerName: 'agenda',
                    event: 'filled',
                    description: `The ${faction.template?.name || id} advances its agenda.`,
                    timestamp: Date.now()
                };
                faction.events = faction.events || [];
                faction.events.push(event);
                events.push(event);
                // Reset timer after fill (so it can start again)
                this.resetFactionTimer(id, 'agenda');
            }

            // Optionally tick crisis timer if standing is low
            if (!options.skipCrisis && faction.standing < 0) {
                const crisisAmount = Math.abs(faction.standing); // more negative = faster crisis
                const crisisFilled = this.tickFactionTimer(id, 'crisis', crisisAmount);
                if (crisisFilled) {
                    const event = {
                        factionId: id,
                        factionName: faction.template?.name || id,
                        timerName: 'crisis',
                        event: 'crisis_erupted',
                        description: `The ${faction.template?.name || id} faces a crisis!`,
                        timestamp: Date.now()
                    };
                    faction.events.push(event);
                    events.push(event);
                    this.resetFactionTimer(id, 'crisis');
                }
            }
        }
        this.factionEvents = this.factionEvents.concat(events);
        // Keep only last 50 events
        if (this.factionEvents.length > 50) {
            this.factionEvents = this.factionEvents.slice(-50);
        }
        return events;
    }

    // ============================================================
    // DOWNTIME PROCESSING
    // ============================================================

    /**
     * Process downtime for the campaign: trim Boons, convert to XP,
     * tick faction timers, and optionally advance Mandate/Crisis.
     * @param {object} charactersModule - reference to the characters module (must have getAll, applyDelta, etc.)
     * @param {object} options - { trimBoons: true, convertBoons: true, factionTicks: 1, advanceTimers: true }
     * @returns {object} - report with changes: { boonTrims, xpGains, factionEvents, mandateChange, crisisChange }
     */
    processDowntime(charactersModule, options = {}) {
        const report = {
            boonTrims: [],
            xpGains: [],
            factionEvents: [],
            mandateChange: 0,
            crisisChange: 0
        };

        // 1. Trim Boons and convert to XP
        if (options.trimBoons !== false) {
            const allChars = charactersModule.getAll();
            for (const [name, char] of Object.entries(allChars)) {
                let boons = char.boons || 0;
                if (boons > MAX_BOONS_CARRYOVER) {
                    // Determine how many Boons to convert
                    const convertible = Math.min(
                        Math.floor((boons - MAX_BOONS_CARRYOVER) / 2),
                        MAX_XP_FROM_BOONS_PER_SESSION
                    );
                    if (convertible > 0 && options.convertBoons !== false) {
                        const xpGained = convertible; // 2 Boons -> 1 XP
                        if (char.xp === undefined) char.xp = 0;
                        char.xp += xpGained;
                        boons -= convertible * 2;
                        report.xpGains.push({ name, xp: xpGained });
                    }
                    if (boons > MAX_BOONS_CARRYOVER) {
                        const trimmed = boons - MAX_BOONS_CARRYOVER;
                        boons = MAX_BOONS_CARRYOVER;
                        report.boonTrims.push({ name, trimmed });
                    }
                    char.boons = boons;
                }
            }
        }

        // 2. Tick faction timers
        if (options.factionTicks > 0) {
            const events = this.tickFactions(options.factionTicks, { skipCrisis: false });
            report.factionEvents = events;
        }

        // 3. Save campaign after downtime
        this.save().catch(err => console.error('Error saving after downtime:', err));

        return report;
    }

    // ============================================================
    // TRUST MANAGEMENT
    // ============================================================

    /**
     * Add or update a trust.
     */
    setTrust(trustId, trustData) {
        this.trusts[trustId] = {
            ...trustData,
            assets: trustData.assets || [],
            followers: trustData.followers || [],
            obligation: trustData.obligation || 0,
            capacity: trustData.capacity || 4,
            lastUpdated: Date.now()
        };
    }

    /**
     * Get a trust.
     */
    getTrust(trustId) {
        return this.trusts[trustId] || null;
    }

    /**
     * Add an asset to a trust.
     */
    addTrustAsset(trustId, asset) {
        const trust = this.trusts[trustId];
        if (!trust) return false;
        if (!trust.assets) trust.assets = [];
        trust.assets.push({
            id: asset.id || `asset-${Date.now()}`,
            name: asset.name,
            type: asset.type || 'asset',
            tier: asset.tier || 'Minor',
            description: asset.description || '',
            cost: asset.cost || 0,
            status: 'Maintained',
            ...asset
        });
        return true;
    }

    /**
     * Add a follower to a trust.
     */
    addTrustFollower(trustId, follower) {
        const trust = this.trusts[trustId];
        if (!trust) return false;
        if (!trust.followers) trust.followers = [];
        trust.followers.push({
            id: follower.id || `follower-${Date.now()}`,
            name: follower.name,
            cap: follower.cap || 1,
            role: follower.role || 'Follower',
            loyalty: follower.loyalty || 'Faithful',
            fitness: follower.fitness || 'Ready',
            ...follower
        });
        return true;
    }

    // ============================================================
    // ASSET MANAGEMENT
    // ============================================================

    /**
     * Track an asset (could be independent of a trust).
     */
    setAsset(assetId, assetData) {
        this.assets[assetId] = {
            ...assetData,
            status: assetData.status || 'Maintained',
            lastUpdated: Date.now()
        };
    }

    /**
     * Get an asset.
     */
    getAsset(assetId) {
        return this.assets[assetId] || null;
    }

    /**
     * Update asset status (Maintained, Neglected, Compromised).
     */
    updateAssetStatus(assetId, status) {
        const asset = this.assets[assetId];
        if (!asset) return false;
        asset.status = status;
        asset.lastUpdated = Date.now();
        return true;
    }

    // ============================================================
    // TIMER MANAGEMENT (general)
    // ============================================================

    /**
     * Create a generic timer.
     */
    setTimer(name, segments, current = 0) {
        this.timers[name] = { segments, current };
    }

    /**
     * Tick a generic timer.
     * @returns {boolean} true if filled.
     */
    tickTimer(name, amount = 1) {
        const timer = this.timers[name];
        if (!timer) return false;
        timer.current += amount;
        if (timer.current >= timer.segments) {
            timer.current = timer.segments;
            return true;
        }
        return false;
    }

    /**
     * Get timer state.
     */
    getTimer(name) {
        return this.timers[name] || null;
    }

    // ============================================================
    // CHARACTER SYNC (optional)
    // ============================================================

    /**
     * Update character stats.
     */
    updateCharacter(name, stats) {
        this.characters[name] = {
            ...this.characters[name],
            ...stats
        };
    }

    /**
     * Get character stats.
     */
    getCharacter(name) {
        return this.characters[name] || null;
    }

    // ============================================================
    // UTILITY
    // ============================================================

    /**
     * Generate a summary of the campaign state for AI prompts.
     */
    getSummary() {
        const factionSummary = this.getFactionStates().map(f =>
            `${f.name}: Standing ${f.standing}, Agenda ${f.timers.agenda.current}/${f.timers.agenda.segments}`
        ).join('\n');
        const trustSummary = Object.values(this.trusts).map(t =>
            `${t.name}: Obligation ${t.obligation}/${t.capacity}, Assets ${t.assets?.length || 0}`
        ).join('\n');
        const timerSummary = Object.entries(this.timers).map(([name, t]) =>
            `${name}: ${t.current}/${t.segments}`
        ).join('\n');
        return `Mandate: ${this.mandate}/6\nCrisis: ${this.crisis}/6\n\nFactions:\n${factionSummary}\n\nTrusts:\n${trustSummary}\n\nTimers:\n${timerSummary}`;
    }

    /**
     * Get a detailed report of the last faction events.
     */
    getFactionEventReport(limit = 10) {
        return this.factionEvents.slice(-limit).map(e =>
            `[${new Date(e.timestamp).toLocaleString()}] ${e.factionName}: ${e.description}`
        ).join('\n');
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    WorldManager,
    CampaignManager,
    REGION_DATA_DIR,
    WORLD_DATA_DIR,
    DEFAULT_TIMER_SEGMENTS,
    MAX_BOONS_CARRYOVER,
    MAX_XP_FROM_BOONS_PER_SESSION
};