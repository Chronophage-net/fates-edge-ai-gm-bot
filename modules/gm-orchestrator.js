// modules/gm-orchestrator.js
/**
 * Game Master Orchestrator Module
 * 
 * The brain of the AI GM bot. Integrates all other modules.
 * Now uses the campaign manager's state as the single source of truth.
 * Adventure-aware NPC generation added via adventureContext.
 */

const { WorldManager, CampaignManager } = require('./world-manager.js');
const deck = require('./deck.js');
const characters = require('./characters.js');
const adventureContext = require('./adventure-context.js');

// ============================================================
// NPC TEMPLATES (unchanged)
// ============================================================

const NPC_TEMPLATES = {
  generic: {
    archetypes: ['Villager', 'Guard', 'Merchant', 'Noble', 'Cultist', 'Rogue', 'Soldier', 'Scholar'],
    descriptors: ['Weary', 'Sharp-eyed', 'Friendly', 'Suspicious', 'Bold', 'Quiet', 'Chatty', 'Gruff'],
    motivations: ['Coin', 'Revenge', 'Loyalty', 'Fear', 'Ambition', 'Justice', 'Survival', 'Love']
  },
  acasia: {
    archetypes: ['Free Company Captain', 'Hedge-Witch', 'Tithe-Collector', 'Road Warden', 'Banner-Lord'],
    descriptors: ['Scarred', 'Cunning', 'Broken', 'Proud', 'Desperate', 'Honorable'],
    motivations: ['Survival', 'Feud', 'Contract', 'Glory', 'Revenge', 'The Curse']
  },
  vhasia: {
    archetypes: ['Knight', 'Courtier', 'Duchy Constable', 'Routier', 'Sun-Court Claimant', 'Parlement Clerk'],
    descriptors: ['Chivalrous', 'Scheming', 'Bitter', 'Proud', 'Ruthless', 'Honorable'],
    motivations: ['Legitimacy', 'Vengeance', 'Ambition', 'Love', 'Honor', 'Survival']
  },
  viterra: {
    archetypes: ['Justiciar', 'Fen Reeve', 'Dawn-Knight', 'Hedge-Wright', 'Queen\'s Agent', 'Legal Advocate'],
    descriptors: ['Precise', 'Patient', 'Stern', 'Wary', 'Just', 'Pragmatic'],
    motivations: ['Law', 'Justice', 'Order', 'Duty', 'Coin', 'Protection']
  },
  ykrul: {
    archetypes: ['Bone-Singer', 'Herd-Scout', 'Hostage-Keeper', 'Khagan\'s Envoy', 'Sky-Speaker', 'Raider'],
    descriptors: ['Pragmatic', 'Proud', 'Silent', 'Watchful', 'Bold', 'Stoic'],
    motivations: ['Honor', 'Survival', 'Freedom', 'Revenge', 'Glory', 'The Steppe']
  },
  valewood: {
    archetypes: ['Pathweaver', 'Fae Courtier', 'Beast-Kin', 'Imperial Shade', 'Hedge-Witch', 'Huntsman'],
    descriptors: ['Ancient', 'Fey', 'Watchful', 'Patient', 'Hungry', 'Courteous'],
    motivations: ['Old Laws', 'The Forest', 'Secrets', 'Revenge', 'Balance', 'Hunger']
  },
  zakov: {
    archetypes: ['Salt Prince\'s Enforcer', 'Pirate Queen', 'Dock-Rat', 'Smuggler Captain', 'Cultist', 'Fence'],
    descriptors: ['Greedy', 'Cunning', 'Bold', 'Slippery', 'Cruel', 'Charming'],
    motivations: ['Coin', 'Power', 'Survival', 'Revenge', 'Freedom', 'The Reaping']
  },
  ecktoria: {
    archetypes: ['Censor\'s Clerk', 'Flame-Warden', 'Imperial Legate', 'Merchant Prince', 'Abbess', 'Inquisitor'],
    descriptors: ['Pious', 'Ambitious', 'Cold', 'Calculating', 'Devout', 'Patient'],
    motivations: ['The Empire', 'The Flame', 'Power', 'Purity', 'Control', 'Legacy']
  }
};

// ============================================================
// ORCHESTRATOR CLASS
// ============================================================

