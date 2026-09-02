// modules/dice.js
/**
 * Fate's Edge Dice Module
 * Handles all dice rolling mechanics: pools, Position, Outcome Matrix, Harm/Fatigue.
 * Enhanced with rich formatting for chat display.
 */

// ─── Core dice rolling ──────────────────────────────────────────────

/**
 * Roll a pool of d10s.
 * @param {number} count - Number of dice to roll.
 * @param {Array} existingDice - Optional array of pre-rolled dice (for re-rolls).
 * @returns {object} { dice: number[], successes: number, sb: number, results: number[] }
 */
function rollDice(count, existingDice = null) {
    const dice = existingDice || [];
    // If no existing dice provided, generate new rolls
    if (dice.length === 0) {
        for (let i = 0; i < count; i++) {
            dice.push(Math.floor(Math.random() * 10) + 1);
        }
    }
    let successes = 0;
    let storyBeats = 0;
    for (const die of dice) {
        if (die === 1) storyBeats++;
        if (die >= 6) {
            successes++;
            if (die === 10) successes++; // 10s count as 2 successes
        }
    }
    return {
        dice,
        successes,
        sb: storyBeats,
        results: dice.slice(), // shallow copy
        count: dice.length
    };
}

// ─── Position effects ──────────────────────────────────────────────

/**
 * Apply Position modifiers (re-rolls) to a roll result.
 * @param {object} result - { dice, successes, sb, results }
 * @param {string} position - 'Dominant', 'Controlled', or 'Desperate'
 * @returns {object} Modified result with new dice and updated successes/sb.
 */
function applyPosition(result, position) {
    const dice = result.dice.slice();
    const reRolled = [];

    // Pick the LOWEST eligible die, not the first one found. SRD: Dominant
    // re-rolls one failure (the lowest), Desperate re-rolls one success
    // (the lowest, and NEVER a 10 — a 10 is not on the table). This used
    // to be findIndex(), i.e. whichever happened to come first in pool
    // order, which is a different rule that merely coincides sometimes.
    const lowestIndexWhere = (pred) => {
        let best = -1;
        for (let i = 0; i < dice.length; i++) {
            if (!pred(dice[i])) continue;
            if (best === -1 || dice[i] < dice[best]) best = i;
        }
        return best;
    };

    let index = -1;
    if (position === 'Dominant') {
        index = lowestIndexWhere(d => d < 6);
    } else if (position === 'Desperate') {
        // 6–9 only. Re-rolling a 10 would let Desperate destroy the
        // pool's best die, which the ladder never does.
        index = lowestIndexWhere(d => d >= 6 && d < 10);
    }
    // Controlled: no re-rolls.

    if (index !== -1) {
        const oldVal = dice[index];
        const newVal = Math.floor(Math.random() * 10) + 1;
        dice[index] = newVal;
        reRolled.push({ old: oldVal, new: newVal });
    }

    return {
        dice,
        // Recounted from the final pool. Successes are a property of the
        // dice as they stand, so counting them is always correct; the
        // previous incremental arithmetic also got 10s wrong on Desperate
        // (a 10 is worth 2, and it subtracted 1).
        successes: countSuccesses(dice),
        // Story Beats are NOT recounted. SRD 18.1: "Re-rolling a 1 does
        // not erase its SB; if the re-rolled die also shows 1, it
        // generates additional SB." A beat is owed for every 1 the dice
        // have ever SHOWN, not every 1 still showing.
        //
        // This function used to do `if (oldVal === 1) storyBeats--`,
        // deleting the beat outright — and because Dominant now picks the
        // lowest failure, a 1 is always what it picks, so it fired on
        // very nearly every roll that earned a beat. The same bug was
        // live in three separate places in the web client. This was the
        // fourth.
        sb: (result.sb || 0) + (index !== -1 && dice[index] === 1 ? 1 : 0),
        results: dice.slice(),
        count: dice.length,
        reRolled
    };
}

/** Successes in a pool: 6–9 is one, a 10 is two. */
function countSuccesses(dice) {
    let successes = 0;
    for (const die of dice) {
        if (die >= 6) {
            successes++;
            if (die === 10) successes++;
        }
    }
    return successes;
}

// ─── Outcome determination ─────────────────────────────────────────

/**
 * Determine outcome based on successes vs DV and story beats.
 * @param {number} successes
 * @param {number} dv
 * @param {number} storyBeats
 * @returns {object} { outcome, outcomeClass, resultText, boonGain }
 */
