// modules/commands/process-tags.js
// Extracted from the original monolithic modules/commands.js.
// Processes AI-emitted [TAG ...] directives embedded in narration
// text (rolls, position/DV changes, timers, tokens, encounters,
// knowledge reveal/hide, etc.) into side effects + replacement text.
// Kept as one cohesive function -- every tag regex operates in
// sequence on a single shared, progressively-mutated 'output'
// string, so splitting it further would require deeper
// restructuring than a mechanical extraction.

const diceModule = require('../dice');
const timersModule = require('../timers');
const adventureDirector = require('../adventure-director');
const rulesModule = require('../rules-index');
const { getVocab, encounterType } = require('../objective-types');
const knowledgeIndex = require('../knowledge-index');
const assistantSuggestions = require('../assistant-suggestions');
const adventureContext = require('../adventure-context');
const WebSocket = require('ws');
const { repairAITagSyntax } = require('./tag-repair');
const { encounterIcon, placeOrUpdateToken, moveToken, removeToken, clearEnemyTokens, inferFaction } = require('./tokens');

async function processSpecialTags(text, context, senderName = null) {
    const charactersModule = context.charactersModule;
    if (!charactersModule) {
        return text;
    }

    if (!context.orchestrator) {
        return text;
    }

    // Repair drift in the model's own tag syntax before any of the
    // strict per-tag regexes below get a chance at it.
    text = repairAITagSyntax(text);
    const campaignState = context.orchestrator.campaign.state;
    const saveCampaign = () => context.orchestrator.campaign.save();
    const ws = context.ws;

    // ─── Timeout helper ──────────────────────────────────────────────
    // Prevents any individual API request from hanging the entire function.
    const withTimeout = (promise, ms = 5000, fallback = null) => {
        return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
        ]).catch(() => fallback);
    };

    // ─── Assistant GM mode ──────────────────────────────────────────
    const isAssistant = context.myRole === 'assistant-gm';

    let output = text;

    // Helper to resolve character name
    const resolveCharName = (name) => {
        if ((name === 'me' || (typeof name === 'string' && name.toLowerCase() === 'unknown')) && senderName) {
            return senderName;
        }
        return name;
    };

    // ─── Helper: process a single roll tag ─────────────────────────
    async function processRollTag(name, poolExpr, dv, position, fullTag) {
        name = resolveCharName(name);
        const char = charactersModule.get(name);
        const hasAttributes = char && Object.keys(char.attributes || {}).some(k => char.attributes[k] !== undefined);

        if (!hasAttributes) {
            return `*(⚠️ Character "${name}" not found. Please select a character in the VTT or create one with \`!gm create "${name}"\`.)*`;
        }

        const diceCount = charactersModule.getPool(name, poolExpr);
        if (diceCount === 0) {
            return `*(Could not resolve dice pool for ${name} with "${poolExpr}". Check attribute/skill names.)*`;
        }

        let result = diceModule.rollDice(diceCount);
        result = diceModule.applyPosition(result, position);
        const formatted = diceModule.formatRollResult(name, poolExpr, diceCount, result, dv, position, char);
        const outcome = diceModule.determineOutcome(result.successes, dv, result.sb);
        if (outcome.boonGain > 0) {
            charactersModule.applyDelta(name, 'boons', outcome.boonGain, saveCampaign);
        }
        campaignState.sb = (campaignState.sb || 0) + result.sb;
        saveCampaign();
        return formatted;
    }

    let match;

    // ─── [CALL FOR ROLL ...] – GM calls for a roll, does NOT resolve it ──
    // Unlike [ROLL ...] below (which immediately rolls dice and returns a
    // finished result), this tag is how the GM asks a player to make a
    // check without deciding the outcome for them. A real GM says "make a
    // Presence roll" (and maybe "-- though your low Presence means you
    // might get more out of leaning on your Melee skill to intimidate
    // instead") and then *waits*; they don't secretly roll the dice on the
    // player's behalf the instant the words leave their mouth. This
    // renders a prompt telling the player exactly what to roll (and an
    // optional GM suggestion/alternative-approach note) and leaves the
    // actual roll to the player's own `!gm roll ...` command or VTT roll
    // button -- see ai-gm-bot.js's recordRollResultInHistory() for how
    // that eventual result gets back into the AI's context so it can
    // react to a roll it didn't fabricate itself.
    const callForRollRegex = /\[CALL FOR ROLL\s*"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)(?:\s*"([^"]*)")?\s*\]/gi;
    while ((match = callForRollRegex.exec(output)) !== null) {
        const name = resolveCharName(match[1]);
        const poolExpr = match[2];
        const dv = parseInt(match[3]);
        const position = match[4];
        const suggestion = (match[5] || '').trim();

        const char = charactersModule.get(name);
        const hasAttributes = char && Object.keys(char.attributes || {}).some(k => char.attributes[k] !== undefined);

        let replacement;
        if (!hasAttributes) {
            replacement = `*(⚠️ Character "${name}" not found. Please select a character in the VTT or create one with \`!gm create "${name}"\`.)*`;
        } else {
            const diceCount = charactersModule.getPool(name, poolExpr);
            const poolNote = diceCount > 0 ? ` (${diceCount} dice)` : '';
            replacement = `🎲 **${name}**, this calls for a **${poolExpr}** roll — DV ${dv}, ${position}${poolNote}.` +
                (suggestion ? ` _${suggestion}_` : '') +
                ` Roll it with \`!gm roll "${name}" ${poolExpr} DV ${dv} ${position}\` — or describe a different approach and I'll adjust the pool — whenever you're ready.`;
        }
        output = output.replace(match[0], replacement);
        callForRollRegex.lastIndex = 0;
    }

    // ─── [ROLL ...] – supports "me" placeholder ────────────────────
    // Immediately rolls and resolves. Still used for GM/system-driven
    // rolls (e.g. an NPC's own check, or a roll a player already agreed to
    // out loud) — the AI's system prompt now steers it toward [CALL FOR
    // ROLL ...] instead for asking a *player* to roll, so this tag firing
    // less often against player characters is expected and fine.
    // First, try the regex approach with flexible spacing
    const rollRegex = /\[ROLL\s*"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)\s*\]/gi;
    let foundAny = false;
    while ((match = rollRegex.exec(text)) !== null) {
        foundAny = true;
        const name = match[1];
        const poolExpr = match[2];
        const dv = parseInt(match[3]);
        const position = match[4];
        const replacement = await processRollTag(name, poolExpr, dv, position, match[0]);
        output = output.replace(match[0], replacement);
    }

    // If regex found nothing, try a more manual parser (more forgiving of whitespace)
    if (!foundAny) {
        let startIdx = 0;
        while (true) {
            const rollStart = output.indexOf('[ROLL "', startIdx);
            if (rollStart === -1) break;
            const rollEnd = output.indexOf(']', rollStart);
            if (rollEnd === -1) break;
            const fullTag = output.slice(rollStart, rollEnd + 1);
            const tagContent = output.slice(rollStart + 7, rollEnd);
            const parts = tagContent.match(/"([^"]+)"\s*([A-Za-z\+]+)\s*DV\s*(\d+)\s*([A-Za-z]+)/);
            if (parts) {
                const name = parts[1];
                const poolExpr = parts[2];
                const dv = parseInt(parts[3]);
                const position = parts[4];
                const replacement = await processRollTag(name, poolExpr, dv, position, fullTag);
                output = output.replace(fullTag, replacement);
                startIdx = rollStart + replacement.length;
            } else {
                startIdx = rollEnd + 1;
            }
        }
    }

    // ─── [LOOKUP RULE "..."] ────────────────────────────────────────
    const lookupRegex = /\[LOOKUP RULE\s*"([^"]+)"\s*\]/gi;
    while ((match = lookupRegex.exec(output)) !== null) {
        const query = match[1];
        const rulesText = context.orchestrator?.world?.getRules?.() || context.orchestrator?.world?.rules;
        const section = rulesModule.findSection(rulesText, query);
        const replacement = section
            ? `\n---\n**${section.title}**\n${section.body}\n---\n`
            : `*(No rule section found matching "${query}".)*`;
        output = output.replace(match[0], replacement);
        lookupRegex.lastIndex = 0;
    }

    // ─── [SET POSITION ...] ────────────────────────────────────────
    const posRegex = /\[SET POSITION ([A-Za-z]+)\]/gi;
    while ((match = posRegex.exec(output)) !== null) {
        const pos = match[1];
        campaignState.scene.position = pos;
        saveCampaign();
        output = output.replace(match[0], `*(Position set to ${pos})*`);
        posRegex.lastIndex = 0;
    }

    // ─── [SET DV ...] ──────────────────────────────────────────────
    const dvRegex = /\[SET DV (\d+)\]/gi;
    while ((match = dvRegex.exec(output)) !== null) {
        const dv = parseInt(match[1]);
        campaignState.scene.defaultDV = dv;
        saveCampaign();
        output = output.replace(match[0], `*(Default DV set to ${dv})*`);
        dvRegex.lastIndex = 0;
    }

    // ─── [APPLY ...] – supports "me" placeholder ───────────────────
    const applyRegex = /\[(?:APPLY|ADD)\s+(HARM|FATIGUE|BOON|OBLIGATION|CORRUPTION|LEASH)\s+([A-Za-z0-9_]+)\s+(-?\d+)(?:\s+(\d+))?\]/gi;
    while ((match = applyRegex.exec(output)) !== null) {
        const type = match[1].toLowerCase();
        let name = match[2];
        name = resolveCharName(name);
        const amount = parseInt(match[3]);
        const extra = match[4] ? parseInt(match[4]) : null;
        if (type === 'harm') {
            const armorStep = extra || 1;
            const char = charactersModule.get(name);
            diceModule.applyHarmAndFatigue(char, amount, armorStep, saveCampaign);
            output = output.replace(match[0], `*(${name} took ${amount} Harm, armor step ${armorStep})*`);
        } else {
            charactersModule.applyDelta(name, type, amount, saveCampaign);
            output = output.replace(match[0], `*(${name} ${type} ${amount >= 0 ? '+' : ''}${amount})*`);
        }
        applyRegex.lastIndex = 0;
    }

    // ─── [TICK TIMER ...] ──────────────────────────────────────────
    const tickRegex = /\[TICK TIMER "([^"]+)" (\d+)\]/gi;
    while ((match = tickRegex.exec(output)) !== null) {
        const name = match[1];
        const ticks = parseInt(match[2]);
        const filled = timersModule.tickTimer(campaignState, name, ticks);
        if (filled) {
            const event = timersModule.resolveTimer(campaignState, name);
            output = output.replace(match[0], `*(Timer "${name}" fills! ${event})*`);
        } else {
            const timer = campaignState.scene.timers.find(t => t.name === name);
            if (timer) {
                output = output.replace(match[0], `*(Timer "${name}" advanced to ${timer.current}/${timer.max})*`);
            } else {
                output = output.replace(match[0], `*(Timer "${name}" not found)*`);
            }
        }
        saveCampaign();
        tickRegex.lastIndex = 0;
    }

    // ─── [TIMER ...] – create timer ───────────────────────────────
    const createRegex = /\[TIMER "([^"]+)" (\d+) "([^"]*)"\]/gi;
    while ((match = createRegex.exec(output)) !== null) {
        const name = match[1];
        const max = parseInt(match[2]);
        const onFill = match[3] || 'Timer fills.';
        timersModule.addTimer(campaignState, name, max, onFill);
        saveCampaign();
        output = output.replace(match[0], `*(Timer "${name}" created with ${max} segments)*`);
        createRegex.lastIndex = 0;
    }

    // ─── [DRAW ...] – WebSocket deck-draw ──────────────────────────
    const drawRegex = /\[DRAW (\d+) ([\w-]+)\]/gi;
    while ((match = drawRegex.exec(output)) !== null) {
        const count = parseInt(match[1]);
        const region = match[2];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'deck-draw', count, region }));
            output = output.replace(match[0], `*(Requested draw of ${count} cards from ${region})*`);
        } else {
            output = output.replace(match[0], `*(Deck draw not available – WebSocket closed)*`);
        }
        drawRegex.lastIndex = 0;
    }

    // ─── [CROWN ...] – WebSocket crown-spread ──────────────────────
    const crownRegex = /\[CROWN ([\w-]+)\]/gi;
    while ((match = crownRegex.exec(output)) !== null) {
        const region = match[1];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'crown-spread', region }));
            output = output.replace(match[0], `*(Requested Crown Spread for ${region})*`);
        } else {
            output = output.replace(match[0], `*(Crown Spread not available – WebSocket closed)*`);
        }
        crownRegex.lastIndex = 0;
    }

    // ─── [SPEND SB ...] ────────────────────────────────────────────
    const sbRegex = /\[SPEND SB (\d+)\]/gi;
    while ((match = sbRegex.exec(output)) !== null) {
        const cost = parseInt(match[1]);
        if (campaignState.sb >= cost) {
            campaignState.sb -= cost;
            saveCampaign();
            output = output.replace(match[0], `*(Spent ${cost} Story Beat${cost > 1 ? 's' : ''})*`);
        } else {
            output = output.replace(match[0], '*(Not enough SB)*');
        }
        sbRegex.lastIndex = 0;
    }

    // ─── [FACT ...] ────────────────────────────────────────────────
    const factRegex = /\[FACT (.+?) (.+?)\]/gi;
    while ((match = factRegex.exec(output)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (isAssistant) {
            assistantSuggestions.enqueue({
                kind: 'fact',
                label: `New fact — ${key}: ${value}`,
                apply: async () => {
                    campaignState.facts[key] = value;
                    saveCampaign();
                    knowledgeIndex.indexFact(context.orchestrator?.campaign?.campaignCode, key, value).catch(() => {});
                },
            });
        } else {
            campaignState.facts[key] = value;
            saveCampaign();
            knowledgeIndex.indexFact(context.orchestrator?.campaign?.campaignCode, key, value).catch(() => {});
        }
        output = output.replace(match[0], '');
        factRegex.lastIndex = 0;
    }

    // ─── [NPC CAST ...] – supports "me" placeholder ───────────────
    const npcCastRegex = /\[NPC CAST "([^"]+)" ([^\]]+)\]/gi;
    while ((match = npcCastRegex.exec(output)) !== null) {
        const spellName = match[1];
        let target = match[2].trim();
        target = resolveCharName(target);
        const spell = context.orchestrator?.world?.getSpell(spellName);
        if (!spell) {
            output = output.replace(match[0], `*(NPC spell "${spellName}" not found)*`);
            npcCastRegex.lastIndex = 0;
            continue;
        }
        const tagCount = spell.tags ? spell.tags.length : 1;
        let sbCost = Math.min(Math.max(tagCount, 2), 5);
        const dangerousTags = ['LEAP', 'FOLD', 'GATE', 'TRANSFORM', 'CREATE', 'SUMMON', 'DOMINATE', 'REVIVE'];
        if (spell.tags && spell.tags.some(t => dangerousTags.includes(t.toUpperCase()))) {
            sbCost = Math.min(sbCost + 1, 6);
        }
        if ((campaignState.sb || 0) < sbCost) {
            output = output.replace(match[0], `*(Not enough SB (need ${sbCost}, have ${campaignState.sb || 0}) for NPC spell "${spellName}")*`);
            npcCastRegex.lastIndex = 0;
            continue;
        }
        campaignState.sb -= sbCost;
        const targetIsPlayer = charactersModule.get(target) ? true : false;
        let resultMsg = `*NPC casts ${spell.name} on ${target}*`;
        if (targetIsPlayer) {
            const char = charactersModule.get(target);
            if (spell.tags.includes('HARM')) {
                diceModule.applyHarmAndFatigue(char, 1, 1, saveCampaign);
                resultMsg += ` – ${target} takes 1 Harm.`;
            } else if (spell.tags.includes('FATIGUE')) {
                char.fatigue = (char.fatigue || 0) + 1;
                resultMsg += ` – ${target} marks 1 Fatigue.`;
            } else {
                resultMsg += ` – The Weave shifts, and ${target} feels the consequence.`;
            }
        } else {
            resultMsg += ` – The Weave answers.`;
        }
        saveCampaign();
        output = output.replace(match[0], resultMsg);
        npcCastRegex.lastIndex = 0;
    }

    // ─── [SCENE COMPLETE "notes"] ──────────────────────────────────
    const sceneCompleteRegex = /\[SCENE COMPLETE(?:\s+"([^"]*)")?\]/gi;
    while ((match = sceneCompleteRegex.exec(output)) !== null) {
        const notes = match[1] || '';
        if (isAssistant) {
            assistantSuggestions.enqueue({
                kind: 'scene-complete',
                label: `Advance the scene${notes ? ` — ${notes}` : ''}`,
                apply: async () => {
                    try {
                        // Timeout the scene completion call to avoid hanging
                        return await withTimeout(
                            adventureDirector.handleSceneComplete(context, notes),
                            5000,
                            '*(Scene completion timed out – please try again)*'
                        );
                    } catch (e) {
                        return `*(Scene completion error: ${e.message})*`;
                    }
                },
            });
            output = output.replace(match[0], '');
        } else {
            let resultMsg;
            try {
                // Timeout the scene completion call
                resultMsg = await withTimeout(
                    adventureDirector.handleSceneComplete(context, notes),
                    5000,
                    '*(Scene completion timed out – please try again)*'
                );
            } catch (e) {
                resultMsg = `*(Scene completion error: ${e.message})*`;
            }
            output = output.replace(match[0], resultMsg || '');
        }
        sceneCompleteRegex.lastIndex = 0;
    }

    // ─── [NPC CREATE "Name" "Role" "Motivation" "Location"] ────────
    const npcCreateRegex = /\[NPC CREATE "([^"]+)"(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?\]/gi;
    while ((match = npcCreateRegex.exec(output)) !== null) {
        const name = match[1];
        const role = match[2] || 'NPC';
        const motivation = match[3] || '';
        const location = match[4] || undefined;
        const registerNpc = async () => {
            try {
                // Timeout the API call to avoid hanging
                await withTimeout(
                    context.apiRequest('POST', ['adventure', 'npc'], { npc: { name, role, motivation, location } }),
                    5000
                );
            } catch (e) {
                console.warn(`[NPC CREATE] failed to register "${name}":`, e.message);
            }
            // Best-effort token placement and indexing – these are fire-and-forget with .catch()
            placeOrUpdateToken(context, { name, faction: inferFaction(role, motivation) }).catch(() => {});
            knowledgeIndex.indexNpc(context.orchestrator?.campaign?.campaignCode, {
                name, role, motivation, location, faction: inferFaction(role, motivation), source: 'created'
            }).catch(() => {});
        };
        if (isAssistant) {
            assistantSuggestions.enqueue({
                kind: 'npc-create',
                label: `New NPC — ${name}${role ? ` (${role})` : ''}`,
                apply: registerNpc,
            });
        } else {
            await registerNpc();
        }
        output = output.replace(match[0], '');
        npcCreateRegex.lastIndex = 0;
    }

    // ─── [NPC LOCATION "Name" "Place"] ──────────────────────────────
    const npcLocationRegex = /\[NPC LOCATION "([^"]+)" "([^"]*)"\]/gi;
    while ((match = npcLocationRegex.exec(output)) !== null) {
        const name = match[1];
        const place = match[2].trim();
        knowledgeIndex.updateNpcLocation(context.orchestrator?.campaign?.campaignCode, name, place || null).catch(() => {});
        output = output.replace(match[0], '');
        npcLocationRegex.lastIndex = 0;
    }

    // ─── [REVEAL "knowledge-id"] / [HIDE "knowledge-id"] ────────────
    const revealRegex = /\[REVEAL\s+"([^"]+)"\]/gi;
    while ((match = revealRegex.exec(output)) !== null) {
        const id = match[1];
        const doReveal = async () => {
            try {
                // Timeout the API call to avoid hanging
                await withTimeout(
                    context.apiRequest('POST', ['adventure', 'knowledge', 'reveal'], { id, by: context.myRole === 'assistant-gm' ? 'AI_GM (assistant)' : 'AI_GM' }),
                    5000
                );
                adventureContext.invalidate();
            } catch (e) {
                console.warn(`[REVEAL] failed to reveal "${id}":`, e.message);
            }
        };
        if (isAssistant) {
            assistantSuggestions.enqueue({ kind: 'knowledge-reveal', label: `Reveal knowledge — ${id}`, apply: doReveal });
        } else {
            await doReveal();
        }
        output = output.replace(match[0], '');
        revealRegex.lastIndex = 0;
    }

    const hideRegex = /\[HIDE\s+"([^"]+)"\]/gi;
    while ((match = hideRegex.exec(output)) !== null) {
        const id = match[1];
        const doHide = async () => {
            try {
                // Timeout the API call to avoid hanging
                await withTimeout(
                    context.apiRequest('POST', ['adventure', 'knowledge', 'hide'], { id, by: context.myRole === 'assistant-gm' ? 'AI_GM (assistant)' : 'AI_GM' }),
                    5000
                );
                adventureContext.invalidate();
            } catch (e) {
                console.warn(`[HIDE] failed to hide "${id}":`, e.message);
            }
        };
        if (isAssistant) {
            assistantSuggestions.enqueue({ kind: 'knowledge-hide', label: `Hide knowledge — ${id}`, apply: doHide });
        } else {
            await doHide();
        }
        output = output.replace(match[0], '');
        hideRegex.lastIndex = 0;
    }

    // ─── [TOKEN MOVE "Name" col row] ────────────────────────────────
    const tokenMoveRegex = /\[TOKEN MOVE "([^"]+)"\s+(-?\d+)\s+(-?\d+)\]/gi;
    while ((match = tokenMoveRegex.exec(output)) !== null) {
        const name = match[1];
        const col = parseInt(match[2], 10);
        const row = parseInt(match[3], 10);
        moveToken(context, name, col, row).catch(() => {});
        output = output.replace(match[0], '');
        tokenMoveRegex.lastIndex = 0;
    }

    // ─── [TOKEN REMOVE "Name"] ───────────────────────────────────────
    const tokenRemoveRegex = /\[TOKEN REMOVE "([^"]+)"\]/gi;
    while ((match = tokenRemoveRegex.exec(output)) !== null) {
        const name = match[1];
        removeToken(context, name).catch(() => {});
        output = output.replace(match[0], '');
        tokenRemoveRegex.lastIndex = 0;
    }

    // ─── [ENCOUNTER START "Name" type] ─────────────────────────────
    const encStartRegex = /\[ENCOUNTER START\s+"([^"]+)"(?:\s+(\w+))?\]/gi;
    while ((match = encStartRegex.exec(output)) !== null) {
        const name = match[1];
        const encType = encounterType({ type: match[2] });
        try {
            const apiRequest = context.apiRequest;
            if (apiRequest) {
                // Timeout the API call to avoid hanging
                const result = await withTimeout(
                    apiRequest('POST', ['adventure', 'encounter', 'start'], {
                        encounter: { name, type: encType },
                    }),
                    5000
                );
                const vocab = getVocab(encType);
                const dv = result?.activeEncounter?.dv;
                output = output.replace(match[0], `${encounterIcon(encType)} Encounter "${name}" (${vocab.label}) begins.${dv !== undefined ? ` DV ${dv}.` : ''}`);
            } else {
                output = output.replace(match[0], '⚠️ Encounter start failed (API not available).');
            }
        } catch (e) {
            output = output.replace(match[0], `⚠️ Encounter start error: ${e.message}`);
        }
        encStartRegex.lastIndex = 0;
    }

    // ─── [ENCOUNTER RESOLVE outcome "notes"] ──────────────────────
    const encResolveRegex = /\[ENCOUNTER RESOLVE\s+(clean|partial|miss)(?:\s+"([^"]*)")?\]/gi;
    while ((match = encResolveRegex.exec(output)) !== null) {
        const outcome = match[1];
        const notes = match[2] || '';
        try {
            const apiRequest = context.apiRequest;
            if (apiRequest) {
                // Timeout the API call to avoid hanging
                const result = await withTimeout(
                    apiRequest('POST', ['adventure', 'encounter', 'resolve'], { outcome, notes }),
                    5000
                );
                clearEnemyTokens(context).catch(() => {});
                if (result && result.lastResolution) {
                    const r = result.lastResolution;
                    const encType = encounterType(r);
                    const msg = `${encounterIcon(encType)} Encounter "${r.encounter || 'Unknown'}" resolved as ${r.outcome}.${r.result ? ' ' + r.result : ''}`;
                    output = output.replace(match[0], msg);
                } else {
                    output = output.replace(match[0], '⚔️ Encounter resolved.');
                }
            } else {
                output = output.replace(match[0], '⚠️ Encounter resolution failed (API not available).');
            }
        } catch (e) {
            output = output.replace(match[0], `⚠️ Encounter resolution error: ${e.message}`);
        }
        encResolveRegex.lastIndex = 0;
    }

    return output;
}

module.exports = { processSpecialTags };
