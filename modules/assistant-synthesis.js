// modules/assistant-synthesis.js
//
// LLM synthesis for the Assistant GM's SB-spend and Crown Spread commands
// (ROADMAP.md item 2). Turns a bare card draw / SB-tier lookup into real
// grounded prose via one short, single-purpose out-of-band LLM call --
// the same pattern ai-gm-bot.js's summariseStory() already uses for the
// conversation summarizer, not the main narration turn.
//
// Deliberately skippable: ASSISTANT_SYNTHESIS_ENABLED=false (env, default
// true) or a per-call `raw: true` (the `!gm ... --raw` flag) both bypass
// the LLM call entirely and fall back to the plain templated text, so a
// cost-conscious table isn't forced to pay for a second real API call per
// spend on top of the main narration turn.

const deck = require('./deck');

const SB_TIERS = {
    1: 'minor — a small inconvenience or passing complication',
    2: 'moderate — a real setback that costs time, resources, or standing',
    3: 'serious — a significant complication that changes the shape of the scene',
};

function tierFor(n) {
    return SB_TIERS[Math.min(n, 3)] || 'major — a severe, scene-altering complication (4+ SB)';
}

function isSynthesisEnabled() {
    return (process.env.ASSISTANT_SYNTHESIS_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * @param {number} n - Story Beats being spent.
 * @param {'table'|'deck'} mode
 * @param {string} [region] - only used for mode 'deck'.
 * @param {Object} [driver] - the bot's LLM driver (context.driver).
 * @param {string} [sceneContext] - adventure-context.js's getSceneContextForPrompt() output.
 * @param {boolean} [raw] - skip synthesis even if enabled (the `--raw` flag).
 * @returns {Promise<{ text: string, synthesized: boolean }>}
 */
async function synthesizeSbSpend({ n, mode, region, driver, sceneContext, raw }) {
    let rawText;
    if (mode === 'deck') {
        const count = Math.max(1, Math.min(n, 5));
        const drawn = await deck.drawCards(count, region || 'generic', true);
        rawText = drawn.map(d => d.meaning).join('\n\n');
    } else {
        rawText = `Spending ${n} Story Beat${n > 1 ? 's' : ''} — ${tierFor(n)}.`;
    }

    if (raw || !isSynthesisEnabled() || !driver) {
        return { text: rawText, synthesized: false };
    }

    try {
        const prompt =
            `The GM is spending ${n} Story Beat${n > 1 ? 's' : ''} against the players — a ${tierFor(n)} complication.\n\n` +
            (mode === 'deck' ? `Deck of Consequences draw:\n${rawText}\n\n` : '') +
            (sceneContext ? `Current scene context:\n${sceneContext}\n\n` : '') +
            `Write ONE short, concrete complication (2-4 sentences) grounded in this scene — a specific ` +
            `consequence the GM could narrate right now, not a generic rules restatement. Output only the ` +
            `complication text, nothing else.`;
        const synthesis = await driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge GM assistant proposing one grounded complication for another GM to approve. Be concrete and brief.',
            messages: [{ role: 'user', content: prompt }],
        });
        if (synthesis && synthesis.trim()) {
            return { text: synthesis.trim(), synthesized: true };
        }
    } catch (e) {
        console.warn('[assistant-synthesis] SB spend synthesis failed, falling back to raw text:', e.message);
    }
    return { text: rawText, synthesized: false };
}

/**
 * @param {Object} crownSpreadResult - the payload the server broadcast for
 *   this draw (positions/wildcard/timer/synthesis -- see deck.js's
 *   synthesiseCrownSpread() / the server's `crown-spread` response).
 * @param {Object} [driver]
 * @param {string} [sceneContext]
 * @param {boolean} [raw]
 * @param {number} [count] - how many distinct interpretations to propose
 *   when synthesizing (decided: separate numbered suggestions, "1 2 3" --
 *   see ROADMAP.md's "Resolved" note under item 2).
 * @returns {Promise<{ texts: string[], synthesized: boolean }>} one or more
 *   candidate interpretations. Falls back to a single-element array of the
 *   server's own templated `synthesis` text when synthesis is off/fails.
 */
async function synthesizeCrownInterpretations({ crownSpreadResult, driver, sceneContext, raw, count = 3 }) {
    const rawText = crownSpreadResult?.synthesis || 'A powerful reading unfolds.';

    if (raw || !isSynthesisEnabled() || !driver) {
        return { texts: [rawText], synthesized: false };
    }

    const positions = (crownSpreadResult?.positions || [])
        .map(p => `${p.position || p.name || '?'}: ${p.meaning || p.display || ''}`)
        .join('\n');

    try {
        const prompt =
            `A Crown Spread was just drawn:\n${positions}\n` +
            (crownSpreadResult?.wildcard ? `Wildcard: ${crownSpreadResult.wildcard.display || ''}\n` : '') +
            (sceneContext ? `\nCurrent scene context:\n${sceneContext}\n` : '') +
            `\nPropose exactly ${count} DIFFERENT candidate interpretations of this spread for the campaign's ` +
            `next turn — genuinely distinct directions, not variations on one idea. Each should be 2-4 ` +
            `sentences, concrete, and grounded in the scene above. Output ONLY the ${count} interpretations, ` +
            `each on its own line, numbered "1." "2." etc, nothing else.`;
        const synthesis = await driver.generateResponse({
            systemPrompt: 'You are a Fate\'s Edge GM assistant proposing Crown Spread interpretations for another GM to choose between. Be concrete, brief, and make each option genuinely distinct.',
            messages: [{ role: 'user', content: prompt }],
        });
        if (synthesis && synthesis.trim()) {
            const texts = synthesis
                .trim()
                .split(/\n(?=\d+\.\s)/)
                .map(t => t.replace(/^\d+\.\s*/, '').trim())
                .filter(Boolean);
            if (texts.length) return { texts, synthesized: true };
        }
    } catch (e) {
        console.warn('[assistant-synthesis] Crown Spread synthesis failed, falling back to templated text:', e.message);
    }
    return { texts: [rawText], synthesized: false };
}

module.exports = { isSynthesisEnabled, synthesizeSbSpend, synthesizeCrownInterpretations, tierFor };
