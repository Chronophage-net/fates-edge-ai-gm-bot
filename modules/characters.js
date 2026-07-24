// modules/characters.js
let characters = {};

function loadCharacters(charData) {
  characters = {};
  for (const [key, value] of Object.entries(charData)) {
    characters[key.toLowerCase()] = { ...value };
  }
}

function get(name) {
  const key = name.toLowerCase();
  if (!characters[key]) {
    // Default starting stats
    characters[key] = {
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
  return characters[key];
}

function getAll() {
  return characters;
}

function update(name, changes, saveCallback) {
  const key = name.toLowerCase();
  const char = get(name);
  Object.assign(char, changes);
  if (saveCallback) saveCallback();
  return char;
}

function persist(name, saveCallback) {
  if (saveCallback) saveCallback();
}

function getPool(name, expr) {
  const char = get(name);
  const parts = expr.split('+');
  if (parts.length !== 2) return 0;
  const attr = parts[0].trim();
  const skill = parts[1].trim();
  const attrVal = char.attributes[attr] || 0;
  const skillVal = char.skills[skill] || 0;
  return attrVal + skillVal;
}

function applyDelta(name, field, delta, saveCallback) {
  const char = get(name);
  if (field === 'harm') {
    char.harm = Math.min(3, Math.max(0, char.harm + delta));
  } else if (field === 'fatigue') {
    char.fatigue = Math.max(0, char.fatigue + delta);
    const body = char.attributes.Body || 2;
    if (char.fatigue >= body) {
      char.harm = Math.min(3, char.harm + 1);
      char.fatigue = 0;
    }
  } else if (field === 'boons') {
    char.boons = Math.min(5, Math.max(0, char.boons + delta));
  } else if (field === 'obligation') {
    char.obligation = Math.max(0, char.obligation + delta);
    const spirit = char.attributes.Spirit || 2;
    const presence = char.attributes.Presence || 2;
    const capacity = spirit + presence;
    if (char.obligation > capacity) {
      const overflow = char.obligation - capacity;
      applyDelta(name, 'fatigue', overflow, saveCallback);
    }
  } else if (field === 'corruption') {
    char.corruption = Math.max(0, char.corruption + delta);
  } else if (field === 'leash') {
    char.leash = Math.max(0, char.leash + delta);
  }
  if (saveCallback) saveCallback();
  return char;
}

module.exports = { loadCharacters, get, getAll, update, persist, getPool, applyDelta };