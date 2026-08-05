const test = require('node:test');
const assert = require('node:assert');
const travel = require('../../modules/travel.js');
const WorldManager = require('../../modules/world-manager.js').WorldManager;

// ============================================================
// generateJourney() — Core Travel Procedure
// ============================================================

test('generateJourney - suit-locked draws never mismatch (card.suit always matches the position drawn for)', async () => {
  const journey = await travel.generateJourney('acasia', 'vhasia', 3, { policed: false });
  assert.strictEqual(journey.error, undefined, journey.error);
  assert.strictEqual(journey.legs.length, 3);
  for (const leg of journey.legs) {
    assert.strictEqual(leg.cards.spade.suit, 'Spades');
    assert.strictEqual(leg.cards.heart.suit, 'Hearts');
    assert.strictEqual(leg.cards.club.suit, 'Clubs');
    assert.strictEqual(leg.cards.diamond.suit, 'Diamonds');
  }
});

test('generateJourney - timer segments follow the 2-5->4 / 6-10->6 / J-K->8 / A->10 table', () => {
  assert.strictEqual(travel.getTimerSizeFromRank('2'), 4);
  assert.strictEqual(travel.getTimerSizeFromRank('5'), 4);
  assert.strictEqual(travel.getTimerSizeFromRank('6'), 6);
  assert.strictEqual(travel.getTimerSizeFromRank('10'), 6);
  assert.strictEqual(travel.getTimerSizeFromRank('J'), 8);
  assert.strictEqual(travel.getTimerSizeFromRank('Q'), 8);
  assert.strictEqual(travel.getTimerSizeFromRank('K'), 8);
  assert.strictEqual(travel.getTimerSizeFromRank('A'), 10);
});

test('generateJourney - policed toggles the club (Pressure) source between the Wilds and the destination', async () => {
  const unpoliced = await travel.generateJourney('acasia', 'vhasia', 1, { policed: false });
  assert.strictEqual(unpoliced.error, undefined, unpoliced.error);
  assert.strictEqual(unpoliced.legs[0].clubSource.toLowerCase().includes('wild'), true);

  const policed = await travel.generateJourney('acasia', 'vhasia', 1, { policed: true });
  assert.strictEqual(policed.error, undefined, policed.error);
  // When policed, Pressure is drawn from the destination region instead of the Wilds.
  assert.notStrictEqual(policed.legs[0].clubSource.toLowerCase().includes('wild'), true);
});

// ============================================================
// generateItineraryJourney() — all 4 WORKED_ITINERARIES
// ============================================================

test('generateItineraryJourney - every entry resolves without error, and every referenced region id is real', async () => {
  const world = new WorldManager();
  await world.loadAll();
  const loadedIds = new Set(Object.keys(world.regions));
  // WILDS_REGION_ID is a real region too (data/regions/the_wilds.json).
  assert.ok(loadedIds.has(travel.WILDS_REGION_ID), 'the_wilds region must be loaded');

  for (const itinerary of travel.WORKED_ITINERARIES) {
    for (const leg of itinerary.legs) {
      for (const key of ['spade', 'heart', 'club', 'diamond']) {
        const regionId = leg[key];
        assert.ok(
          loadedIds.has(regionId),
          `Itinerary "${itinerary.key}" leg "${leg.label}" references unknown region id "${regionId}" for ${key} (real region ids: ${[...loadedIds].join(', ')})`
        );
      }
    }

    const journey = await travel.generateItineraryJourney(itinerary.key);
    assert.strictEqual(journey.error, undefined, `itinerary "${itinerary.key}" failed: ${journey.error}`);
    assert.strictEqual(journey.legs.length, itinerary.legs.length);
  }
});

// ============================================================
// generateTravelersSpread()
// ============================================================

