// modules/travel.js
/**
 * Travel module for the AI GM bot -- ports the Core Travel Procedure and
 * Worked Itineraries from the web client's Travel Planner
 * (js/features/travel-planner/index.js) so the bot can narrate journeys
 * within a region and between adventures the same way the tabletop tool
 * does, using the same region decks everything else (deck.js, !gm region)
 * already reads from.
 *
 * Sourced from the Travel Reference chapter (fates_edge_amaranthine.tex /
 * fates_edge_amaranthine_condensed.tex) and the "Worked Itineraries" /
 * "Regional Routes" / "Gateway Control Points" sections of travel_guide.tex:
 *
 *   For each leg of a journey, draw one card per suit:
 *     Spade   (Place)    -- from the DESTINATION deck.
 *     Heart   (Actor)    -- from the DESTINATION deck.
 *     Club    (Pressure) -- from the WILDS deck (general hazards), unless
 *                            the route is strongly policed, in which case
 *                            it's drawn from the destination deck instead.
 *     Diamond (Leverage) -- from the GATEWAY AUTHORITY deck: whichever
 *                            polity's papers, escorts, or rights actually
 *                            gate the route (often the destination, but
 *                            not always).
 *   The highest-ranked card among the four sets the leg's timer (2-5 -> 4
 *   segments, 6-10 -> 6, J/Q/K -> 8, A -> 10). An Ace draws the Hollow's
 *   attention (+1 SB for the GM).
 *
 * Named "Worked Itineraries" are scripted leg-by-leg (region ids match
 * data/regions/*.json filename stems, same as world-manager.js/deck.js
 * already use) straight from the sourcebook, since some legs draw
 * different suits from different regions entirely (e.g. the Coastal
 * Haul's first leg draws its Diamond from Kahfagia even though the leg's
 * destination is Ecktoria) -- richer than the generic policed/gateway
 * fallback can express on its own.
 */

const deck = require('./deck.js');

// ============================================================
// CONSTANTS
// ============================================================

