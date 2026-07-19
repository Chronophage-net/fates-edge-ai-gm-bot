// Roll a pool of d10s
function rollDice(count) {
  const results = [];
  let successes = 0;
  let sb = 0;
  for (let i = 0; i < count; i++) {
    const roll = Math.floor(Math.random() * 10) + 1;
    results.push(roll);
    if (roll === 1) sb++;
    else if (roll >= 6 && roll <= 9) successes++;
    else if (roll === 10) successes += 2; // critical
  }
  return { results, successes, sb };
}

// Apply Position re-rolls
// Position: 'Dominant' (re-roll failures), 'Controlled' (none), 'Desperate' (re-roll successes)
// 10s are never re-rolled.
function applyPosition(result, position) {
  let { results, successes, sb } = result;
  if (position === 'Dominant') {
    // Re-roll one failure (die < 6, and not a 1? Actually failures are 2-5? But 1 is SB; we should reroll a non-1 failure)
    // Find first die that is 2-5, reroll it.
    const idx = results.findIndex(r => r >= 2 && r <= 5);
    if (idx !== -1) {
      const newRoll = Math.floor(Math.random() * 10) + 1;
      const old = results[idx];
      results[idx] = newRoll;
      // adjust successes and sb
      if (old >= 6 && old <= 9) successes--; // shouldn't happen, but safe
      else if (old === 10) successes -= 2;
      else if (old === 1) sb--;
      // add new
      if (newRoll >= 6 && newRoll <= 9) successes++;
      else if (newRoll === 10) successes += 2;
      else if (newRoll === 1) sb++;
    }
  } else if (position === 'Desperate') {
    // Re-roll one success (die >= 6). 10s are never re-rolled.
    const idx = results.findIndex(r => r >= 6 && r <= 9);
    if (idx !== -1) {
      const newRoll = Math.floor(Math.random() * 10) + 1;
      const old = results[idx];
      results[idx] = newRoll;
      if (old >= 6 && old <= 9) successes--;
      else if (old === 10) successes -= 2;
      else if (old === 1) sb--;
      if (newRoll >= 6 && newRoll <= 9) successes++;
      else if (newRoll === 10) successes += 2;
      else if (newRoll === 1) sb++;
    }
  }
  return { results, successes, sb };
}

// Determine outcome based on successes, DV, SB
function determineOutcome(successes, dv, sb) {
  let outcome = '';
  let boonGain = 0;
  if (successes >= dv && sb === 0) {
    outcome = '✅ **Clean Success** – your action succeeds without complication.';
  } else if (successes >= dv && sb > 0) {
    outcome = `⚠️ **Success with SB** – your action succeeds, but the GM gains ${sb} Story Beats to introduce a complication.`;
  } else if (successes > 0 && successes < dv) {
    outcome = '🔄 **Partial** – you make progress, but not fully. Gain 1 Boon.';
    boonGain = 1;
  } else if (successes === 0) {
    outcome = '❌ **Miss** – you fail, and the situation worsens. Gain 2 Boons; GM gains SB to escalate.';
    boonGain = 2;
  }
  return { outcome, boonGain };
}

// Armor conversion: uses the step method.
// Incoming Harm H, Armor Step P (Light=1, Medium=2, Heavy=3)
// Returns { fatigueGained, harmRemaining }
function convertArmor(harm, armorStep) {
  let fatigueGained = 0;
  let harmRemaining = harm;
  if (harm <= armorStep) {
    // all converted
    fatigueGained = Math.max(1, harm - 1); // minimum 1 Fatigue per hit
    harmRemaining = 0;
  } else {
    // first step converted
    fatigueGained = Math.max(1, armorStep - 1);
    harmRemaining = harm - armorStep;
  }
  return { fatigueGained, harmRemaining };
}

// Apply the roller-coaster: when Harm is taken, clear all Fatigue, then apply Harm and Fatigue.
// This function takes a character state (from characters module) and applies the effect.
function applyHarmAndFatigue(charState, harm, armorStep, saveCallback) {
  // 1. Convert Harm using armor
  const { fatigueGained, harmRemaining } = convertArmor(harm, armorStep);
  
  // 2. Apply Harm remaining: clear Fatigue, then increase Harm
  if (harmRemaining > 0) {
    charState.fatigue = 0; // clear all Fatigue (roller-coaster)
    charState.harm = Math.min(3, charState.harm + harmRemaining);
  }
  
  // 3. Add Fatigue from conversion
  charState.fatigue += fatigueGained;
  
  // 4. Overflow: if Fatigue >= Body, overflow to Harm
  const body = charState.attributes.Body || 2;
  while (charState.fatigue >= body) {
    charState.harm = Math.min(3, charState.harm + 1);
    charState.fatigue -= body;
  }
  
  if (saveCallback) saveCallback();
  return charState;
}

// Format roll result for chat
function formatRollResult(name, poolExpr, diceCount, result, dv, position) {
  const { results, successes, sb } = result;
  const outcome = determineOutcome(successes, dv, sb);
  const boonNote = outcome.boonGain > 0 ? ` (+${outcome.boonGain} Boon${outcome.boonGain > 1 ? 's' : ''})` : '';
  return (
    `🎲 **${name}** rolled **${diceCount}d10** for **${poolExpr}** (DV ${dv}, ${position}).\n` +
    `   Rolls: [${results.join(', ')}] → ${successes} success${successes !== 1 ? 'es' : ''}, ${sb} SB.\n` +
    `${outcome.outcome}${boonNote}`
  );
}

module.exports = { rollDice, applyPosition, determineOutcome, convertArmor, applyHarmAndFatigue, formatRollResult };
