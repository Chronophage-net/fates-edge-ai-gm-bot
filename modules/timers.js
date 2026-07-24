// modules/timers.js
/**
 * Timer Module for AI GM Bot
 * 
 * Manages both scene-level and campaign-level timers.
 * Integrates with the deck module for generating timer-fill events.
 * Supports automatic event triggering, timer merging, and persistence.
 * 
 * Usage:
 *   const timers = require('./timers');
 *   const timerState = timers.createTimerState();
 *   timers.addTimer(timerState, 'Guard Patrol', 4, 'Reinforcements arrive!');
 *   timers.tickTimer(timerState, 'Guard Patrol', 1);
 *   if (timers.isTimerFilled(timerState, 'Guard Patrol')) {
 *     const event = timers.resolveTimer(timerState, 'Guard Patrol');
 *     // Handle the event
 *   }
 */

const { drawCards, getWildcardMeaning } = require('./deck.js');

// ============================================================
// STATE MANAGEMENT
// ============================================================

/**
 * Create a new timer state object.
 * @param {object} options - Configuration options.
 * @returns {object} Timer state.
 */
function createTimerState(options = {}) {
  return {
    scene: {
      timers: options.sceneTimers || [],
      maxSceneTimers: options.maxSceneTimers || 3
    },
    campaign: {
      timers: options.campaignTimers || [],
      autoPersist: options.autoPersist || false
    },
    lastTick: Date.now(),
    events: []
  };
}

/**
 * Reset a timer state (clear all timers).
 */
function resetTimerState(state) {
  if (state.scene) state.scene.timers = [];
  if (state.campaign) state.campaign.timers = [];
  state.events = [];
  state.lastTick = Date.now();
}

// ============================================================
// ADD TIMERS
// ============================================================

/**
 * Add a timer to the scene or campaign.
 * @param {object} state - Timer state.
 * @param {string} name - Unique identifier for the timer.
 * @param {number} maxSegments - Maximum segments (4, 6, 8, 10).
 * @param {string|function} onFill - Event description or callback when timer fills.
 * @param {object} options - Additional options.
 * @param {string} scope - 'scene' or 'campaign' (default 'scene').
 */
function addTimer(state, name, maxSegments, onFill = 'Timer fills.', options = {}, scope = 'scene') {
  const container = scope === 'campaign' ? state.campaign : state.scene;
  if (!container) {
    if (scope === 'campaign' && !state.campaign) state.campaign = { timers: [] };
    if (scope === 'scene' && !state.scene) state.scene = { timers: [] };
    return addTimer(state, name, maxSegments, onFill, options, scope);
  }

  const existing = container.timers.find(t => t.name === name);
  const timer = {
    name,
    max: maxSegments,
    current: 0,
    onFill: typeof onFill === 'function' ? onFill : () => onFill,
    options: options || {},
    createdAt: Date.now(),
    scope,
    tags: options.tags || []
  };

  if (existing) {
    existing.current = 0;
    existing.max = maxSegments;
    existing.onFill = timer.onFill;
    existing.options = options || existing.options;
    return existing;
  }

  container.timers.push(timer);
  // Enforce three-timer rule for scene timers
  if (scope === 'scene') {
    enforceThreeTimers(state);
  }

  return timer;
}

/**
 * Add a campaign-level timer (persists across scenes).
 */
function addCampaignTimer(state, name, maxSegments, onFill = 'Campaign timer fills.', options = {}) {
  return addTimer(state, name, maxSegments, onFill, options, 'campaign');
}

// ============================================================
// TICK TIMERS
// ============================================================

/**
 * Tick a timer forward.
 * @param {object} state - Timer state.
 * @param {string} name - Timer name.
 * @param {number} ticks - Number of ticks to add (default 1).
 * @param {string} scope - 'scene' or 'campaign' (default 'scene').
 * @returns {object} - { filled: boolean, timer: object, event: string }
 */
