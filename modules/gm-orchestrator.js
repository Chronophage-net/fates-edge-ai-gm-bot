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
const timers = require('./timers.js');
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
      campaignCode: null,
      factions: {},
      trusts: {},
      assets: {},
      mandate: 0,
      crisis: 0,
      meta: {}
    };
  }

  // ─── HELPER METHODS FOR COMMANDS ──────────────────────────────

  setPosition(pos) {
    if (this.state) this.state.scene.position = pos;
  }

  setDefaultDV(dv) {
    if (this.state) this.state.scene.defaultDV = dv;
  }

  addStoryBeats(n) {
    if (this.state) this.state.sb = (this.state.sb || 0) + n;
  }

  spendStoryBeats(n) {
    if (this.state && this.state.sb >= n) {
      this.state.sb -= n;
      return true;
    }
    return false;
  }

  setFact(key, value) {
    if (this.state) this.state.facts[key] = value;
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

  /**
   * Sync orchestrator state to campaign state.
   */
  _syncToState() {
    if (!this.state || !this.currentScene) return;
    const s = this.state;
    const scene = this.currentScene;

    s.scene.id = scene.id;
    s.scene.region = scene.region;
    s.scene.location = scene.location;
    s.scene.hook = scene.hook;
    s.scene.started = scene.started;
    s.scene.timers = scene.timers || [];
    s.scene.events = scene.events || [];
    s.scene.npcs = scene.npcs || [];
    s.scene.active = scene.active;
    s.scene.mood = scene.mood || 'Neutral';
    s.scene.resolved = scene.resolved || null;
    s.scene.resolution = scene.resolution || null;
    s.scene.outcomes = scene.outcomes || {};
  }

  // ─── SCENE MANAGEMENT ──────────────────────────────────────────

  async startScene(regionId, location, hook, options = {}) {
    const scene = {
      id: `scene-${Date.now()}`,
      region: regionId || this.options.defaultRegion,
      location: location || 'Unknown',
      hook: hook || 'The party finds themselves in a situation that demands action.',
      started: Date.now(),
      timers: [],
      events: [],
      npcs: options.npcs || [],
      active: true,
      mood: 'Neutral',
      ...options
    };

    // Clear scene timers in state
    if (this.state) {
      this.state.scene.timers = [];
      this.state.scene.location = scene.location;
      this.state.scene.position = options.position || 'Controlled';
      this.state.scene.defaultDV = options.defaultDV || 3;
      this.state.scene.id = scene.id;
      this.state.scene.region = scene.region;
      this.state.scene.hook = scene.hook;
      this.state.scene.started = scene.started;
      this.state.scene.events = [];
      this.state.scene.npcs = scene.npcs;
      this.state.scene.active = true;
      this.state.scene.mood = scene.mood;
    }

    // Generate scene mood from Crown Spread
    try {
      const spread = await deck.crownSpread(regionId);
      scene.crownSpread = spread;
      scene.mood = this.interpretCrownSpread(spread);
      if (this.state) this.state.scene.mood = scene.mood;
    } catch (e) {
      // fallback
    }

    // Add initial timer (stored in scene.timers)
    const timerSegments = options.timerSegments || 4;
    const timerState = { 
      scene: { timers: scene.timers }, 
      campaign: { timers: [] } 
    };
    timers.addTimer(
      timerState,
      'Scene Progress',
      timerSegments,
      'The scene reaches a critical turning point.',
      { tags: ['scene'] }
    );
    scene.timers = timerState.scene.timers;
    if (this.state) this.state.scene.timers = scene.timers;

    this.currentScene = scene;
    this.sceneHistory.push({
      id: scene.id,
      region: scene.region,
      location: scene.location,
      started: scene.started,
      mood: scene.mood
    });

    // Persist
    await this.save();

    return this.currentScene;
  }

  endScene(resolution, outcomes = {}) {
    if (!this.currentScene) return null;
    this.currentScene.active = false;
    this.currentScene.resolved = Date.now();
    this.currentScene.resolution = resolution;
    this.currentScene.outcomes = outcomes;

    // Update state
    if (this.state) {
      this.state.scene.active = false;
      this.state.scene.resolved = this.currentScene.resolved;
      this.state.scene.resolution = resolution;
      this.state.scene.outcomes = outcomes;
    }

    const completedScene = this.currentScene;
    this.currentScene = null;
    this.save();
    return completedScene;
  }

  // ─── PLAYER ACTION RESOLUTION ──────────────────────────────────

  async resolveAction(playerName, action, poolExpr, dv = 3, position = 'Controlled', boonSpend = 0, options = {}) {
    const char = characters.get(playerName);
    if (!char) {
      return {
        success: false,
        error: `Character "${playerName}" not found.`,
        complication: 'The character is not available.'
      };
    }

    const poolSize = characters.getPool(playerName, poolExpr);
    if (poolSize === 0) {
      return {
        success: false,
        error: `Invalid dice pool expression: "${poolExpr}".`,
        complication: 'The action cannot be resolved.'
      };
    }

    // Apply boon spend (improve position)
    let actualPosition = position;
    if (boonSpend > 0) {
      if (char.boons >= boonSpend) {
        char.boons -= boonSpend;
        if (position === 'Controlled') actualPosition = 'Dominant';
        else if (position === 'Desperate') actualPosition = 'Controlled';
      } else {
        return {
          success: false,
          error: `Not enough Boons. Need ${boonSpend}, have ${char.boons}.`,
          complication: 'The action fails due to insufficient resources.'
        };
      }
    }

    // Roll dice
    const dice = [];
    let successCount = 0;
    let storyBeats = 0;
    for (let i = 0; i < poolSize; i++) {
      const roll = Math.floor(Math.random() * 10) + 1;
      dice.push(roll);
      if (roll >= 6) {
        successCount++;
        if (roll === 10) successCount++;
      }
      if (roll === 1) storyBeats++;
    }

    const isSuccess = successCount >= dv;

    // Determine outcome
    let outcome = '';
    let playerGain = 0;
    if (isSuccess) {
      outcome = storyBeats === 0 ? 'Clean Success' : 'Success with SB';
    } else if (successCount > 0 && successCount < dv) {
      outcome = 'Partial';
      playerGain = 1;
    } else {
      outcome = 'Miss';
      playerGain = 2;
    }

    if (playerGain > 0) {
      char.boons = Math.min(5, char.boons + playerGain);
    }

    // Generate complications from Story Beats
    let complications = [];
    if (storyBeats > 0) {
      complications = await deck.processStoryBeats(
        storyBeats,
        this.currentScene?.region || this.options.defaultRegion,
        this.campaign,
        this.getActiveComplications()
      );
    }

    const result = {
      player: playerName,
      action,
      pool: poolExpr,
      dice,
      successes: successCount,
      dv,
      position: actualPosition,
      isSuccess,
      outcome,
      storyBeats,
      boonsEarned: playerGain,
      boonsRemaining: char.boons,
      complications,
      timestamp: Date.now()
    };

    // Update campaign state with story beats
    if (storyBeats > 0) {
      this.addStoryBeats(storyBeats);
    }

    // Tick scene timer on Partial/Miss
    if (outcome === 'Partial' || outcome === 'Miss') {
      const timerState = { 
        scene: { timers: this.currentScene?.timers || [] }, 
        campaign: { timers: [] } 
      };
      timers.tickTimer(timerState, 'Scene Progress', 1);
      if (this.currentScene) {
        this.currentScene.timers = timerState.scene.timers;
        if (this.state) this.state.scene.timers = timerState.scene.timers;
      }
    }

    // Check if scene timer filled
    const timerState = { 
      scene: { timers: this.currentScene?.timers || [] }, 
      campaign: { timers: [] } 
    };
    const sceneProgress = timers.getTimerProgress(timerState, 'Scene Progress');
    if (sceneProgress && sceneProgress.filled) {
      const timerEvent = timers.resolveTimer(timerState, 'Scene Progress');
      result.sceneEvent = timerEvent.event;
      // Restart scene timer
      if (this.currentScene && this.currentScene.active) {
        const newTimerState = { scene: { timers: this.currentScene.timers }, campaign: { timers: [] } };
        timers.addTimer(
          newTimerState,
          'Scene Progress',
          Math.max(4, this.currentScene.timerSegments || 4),
          'The scene reaches another critical turning point.',
          { tags: ['scene'] }
        );
        this.currentScene.timers = newTimerState.scene.timers;
        if (this.state) this.state.scene.timers = newTimerState.scene.timers;
      }
    }

    // Record event in scene
    if (this.currentScene) {
      this.currentScene.events.push({
        type: 'action',
        player: playerName,
        action,
        result: result.outcome,
        timestamp: Date.now()
      });
      if (this.state) {
        this.state.scene.events = this.currentScene.events;
      }
    }

    // Save campaign
    await this.save();

    return result;
  }

  // ─── STORY BEAT PROCESSING ─────────────────────────────────────

  async processStoryBeats(count, source = 'unknown') {
    if (count <= 0) return [];

    const complications = await deck.processStoryBeats(
      count,
      this.currentScene?.region || this.options.defaultRegion,
      this.campaign,
      this.getActiveComplications()
    );

    this.pendingComplications.push({
      source,
      complications,
      timestamp: Date.now(),
      processed: false
    });

    if (this.currentScene && this.currentScene.active) {
      for (const comp of complications) {
        this.currentScene.events.push({
          type: 'complication',
          description: comp,
          timestamp: Date.now()
        });
      }
      if (this.state) this.state.scene.events = this.currentScene.events;
    }

    return complications;
  }

  getActiveComplications() {
    const comps = [];
    if (this.currentScene) {
      for (const event of this.currentScene.events) {
        if (event.type === 'complication') {
          comps.push(event.description);
        }
      }
    }
    // Add timer names
    const timers = this.currentScene?.timers || this.state?.scene?.timers || [];
    for (const timer of timers) {
      comps.push(`Timer "${timer.name}" at ${timer.current}/${timer.max}`);
    }
    return comps;
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

  /**
   * Adventure-aware NPC lookup/generation. Checks the CURRENTLY LOADED
   * adventure's own npcs[] and bestiary[] first (via adventure-context.js
   * -- exactly what the module's author wrote for this specific story),
   * and only falls back to generateNPC()'s generic per-region templates
   * if nothing matches or no adventure is loaded. `context` here is the
   * same { apiRequest, ... } shape passed to !gm command handlers.
   */
  async generateNPCAware(context, name, region = null, overrides = {}) {
    if (name) {
      const activeNpc = await adventureContext.getActiveNpc(context, name);
      if (activeNpc) {
        return {
          name: activeNpc.name,
          role: activeNpc.role || 'NPC',
          motivation: activeNpc.motivation || '',
          region: region || this.currentScene?.region || this.options.defaultRegion,
          source: 'adventure', // distinguishes a real module NPC from a generated one
          ...overrides,
        };
      }
      const activeCreature = await adventureContext.getActiveCreature(context, name);
      if (activeCreature) {
        return {
          name: activeCreature.name,
          role: activeCreature.class || activeCreature.category || 'Creature',
          stats: activeCreature.stats,
          sb_spends: activeCreature.sb_spends,
          region: region || this.currentScene?.region || this.options.defaultRegion,
          source: 'adventure',
          ...overrides,
        };
      }
    }
    // Fall through to the existing generic generator -- unchanged.
    return this.generateNPC(region, overrides);
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

  generateNPCS(count, region = null, includeStats = true) {
    const npcs = [];
    for (let i = 0; i < count; i++) {
      npcs.push(this.generateNPC(region, {}, includeStats));
    }
    return npcs;
  }

  // ─── CROWN SPREAD INTERPRETATION ──────────────────────────────

  interpretCrownSpread(spread) {
    if (!spread || !spread.positions) return 'Neutral';
    const moods = [];
    for (const pos of spread.positions) {
      if (pos.meaning) {
        const keywords = ['danger', 'opportunity', 'mystery', 'conflict', 'revelation', 'betrayal', 'hope'];
        for (const kw of keywords) {
          if (pos.meaning.toLowerCase().includes(kw)) {
            moods.push(kw);
          }
        }
      }
    }
    if (moods.length === 0) return 'Neutral';
    const counts = {};
    for (const m of moods) {
      counts[m] = (counts[m] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0][0];
  }

  // ─── CONTEXT GENERATION ────────────────────────────────────────

  generateContext() {
    const lines = [];
    if (this.currentScene) {
      lines.push(`📍 Location: ${this.currentScene.location}`);
      lines.push(`🎭 Mood: ${this.currentScene.mood || 'Neutral'}`);
      lines.push(`📜 Hook: ${this.currentScene.hook}`);
      if (this.currentScene.npcs && this.currentScene.npcs.length > 0) {
        lines.push(`👤 NPCs: ${this.currentScene.npcs.map(n => n.name).join(', ')}`);
      }
    }
    const regionData = this.world.getRegion(this.currentScene?.region || this.options.defaultRegion);
    if (regionData) {
      lines.push(`🏛️ Region: ${regionData.title || regionData.name || 'Unknown'}`);
    }
    const timerStatus = timers.getTimerStatus({ 
      scene: { timers: this.currentScene?.timers || [] }, 
      campaign: { timers: [] } 
    });
    if (timerStatus !== 'No active timers.') {
      lines.push(`⏱️ Timers:\n${timerStatus}`);
    }
    if (this.campaign) {
      lines.push(`📊 Campaign: Mandate ${this.campaign.mandate}/6, Crisis ${this.campaign.crisis}/6`);
    }
    return lines.join('\n');
  }

  // ─── SUGGESTED ACTIONS ────────────────────────────────────────

  getSuggestedActions() {
    const suggestions = [];
    const timers = this.currentScene?.timers || this.state?.scene?.timers || [];
    const sceneProgress = timers.find(t => t.name === 'Scene Progress');
    if (sceneProgress) {
      const ratio = sceneProgress.current / sceneProgress.max;
      if (ratio > 0.7) {
        suggestions.push(`⏱️ Scene Progress timer at ${sceneProgress.current}/${sceneProgress.max} - consider escalating the scene.`);
      }
    }
    const pending = this.pendingComplications.filter(p => !p.processed);
    if (pending.length > 0) {
      suggestions.push(`💥 ${pending.length} pending complication(s) - process them soon.`);
    }
    if (this.currentScene && this.currentScene.npcs) {
      const unused = this.currentScene.npcs.filter(n => {
        return !this.currentScene.events.some(e => e.npc === n.id);
      });
      if (unused.length > 0) {
        suggestions.push(`👤 ${unused.length} NPC(s) unused - consider introducing ${unused[0].name}.`);
      }
    }
    const allChars = characters.getAll();
    const lowBoons = Object.entries(allChars).filter(([name, c]) => c.boons <= 1);
    if (lowBoons.length > 0) {
      suggestions.push(`🪙 ${lowBoons.length} character(s) have low Boons (${lowBoons.map(([n]) => n).join(', ')}) - consider offering opportunities to earn more.`);
    }
    const highFatigue = Object.entries(allChars).filter(([name, c]) => c.fatigue >= 2);
    if (highFatigue.length > 0) {
      suggestions.push(`😫 ${highFatigue.length} character(s) have high Fatigue (${highFatigue.map(([n]) => n).join(', ')}) - consider a rest or respite.`);
    }
    return suggestions;
  }

  // ─── DICE ROLLING ──────────────────────────────────────────────

  rollDice(count, difficulty = null) {
    const results = [];
    let successes = 0;
    let storyBeats = 0;
    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * 10) + 1;
      results.push(roll);
      if (roll >= 6) {
        successes++;
        if (roll === 10) successes++;
      }
      if (roll === 1) storyBeats++;
    }
    const success = difficulty !== null ? successes >= difficulty : null;
    return {
      dice: results,
      successes,
      storyBeats,
      success,
      total: count,
      difficulty
    };
  }

  // ─── UTILITY ────────────────────────────────────────────────────

  getSummary() {
    const lines = [];
    lines.push(`🎮 Game State Summary`);
    lines.push(`📅 ${new Date().toLocaleString()}`);
    lines.push('');
    if (this.currentScene) {
      lines.push(`📍 Scene: ${this.currentScene.location}`);
      lines.push(`🎭 Mood: ${this.currentScene.mood || 'Neutral'}`);
      lines.push(`📜 Hook: ${this.currentScene.hook}`);
      lines.push(`⏱️ Started: ${new Date(this.currentScene.started).toLocaleTimeString()}`);
      lines.push('');
    }
    lines.push(`⏱️ Timers:`);
    const timerStatus = timers.getTimerStatus({ 
      scene: { timers: this.currentScene?.timers || [] }, 
      campaign: { timers: [] } 
    });
    lines.push(timerStatus);
    lines.push('');
    const allChars = characters.getAll();
    const charSummary = Object.entries(allChars).map(([name, c]) => {
      return `${name}: H${c.harm} F${c.fatigue} B${c.boons} O${c.obligation}`;
    });
    lines.push(`👤 Characters (${Object.keys(allChars).length}):`);
    lines.push(charSummary.join(', ') || 'None');
    if (this.campaign) {
      lines.push('');
      lines.push(`📊 Campaign: Mandate ${this.campaign.mandate}/6, Crisis ${this.campaign.crisis}/6`);
      if (this.campaign.campaignCode) {
        lines.push(`🔑 Code: ${this.campaign.campaignCode}`);
      }
    }
    return lines.join('\n');
  }

  getState() {
    return {
      roomCode: this.options.roomCode,
      campaignCode: this.campaign?.campaignCode || null,
      currentScene: this.currentScene,
      sceneHistory: this.sceneHistory,
      context: { ...this.context },
      pendingComplications: this.pendingComplications,
      characters: characters.getAll(),
      campaign: this.campaign ? {
        factions: this.campaign.factions,
        trusts: this.campaign.trusts,
        assets: this.campaign.assets,
        mandate: this.campaign.mandate,
        crisis: this.campaign.crisis,
        meta: this.campaign.meta
      } : null,
      timestamp: Date.now()
    };
  }

  restoreState(state) {
    if (state.currentScene) this.currentScene = state.currentScene;
    if (state.sceneHistory) this.sceneHistory = state.sceneHistory;
    if (state.context) this.context = state.context;
    if (state.pendingComplications) this.pendingComplications = state.pendingComplications;
    if (state.characters) {
      characters.loadCharacters(state.characters);
    }
    if (state.campaign && this.campaign) {
      this.campaign.factions = state.campaign.factions || {};
      this.campaign.trusts = state.campaign.trusts || {};
      this.campaign.assets = state.campaign.assets || {};
      this.campaign.mandate = state.campaign.mandate || 0;
      this.campaign.crisis = state.campaign.crisis || 0;
      this.campaign.meta = state.campaign.meta || {};
    }
    // Sync to state
    if (this.currentScene) {
      this._syncToState();
    }
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