class Orchestrator {
  /**
   * @param {WorldManager} worldManager - The world data provider.
   * @param {object} options - Configuration options.
   */
  constructor(worldManager, options = {}) {
    this.world = worldManager;
    this.options = {
      roomCode: options.roomCode || 'AI-GM',
      serverUrl: options.serverUrl || 'http://localhost:3000',
      maxSceneTimers: options.maxSceneTimers || 3,
      defaultRegion: options.defaultRegion || 'acasia-broken-marches',
      ...options
    };

    // Campaign manager (set later)
    this.campaign = null;
    
    // Internal state (synced from campaign.state)
    this.currentScene = null;
    this.sceneHistory = [];
    this.pendingComplications = [];
    this.context = {
      region: this.options.defaultRegion,
      location: 'Unknown',
      time: 'Day',
      mood: 'Neutral'
    };
    this.initialized = false;
  }

  // ─── STATE ACCESS ──────────────────────────────────────────────

  /**
   * Get the campaign state object. Initializes it if missing.
   */
  get state() {
    if (!this.campaign) return null;
    if (!this.campaign.state) {
      this.campaign.state = this._defaultCampaignState();
    }
    return this.campaign.state;
  }

  /**
   * Default campaign state structure.
   */
  _defaultCampaignState() {
    return {
      conversation: [],
      facts: {},
      scene: {
        position: 'Controlled',
        defaultDV: 3,
        location: 'Unknown',
        timers: [],
        id: null,
        region: this.options.defaultRegion,
        hook: null,
        started: null,
        events: [],
        npcs: [],
        active: false,
        mood: 'Neutral',
        resolved: null,
        resolution: null,
        outcomes: {}
      },
      sb: 0,
      messagesSinceLastSummary: 0,
      // campaign metadata
      campaignCode: null
    };
  }

  // ─── HELPER METHODS FOR COMMANDS ──────────────────────────────
  // NOTE: setPosition()/setDefaultDV()/spendStoryBeats()/setFact() used
  // to live here too, but nothing ever called them -- the live !gm
  // command/tag handlers (gm-commands.js, process-tags.js) write
  // campaignState.scene.position/.defaultDV/.facts directly instead.
  // Removed as dead duplicates; addStoryBeats()/addConversation() below
  // ARE genuinely called (the WS roll handler, chat history tracking)
  // so they stay.

  addStoryBeats(n) {
    if (this.state) this.state.sb = (this.state.sb || 0) + n;
  }

  addConversation(entry) {
    if (this.state) this.state.conversation.push(entry);
  }

  /**
   * Save the current campaign (including state).
   */
  async save() {
    if (!this.campaign) return null;
    return await this.campaign.save();
  }

  // ─── INITIALISATION ────────────────────────────────────────────

  async initialize() {
    if (this.initialized) return this;

    if (!this.world.loaded) {
      await this.world.loadAll();
    }

    deck.setWorldManager(this.world);

    // Create campaign manager (if not already set)
    if (!this.campaign) {
      this.campaign = new CampaignManager(
        this.world,
        this.options.roomCode,
        this.options.serverUrl,
        this.options.apiKey || ''
      );
    }

    // Ensure state is initialised
    if (!this.state) {
      this.campaign.state = this._defaultCampaignState();
    }

    // Sync any existing data
    this._syncFromState();

    this.initialized = true;
    console.log(`🎮 GM Orchestrator initialized for room ${this.options.roomCode}`);
    return this;
  }

  /**
   * Load a campaign from the server.
   */
  async loadCampaign(campaignCode) {
    if (!this.initialized) await this.initialize();
    await this.campaign.load(campaignCode);
    // After load, state is updated; sync our internal fields
    this._syncFromState();
    return this;
  }

  /**
   * Sync orchestrator's internal fields from the campaign state.
   */
  _syncFromState() {
    if (!this.state) return;
    const s = this.state;

    // Restore scene from stored state if any
    if (s.scene && s.scene.location) {
      this.currentScene = {
        id: s.scene.id || `scene-${Date.now()}`,
        region: s.scene.region || this.options.defaultRegion,
        location: s.scene.location,
        hook: s.scene.hook || 'The story continues...',
        started: s.scene.started || Date.now(),
        timers: s.scene.timers || [],
        events: s.scene.events || [],
        npcs: s.scene.npcs || [],
        active: s.scene.active !== undefined ? s.scene.active : true,
        mood: s.scene.mood || 'Neutral',
        resolved: s.scene.resolved || null,
        resolution: s.scene.resolution || null,
        outcomes: s.scene.outcomes || {}
      };
    }

    // Restore context
    if (s.scene) {
      this.context.location = s.scene.location || 'Unknown';
      this.context.mood = s.scene.mood || 'Neutral';
    }
  }

