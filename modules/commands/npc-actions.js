// modules/commands/npc-actions.js
// Extracted from the original monolithic modules/commands.js.
// NPC attack/social/spell action resolver used by !gm npc and [NPC CAST ...].

const diceModule = require('../dice');

async function resolveNPCAction(actionType, npcName, target, context, options = {}) {
    const charactersModule = context.charactersModule;
    if (!charactersModule) return '❌ Characters module not available.';

    const orchestrator = context.orchestrator;
    if (!orchestrator) return '❌ Orchestrator not available.';

    const state = orchestrator.campaign.state;
    const saveCampaign = () => orchestrator.campaign.save();

    let sbCost = options.cost || 2;
    if (options.dangerous) sbCost += 1;
    if (options.area) sbCost += 1;

    if ((state.sb || 0) < sbCost) {
        return `❌ Not enough SB (need ${sbCost}, have ${state.sb || 0})`;
    }

    state.sb = (state.sb || 0) - sbCost;

    let result = '';
    let targetChar = charactersModule.get(target);
    const isPlayer = !!targetChar;

    switch (actionType) {
        case 'attack': {
            const harm = options.harm || 1;
            if (isPlayer) {
                diceModule.applyHarmAndFatigue(targetChar, harm, options.armorStep || 1, saveCampaign);
                result = `${npcName} attacks ${target} for ${harm} Harm.`;
                if (options.fatigue) {
                    targetChar.fatigue = (targetChar.fatigue || 0) + 1;
                    result += ` ${target} also marks 1 Fatigue.`;
                }
            } else {
                result = `${npcName} attacks ${target} (narrative).`;
            }
            break;
        }
        case 'social': {
            const tactic = options.tactic || 'intimidate';
            if (isPlayer) {
                const penalty = options.penalty || 1;
                result = `${npcName} ${tactic}s ${target}. Position worsens by ${penalty} step.`;
            } else {
                result = `${npcName} ${tactic}s ${target} (narrative).`;
            }
            break;
        }
        case 'spell': {
            const spellName = options.spell || 'Light';
            const spell = orchestrator.world.getSpell(spellName);
            if (!spell) return `❌ Spell "${spellName}" not found.`;
            const tagCount = spell.tags ? spell.tags.length : 1;
            let cost = Math.min(Math.max(tagCount, 2), 5);
            const dangerous = ['LEAP', 'FOLD', 'GATE', 'TRANSFORM', 'CREATE', 'SUMMON', 'DOMINATE', 'REVIVE'];
            if (spell.tags && spell.tags.some(t => dangerous.includes(t.toUpperCase()))) cost = Math.min(cost + 1, 6);
            if (isPlayer) {
                if (spell.tags.includes('HARM')) {
                    diceModule.applyHarmAndFatigue(targetChar, 1, 1, saveCampaign);
                    result = `${npcName} casts ${spell.name} on ${target} – ${target} takes 1 Harm.`;
                } else if (spell.tags.includes('FATIGUE')) {
                    targetChar.fatigue = (targetChar.fatigue || 0) + 1;
                    result = `${npcName} casts ${spell.name} on ${target} – ${target} marks 1 Fatigue.`;
                } else {
                    result = `${npcName} casts ${spell.name} on ${target} – the Weave shifts.`;
                }
            } else {
                result = `${npcName} casts ${spell.name} on ${target} (narrative).`;
            }
            break;
        }
        default:
            return '❌ Unknown NPC action type.';
    }

    await saveCampaign();
    return result;
}

// ─── Main command handler ──────────────────────────────────────────

module.exports = { resolveNPCAction };
