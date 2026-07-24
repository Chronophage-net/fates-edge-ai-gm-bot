// modules/characters.js
/**
 * In-memory character store for the AI GM Bot.
 *
 * This is the single source of truth for character data during a session.
 * `dice.js` reads/writes harm & fatigue directly on the objects this module
 * hands out; `commands.js` and `gm-orchestrator.js` read/write everything else.
 * Keep that in mind before changing shapes here — this file is a shared contract.
 */

// ─── Constants ───────────────────────────────────────────────────────
// Exported so other modules (e.g. !gm setattr / !gm setskill validation)
// can check against real attribute/skill names instead of accepting typos.
const ATTRIBUTE_NAMES = ['Body', 'Wits', 'Spirit', 'Presence'];
const SKILL_NAMES = [
  'Melee', 'Ranged', 'Unarmed',
  'Athletics', 'Stealth', 'Endurance', 'Craft',
  'Sway', 'Deception', 'Subterfuge', 'Performance', 'Insight',
  'Lore', 'Investigation', 'Medicine',
  'Arcana'
];

const BOONS_MAX = 5;
// NOTE: dice.js's applyHarmAndFatigue() never caps Harm — this cap only
// applies to direct manual adjustments (!gm harm <name> <amount>). If your
// rules define a hard Harm track size, set it here and consider enforcing
// the same cap in dice.js so both paths agree.
const HARM_MAX = 5;

const DEFAULT_ATTRIBUTES = { Body: 2, Wits: 2, Spirit: 2, Presence: 2 };
const DEFAULT_SKILLS = Object.fromEntries(SKILL_NAMES.map(s => [s, 0]));

// ─── Internal store ──────────────────────────────────────────────────
let characters = {};

function makeDefaultCharacter(displayName) {
  return {
    name: displayName,
    attributes: { ...DEFAULT_ATTRIBUTES },
    skills: { ...DEFAULT_SKILLS },
    talents: [],
    bonds: [],
    complications: [],
    harm: 0,
    fatigue: 0,
    boons: 0,
    obligation: 0,
    corruption: 0,
    leash: 0,
    assets: [],
    followers: [],
    xp: 0,
    tier: 1,
  };
}

/**
 * Case-insensitively resolve a key ("body") against a canonical name ("Body").
 * Falls back to the raw input if nothing matches, so callers who pass exact
 * canonical casing behave exactly as before.
 */
function resolveKey(input, canonicalList) {
  const match = canonicalList.find(c => c.toLowerCase() === input.toLowerCase());
  return match || input;
}

// ─── Load / bulk replace ─────────────────────────────────────────────

/**
 * Replace the entire in-memory roster (e.g. on `state-updated` sync).
 * Preserves whatever "name" casing the incoming data provides.
 */
function loadCharacters(charData) {
  characters = {};
  for (const [key, value] of Object.entries(charData)) {
    characters[key.toLowerCase()] = { name: value.name || key, ...value };
  }
}

/**
 * Does this character already exist locally? Use this instead of
 * `!!get(name)` — get() auto-creates, so it always returns truthy.
 */
function exists(name) {
  return Object.prototype.hasOwnProperty.call(characters, name.toLowerCase());
}

/**
 * Get a character, creating a default one if it doesn't exist yet.
 */
function get(name) {
  const key = name.toLowerCase();
  if (!characters[key]) {
    characters[key] = makeDefaultCharacter(name);
  }
  return characters[key];
}

function getAll() {
  return characters;
}

/**
 * Remove a character entirely (e.g. an admin `!gm delete <name>` command).
 */
function remove(name) {
  const key = name.toLowerCase();
  const existed = exists(key);
  delete characters[key];
  return existed;
}

// ─── Update ──────────────────────────────────────────────────────────

/**
 * Merge `changes` into a character. Deep-merges attributes/skills so a
 * partial update like `{ attributes: { Body: 3 } }` doesn't wipe out the
 * character's other attributes.
 */
function update(name, changes, saveCallback) {
  const char = get(name);
  const { attributes, skills, ...rest } = changes || {};

  if (attributes) char.attributes = { ...char.attributes, ...attributes };
  if (skills) char.skills = { ...char.skills, ...skills };
  Object.assign(char, rest);

  if (saveCallback) saveCallback();
  return char;
}

function persist(name, saveCallback) {
  if (saveCallback) saveCallback();
}

// ─── Dice pool resolution ────────────────────────────────────────────

/**
 * Resolve "Attribute+Skill" (case-insensitive) into a dice pool size.
 */
function getPool(name, expr) {
  const char = get(name);
  const parts = expr.split('+').map(s => s.trim());
  if (parts.length !== 2) return 0;

  const attrKey = resolveKey(parts[0], ATTRIBUTE_NAMES);
  const skillKey = resolveKey(parts[1], SKILL_NAMES);

  const attrVal = char.attributes[attrKey] ?? 0;
  const skillVal = char.skills[skillKey] ?? 0;
  return attrVal + skillVal;
}

// ─── Resource deltas ─────────────────────────────────────────────────

/**
 * Apply a signed delta to a resource field, with the correct clamping and
 * overflow-conversion rules (fatigue -> harm, obligation -> fatigue).
 */
function applyDelta(name, field, delta, saveCallback) {
  const char = get(name);
  delta = Number(delta);
  if (!Number.isFinite(delta)) {
    console.warn(`applyDelta: ignoring non-finite delta "${delta}" for ${name}.${field}`);
    return char;
  }

  switch (field) {
    case 'harm': {
      char.harm = Math.min(HARM_MAX, Math.max(0, char.harm + delta));
      break;
    }
    case 'fatigue': {
      char.fatigue = Math.max(0, char.fatigue + delta);
      const body = char.attributes.Body || 2;
      // Cascade overflow: every full "Body" of fatigue converts to 1 Harm.
      while (char.fatigue >= body && body > 0) {
        char.fatigue -= body;
        char.harm = Math.min(HARM_MAX, char.harm + 1);
      }
      break;
    }
    case 'boons': {
      char.boons = Math.min(BOONS_MAX, Math.max(0, char.boons + delta));
      break;
    }
    case 'obligation': {
      char.obligation = Math.max(0, char.obligation + delta);
      const spirit = char.attributes.Spirit || 2;
      const presence = char.attributes.Presence || 2;
      const capacity = spirit + presence;
      if (char.obligation > capacity) {
        const overflow = char.obligation - capacity;
        char.obligation = capacity;
        // Cascades further into fatigue (and potentially harm) via recursion.
        applyDelta(name, 'fatigue', overflow, null);
      }
      break;
    }
    case 'corruption': {
      char.corruption = Math.max(0, char.corruption + delta);
      break;
    }
    case 'leash': {
      char.leash = Math.max(0, char.leash + delta);
      break;
    }
    default: {
      // Generic fallback for fields like xp/tier that don't need special
      // clamping logic, instead of silently doing nothing.
      const current = typeof char[field] === 'number' ? char[field] : 0;
      char[field] = Math.max(0, current + delta);
      break;
    }
  }

  if (saveCallback) saveCallback(char);
  return char;
}

module.exports = {
  loadCharacters,
  exists,
  get,
  getAll,
  remove,
  update,
  persist,
  getPool,
  applyDelta,
  // Constants exposed for validation elsewhere (e.g. !gm setattr/setskill)
  ATTRIBUTE_NAMES,
  SKILL_NAMES,
  BOONS_MAX,
  HARM_MAX,
};