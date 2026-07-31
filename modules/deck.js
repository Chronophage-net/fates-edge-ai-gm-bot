// modules/deck.js
/**
 * Deck of Consequences module for AI GM Bot.
 *
 * Handles card drawing, Crown Spread, region-specific meanings,
 * Ace effects, and wildcard twists.
 *
 * Integrates with WorldManager to load region data.
 * Provides functions for generating complications from Story Beats.
 */

const path = require('path');
const fs = require('fs').promises;

// ============================================================
// CONSTANTS
// ============================================================

const SUITS = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const SUIT_SYMBOLS = { Hearts: '♥', Spades: '♠', Clubs: '♣', Diamonds: '♦' };
const SUIT_NAMES = { Hearts: 'Hearts', Spades: 'Spades', Clubs: 'Clubs', Diamonds: 'Diamonds' };
const RANK_NAMES = {
  'A': 'Ace', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five',
  '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine', '10': 'Ten',
  'J': 'Jack', 'Q': 'Queen', 'K': 'King'
};

const POKER_RANK = { 'A': 14, 'K': 13, 'Q': 12, 'J': 11, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
const SUIT_ORDER = { 'Spades': 4, 'Hearts': 3, 'Diamonds': 2, 'Clubs': 1 };

const DEFAULT_TWISTS = [
  "A sudden storm or environmental shift changes the scene.",
  "An unexpected ally appears with conflicting motives.",
  "A minor curse or blessing from a Patron alters the odds.",
  "A forgotten debt is called in at the worst moment.",
  "The ground beneath you gives way—literal or figurative.",
  "A piece of evidence surfaces that reframes everything.",
  "A rival's plan backfires, creating chaos for everyone.",
  "A moment of clarity reveals a hidden truth.",
];

// Crown Spread positions
const CROWN_POSITIONS = [
  { key: 'root', label: 'Root', icon: '🌱', interpretive: 'What has been growing beneath the surface?' },
  { key: 'crest', label: 'Crest', icon: '🏔️', interpretive: 'What power is gathering strength?' },
  { key: 'crown', label: 'Crown', icon: '👑', interpretive: 'What is the shape of the storm that awaits?' },
  { key: 'left', label: 'Left Hand', icon: '🤝', interpretive: 'Who stands with you?' },
];

// Ace Effects (region-specific, fallback)
const ACE_EFFECTS = {
  generic: [
    { emoji: '👻', text: 'The Hollow takes notice. A pale figure watches from the corner of your eye.' },
    { emoji: '🔔', text: 'A bell rings without being struck. The ninth chime is silent.' },
    { emoji: '🌫️', text: 'Mist rolls in, carrying whispers of a debt unpaid.' },
    { emoji: '🕯️', text: 'A candle gutters and relights itself, burning blue.' },
    { emoji: '🃏', text: 'The Joker\'s wildcard manifests — the unexpected becomes inevitable.' },
    { emoji: '🌙', text: 'The moon flickers. For a moment, you see two shadows.' },
    { emoji: '⚖️', text: 'A scale appears in the air, weighing something you cannot see.' },
    { emoji: '🕸️', text: 'A spider web glistens in the corner, its threads forming a pattern you almost recognize.' },
    { emoji: '🗝️', text: 'A key falls from an empty pocket. It unlocks a door you haven\'t found yet.' },
  ],
  acasia: [
    { emoji: '🌿', text: 'The Curse stirs. A crossroads behind you now leads to a place you have already been.' },
    { emoji: '🪦', text: 'A broken milestone weeps rust. The empire\'s ghost is counting.' },
    { emoji: '🔥', text: 'A free company\'s banner flickers in the distance, its colors changed.' }
  ],
  ecktoria: [
    { emoji: '🏛️', text: 'A statue turns its head to watch you. The marble is warm.' },
    { emoji: '⚜️', text: 'A seal appears on your documents that you did not stamp. The Vigil is watching.' },
    { emoji: '🔥', text: 'The Everflame burns blue. A forgotten precedent surfaces.' }
  ],
  vhasia: [
    { emoji: '☀️', text: 'The sun fractures. You see a reflection of Lence in every mirror.' },
    { emoji: '🗡️', text: 'A knight\'s gorget unbuckles on its own. Chivalry is a weight.' },
    { emoji: '👑', text: 'A crown sits on a throne that was empty a moment ago. The claimant is watching.' }
  ],
  viterra: [
    { emoji: '🌳', text: 'A hedge grows where no hedge was before. The boundary has moved.' },
    { emoji: '⚖️', text: 'A legal duel is declared in your name. You have one hour to prepare.' },
    { emoji: '🛡️', text: 'The Queen\'s Justiciar passes by. She does not see you—yet.' }
  ],
  ykrul: [
    { emoji: '🐺', text: 'A wolf howls in the distance. The steppe is counting its debts.' },
    { emoji: '🌾', text: 'A white squall approaches. The wind carries the names of the dead.' },
    { emoji: '⚔️', text: 'A hostage string is cut. A feud rekindles.' }
  ],
  valewood: [
    { emoji: '🌲', text: 'A star-road phases into existence. The forest remembers.' },
    { emoji: '🍃', text: 'A leaf falls upward, pointing to a hidden threshold.' },
    { emoji: '👑', text: 'The Hazel Queen\'s laughter echoes through the trees.' }
  ],
  aelinnel: [
    { emoji: '🔮', text: 'A geas forms on your tongue. Choose your next words carefully.' },
    { emoji: '🌿', text: 'The Green Gate opens at the wrong hour. Roads rewire.' },
    { emoji: '🕊️', text: 'A fae courtier offers a gift. Accepting may cost more than you know.' }
  ],
  aelaerem: [
    { emoji: '🍎', text: 'The Hollow walks. The ninth cup is poured.' },
    { emoji: '🐦', text: 'The watch-geese fall silent. Someone is coming.' },
    { emoji: '🌾', text: 'The scarecrow turns to face you. It knows your name.' }
  ],
  aeler: [
    { emoji: '⛏️', text: 'The mountain shifts. A knock in threes echoes from the deep.' },
    { emoji: '🕯️', text: 'A lamplighter\'s wick fails for no reason. The dark is listening.' },
    { emoji: '🌬️', text: 'The air grows thin. Count your breaths, or the pressure will count them for you.' }
  ],
  zakov: [
    { emoji: '🌊', text: 'The tide turns early. The reef is hungry.' },
    { emoji: '💎', text: 'A crystalline shard glows in the dark. The Reaping stirs.' },
    { emoji: '🏴‍☠️', text: 'The Salt Prince raises the levy. Every ship pays.' }
  ],
  kahfagia: [
    { emoji: '🔦', text: 'A beacon gutters. The Admiralty has changed the channel.' },
    { emoji: '🕸️', text: 'A silk thread appears on your rigging. The Spider is watching.' },
    { emoji: '🌊', text: 'The tide turns twice in one day. The sea is unsettled.' }
  ]
};

// ============================================================
// HELPER: transform region data (new format -> old suit->rank)
// ============================================================

function transformRegionData(raw) {
  if (!raw) return null;
  // Already in old format?
  if (raw.hearts && typeof raw.hearts === 'object' && !Array.isArray(raw.hearts)) {
    return raw;
  }

  const transformed = {
    name: raw.title || raw.id || 'Unknown',
    description: '',
    spades: {},
    hearts: {},
    clubs: {},
    diamonds: {},
    tags: [],
    ace_effects: raw.ace_effects || null, // preserve if present
    raw: raw // keep reference to raw data for additional fields
  };

  // Build description (plain text for bot)
  if (raw.overview) {
    let desc = '';
    if (raw.overview.tagline) desc += `${raw.overview.tagline}\n`;
    if (raw.overview.genre) desc += `Genre: ${raw.overview.genre}\n`;
    if (raw.overview.mood) desc += `Mood: ${raw.overview.mood}\n`;
    if (raw.overview.starting_location) desc += `Starting Location: ${raw.overview.starting_location}\n`;
    if (raw.overview.lore) {
      if (raw.overview.lore.history) desc += `${raw.overview.lore.history}\n`;
      if (raw.overview.lore.first_notice) desc += `First notice: ${raw.overview.lore.first_notice}\n`;
      if (raw.overview.lore.rule_that_kills) desc += `Rule that kills: ${raw.overview.lore.rule_that_kills}\n`;
    }
    transformed.description = desc;
  }

  const suitMap = {
    spades: 'places',
    hearts: 'people_and_factions',
    clubs: 'complications',
    diamonds: 'rewards'
  };

  for (const suit of Object.keys(suitMap)) {
    const key = suitMap[suit];
    const items = raw[key];
    if (!items || !Array.isArray(items)) continue;
    for (const card of items) {
      const rank = String(card.rank || '');
      if (!rank) continue;
      let meaning = `${card.title || 'Untitled'}: ${card.description || ''}`;
      if (card.flavor) meaning += ` ${card.flavor}`;
      if (card.mechanical_hook) meaning += ` [Mechanic: ${card.mechanical_hook}]`;
      if (card.what_they_carry) meaning += ` [Carries: ${card.what_they_carry}]`;
      if (card.what_they_ask) meaning += ` [Asks: ${card.what_they_ask}]`;
      if (card.debt) meaning += ` [Debt: ${card.debt}]`;
      if (card.price) meaning += ` [Price: ${card.price}]`;
      if (card.curse_cost) meaning += ` [Cost: ${card.curse_cost}]`;
      transformed[suit][rank] = meaning;
    }
  }

  return transformed;
}

// ============================================================
// REGION DATA LOADING (using WorldManager or fallback)
// ============================================================

let worldManager = null;
let regionCache = {};

/**
 * Set the WorldManager instance for loading region data.
 * @param {object} wm - The WorldManager instance.
 */
function setWorldManager(wm) {
  worldManager = wm;
}

/**
 * Load region data by ID or slug.
 * Uses the WorldManager if available; otherwise tries to load from file.
 */
async function loadRegionData(regionId) {
  if (regionCache[regionId]) {
    return regionCache[regionId];
  }

  let raw = null;

  if (worldManager) {
    const region = worldManager.getRegion(regionId);
    if (region) {
      raw = region;
    }
  }

  if (!raw) {
    // Fallback: try to load from data/regions directory
    const filePath = path.resolve(process.cwd(), 'data', 'regions', `${regionId}.json`);
    try {
      const fileData = await fs.readFile(filePath, 'utf-8');
      raw = JSON.parse(fileData);
    } catch (e) {
      // If not found, return null
      return null;
    }
  }

  const transformed = transformRegionData(raw);
  if (transformed) {
    regionCache[regionId] = transformed;
  }
  return transformed || null;
}

// ============================================================
// CARD DECK FUNCTIONS
// ============================================================

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardToString(card) {
  if (!card) return '—';
  return `${card.rank} of ${card.suit}`;
}

function cardDisplay(card) {
  if (!card) return '—';
  const symbol = SUIT_SYMBOLS[card.suit] || '';
  const rankName = RANK_NAMES[card.rank] || card.rank;
  return `${symbol} ${rankName} of ${card.suit}`;
}

// ============================================================
// MEANING FUNCTIONS
// ============================================================

function getCardMeaningFromRegion(suit, rank, regionData) {
  if (!regionData) {
    return `A complication of ${suit} arises.`;
  }
  const suitKey = suit.toLowerCase();
  const obj = regionData[suitKey];
  if (!obj || !obj[rank]) {
    return `A complication of ${suit} arises.`;
  }
  return obj[rank];
}

function getWildcardMeaning(regionData) {
  // If region data has a wildcard_effects field, use that
  if (regionData && regionData.raw && regionData.raw.wildcard_effects) {
    const effects = regionData.raw.wildcard_effects;
    const idx = Math.floor(Math.random() * effects.length);
    return `✨ Wildcard Twist: ${effects[idx]}`;
  }
  const twists = DEFAULT_TWISTS;
  const idx = Math.floor(Math.random() * twists.length);
  return `✨ Wildcard Twist: ${twists[idx]}`;
}

function getAceEffect(regionId, card, regionData) {
  // If region data has ace_effects, use those
  if (regionData && regionData.ace_effects && Array.isArray(regionData.ace_effects)) {
    const effects = regionData.ace_effects;
    const idx = Math.floor(Math.random() * effects.length);
    const effect = effects[idx];
    return { emoji: effect.emoji || '🃏', text: effect.text || effect };
  }

  // Fallback to hardcoded ACE_EFFECTS
  const regionKey = regionId ? regionId.toLowerCase() : 'generic';
  let effects = ACE_EFFECTS[regionKey];
  if (!effects) {
    // Try to find a partial match
    const match = Object.keys(ACE_EFFECTS).find(key =>
      key !== 'generic' && regionKey.includes(key)
    );
    if (match) effects = ACE_EFFECTS[match];
  }
  if (!effects) effects = ACE_EFFECTS.generic;
  const idx = Math.floor(Math.random() * effects.length);
  return effects[idx];
}

// ============================================================
// DRAW FUNCTIONS
// ============================================================

/**
 * Draw a number of cards from a shuffled deck.
 * @param {number} count - Number of cards to draw.
 * @param {string} regionId - Region slug (e.g., 'acasia-broken-marches').
 * @param {boolean} includeMeanings - Whether to include meanings.
 * @returns {Promise<Array>} Array of card objects with meanings if requested.
 */
async function drawCards(count, regionId = 'generic', includeMeanings = true) {
  const deck = shuffle(buildDeck());
  const drawn = deck.slice(0, count);
  if (!includeMeanings) return drawn;

  const regionData = regionId !== 'generic' ? await loadRegionData(regionId) : null;

  const result = [];
  for (const card of drawn) {
    let meaning = getCardMeaningFromRegion(card.suit.toLowerCase(), card.rank, regionData);
    let aceEffect = null;
    if (card.rank === 'A') {
      aceEffect = getAceEffect(regionId, card, regionData);
    }
    result.push({
      card,
      meaning,
      aceEffect,
      display: cardDisplay(card)
    });
  }
  return result;
}

/**
 * Compose Crown Spread positions/timer/synthesis from ALREADY-DRAWN
 * cards, without drawing anything itself.
 *
 * FIXED: this function didn't exist before, but server/api.js's
 * POST /api/rooms/:code/deck/crown route was calling
 * `deck.synthesiseCrownSpread(mainCards, wildcard, regionData)` on every
 * single request -- a guaranteed `TypeError: ... is not a function`,
 * caught by that route's try/catch and surfaced as a 404 error. This
 * broke every REST-driven Crown Spread, including
 * adventure-director.js's "Draw a Crown Spread and build a new
 * adventure" flow. Extracted from crownSpread()'s own composition logic
 * below so callers that already have room-drawn cards (api.js draws
 * from the room's own persistent, shared deck state, so deckHistory/
 * remaining-card-count stay consistent with ordinary draws) can compose
 * a spread without crownSpread()'s own internal fresh-shuffle-every-time
 * behavior.
 *
 * @param {Array} mainCards - exactly 4 cards for Root/Crest/Crown/Left Hand.
 * @param {Object} wildcard - the 5th card.
 * @param {Object} regionData - already-loaded region data (or null for generic).
 * @param {string} regionId - region slug string, needed for getAceEffect()'s
 *   own fallback lookup (it indexes ACE_EFFECTS by this string, separately
 *   from regionData).
 * @returns {Object} { positions, wildcard, timer, highestCard, aceEffects, synthesis }
 */
function synthesiseCrownSpread(mainCards, wildcard, regionData, regionId = 'generic') {
  const positionCards = mainCards.map((card, idx) => {
    const pos = CROWN_POSITIONS[idx];
    const meaning = getCardMeaningFromRegion(card.suit.toLowerCase(), card.rank, regionData);
    const aceEffect = card.rank === 'A' ? getAceEffect(regionId, card, regionData) : null;
    return {
      position: pos,
      card,
      meaning,
      aceEffect,
      display: cardDisplay(card)
    };
  });

  const wildcardMeaning = getWildcardMeaning(regionData);

  // Determine highest card (for timer suggestion). NEW: also exposed on
  // the return value as `highestCard` -- e.g. for feeding a "narrative
  // tension" signal into an LLM adventure-generation prompt, as a
  // subtle weighting rather than a hard mechanical theme dictation.
  let highest = mainCards[0];
  for (const card of mainCards) {
    const r1 = POKER_RANK[highest.rank] || 0;
    const r2 = POKER_RANK[card.rank] || 0;
    if (r2 > r1) highest = card;
    else if (r2 === r1) {
      const s1 = SUIT_ORDER[highest.suit] || 0;
      const s2 = SUIT_ORDER[card.suit] || 0;
      if (s2 > s1) highest = card;
    }
  }
  let timer = null;
  if (highest) {
    const rankVal = POKER_RANK[highest.rank] || 0;
    let segments = 4;
    if (rankVal >= 14) segments = 10;
    else if (rankVal >= 13) segments = 8;
    else if (rankVal >= 11) segments = 8;
    else if (rankVal >= 10) segments = 6;
    else if (rankVal >= 7) segments = 6;
    else segments = 4;
    timer = { segments, card: `${highest.rank} of ${highest.suit}` };
  }

  // Ace effects from main cards
  const aceEffects = mainCards
    .filter(c => c.rank === 'A')
    .map(c => getAceEffect(regionId, c, regionData));

  // Synthesis text
  let synthesis = `🌱 Root: ${positionCards[0].meaning}\n`;
  synthesis += `🏔️ Crest: ${positionCards[1].meaning}\n`;
  synthesis += `👑 Crown: ${positionCards[2].meaning}\n`;
  synthesis += `🤝 Left Hand: ${positionCards[3].meaning}\n`;
  synthesis += `🌟 Wildcard: ${wildcardMeaning}`;

  if (timer) {
    synthesis += `\n\n⏱️ Suggested Timer: ${timer.segments} segments (from ${timer.card})`;
  }

  return {
    positions: positionCards,
    wildcard: { card: wildcard, meaning: wildcardMeaning, display: cardDisplay(wildcard) },
    timer,
    highestCard: highest, // NEW: exposed for callers that want to use it as a soft signal
    aceEffects,
    synthesis
  };
}

/**
 * Perform a Crown Spread (5 cards: 4 main + 1 wildcard). Draws its own
 * fresh shuffled deck internally (does NOT use any room's persistent
 * deck state) -- delegates the actual position/timer/synthesis
 * composition to synthesiseCrownSpread() above, so the two never drift
 * out of sync with each other.
 * @param {string} regionId - Region slug.
 * @returns {Promise<Object>} Object with positions, cards, meanings, synthesis.
 */
async function crownSpread(regionId = 'generic') {
  const deck = shuffle(buildDeck());
  const cards = deck.slice(0, 5);
  const mainCards = cards.slice(0, 4);
  const wildcard = cards[4];

  const regionData = regionId !== 'generic' ? await loadRegionData(regionId) : null;

  const result = synthesiseCrownSpread(mainCards, wildcard, regionData, regionId);

  return {
    ...result,
    rawCards: cards
  };
}

/**
 * Synthesize a consequence from multiple cards (for normal draws).
 */
function synthesiseConsequence(cards, regionData) {
  const entries = cards.map(c => {
    return getCardMeaningFromRegion(c.suit.toLowerCase(), c.rank, regionData);
  });
  if (entries.length === 1) {
    return entries[0];
  } else if (entries.length === 2) {
    return `${entries[0]}\n\nThen, ${entries[1]}`;
  } else {
    return entries.map((e, i) => `${i+1}. ${e}`).join('\n\n');
  }
}

// ============================================================
// STORY BEAT PROCESSING
// ============================================================

/**
 * Process Story Beats generated from a roll.
 * @param {number} sbCount - Number of Story Beats earned.
 * @param {string} regionId - Region slug.
 * @param {object} campaignState - Optional campaign state (for timers).
 * @param {Array} extraContext - Optional list of active complications/timers.
 * @returns {Promise<Array>} Array of suggested complications (strings).
 */
async function processStoryBeats(sbCount, regionId = 'generic', campaignState = null, extraContext = []) {
  if (sbCount <= 0) return [];

  const suggestions = [];
  const regionData = regionId !== 'generic' ? await loadRegionData(regionId) : null;

  // Draw cards to get complication themes
  const cards = shuffle(buildDeck()).slice(0, Math.min(sbCount * 2, 5));
  for (const card of cards) {
    let meaning = getCardMeaningFromRegion(card.suit.toLowerCase(), card.rank, regionData);
    // Add some generic twists based on suit and rank
    let twist = '';
    switch (card.suit) {
      case 'Hearts': twist = 'A relationship is strained or a secret is revealed.'; break;
      case 'Spades': twist = 'A physical obstacle or injury occurs.'; break;
      case 'Clubs': twist = 'A resource is lost or a debt is called in.'; break;
      case 'Diamonds': twist = 'An unexpected opportunity or hidden truth emerges.'; break;
    }
    suggestions.push(`${meaning} ${twist}`);
    if (suggestions.length >= sbCount) break;
  }

  // If we need more suggestions, pad with generic ones
  while (suggestions.length < sbCount) {
    suggestions.push(`The world pushes back — a minor setback or complication arises.`);
  }

  // If campaign state exists, suggest timer ticks
  if (campaignState && campaignState.timers) {
    const timerNames = Object.keys(campaignState.timers);
    if (timerNames.length > 0) {
      const timerName = timerNames[Math.floor(Math.random() * timerNames.length)];
      suggestions.push(`Tick timer "${timerName}" +${Math.min(sbCount, 2)} segments.`);
    }
  }

  return suggestions;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  buildDeck,
  shuffle,
  drawCards,
  crownSpread,
  synthesiseCrownSpread, // NEW -- see fix comment above crownSpread()
  cardToString,
  cardDisplay,
  loadRegionData,
  setWorldManager,
  getCardMeaningFromRegion,
  getWildcardMeaning,
  getAceEffect,
  synthesiseConsequence,
  processStoryBeats,
  // Expose constants for reference
  SUITS,
  RANKS,
  SUIT_SYMBOLS,
  RANK_NAMES,
  CROWN_POSITIONS,
  ACE_EFFECTS
};