function tickTimer(state, name, ticks = 1, scope = 'scene') {
  const container = scope === 'campaign' ? state.campaign : state.scene;
  if (!container) {
    return { filled: false, timer: null, event: null };
  }

  const timer = container.timers.find(t => t.name === name);
  if (!timer) {
    return { filled: false, timer: null, event: null };
  }

  timer.current = Math.min(timer.max, timer.current + ticks);
  timer.lastTicked = Date.now();

  if (timer.current >= timer.max) {
    // Timer filled - generate event
    const event = typeof timer.onFill === 'function' 
      ? timer.onFill(timer, state) 
      : timer.onFill;
    
    // Remove timer from active list (or keep if persistent)
    if (!timer.options.persistent) {
      const idx = container.timers.indexOf(timer);
      if (idx !== -1) {
        container.timers.splice(idx, 1);
      }
    } else {
      // Persistent timer: reset but keep track
      timer.current = 0;
      timer.filledCount = (timer.filledCount || 0) + 1;
    }

    state.events = state.events || [];
    state.events.push({
      timer: timer.name,
      event,
      timestamp: Date.now(),
      scope
    });

    return { filled: true, timer, event };
  }

  return { filled: false, timer, event: null };
}

/**
 * Check if a timer is filled (without ticking).
 */
function isTimerFilled(state, name, scope = 'scene') {
  const container = scope === 'campaign' ? state.campaign : state.scene;
  if (!container) return false;
  const timer = container.timers.find(t => t.name === name);
  if (!timer) return false;
  return timer.current >= timer.max;
}

/**
 * Get the current progress of a timer.
 */
function getTimerProgress(state, name, scope = 'scene') {
  const container = scope === 'campaign' ? state.campaign : state.scene;
  if (!container) return null;
  const timer = container.timers.find(t => t.name === name);
  if (!timer) return null;
  return {
    name: timer.name,
    current: timer.current,
    max: timer.max,
    progress: timer.current / timer.max,
    remaining: timer.max - timer.current,
    filled: timer.current >= timer.max
  };
}

// ============================================================
// RESOLVE TIMERS
// ============================================================

/**
 * Resolve a filled timer (generate event and remove it).
 * @param {object} state - Timer state.
 * @param {string} name - Timer name.
 * @param {string} scope - 'scene' or 'campaign'.
 * @returns {object} - { event: string, timer: object }
 */
function resolveTimer(state, name, scope = 'scene') {
  const container = scope === 'campaign' ? state.campaign : state.scene;
  if (!container) return { event: null, timer: null };

  const idx = container.timers.findIndex(t => t.name === name);
  if (idx === -1) return { event: null, timer: null };

  const timer = container.timers[idx];
  const event = typeof timer.onFill === 'function' 
    ? timer.onFill(timer, state) 
    : timer.onFill;

  // Remove timer
  container.timers.splice(idx, 1);

  state.events = state.events || [];
  state.events.push({
    timer: timer.name,
    event,
    timestamp: Date.now(),
    scope,
    resolved: true
  });

  return { event, timer };
}

// ============================================================
// TIMER STATUS
// ============================================================

/**
 * Get a formatted status of all active timers.
 */
function getTimerStatus(state, scope = 'all') {
  const lines = [];
  
  if (scope === 'all' || scope === 'scene') {
    const sceneTimers = state.scene?.timers || [];
    if (sceneTimers.length > 0) {
      lines.push('📋 Scene Timers:');
      for (const t of sceneTimers) {
        const bar = '█'.repeat(Math.round((t.current / t.max) * 8)) + '░'.repeat(8 - Math.round((t.current / t.max) * 8));
        lines.push(`  - ${t.name}: [${bar}] ${t.current}/${t.max}`);
      }
    }
  }

  if (scope === 'all' || scope === 'campaign') {
    const campaignTimers = state.campaign?.timers || [];
    if (campaignTimers.length > 0) {
      if (lines.length > 0 && sceneTimers?.length > 0) lines.push('');
      lines.push('📌 Campaign Timers:');
      for (const t of campaignTimers) {
        const bar = '█'.repeat(Math.round((t.current / t.max) * 8)) + '░'.repeat(8 - Math.round((t.current / t.max) * 8));
        lines.push(`  - ${t.name}: [${bar}] ${t.current}/${t.max}`);
      }
    }
  }

  if (lines.length === 0) {
    return 'No active timers.';
  }

  return lines.join('\n');
}

