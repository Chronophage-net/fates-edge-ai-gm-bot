const SUITS = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawCards(count, region = 'generic') {
  const deck = shuffle(buildDeck());
  return deck.slice(0, count);
}

function crownSpread(region = 'generic') {
  const cards = drawCards(5, region);
  return {
    root: cards[0] || null,
    crest: cards[1] || null,
    crown: cards[2] || null,
    leftHand: cards[3] || null,
    rightHand: cards[4] || null,
  };
}

function cardToString(card) {
  if (!card) return '—';
  return `${card.rank} of ${card.suit}`;
}

module.exports = { drawCards, crownSpread, cardToString, buildDeck, shuffle };