function determineOutcome(successes, dv, storyBeats) {
    let outcome, outcomeClass, resultText, boonGain = 0;
    if (successes >= dv && storyBeats === 0) {
        outcome = 'Clean Success';
        outcomeClass = 'clean-success';
        resultText = 'Success without complication.';
        boonGain = 0;
    } else if (successes >= dv && storyBeats > 0) {
        outcome = 'Success with SB';
        outcomeClass = 'success-with-sb';
        resultText = 'Success, but the GM gains Story Beats to complicate.';
        boonGain = 0;
    } else if (successes > 0 && successes < dv) {
        outcome = 'Partial';
        outcomeClass = 'partial';
        resultText = 'Progress made, but not fully resolved.';
        boonGain = 1;
    } else if (successes === 0) {
        outcome = 'Miss';
        outcomeClass = 'miss';
        resultText = 'No progress; the situation escalates.';
        boonGain = 2;
    } else {
        // fallback
        outcome = 'Unknown';
        outcomeClass = 'unknown';
        resultText = 'An unexpected outcome.';
        boonGain = 0;
    }
    return { outcome, outcomeClass, resultText, boonGain };
}

// ─── Formatting for chat ───────────────────────────────────────────

/**
 * Get color for outcome type (for CSS).
 */
function getOutcomeColor(outcome) {
    const map = {
        'Clean Success': 'var(--green)',
        'Success with SB': 'var(--gold)',
        'Partial': 'var(--blue)',
        'Miss': 'var(--red)',
        'Unknown': 'var(--text3)'
    };
    return map[outcome] || 'var(--text3)';
}

function getOutcomeLabel(outcome) {
    return outcome || 'Unknown';
}

function getOutcomeClass(outcome) {
    const map = {
        'Clean Success': 'clean-success',
        'Success with SB': 'success-with-sb',
        'Partial': 'partial',
        'Miss': 'miss',
        'Unknown': 'unknown'
    };
    return map[outcome] || 'unknown';
}

/**
 * Format a roll result into a rich HTML string for chat.
 * @param {string} characterName
 * @param {string} poolExpr - e.g., "Body+Melee"
 * @param {number} diceCount
 * @param {object} result - from rollDice + applyPosition
 * @param {number} dv
 * @param {string} position
 * @param {object} char - optional character object to show stats
 * @returns {string} HTML-formatted string
 */
function formatRollResult(characterName, poolExpr, diceCount, result, dv, position, char = null) {
    const outcome = determineOutcome(result.successes, dv, result.sb);
    const outcomeColor = getOutcomeColor(outcome.outcome);
    const outcomeLabel = getOutcomeLabel(outcome.outcome);
    const outcomeClass = getOutcomeClass(outcome.outcome);
    const dice = result.dice || [];
    let diceStr = dice.map(d => {
        if (d === 10) return '🔟';
        if (d >= 6) return `<strong>${d}</strong>`;
        if (d === 1) return `<em>${d}</em>`;
        return `${d}`;
    }).join(' ');

    let msg = `<div class="roll-result">`;
    msg += `<div><strong>${characterName}</strong> rolls <strong>${poolExpr}</strong> (${diceCount}d10) vs DV ${dv} (${position}):</div>`;
    msg += `<div>🎲 ${diceStr}</div>`;
    msg += `<div>✅ Successes: ${result.successes} | 💀 Story Beats: ${result.sb}</div>`;
    if (result.reRolled && result.reRolled.length > 0) {
        const reRollStr = result.reRolled.map(r => `${r.old}→${r.new}`).join(', ');
        msg += `<div>🔄 Re-rolls: ${reRollStr}</div>`;
    }
    msg += `<div><span class="outcome-tag ${outcomeClass}" style="background:${outcomeColor};color:white;padding:0.1rem 0.6rem;border-radius:12px;">${outcomeLabel}</span></div>`;
    if (outcome.boonGain > 0) {
        msg += `<div>+${outcome.boonGain} Boon${outcome.boonGain > 1 ? 's' : ''}</div>`;
    }
    if (char) {
        msg += `<div style="font-size:0.8rem;color:var(--text2);">Current: Harm ${char.harm || 0}, Fatigue ${char.fatigue || 0}, Boons ${char.boons || 0}</div>`;
    }
    msg += `</div>`;
    return msg;
}

// ─── Harm and Fatigue application ──────────────────────────────────

/**
 * Apply Harm to a character with armor conversion and fatigue overflow.
 * Implements the "roller-coaster" effect.
 * @param {object} character - The character object (mutated).
 * @param {number} incomingHarm - Raw harm value before armor.
 * @param {number} armorStep - Armor step (1=Light, 2=Medium, 3=Heavy).
 * @param {Function} saveCallback - Optional function to save character state.
 */
