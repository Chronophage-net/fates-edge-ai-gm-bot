const test = require('node:test');
const assert = require('node:assert');
const { processSpecialTags } = require('../../modules/commands.js');

// ------------------------------------------------------------------
// Mock context object – mimics what ai-gm-bot.js passes to commands.js
// ------------------------------------------------------------------
function buildMockContext() {
  const rulesText = [
    '================================================================================',
    'I. OUTCOME MATRIX',
    '================================================================================',
    'S >= DV and SB == 0 -> Clean Success',
    'S >= DV and SB > 0 -> Success with SB',
    '0 < S < DV -> Partial',
    'S == 0 -> Miss',
    '================================================================================',
  ].join('\n');
  const mockOrchestrator = {
    world: {
      getRules: () => rulesText,
    },
    campaign: {
      state: {
        scene: {},
      },
      save: async () => {},
    },
  };
  const mockCharacters = {
    get: (name) => {
      // Return a fake character for known names
      if (name === 'Levi' || name === 'me' || name === 'Unknown') {
        return {
          name: name === 'me' ? 'Levi' : name,
          attributes: { Body: 4, Mind: 3, Spirit: 2 },
          skills: { Melee: 3, Ranged: 2, Craft: 4 },
        };
      }
      return null;
    },
    getPool: (name, expr) => {
      // Mirrors modules/characters.js getPool: Attribute+Skill -> sum
      const char = mockCharacters.get(name);
      if (!char) return 0;
      const parts = expr.split('+').map((s) => s.trim());
      if (parts.length !== 2) return 0;
      const attrVal = char.attributes[parts[0]] || 0;
      const skillVal = char.skills[parts[1]] || 0;
      return attrVal + skillVal;
    },
    applyDelta: () => {},
  };
  return {
    orchestrator: mockOrchestrator,
    charactersModule: mockCharacters,
    sender: 'Levi', // default sender for 'me' resolution
  };
}

// ------------------------------------------------------------------
// Part A: [LOOKUP RULE "..."] tag
// ------------------------------------------------------------------
test('processSpecialTags - LOOKUP RULE replaces with section text', async () => {
  const context = buildMockContext();
  const input = 'Before [LOOKUP RULE "Outcome Matrix"] after.';
  const result = await processSpecialTags(input, context, 'Tester');
  // Should not contain the literal tag
  assert.doesNotMatch(result, /\[LOOKUP RULE "Outcome Matrix"\]/);
  // Should contain content from the rule section (e.g., "Clean Success")
  assert.match(result, /Clean Success/);
  // Should preserve surrounding text
  assert.match(result, /^Before [\s\S]* after\.$/);
});

test('processSpecialTags - LOOKUP RULE with unknown rule leaves tag as-is', async () => {
  const context = buildMockContext();
  const input = '[LOOKUP RULE "NonExistentRule"]';
  const result = await processSpecialTags(input, context, 'Tester');
  // If rule not found, the tag should remain (or be replaced with a fallback)
  // The current implementation returns the tag unchanged if not found.
  assert.strictEqual(result, '*(No rule section found matching "NonExistentRule".)*');
});

// ------------------------------------------------------------------
// Part B: [ROLL ...] tag – the fragile parser
// ------------------------------------------------------------------
test('processSpecialTags - ROLL well-formed with +', async () => {
  const context = buildMockContext();
  const input = '[ROLL "Levi" Body+Melee DV 3 Controlled]';
  const result = await processSpecialTags(input, context, 'Tester');
  // Should return a dice roll result, e.g. "Levi rolls 7 dice vs DV 3: ..."
  // We can't predict the exact dice, but we can check it contains "rolls" and "DV"
  assert.match(result, /rolls <strong>Body\+Melee<\/strong> \(\d+d10\) vs DV 3/);
  assert.match(result, /Controlled/); // position modifier
});