test('generateTravelersSpread - draws 3 cards, positions in order, with universal fallback text when no region given', async () => {
  const reading = await travel.generateTravelersSpread(null);
  assert.strictEqual(reading.cards.length, 3);
  assert.deepStrictEqual(reading.cards.map(c => c.position.key), ['behind', 'ahead', 'beneath']);
  // No region -> falls back to the universal per-suit prompt text.
  const universalTexts = ['A place or landmark.', 'A person or faction.', 'A complication or threat.', 'A reward, token, or secret.'];
  for (const c of reading.cards) {
    const matchesUniversal = universalTexts.some(t => c.meaning.startsWith(t));
    assert.ok(matchesUniversal, `meaning "${c.meaning}" should be one of the universal fallback prompts`);
  }
});

// ============================================================
// handleTravelCommand() — mock context, exercise subcommands
// ============================================================

function buildMockTravelContext() {
  const state = { scene: { region: 'acasia' } };
  const orchestrator = {
    campaign: {
      state,
      save: async () => {},
    },
    world: {
      getRegion: (id) => (id === 'vhasia' || id === 'acasia' || id === 'the_wilds') ? { name: id } : null,
    },
    options: { defaultRegion: 'acasia' },
    addConversation: () => {},
  };
  return { orchestrator };
}

test('handleTravelCommand - "to" subcommand generates a journey and updates scene region', async () => {
  const context = buildMockTravelContext();
  const result = await travel.handleTravelCommand('Tester', ['to', 'vhasia', '2'], context);
  assert.match(result, /Journey:/);
  assert.strictEqual(context.orchestrator.campaign.state.scene.region, 'vhasia');
});

test('handleTravelCommand - "policed" subcommand toggles state', async () => {
  const context = buildMockTravelContext();
  const onResult = await travel.handleTravelCommand('Tester', ['policed', 'on'], context);
  assert.match(onResult, /ON/);
  assert.strictEqual(context.orchestrator.campaign.state.travel.policed, true);

  const offResult = await travel.handleTravelCommand('Tester', ['policed', 'off'], context);
  assert.match(offResult, /off/);
  assert.strictEqual(context.orchestrator.campaign.state.travel.policed, false);
});

test('handleTravelCommand - "gateway" subcommand sets and clears the gateway authority region', async () => {
  const context = buildMockTravelContext();
  const setResult = await travel.handleTravelCommand('Tester', ['gateway', 'vhasia'], context);
  assert.match(setResult, /Gateway Authority set/);
  assert.strictEqual(context.orchestrator.campaign.state.travel.gatewayId, 'vhasia');

  const clearResult = await travel.handleTravelCommand('Tester', ['gateway', 'clear'], context);
  assert.match(clearResult, /cleared/);
  assert.strictEqual(context.orchestrator.campaign.state.travel.gatewayId, null);
});

test('handleTravelCommand - "itineraries" lists Worked Itineraries', async () => {
  const context = buildMockTravelContext();
  const result = await travel.handleTravelCommand('Tester', ['itineraries'], context);
  assert.match(result, /Worked Itineraries/);
  for (const it of travel.WORKED_ITINERARIES) {
    assert.ok(result.includes(it.name), `itineraries list should include "${it.name}"`);
  }
});

test('handleTravelCommand - "itinerary" runs a named itinerary by number', async () => {
  const context = buildMockTravelContext();
  const result = await travel.handleTravelCommand('Tester', ['itinerary', '1'], context);
  assert.match(result, /Worked Itinerary:/);
});

test('handleTravelCommand - "spread" draws the Traveler\'s Spread', async () => {
  const context = buildMockTravelContext();
  const result = await travel.handleTravelCommand('Tester', ['spread'], context);
  assert.match(result, /Traveler's Spread/);
});

test('handleTravelCommand - "history" reports journeys after one has happened', async () => {
  const context = buildMockTravelContext();
  await travel.handleTravelCommand('Tester', ['to', 'vhasia', '1'], context);
  const result = await travel.handleTravelCommand('Tester', ['history'], context);
  assert.match(result, /Recent Journeys/);
});

test('handleTravelCommand - "history" with no journeys yet', async () => {
  const context = buildMockTravelContext();
  const result = await travel.handleTravelCommand('Tester', ['history'], context);
  assert.match(result, /No journeys yet/);
});
