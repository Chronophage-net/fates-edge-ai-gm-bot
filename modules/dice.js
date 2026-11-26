// modules/dice.js
/**
 * Fate's Edge Dice Module
 * Handles all dice rolling mechanics: pools, Position, Outcome Matrix, Harm/Fatigue.
 * Enhanced with rich formatting for chat display.
 */

// ─── Core dice rolling ──────────────────────────────────────────────

const MAX_POOL = 10;

/** Pool cap for a character's tier (SRD 02/15): 8 at Tier I, 9 at II, 10 above. */
function maxPoolFor(character) {
    const xp = Number(character?.xp) || 0;
    return xp <= 40 ? 8 : xp <= 90 ? 9 : MAX_POOL;
}

/**
 * Roll a pool of d10s.
 * @param {number} count - Number of dice to roll.
 * @param {Array} existingDice - Optional array of pre-rolled dice (for re-rolls).
 * @returns {object} { dice: number[], successes: number, sb: number, results: number[] }
 */
function rollDice(count, existingDice = null, maxPool = MAX_POOL) {
    const dice = existingDice || [];
    // SRD 02 Maximum Dice Pool: at most 10d10 (8 at Tier I, 9 at Tier II);
    // each die past the cap is an automatic success instead.
    const autoSuccesses = existingDice ? 0 : Math.max(0, count - maxPool);
    // If no existing dice provided, generate new rolls
    if (dice.length === 0) {
        for (let i = 0; i < count - autoSuccesses; i++) {
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
        successes: successes + autoSuccesses,
        autoSuccesses,
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
    // Tags and commands arrive in any case ("dominant", "DESPERATE").
    position = typeof position === 'string' ? position.charAt(0).toUpperCase() + position.slice(1).toLowerCase() : position;
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
        successes: countSuccesses(dice) + (result.autoSuccesses || 0),
        autoSuccesses: result.autoSuccesses || 0,
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
 * Apply Harm from one hit, following the SRD procedure (09 Health, Fatigue
 * and Harm). Compare incoming Harm H with armor Step S:
 *   H <= S: mark max(1, H-1) Fatigue, take no Harm.
 *   H >  S: mark max(1, S-1) Fatigue and take H-S Harm; a wound that gets
 *           through clears all existing Fatigue first.
 * Then add the Fatigue; if the track (Body) fills, raise Harm one level,
 * clear Fatigue and discard the excess -- once per hit, never looped.
 * Harm levels stop at 3 (incapacitated); Harm taken at 3 kills.
 * @returns {{harmTaken:number, fatigueGained:number, overflow:boolean, incapacitated:boolean, dead:boolean}}
 */
function applyHarmAndFatigue(character, incomingHarm, armorStep = 1, saveCallback = null) {
    if (!character) return null;
    const H = Math.max(0, Number(incomingHarm) || 0);
    const S = Math.max(0, Number.isFinite(Number(armorStep)) ? Number(armorStep) : 1);
    if (H === 0) return { harmTaken: 0, fatigueGained: 0, overflow: false, incapacitated: (character.harm || 0) >= 3, dead: !!character.dead };

    const fatigueGained = H <= S ? Math.max(1, H - 1) : Math.max(1, S - 1);
    const woundHarm = H <= S ? 0 : H - S;
    let harmTaken = 0;
    if (woundHarm > 0) {
        character.fatigue = 0;
        harmTaken += addHarm(character, woundHarm);
    }
    character.fatigue = (character.fatigue || 0) + fatigueGained;
    const body = Math.max(1, character.attributes?.Body || 2);
    let overflow = false;
    if (character.fatigue >= body) {
        overflow = true;
        character.fatigue = 0;
        harmTaken += addHarm(character, 1);
    }
    if (saveCallback) saveCallback(character);
    return { harmTaken, fatigueGained, overflow, incapacitated: character.harm >= 3, dead: !!character.dead };
}

/** Raise Harm by `amount` levels, capped at 3; Harm past 3 marks death. */
function addHarm(character, amount) {
    const before = character.harm || 0;
    const target = before + amount;
    if (target > 3) character.dead = true;
    character.harm = Math.min(3, target);
    return character.harm - before;
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
    maxPoolFor,
    MAX_POOL,
    getPoolFromCharacter
};