/**
 * Get timer data as an object (for serialization).
 */
function getTimersData(state, scope = 'all') {
  const result = { scene: [], campaign: [] };
  if (scope === 'all' || scope === 'scene') {
    result.scene = (state.scene?.timers || []).map(t => ({
      name: t.name,
      current: t.current,
      max: t.max,
      tags: t.tags || [],
      options: t.options || {}
    }));
  }
  if (scope === 'all' || scope === 'campaign') {
    result.campaign = (state.campaign?.timers || []).map(t => ({
      name: t.name,
      current: t.current,
      max: t.max,
      tags: t.tags || [],
      options: t.options || {}
    }));
  }
  return result;
}

// ============================================================
// THREE-TIMER RULE
// ============================================================

/**
 * Enforce the three-timer rule: maintain at most three active scene timers.
 * Merges or retires redundant timers.
 */
function enforceThreeTimers(state) {
  if (!state.scene) return;
  const timers = state.scene.timers;
  if (timers.length <= 3) return;

  // Sort by importance (max segments, then creation time)
  timers.sort((a, b) => {
    // Higher max = more important (longer timers are usually more significant)
    if (a.max !== b.max) return b.max - a.max;
    // Older timers are more established
    return a.createdAt - b.createdAt;
  });

  // Keep only the top 3
  const kept = timers.slice(0, 3);
  const removed = timers.slice(3);

  // For removed timers, merge their progress into a "merged" timer
  if (removed.length > 0) {
    const mergedName = 'Merged: ' + removed.map(t => t.name).join(', ');
    const mergedMax = Math.max(...kept.map(t => t.max));
    const mergedCurrent = Math.min(
      mergedMax,
      kept.reduce((sum, t) => sum + (t.current / t.max) * t.max, 0) / kept.length
    );
    
    // Add a merged timer with combined progress
    const existingMerged = kept.find(t => t.name === mergedName);
    if (existingMerged) {
      existingMerged.current = Math.min(existingMerged.max, existingMerged.current + 1);
    } else {
      kept.push({
        name: mergedName,
        max: mergedMax,
        current: Math.floor(mergedCurrent),
        onFill: () => 'Multiple timers coalesce into a single threat.',
        createdAt: Date.now(),
        scope: 'scene',
        tags: ['merged'],
        options: { persistent: true }
      });
    }

    state.scene.timers = kept;
  }
}

/**
 * Merge related timers intelligently.
 */
function mergeRelatedTimers(state, timerNames, newName, newMax) {
  if (!state.scene) return false;
  
  const timers = state.scene.timers;
  const toMerge = timers.filter(t => timerNames.includes(t.name));
  if (toMerge.length < 2) return false;

  // Calculate merged progress
  const totalProgress = toMerge.reduce((sum, t) => sum + (t.current / t.max), 0);
  const avgProgress = totalProgress / toMerge.length;
  const mergedCurrent = Math.floor(avgProgress * newMax);

  // Remove merged timers
  const remaining = timers.filter(t => !timerNames.includes(t.name));
  
  // Add merged timer
  remaining.push({
    name: newName,
    max: newMax,
    current: Math.min(newMax, mergedCurrent),
    onFill: () => `Merged timers (${timerNames.join(', ')}) resolve into a single event.`,
    createdAt: Date.now(),
    scope: 'scene',
    tags: ['merged'],
    options: { persistent: true }
  });

  state.scene.timers = remaining;
  return true;
}

// ============================================================
// TIMER EVENTS (Integration with Deck)
// ============================================================

/**
 * Generate a timer-fill event using the deck module.
 */