  // ─── NPC GENERATION ─────────────────────────────────────────────

  generateNPC(region = null, overrides = {}, detailed = true) {
    const regionKey = region || this.currentScene?.region || this.options.defaultRegion;
    const template = NPC_TEMPLATES[regionKey] || NPC_TEMPLATES.generic;

    const archetypes = template.archetypes || NPC_TEMPLATES.generic.archetypes;
    const descriptors = template.descriptors || NPC_TEMPLATES.generic.descriptors;
    const motivations = template.motivations || NPC_TEMPLATES.generic.motivations;

    const npc = {
      id: overrides.id || `npc-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: overrides.name || this.generateName(regionKey),
      archetype: overrides.archetype || archetypes[Math.floor(Math.random() * archetypes.length)],
      descriptor: overrides.descriptor || descriptors[Math.floor(Math.random() * descriptors.length)],
      motivation: overrides.motivation || motivations[Math.floor(Math.random() * motivations.length)],
      region: regionKey,
      ...overrides
    };

    if (detailed) {
      const stats = this.generateNPCStats(npc.archetype, npc.descriptor);
      npc.attributes = stats.attributes;
      npc.skills = stats.skills;
      npc.harm = 0;
      npc.fatigue = 0;
      npc.tier = stats.tier || 1;
      npc.cap = stats.cap || 1;
      npc.quirks = this.generateQuirks(regionKey);
    }

    return npc;
  }

  generateName(region) {
    const nameSets = {
      acasia: ['Aldric', 'Bors', 'Cedric', 'Dorian', 'Emeric', 'Falk', 'Gareth', 'Hugh', 'Ivo', 'Jax'],
      vhasia: ['Arnault', 'Brielle', 'Chambard', 'Delphine', 'Etienne', 'Guy', 'Isabeau', 'Lucien', 'Margot', 'Renaud'],
      viterra: ['Aelfred', 'Baldric', 'Cuthbert', 'Elfrida', 'Godric', 'Hilda', 'Leofric', 'Morcar', 'Osric', 'Wulfric'],
      ykrul: ['Bortei', 'Edil', 'Khasar', 'Mongke', 'Saruul', 'Temur', 'Urum', 'Yara'],
      valewood: ['Alba', 'Caelith', 'Eryndor', 'Fenn', 'Liriel', 'Oren', 'Riven', 'Sila', 'Vesper'],
      zakov: ['Dmytro', 'Kostya', 'Lev', 'Mila', 'Olena', 'Ruslan', 'Sarkis', 'Zoya'],
      ecktoria: ['Aurelius', 'Cassia', 'Decimus', 'Flavia', 'Hadrian', 'Livia', 'Marcus', 'Valerius']
    };
    const names = nameSets[region] || ['Aldric', 'Brielle', 'Cedric', 'Delphine', 'Emeric', 'Isabeau'];
    return names[Math.floor(Math.random() * names.length)];
  }

  generateNPCStats(archetype, descriptor) {
    const base = {
      attributes: { Body: 2, Wits: 2, Spirit: 2, Presence: 2 },
      skills: {
        Melee: 0, Ranged: 0, Unarmed: 0,
        Athletics: 0, Stealth: 0, Endurance: 0, Craft: 0,
        Sway: 0, Deception: 0, Subterfuge: 0, Performance: 0, Insight: 0,
        Lore: 0, Investigation: 0, Medicine: 0,
        Arcana: 0
      }
    };

    const archetypeStats = {
      'Guard': { Body: 3, Wits: 2, Melee: 2, Athletics: 1, tier: 1, cap: 2 },
      'Soldier': { Body: 3, Wits: 2, Melee: 2, Ranged: 1, Endurance: 1, tier: 2, cap: 2 },
      'Noble': { Presence: 3, Spirit: 2, Sway: 2, Insight: 1, tier: 2, cap: 1 },
      'Merchant': { Presence: 2, Wits: 3, Sway: 2, Subterfuge: 1, Craft: 1, tier: 1, cap: 1 },
      'Cultist': { Spirit: 3, Wits: 2, Arcana: 2, Lore: 1, tier: 2, cap: 1 },
      'Rogue': { Body: 2, Wits: 3, Stealth: 2, Subterfuge: 2, tier: 2, cap: 1 },
      'Scholar': { Wits: 3, Spirit: 2, Lore: 2, Investigation: 1, tier: 1, cap: 1 },
      'Villager': { Body: 2, Wits: 2, Craft: 1, Athletics: 1, tier: 0, cap: 1 },
      'Knight': { Body: 3, Presence: 2, Melee: 3, Endurance: 1, tier: 2, cap: 2 },
      'Courtier': { Presence: 3, Wits: 2, Sway: 2, Deception: 1, Insight: 1, tier: 2, cap: 1 },
      'Hedge-Witch': { Spirit: 3, Wits: 2, Arcana: 2, Lore: 1, Medicine: 1, tier: 2, cap: 1 },
      'Raider': { Body: 3, Melee: 2, Ranged: 1, Athletics: 2, tier: 2, cap: 2 }
    };

    const stats = archetypeStats[archetype] || archetypeStats['Villager'];
    const result = {
      attributes: { ...base.attributes, ...stats },
      skills: { ...base.skills, ...stats },
      tier: stats.tier || 1,
      cap: stats.cap || 1
    };

    const descriptorBonuses = {
      'Weary': { fatigue: 1 },
      'Sharp-eyed': { Wits: 1, Insight: 1 },
      'Friendly': { Presence: 1, Sway: 1 },
      'Suspicious': { Wits: 1, Insight: 1 },
      'Bold': { Spirit: 1, Presence: 1 },
      'Quiet': { Wits: 1, Stealth: 1 },
      'Chatty': { Presence: 1, Sway: 1 },
      'Gruff': { Body: 1, Melee: 1 },
      'Scarred': { Body: 1, Endurance: 1 },
      'Cunning': { Wits: 1, Subterfuge: 1 },
      'Broken': { Spirit: -1, fatigue: 1 },
      'Proud': { Presence: 1, Sway: 1 },
      'Desperate': { Body: 1, Melee: 1 },
      'Honorable': { Spirit: 1, Presence: 1 },
      'Scheming': { Wits: 1, Deception: 1 },
      'Ruthless': { Body: 1, Melee: 1 }
    };

    const bonus = descriptorBonuses[descriptor] || {};
    for (const [key, val] of Object.entries(bonus)) {
      if (key === 'fatigue') {
        result.fatigue = val;
      } else if (result.attributes[key] !== undefined) {
        result.attributes[key] = (result.attributes[key] || 0) + val;
      } else if (result.skills[key] !== undefined) {
        result.skills[key] = (result.skills[key] || 0) + val;
      }
    }

    return result;
  }

  generateQuirks(region) {
    const quirkSets = {
      acasia: ['Always counts under their breath', 'Wears a broken seal on a string', 'Has a map tattoo that changes'],
      vhasia: ['Touches their gorget when speaking of mercy', 'Speaks in legal precedent', 'Carries a cracked mirror'],
      viterra: ['Ties red thread to everything', 'Has a tally-stick notched with grudges', 'Mumbles hedge-law'],
      ykrul: ['Smells the wind before speaking', 'Wears a hostage string on their wrist', 'Counts hoofbeats'],
      valewood: ['Carries a living branch', 'Speaks in riddles', 'Has eyes that reflect moonlight'],
      zakov: ['Keeps one hand on a coin', 'Counts tides silently', 'Wears a Serpent\'s Mark']
    };
    const quirks = quirkSets[region] || ['Has a nervous tic', 'Speaks in a dialect you don\'t recognize'];
    return quirks[Math.floor(Math.random() * quirks.length)];
  }

  // ─── SHUTDOWN ──────────────────────────────────────────────────

  async shutdown() {
    if (this.campaign && this.campaign.campaignCode) {
      await this.save();
    }
    console.log('🎮 GM Orchestrator shutting down.');
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  Orchestrator,
  NPC_TEMPLATES
};