function applyHarmAndFatigue(character, incomingHarm, armorStep = 1, saveCallback = null) {
    if (!character) return;
    // Step 1: Convert harm to fatigue based on armor
    let remainingHarm = incomingHarm;
    if (armorStep >= 1) {
        // Step 1: if Harm <= Step, mark 1 Fatigue, Harm = 0
        // Step 2: if Harm == Step, mark Step-1 Fatigue (min 1), Harm=0
        // Step 3: if Harm > Step, mark 1 Fatigue, Harm = Harm - 1
        // We'll implement a simplified version.
        if (remainingHarm <= armorStep) {
            // Gain Fatigue = armorStep - 1 (min 1)
            const fatigueGain = Math.max(1, armorStep - 1);
            character.fatigue = (character.fatigue || 0) + fatigueGain;
            remainingHarm = 0;
        } else {
            // Harm > Armor
            character.fatigue = (character.fatigue || 0) + 1;
            remainingHarm = remainingHarm - 1;
        }
    } else {
        // No armor, apply harm directly
        // But still might convert to fatigue if harm < some threshold? For simplicity, apply harm.
        // Actually, core rule: if no armor, Harm applies directly to Harm track.
        // We'll just add to harm.
        character.harm = (character.harm || 0) + remainingHarm;
        remainingHarm = 0;
    }
    // Now apply any remaining harm to the harm track
    if (remainingHarm > 0) {
        character.harm = (character.harm || 0) + remainingHarm;
    }

    // Step 2: Check fatigue overflow -> convert to harm
    // Fatigue track is up to Body attribute. If fatigue > Body, convert to harm and clear fatigue.
    const body = character.attributes?.Body || 2;
    while ((character.fatigue || 0) > body) {
        // Convert one overflow to harm
        character.harm = (character.harm || 0) + 1;
        character.fatigue = (character.fatigue || 0) - body; // Clear fatigue? Actually we clear all fatigue and add harm.
        // But the rule: when fatigue fills (>= Body), increase harm by 1 and clear fatigue.
        // So we need to handle.
        // This is a more accurate approach.
        character.harm = (character.harm || 0) + 1;
        character.fatigue = Math.max(0, (character.fatigue || 0) - body);
    }

    // Step 3: Roller-coaster: Taking Harm can clear Fatigue if Harm is applied.
    // Actually, the rule: When a character takes Harm, any existing Fatigue is cleared.
    // But we already applied harm and fatigue. We need to clear fatigue if harm was applied.
    // However, we only clear fatigue if the character actually took harm (not just fatigue).
    // Let's implement: if incomingHarm > 0, and character.harm increased, clear fatigue.
    // We can detect if harm increased.
    // For simplicity, we'll just clear fatigue if any harm was applied.
    // But careful: if armor converted harm to fatigue, the character didn't take harm.
    // So we should only clear fatigue if the character actually gained harm.
    // We'll check if the character's harm increased.
    // But we don't have the old harm. We can compare.
    // Actually, we can just check if remainingHarm > 0 before applying.
    // If remainingHarm > 0, that means harm was actually applied.
    // So we can clear fatigue in that case.
    if (remainingHarm > 0) {
        // Clear fatigue (the shock of injury)
        character.fatigue = 0;
    }

    // Ensure values are non-negative
    character.harm = Math.max(0, character.harm || 0);
    character.fatigue = Math.max(0, character.fatigue || 0);

    if (saveCallback) {
        saveCallback(character);
    }
}

// ─── Helpers to get dice pool from character ──────────────────────

/**
 * Calculate dice pool size from a character and an expression like "Body+Melee".
 * @param {string} name - Character name (unused, but kept for consistency)
 * @param {string} poolExpr - e.g., "Body+Melee"
 * @param {object} character - The character object
 * @returns {number} Pool size (attribute + skill)
 */
function getPoolFromCharacter(character, poolExpr) {
    if (!character) return 0;
    const parts = poolExpr.split('+').map(s => s.trim());
    if (parts.length !== 2) return 0;
    const [attrName, skillName] = parts;
    const attr = character.attributes?.[attrName] || 0;
    const skill = character.skills?.[skillName] || 0;
    return attr + skill;
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
    rollDice,
    applyPosition,
    determineOutcome,
    formatRollResult,
    getOutcomeColor,
    getOutcomeLabel,
    getOutcomeClass,
    applyHarmAndFatigue,
    getPoolFromCharacter
};