async function generateTimerEvent(timer, state, regionId = 'generic') {
  const event = typeof timer.onFill === 'function' 
    ? timer.onFill(timer, state) 
    : timer.onFill;

  // Add a random complication from the deck
  try {
    const cards = await drawCards(1, regionId, true);
    if (cards && cards.length > 0) {
      const card = cards[0];
      return {
        event,
        complication: card.meaning,
        aceEffect: card.aceEffect,
        card: card.display
      };
    }
  } catch (e) {
    // Fallback
    return { event, complication: 'The situation escalates unexpectedly.' };
  }

  return { event };
}

// ============================================================
// BULK OPERATIONS
// ============================================================

/**
 * Tick all scene timers by 1.
 * @returns {Array} List of filled timers.
 */
function tickAllSceneTimers(state, ticks = 1) {
  if (!state.scene) return [];
  const filled = [];
  const timers = state.scene.timers;
  for (let i = timers.length - 1; i >= 0; i--) {
    const timer = timers[i];
    timer.current = Math.min(timer.max, timer.current + ticks);
    if (timer.current >= timer.max) {
      const result = resolveTimer(state, timer.name, 'scene');
      if (result.event) {
        filled.push({ timer: timer.name, event: result.event });
      }
    }
  }
  return filled;
}

/**
 * Tick all campaign timers by 1.
 */
function tickAllCampaignTimers(state, ticks = 1) {
  if (!state.campaign) return [];
  const filled = [];
  const timers = state.campaign.timers;
  for (let i = timers.length - 1; i >= 0; i--) {
    const timer = timers[i];
    timer.current = Math.min(timer.max, timer.current + ticks);
    if (timer.current >= timer.max) {
      const result = resolveTimer(state, timer.name, 'campaign');
      if (result.event) {
        filled.push({ timer: timer.name, event: result.event });
      }
    }
  }
  return filled;
}

// ============================================================
// EXTERNAL INTEGRATION
// ============================================================

/**
 * Apply timer ticks based on a deck draw result.
 */
function applyDeckDrawToTimers(state, drawResult, campaignManager = null) {
  const ticks = [];
  
  // If the draw contains an Ace, tick a random timer
  if (drawResult.cards && drawResult.cards.some(c => c.rank === 'A')) {
    // Tick a random scene timer
    if (state.scene && state.scene.timers.length > 0) {
      const idx = Math.floor(Math.random() * state.scene.timers.length);
      const timer = state.scene.timers[idx];
      timer.current = Math.min(timer.max, timer.current + 1);
      ticks.push({ timer: timer.name, ticks: 1 });
    }
  }

  // If the draw is a Crown Spread, tick all timers by 1
  if (drawResult.type === 'crown') {
    if (state.scene) {
      for (const timer of state.scene.timers) {
        timer.current = Math.min(timer.max, timer.current + 1);
        ticks.push({ timer: timer.name, ticks: 1 });
      }
    }
    if (state.campaign) {
      for (const timer of state.campaign.timers) {
        timer.current = Math.min(timer.max, timer.current + 1);
        ticks.push({ timer: timer.name, ticks: 1 });
      }
    }
  }

  return ticks;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // State management
  createTimerState,
  resetTimerState,

  // Adding timers
  addTimer,
  addCampaignTimer,

  // Ticking and resolving
  tickTimer,
  isTimerFilled,
  getTimerProgress,
  resolveTimer,

  // Status
  getTimerStatus,
  getTimersData,

  // Three-timer rule
  enforceThreeTimers,
  mergeRelatedTimers,

  // Bulk operations
  tickAllSceneTimers,
  tickAllCampaignTimers,

  // Integration
  generateTimerEvent,
  applyDeckDrawToTimers,

  // Helpers
  getActiveTimers: (state, scope = 'scene') => {
    const container = scope === 'campaign' ? state.campaign : state.scene;
    return container?.timers || [];
  },
  
  getFilledTimers: (state, scope = 'scene') => {
    const container = scope === 'campaign' ? state.campaign : state.scene;
    if (!container) return [];
    return container.timers.filter(t => t.current >= t.max);
  }
};