const SUITS = ['Spades', 'Hearts', 'Clubs', 'Diamonds'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const POKER_RANK = { 'A': 14, 'K': 13, 'Q': 12, 'J': 11, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
const SUIT_ORDER = { 'Spades': 4, 'Hearts': 3, 'Diamonds': 2, 'Clubs': 1 };

const WILDS_REGION_ID = 'the_wilds';

const TRAVELERS_SPREAD_POSITIONS = [
    { key: 'behind', label: 'The Road Behind', prompt: 'What have you left behind, and what follows you?' },
    { key: 'ahead', label: 'The Road Ahead', prompt: 'What waits for you, and what will you face?' },
    { key: 'beneath', label: 'The Road Beneath', prompt: 'What is true, whether you wish it or not?' }
];

const SUIT_UNIVERSAL_PROMPT = {
    spades: 'A place or landmark. What is its name? What happened here?',
    hearts: 'A person or faction. What do they want? What do they fear?',
    clubs: 'A complication or threat. Who or what is the obstacle?',
    diamonds: 'A reward, token, or secret. What can be gained?'
};

// Named Worked Itineraries -- region ids are data/regions/*.json filename
// stems (lowercase, underscores), consistent with world-manager.js's
// getRegion()/listRegions() and deck.js's loadRegionData().
const WORKED_ITINERARIES = [
    {
        key: 'coastal_haul',
        name: 'West-to-East Coastal Haul',
        description: 'Kahfagia -> Ecktoria -> Silkstrand (Acasia) -> Marcott (Vhasia) -> Fairport (Viterra).',
        legs: [
            { label: 'Kassamira -> Ecktoria', spade: 'ecktoria', heart: 'ecktoria', club: WILDS_REGION_ID, diamond: 'kahfagia', flavor: 'Aqueduct arcades; Coin-house factor; gale; convoy letter.' },
            { label: 'Ecktoria -> Silkstrand', spade: 'acasia', heart: 'acasia', club: 'acasia', diamond: 'acasia', flavor: "Three-Queens Bridge; Dyers' Guildmistress; loom strike; Exchange pass." },
            { label: 'Silkstrand -> Marcott', spade: 'vhasia', heart: 'vhasia', club: 'vhasia', diamond: 'vhasia', flavor: 'Pont-du-Tithe; Parlement clerk; coin rumor; letters patent.' },
            { label: 'Marcott -> Fairport', spade: 'viterra', heart: 'viterra', club: 'linn', diamond: 'viterra', flavor: 'Fairport tideworks; shipwright; boom lifts; customs seal.' }
        ]
    },
    {
        key: 'acasia_mistlands',
        name: 'Acasia -> Mistlands (Forgotten Pass + Under-Gate)',
        description: 'Silkstrand (Acasia) -> Aeler Gate -> Mistlands.',
        legs: [
            { label: 'Silkstrand -> Aeler Gate', spade: 'aeler', heart: 'aeler', club: 'aeler', diamond: 'aeler', flavor: 'Avalanche gallery; Geometer; Engineer requisition; Underway Pass.' },
            { label: 'Gate -> Mistlands', spade: 'mistlands', heart: 'mistlands', club: 'mistlands', diamond: 'mistlands', flavor: 'Bell-Line levee; Bell-warden; wraith crossing; Ward-salt.' }
        ]
    },
    {
        key: 'thin_shore_zakov_theona',
        name: 'Thin Shore -> Zakov -> Theona (Corsair Jobs)',
        description: 'A fast arc for crews running the misted coast into pirate politics and back into isle taboos.',
        legs: [
            { label: "Payden's Port -> Thin Shore (Shadow Corridor)", spade: 'valewood', heart: 'mistlands', club: 'mistlands', diamond: 'mistlands', flavor: 'Green lane / Unfound stile; Protectorate clerk; bell-line failure; Lantern Writ. Rule of 9s applies.' },
            { label: 'Thin Shore Transit (toward Zakov)', spade: 'valewood', heart: 'valewood', club: 'valewood', diamond: 'valewood', flavor: 'Sea-mist arcade; Path-warden; Sweet wind; Way-cord (spending it negates one Sweet wind lie).' },
            { label: 'Approach to Zakov (Roadstead & Booms)', spade: 'zakov', heart: 'zakov', club: 'zakov', diamond: 'zakov', flavor: 'Boomhouse or Red Wharf; Pilot-Matron or Night Magistrate; Boom Drop or Customs Sweep; Harbor-Green Chit or Pilot Token.' },
            { label: 'Zakov -> Theona (Isles & Moot)', spade: 'theona', heart: 'theona', club: 'linn', diamond: 'theona', flavor: "Uncounted Bridge; Matron of Wells or Moot Envoy; fogfall raids; Moot Token. Taboo: don't count the steps aloud." }
        ]
    },
    {
        key: 'steppe_passage',
        name: 'Steppe Passage: Black Banner Territory',
        description: 'A dangerous journey through contested lands where three powers vie for control.',
        legs: [
            { label: 'Foedus Stone -> Black Banner Camp', spade: 'vilikari', heart: 'black_banners', club: WILDS_REGION_ID, diamond: 'black_banners', flavor: 'Wolf Road milepost or Foedus Stone; Clan Elder or War Captain; Rasputitsa or Remount Sickness; Safe-conduct or Remount Chit.' },
            { label: 'Black Banner Camp -> Ykrul Territory', spade: 'ykrul', heart: 'ykrul', club: WILDS_REGION_ID, diamond: 'ykrul', flavor: "Winter camp ring or Khagan's way-station; Khatun of the Ring or Noyan envoy; Hostage protocol or Feud spark; Paiza tablet or Foedus seal." }
        ]
    }
];

// ============================================================
// DECK HELPERS -- suit-locked, so a drawn card's suit and its
// interpreted role (Place/Actor/Pressure/Leverage) always agree
// ============================================================

function buildSuitDeck(suit) {
    return deck.shuffle(RANKS.map(rank => ({ suit, rank })));
}

function makeSuitDecks() {
    return {
        Spades: buildSuitDeck('Spades'),
        Hearts: buildSuitDeck('Hearts'),
        Clubs: buildSuitDeck('Clubs'),
        Diamonds: buildSuitDeck('Diamonds')
    };
}

function drawSuitCard(suitDecks, suit) {
    if (!suitDecks[suit] || suitDecks[suit].length === 0) {
        suitDecks[suit] = buildSuitDeck(suit);
    }
    return suitDecks[suit].pop();
}

function buildMixedDeck() {
    const cards = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) cards.push({ suit, rank });
    }
    return deck.shuffle(cards);
}