test('processSpecialTags - ROLL with spaces around + (fixed by fuzzy tag repair)', async () => {
  const context = buildMockContext();
  const input = '[ROLL "Levi" Body + Melee DV 3 Controlled]';
  // FIXED (was a KNOWN GAP): repairAITagSyntax() now runs before the strict
  // rollRegex and squeezes whitespace out of just the '+' joins in a roll
  // pool expression, so "Body + Melee" resolves exactly like "Body+Melee".
  const result = await processSpecialTags(input, context, 'Tester');
  assert.match(result, /Levi<\/strong> rolls/);
  assert.doesNotMatch(result, /\[ROLL/);
});

test('processSpecialTags - ROLL with DV as word "three" (KNOWN GAP)', async () => {
  const context = buildMockContext();
  const input = '[ROLL "Levi" Body+Melee DV three Controlled]';
  const result = await processSpecialTags(input, context, 'Tester');
  // Currently fails because DV must be numeric.
  assert.strictEqual(result, input);
  // KNOWN GAP: word numbers are not parsed.
});

test('processSpecialTags - ROLL with "me" resolves to sender', async () => {
  const context = buildMockContext();
  // Use sender 'Levi' from mock context
  const input = '[ROLL "me" Body+Melee DV 3 Controlled]';
  const result = await processSpecialTags(input, context, 'Levi');
  // Should resolve to "Levi" (the sender)
  assert.match(result, /Levi<\/strong> rolls/);
  // The tag should not appear.
  assert.doesNotMatch(result, /\[ROLL "me" Body\+Melee DV 3 Controlled\]/);
});

test('processSpecialTags - ROLL with "Unknown" placeholder', async () => {
  const context = buildMockContext();
  const input = '[ROLL "Unknown" Body+Melee DV 3 Controlled]';
  // resolveCharName maps "Unknown" -> senderName, so the sender must be
  // a resolvable character (mirrors real usage: "Unknown" means "whoever
  // is actually speaking right now").
  const result = await processSpecialTags(input, context, 'Levi');
  assert.doesNotMatch(result, /\[ROLL "Unknown" Body\+Melee DV 3 Controlled\]/);
  assert.match(result, /rolls/);
});

// ------------------------------------------------------------------
// Additional edge cases: malformed tag – but note: the well‑formedness
// check is in ai-gm-bot.js, not in commands.js. We can still test that
// processSpecialTags does not crash on malformed input.
// ------------------------------------------------------------------
test('processSpecialTags - malformed ROLL tag does not crash', async () => {
  const context = buildMockContext();
  const input = '[ROLL "Levi" Body+Melee DV]'; // missing DV number
  const result = await processSpecialTags(input, context, 'Tester');
  // Should not throw; probably returns the tag unchanged.
  assert.strictEqual(result, input);
});

// ------------------------------------------------------------------
// Part B.2: [CALL FOR ROLL ...] tag – calls for a roll WITHOUT resolving
// it (unlike [ROLL ...] above). See ai-gm-bot.js's system prompt change
// and commands.js's processSpecialTags() for the full rationale: the GM
// should ask for a roll and wait, not secretly roll on the player's
// behalf.
// ------------------------------------------------------------------
test('processSpecialTags - CALL FOR ROLL prompts for the roll instead of resolving it', async () => {
  const context = buildMockContext();
  const input = '[CALL FOR ROLL "Levi" Body+Melee DV 3 Controlled]';
  const result = await processSpecialTags(input, context, 'Tester');
  // Tag itself is gone.
  assert.doesNotMatch(result, /\[CALL FOR ROLL/);
  // But it must NOT have actually rolled dice -- no roll-result card.
  assert.doesNotMatch(result, /rolls <strong>/);
  assert.doesNotMatch(result, /Successes:/);
  // It should tell the player what to roll and how.
  assert.match(result, /Levi/);
  assert.match(result, /Body\+Melee/);
  assert.match(result, /DV 3/);
  assert.match(result, /!gm roll "Levi" Body\+Melee DV 3 Controlled/);
});

test('processSpecialTags - CALL FOR ROLL includes the GM suggestion when given', async () => {
  const context = buildMockContext();
  const input = '[CALL FOR ROLL "Levi" Presence+Sway DV 4 Desperate "Low Presence, but Melee could sell the threat instead"]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.match(result, /Low Presence, but Melee could sell the threat instead/);
});

test('processSpecialTags - CALL FOR ROLL with spaces around + (fuzzy tag repair applies here too)', async () => {
  const context = buildMockContext();
  const input = '[CALL FOR ROLL "Levi" Body + Melee DV 3 Controlled]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[CALL FOR ROLL/);
  assert.match(result, /Body\+Melee/);
});

test('processSpecialTags - CALL FOR ROLL with an unquoted name (fuzzy tag repair applies here too)', async () => {
  const context = buildMockContext();
  // Real drift seen from a small local model (llama3.2:1b) in practice --
  // it dropped the required quotes around the name entirely. Before
  // quoteBareRollName() this leaked the whole tag into chat as literal
  // unresolved bracket text instead of prompting for a roll.
  const input = 'You edge toward the opening, [CALL FOR ROLL Levi Body+Melee DV 3 Controlled] -- how do you want to play it?';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[CALL FOR ROLL/);
  assert.match(result, /Body\+Melee/);
});

test('processSpecialTags - CALL FOR ROLL with "me" resolves to sender', async () => {
  const context = buildMockContext();
  const input = '[CALL FOR ROLL "me" Body+Melee DV 3 Controlled]';
  const result = await processSpecialTags(input, context, 'Levi');
  assert.match(result, /Levi/);
  assert.doesNotMatch(result, /\[CALL FOR ROLL/);
});

test('processSpecialTags - CALL FOR ROLL with unknown character reports the same error as ROLL', async () => {
  const context = buildMockContext();
  const input = '[CALL FOR ROLL "Nobody" Body+Melee DV 3 Controlled]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.match(result, /Character "Nobody" not found/);
});

// ------------------------------------------------------------------
// Part C: [APPLY ...] / [ADD ...] / [SET POSITION ...] / [SET DV ...]
// ------------------------------------------------------------------

function buildMockContextWithDeltaTracking() {
  const context = buildMockContext();
  const calls = [];
  context.charactersModule.applyDelta = (name, field, amount) => {
    calls.push({ name, field, amount });
  };
  return { context, calls };
}

test('processSpecialTags - APPLY BOON (positive amount)', async () => {
  const { context, calls } = buildMockContextWithDeltaTracking();
  const input = '[APPLY BOON Levi 2]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[APPLY BOON/);
  assert.deepStrictEqual(calls, [{ name: 'Levi', field: 'boon', amount: 2 }]);
});

test('processSpecialTags - ADD BOON spelling also parses (regression: model uses ADD per system prompt)', async () => {
  const { context, calls } = buildMockContextWithDeltaTracking();
  const input = '[ADD BOON Levi 1]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[ADD BOON/);
  assert.deepStrictEqual(calls, [{ name: 'Levi', field: 'boon', amount: 1 }]);
});

test('processSpecialTags - APPLY with negative amount (spending a boon / removing a resource)', async () => {
  const { context, calls } = buildMockContextWithDeltaTracking();
  const input = '[APPLY BOON Levi -1]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[APPLY BOON/);
  assert.deepStrictEqual(calls, [{ name: 'Levi', field: 'boon', amount: -1 }]);
});

test('processSpecialTags - FIXED regression: multiple APPLY tags of different types in one message all resolve', async () => {
  // Regression test for a genuine bug found while writing this suite
  // (see TEST_TODO.md history / session notes): the [APPLY ...] handler
  // in modules/commands.js looped with
  // `while ((match = applyRegex.exec(output)) !== null)` while ALSO
  // reassigning `output = output.replace(match[0], replacement)` inside
  // the loop body. `applyRegex` carries the `g` flag, so it keeps its
  // own `lastIndex` across calls -- but each replacement changes the
  // string's length (the replacement text is essentially never the same
  // length as the original tag), which desynced `lastIndex` from the
  // actual position of the next tag in the now-shorter/longer `output`
  // string. Effect: with more than one [APPLY ...] tag of different
  // types in a single AI response, some were silently left unresolved
  // as literal tag text in the chat output.
  //
  // Fixed by resetting each tag handler's regex `lastIndex` to 0 after
  // every `output` mutation (applied to every `while (regex.exec(output))`
  // loop in commands.js: LOOKUP RULE, SET POSITION, SET DV, APPLY/ADD,
  // TICK TIMER, TIMER, DRAW, CROWN, SPEND SB, FACT, NPC CAST,
  // SCENE COMPLETE, NPC CREATE, TOKEN MOVE, TOKEN REMOVE,
  // ENCOUNTER RESOLVE -- all shared the identical pattern). The manual
  // (non-regex) [ROLL ...] fallback parser had the equivalent bug via a
  // stale `startIdx` offset and was fixed the same way (advance from the
  // actual replacement length instead of the pre-replacement tag length).
  const { context, calls } = buildMockContextWithDeltaTracking();
  const input = '[APPLY OBLIGATION Levi 1] [APPLY CORRUPTION Levi 1] [APPLY LEASH Levi 1] [APPLY FATIGUE Levi 1]';
  const result = await processSpecialTags(input, context, 'Tester');
  // All four tags now resolve -- none left as literal unparsed text.
  assert.doesNotMatch(result, /\[APPLY /);
  const fields = calls.map(c => c.field);
  assert.deepStrictEqual(fields, ['obligation', 'corruption', 'leash', 'fatigue']);
});

test('processSpecialTags - APPLY HARM applies armor conversion via diceModule.applyHarmAndFatigue', async () => {
  const context = buildMockContext();
  const input = '[APPLY HARM Levi 3 2]'; // 3 harm, armor step 2
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[APPLY HARM/);
  assert.match(result, /Levi took 3 Harm, armor step 2/);
});

test('processSpecialTags - APPLY with "me" placeholder resolves to sender', async () => {
  const { context, calls } = buildMockContextWithDeltaTracking();
  const input = '[APPLY BOON me 1]';
  const result = await processSpecialTags(input, context, 'Levi');
  assert.doesNotMatch(result, /\[APPLY BOON/);
  assert.deepStrictEqual(calls, [{ name: 'Levi', field: 'boon', amount: 1 }]);
});

test('processSpecialTags - SET POSITION updates campaign scene state', async () => {
  const context = buildMockContext();
  const input = '[SET POSITION Risky]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[SET POSITION/);
  assert.match(result, /Position set to Risky/);
  assert.strictEqual(context.orchestrator.campaign.state.scene.position, 'Risky');
});

test('processSpecialTags - SET DV updates campaign scene state', async () => {
  const context = buildMockContext();
  const input = '[SET DV 4]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[SET DV/);
  assert.match(result, /Default DV set to 4/);
  assert.strictEqual(context.orchestrator.campaign.state.scene.defaultDV, 4);
});

// ------------------------------------------------------------------
// Part D: [ENCOUNTER START ...] / [ENCOUNTER RESOLVE ...] tags --
// type-aware vocabulary (combat vs. non-combat encounter types).
// ------------------------------------------------------------------

function buildMockContextWithApi(apiRequestImpl) {
  const context = buildMockContext();
  context.apiRequest = apiRequestImpl;
  return context;
}

test('processSpecialTags - ENCOUNTER START with no type defaults to combat (back-compat)', async () => {
  let sentBody;
  const context = buildMockContextWithApi(async (method, path, body) => {
    sentBody = body;
    return { activeEncounter: { dv: 3 } };
  });
  const input = '[ENCOUNTER START "Bandit Ambush"]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[ENCOUNTER START/);
  assert.strictEqual(sentBody.encounter.type, 'combat');
  assert.match(result, /⚔️/);
  assert.match(result, /Bandit Ambush/);
});

test('processSpecialTags - ENCOUNTER START with an explicit non-combat type threads it through', async () => {
  let sentBody;
  const context = buildMockContextWithApi(async (method, path, body) => {
    sentBody = body;
    return { activeEncounter: { dv: 2 } };
  });
  const input = '[ENCOUNTER START "The Vault Door" lockpick]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[ENCOUNTER START/);
  assert.strictEqual(sentBody.encounter.type, 'lockpick');
  assert.match(result, /🔓/);
  assert.match(result, /Lockpick/);
});

test('processSpecialTags - ENCOUNTER START with an unrecognized type falls back to combat', async () => {
  let sentBody;
  const context = buildMockContextWithApi(async (method, path, body) => {
    sentBody = body;
    return {};
  });
  const input = '[ENCOUNTER START "Weird One" not_a_real_type]';
  await processSpecialTags(input, context, 'Tester');
  assert.strictEqual(sentBody.encounter.type, 'combat');
});

test('processSpecialTags - ENCOUNTER RESOLVE with no type on the returned resolution defaults to combat icon (back-compat)', async () => {
  const context = buildMockContextWithApi(async () => ({
    lastResolution: { encounter: 'Bandit Ambush', outcome: 'clean', result: 'The bandits flee.' },
  }));
  const input = '[ENCOUNTER RESOLVE clean "cleared the road"]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.doesNotMatch(result, /\[ENCOUNTER RESOLVE/);
  assert.match(result, /⚔️/);
  assert.match(result, /resolved as clean/);
});

test('processSpecialTags - ENCOUNTER RESOLVE with a non-combat type on the returned resolution uses that type\'s icon', async () => {
  const context = buildMockContextWithApi(async () => ({
    lastResolution: { encounter: 'The Vault Door', outcome: 'clean', result: 'The lock clicks open.', type: 'lockpick' },
  }));
  const input = '[ENCOUNTER RESOLVE clean "picked it"]';
  const result = await processSpecialTags(input, context, 'Tester');
  assert.match(result, /🔓/);
  assert.match(result, /The Vault Door/);
});