function getTimerSizeFromRank(rank) {
    const val = POKER_RANK[rank] || 0;
    if (val >= 14) return 10; // Ace
    if (val >= 11) return 8;  // J/Q/K
    if (val >= 6) return 6;   // 6-10
    return 4;                 // 2-5
}

function displayRegionName(regionId, regionData) {
    if (regionData && (regionData.name || regionData.title)) {
        return (regionData.name || regionData.title).split(/\s+[-—]\s+/)[0];
    }
    return regionId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ============================================================
// LEG GENERATION
// ============================================================

// sources: { spadeId, heartId, clubId, diamondId, spadeData, heartData,
//            clubData, diamondData, legLabel, legFlavor }
async function generateLeg(suitDecks, sources, legIndex) {
    const spade = drawSuitCard(suitDecks, 'Spades');
    const heart = drawSuitCard(suitDecks, 'Hearts');
    const club = drawSuitCard(suitDecks, 'Clubs');
    const diamond = drawSuitCard(suitDecks, 'Diamonds');

    const place = deck.getCardMeaningFromRegion('spades', spade.rank, sources.spadeData);
    const actor = deck.getCardMeaningFromRegion('hearts', heart.rank, sources.heartData);
    const pressure = deck.getCardMeaningFromRegion('clubs', club.rank, sources.clubData);
    const leverage = deck.getCardMeaningFromRegion('diamonds', diamond.rank, sources.diamondData);

    const cards = [spade, heart, club, diamond];
    const highest = cards.reduce((a, b) => {
        const ra = POKER_RANK[a.rank] || 0, rb = POKER_RANK[b.rank] || 0;
        if (ra !== rb) return ra > rb ? a : b;
        return (SUIT_ORDER[a.suit] || 0) > (SUIT_ORDER[b.suit] || 0) ? a : b;
    });
    const timerSegments = getTimerSizeFromRank(highest.rank);

    const aces = cards.filter(c => c.rank === 'A');
    let aceEffect = null;
    if (aces.length > 0) {
        aceEffect = deck.getAceEffect(sources.spadeId, aces[0], sources.spadeData);
    }

    return {
        legLabel: sources.legLabel || `Leg ${legIndex + 1}`,
        legFlavor: sources.legFlavor || null,
        cards: { spade, heart, club, diamond },
        place, actor, pressure, leverage,
        timerSegments,
        timerCard: deck.cardDisplay(highest),
        aceEffect,
        aceCount: aces.length,
        spadeSource: displayRegionName(sources.spadeId, sources.spadeData),
        heartSource: displayRegionName(sources.heartId, sources.heartData),
        clubSource: displayRegionName(sources.clubId, sources.clubData),
        diamondSource: displayRegionName(sources.diamondId, sources.diamondData)
    };
}

function formatLeg(leg, idx) {
    let out = `**${leg.legLabel}** — Timer: ${leg.timerSegments} segments (${leg.timerCard})\n`;
    if (leg.legFlavor) out += `_${leg.legFlavor}_\n`;
    out += `♠ Place (${leg.spadeSource}): ${leg.place}\n`;
    out += `♥ Actor (${leg.heartSource}): ${leg.actor}\n`;
    out += `♣ Pressure (${leg.clubSource}): ${leg.pressure}\n`;
    out += `♦ Leverage (${leg.diamondSource}): ${leg.leverage}\n`;
    if (leg.aceEffect) {
        out += `🃏 **The Hollow's Attention** (GM +${leg.aceCount} SB): ${leg.aceEffect.emoji || ''} ${leg.aceEffect.text}\n`;
    }
    return out;
}

// ============================================================
// FREEFORM JOURNEY (Core Travel Procedure)
// ============================================================

async function generateJourney(startId, destId, numLegs, { policed = false, gatewayId = null } = {}) {
    const destData = await deck.loadRegionData(destId);
    if (!destData) return { error: `Could not load region data for "${destId}".` };

    const clubId = policed ? destId : WILDS_REGION_ID;
    const clubData = policed ? destData : await deck.loadRegionData(WILDS_REGION_ID);

    const diamondId = gatewayId && gatewayId !== destId ? gatewayId : destId;
    const diamondData = diamondId === destId ? destData : await deck.loadRegionData(diamondId);
    if (!diamondData) return { error: `Could not load region data for gateway "${diamondId}".` };
    if (!clubData) return { error: `Could not load region data for "${clubId}".` };

    const suitDecks = makeSuitDecks();
    const sources = {
        spadeId: destId, heartId: destId, clubId, diamondId,
        spadeData: destData, heartData: destData, clubData, diamondData
    };

    const legs = [];
    let totalTimer = 0;
    const aceEffects = [];
    for (let i = 0; i < numLegs; i++) {
        const leg = await generateLeg(suitDecks, sources, i);
        legs.push(leg);
        totalTimer += leg.timerSegments;
        if (leg.aceEffect) aceEffects.push(leg.aceEffect);
    }

    return {
        kind: 'freeform',
        startId, destId, numLegs, legs,
        totalSegments: Math.min(totalTimer, 10),
        policed, gatewayId: diamondId,
        aceEffects,
        startName: displayRegionName(startId, null),
        destName: displayRegionName(destId, destData)
    };
}

// ============================================================
// WORKED ITINERARY JOURNEY
// ============================================================

async function generateItineraryJourney(itineraryKey) {
    const itinerary = WORKED_ITINERARIES.find(it => it.key === itineraryKey);
    if (!itinerary) return { error: `Unknown itinerary "${itineraryKey}".` };

    const dataCache = new Map();
    async function getData(id) {
        if (!dataCache.has(id)) dataCache.set(id, await deck.loadRegionData(id));
        return dataCache.get(id);
    }

    const suitDecks = makeSuitDecks();
    const legs = [];
    let totalTimer = 0;
    const aceEffects = [];

    for (let i = 0; i < itinerary.legs.length; i++) {
        const def = itinerary.legs[i];
        const [spadeData, heartData, clubData, diamondData] = await Promise.all([
            getData(def.spade), getData(def.heart), getData(def.club), getData(def.diamond)
        ]);
        if (!spadeData || !heartData || !clubData || !diamondData) {
            return { error: `Could not load region data for "${def.label}".` };
        }
        const sources = {
            spadeId: def.spade, heartId: def.heart, clubId: def.club, diamondId: def.diamond,
            spadeData, heartData, clubData, diamondData,
            legLabel: def.label, legFlavor: def.flavor
        };
        const leg = await generateLeg(suitDecks, sources, i);
        legs.push(leg);
        totalTimer += leg.timerSegments;
        if (leg.aceEffect) aceEffects.push(leg.aceEffect);
    }

    return {
        kind: 'itinerary',
        itineraryKey: itinerary.key,
        itineraryName: itinerary.name,
        legs,
        totalSegments: Math.min(totalTimer, 10),
        aceEffects,
        startId: itinerary.legs[0].spade,
        destId: itinerary.legs[itinerary.legs.length - 1].spade
    };
}

// ============================================================
// THE TRAVELER'S SPREAD -- Tulkani three-card journey reading
// ============================================================

async function generateTravelersSpread(regionId) {
    const data = regionId ? await deck.loadRegionData(regionId) : null;
    const mixedDeck = buildMixedDeck();

    const cards = TRAVELERS_SPREAD_POSITIONS.map(position => {
        const card = mixedDeck.pop();
        const suitKey = card.suit.toLowerCase();
        const meaning = data
            ? deck.getCardMeaningFromRegion(suitKey, card.rank, data)
            : SUIT_UNIVERSAL_PROMPT[suitKey];
        return { position, card, meaning };
    });

    const aceCard = cards.find(c => c.card.rank === 'A');
    const aceEffect = aceCard ? deck.getAceEffect(regionId, aceCard.card, data) : null;

    return { regionId, cards, aceEffect };
}

// ============================================================
// COMMAND HANDLER
// ============================================================

function getTravelState(orchestrator) {
    const state = orchestrator.campaign.state;
    if (!state.travel) {
        state.travel = { policed: false, gatewayId: null, history: [] };
    }
    return state.travel;
}

function pushHistory(orchestrator, entry) {
    const t = getTravelState(orchestrator);
    t.history.unshift({ ...entry, timestamp: Date.now() });
    if (t.history.length > 10) t.history.length = 10;
}

// Logs the journey into the bot's own conversation history (what
// ai-gm-bot.js feeds the LLM as chat context every turn -- see
// adventure-director.js's resetNarrativeState() comment for why this,
// rather than a separate log, is what actually keeps the AI GM's
// narration aware of what just happened) and, for a deliberate
// destination change, updates the active scene's region so subsequent
// adventure content (Crown Spreads, !gm region, NPC generation) reflects
// arrival -- this is what makes travel actually move the party "between
// adventures," not just print flavor text.
function logJourneyToSession(context, journey, summaryText, { updateRegion = null } = {}) {
    const orchestrator = context.orchestrator;
    if (typeof orchestrator.addConversation === 'function') {
        orchestrator.addConversation({
            role: 'system',
            content: `[Travel] ${summaryText}`,
            timestamp: Date.now()
        });
    }
    if (updateRegion) {
        orchestrator.campaign.state.scene.region = updateRegion;
    }
}

function formatItineraryList() {
    const lines = WORKED_ITINERARIES.map((it, i) => `${i + 1}. **${it.name}** (${it.legs.length} legs) — ${it.description}`);
    return `🗒️ **Worked Itineraries:**\n${lines.join('\n')}\n\nRun one with \`!gm travel itinerary <number or name>\`.`;
}

function resolveItinerary(arg) {
    if (!arg) return null;
    const n = parseInt(arg, 10);
    if (!isNaN(n) && n >= 1 && n <= WORKED_ITINERARIES.length) return WORKED_ITINERARIES[n - 1];
    const lower = arg.toLowerCase().replace(/\s+/g, '_');
    return WORKED_ITINERARIES.find(it => it.key === lower || it.name.toLowerCase().includes(arg.toLowerCase())) || null;
}

/**
 * !gm travel                         - usage + current settings
 * !gm travel to <region> [legs]      - freeform journey from the current
 *                                       scene region to <region>
 * !gm travel policed on|off          - toggle strongly-policed route
 * !gm travel gateway <region|clear>  - set/clear the gateway authority
 * !gm travel itineraries             - list Worked Itineraries
 * !gm travel itinerary <n|name>      - run a named Worked Itinerary,
 *                                       arriving at its final region
 * !gm travel spread [region]         - draw the Traveler's Spread
 * !gm travel history                 - last journeys this campaign
 */
async function handleTravelCommand(sender, args, context) {
    const orchestrator = context.orchestrator;
    if (!orchestrator || !orchestrator.campaign) return '❌ Orchestrator not available.';
    deck.setWorldManager(orchestrator.world);

    const campaignState = orchestrator.campaign.state;
    const saveCampaign = () => orchestrator.campaign.save();
    const travelState = getTravelState(orchestrator);

    const sub = (args[0] || '').toLowerCase();

    // ─── Usage / status ─────────────────────────────────────────
    if (!sub) {
        const current = campaignState.scene?.region || orchestrator.options?.defaultRegion || 'unknown';
        return `🗺️ **Travel** — currently in **${displayRegionName(current, orchestrator.world.getRegion(current))}**\n` +
            `Strongly Policed Route: ${travelState.policed ? 'ON' : 'off'} | Gateway Authority: ${travelState.gatewayId ? displayRegionName(travelState.gatewayId, null) : 'destination (default)'}\n\n` +
            `\`!gm travel to <region> [legs]\` — freeform journey (Core Travel Procedure)\n` +
            `\`!gm travel policed on|off\` — toggle strongly-policed route\n` +
            `\`!gm travel gateway <region|clear>\` — set the gateway authority region\n` +
            `\`!gm travel itineraries\` — list named Worked Itineraries\n` +
            `\`!gm travel itinerary <n|name>\` — run a Worked Itinerary\n` +
            `\`!gm travel spread [region]\` — draw the Traveler's Spread\n` +
            `\`!gm travel history\` — recent journeys`;
    }

    // ─── Policed toggle ─────────────────────────────────────────
    if (sub === 'policed') {
        const val = (args[1] || '').toLowerCase();
        if (val !== 'on' && val !== 'off') return 'Usage: !gm travel policed on|off';
        travelState.policed = val === 'on';
        await saveCampaign();
        return `♣ Strongly Policed Route: ${travelState.policed ? 'ON (Pressure drawn from destination)' : 'off (Pressure drawn from the Wilds)'}`;
    }

    // ─── Gateway authority ──────────────────────────────────────
    if (sub === 'gateway') {
        const arg = (args[1] || '').toLowerCase();
        if (!arg) return 'Usage: !gm travel gateway <region>  or  !gm travel gateway clear';
        if (arg === 'clear') {
            travelState.gatewayId = null;
            await saveCampaign();
            return '♦ Gateway Authority cleared — defaults to the destination.';
        }
        const regionId = arg.replace(/\s+/g, '_');
        if (!orchestrator.world.getRegion(regionId)) return `❌ Unknown region "${args[1]}". Try \`!gm region list\`.`;
        travelState.gatewayId = regionId;
        await saveCampaign();
        return `♦ Gateway Authority set to **${displayRegionName(regionId, orchestrator.world.getRegion(regionId))}**.`;
    }

    // ─── Freeform journey ───────────────────────────────────────
    if (sub === 'to') {
        const rest = args.slice(1);
        let numLegs = 3;
        if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1])) {
            numLegs = Math.max(1, Math.min(5, parseInt(rest.pop(), 10)));
        }
        const destArg = rest.join(' ');
        if (!destArg) return 'Usage: !gm travel to <region> [legs]';
        const destId = destArg.toLowerCase().replace(/\s+/g, '_');
        if (!orchestrator.world.getRegion(destId)) return `❌ Unknown region "${destArg}". Try \`!gm region list\`.`;

        const startId = campaignState.scene?.region || orchestrator.options?.defaultRegion || destId;
        if (startId === destId) return '❌ You are already there.';

        const journey = await generateJourney(startId, destId, numLegs, {
            policed: travelState.policed,
            gatewayId: travelState.gatewayId
        });
        if (journey.error) return `❌ ${journey.error}`;

        const header = `🗺️ **Journey: ${journey.startName} → ${journey.destName}** (${numLegs} leg${numLegs > 1 ? 's' : ''}, ${journey.totalSegments}-segment total timer)`;
        const body = journey.legs.map(formatLeg).join('\n');
        const summary = `${header}\n\n${body}`;

        pushHistory(orchestrator, { kind: 'freeform', from: journey.startName, to: journey.destName, legs: numLegs });
        logJourneyToSession(context, journey,
            `The party travels from ${journey.startName} to ${journey.destName} (${numLegs} legs, timer ${journey.totalSegments}).${journey.aceEffects.length ? ' The Hollow took notice along the way.' : ''}`,
            { updateRegion: destId });
        await saveCampaign();

        return summary + `\n\n📍 Arrived — region set to **${journey.destName}**.`;
    }

    // ─── Worked Itineraries ─────────────────────────────────────
    if (sub === 'itineraries') {
        return formatItineraryList();
    }

    if (sub === 'itinerary') {
        const itinerary = resolveItinerary(args.slice(1).join(' '));
        if (!itinerary) return `❌ Unknown itinerary. ${formatItineraryList()}`;

        const journey = await generateItineraryJourney(itinerary.key);
        if (journey.error) return `❌ ${journey.error}`;

        const header = `🗒️ **Worked Itinerary: ${journey.itineraryName}** (${journey.legs.length} legs, ${journey.totalSegments}-segment total timer)`;
        const body = journey.legs.map(formatLeg).join('\n');
        const destData = orchestrator.world.getRegion(journey.destId);
        const destName = displayRegionName(journey.destId, destData);

        pushHistory(orchestrator, { kind: 'itinerary', name: journey.itineraryName, legs: journey.legs.length });
        logJourneyToSession(context, journey,
            `The party follows the "${journey.itineraryName}" itinerary and arrives in ${destName}.${journey.aceEffects.length ? ' The Hollow took notice along the way.' : ''}`,
            { updateRegion: journey.destId });
        await saveCampaign();

        return `${header}\n\n${body}\n\n📍 Arrived — region set to **${destName}**.`;
    }

    // ─── Traveler's Spread ──────────────────────────────────────
    if (sub === 'spread') {
        const regionArg = args.slice(1).join(' ');
        const regionId = regionArg ? regionArg.toLowerCase().replace(/\s+/g, '_') : (campaignState.scene?.region || null);
        const reading = await generateTravelersSpread(regionId);

        let out = `🔮 **The Traveler's Spread**${regionId ? ` (${displayRegionName(regionId, orchestrator.world.getRegion(regionId))})` : ''}\n`;
        for (const c of reading.cards) {
            out += `\n**${c.position.label}** — _${c.position.prompt}_\n${deck.cardDisplay(c.card)}: ${c.meaning}\n`;
        }
        if (reading.aceEffect) {
            out += `\n🃏 **The Hollow's Attention** (GM +1 SB): ${reading.aceEffect.emoji || ''} ${reading.aceEffect.text}`;
        }
        return out;
    }

    // ─── History ────────────────────────────────────────────────
    if (sub === 'history') {
        if (travelState.history.length === 0) return '📜 No journeys yet.';
        return '📜 **Recent Journeys:**\n' + travelState.history.map(h => {
            const when = new Date(h.timestamp).toLocaleString();
            return h.kind === 'itinerary'
                ? `- [${when}] Itinerary: ${h.name} (${h.legs} legs)`
                : `- [${when}] ${h.from} → ${h.to} (${h.legs} legs)`;
        }).join('\n');
    }

    return 'Usage: !gm travel [to <region> [legs] | policed on|off | gateway <region>|clear | itineraries | itinerary <n|name> | spread [region] | history]';
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    WORKED_ITINERARIES,
    WILDS_REGION_ID,
    generateJourney,
    generateItineraryJourney,
    generateTravelersSpread,
    handleTravelCommand,
    getTimerSizeFromRank,
    formatLeg
};
