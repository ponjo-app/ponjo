// The poker page's dealer (site/poker.html): everything that must be exact in
// No-Limit Texas Hold'em, and nothing else. Shuffling, dealing, blinds, whose
// turn it is, what is legal, the pot and its side pots, ranking hands. Pure:
// each call takes a hand and returns a new one, so it is tested with no page
// (test/poker.test.js). The players decide; this only says what may land.
// A hand holds no deck: it is dealt its hole cards when it starts, and each
// street's cards (`board`) once the betting before it is over.
//
// A card is a string, its rank then its suit: 'As', 'Td', '7h'.

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const rankOf = (card) => RANKS.indexOf(card[0]) + 2;

// A shuffled deck: Fisher–Yates on `random(n)`, a fair whole number below n.
export function shuffled(random = cryptoRandom) {
  const deck = [...RANKS].flatMap((r) => [...SUITS].map((s) => r + s));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// `n` cards from a shuffled deck, none of them `out` (dealt already).
export const draw = (out, n) => shuffled().filter((c) => !out.includes(c)).slice(0, n);

// A fair whole number below n from crypto.getRandomValues, with no modulo bias.
function cryptoRandom(n) {
  const limit = Math.floor(2 ** 32 / n) * n;
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return word[0] % n;
}

// ---- ranking ----

const NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// Five cards' score: [category, ...tie-breakers], compared left to right.
function score5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const distinct = new Set(ranks).size === 5;
  const high = !distinct ? 0 : ranks[0] - ranks[4] === 4 ? ranks[0] : ranks[0] === 14 && ranks[1] === 5 ? 5 : 0;
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const by = groups.map(([r]) => r);
  const [n0, n1] = groups.map(([, n]) => n);
  if (high && flush) return [8, high];
  if (n0 === 4) return [7, ...by];
  if (n0 === 3 && n1 === 2) return [6, ...by];
  if (flush) return [5, ...ranks];
  if (high) return [4, high];
  if (n0 === 3) return [3, ...by];
  if (n0 === 2 && n1 === 2) return [2, ...by];
  if (n0 === 2) return [1, ...by];
  return [0, ...ranks];
}

export const compare = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

// The best five of five to seven cards: { score, name, cards }.
export function bestHand(cards) {
  let best = null;
  const pick = (from, chosen) => {
    if (chosen.length === 5) {
      const score = score5(chosen);
      if (!best || compare(score, best.score) > 0) best = { score, cards: chosen };
      return;
    }
    for (let i = from; i <= cards.length - (5 - chosen.length); i++) pick(i + 1, [...chosen, cards[i]]);
  };
  pick(0, []);
  return { ...best, name: NAMES[best.score[0]] };
}

// ---- pots ----

// The pots from what each seat put in: [{ amount, eligible: [seat] }], the
// main pot first. A seat that folded pays in but can win none.
export function pots(seats) {
  const levels = [...new Set(seats.filter((s) => !s.folded && s.total > 0).map((s) => s.total))].sort((a, b) => a - b);
  const out = [];
  let below = 0;
  for (const level of levels) {
    const amount = seats.reduce((sum, s) => sum + Math.max(0, Math.min(s.total, level) - below), 0);
    out.push({ amount, eligible: seats.flatMap((s, i) => (!s.folded && s.total >= level ? [i] : [])) });
    below = level;
  }
  const rest = seats.reduce((sum, s) => sum + Math.max(0, s.total - below), 0); // folded money above every live level
  if (rest && out.length) out[out.length - 1].amount += rest;
  return out;
}

// ---- a hand ----

const next = (hand, from, ok) => {
  for (let k = 1; k <= hand.seats.length; k++) {
    const i = (from + k) % hand.seats.length;
    if (ok(hand.seats[i], i)) return i;
  }
  return null;
};
const inHand = (s) => s.inHand && !s.folded;
const canAct = (s) => inHand(s) && !s.allIn;
const clone = (hand) => structuredClone(hand);

/**
 * A new hand. `players` are [{ id, stack }] in seat order; those with no
 * chips sit out. The button moves to the next seat with chips after
 * `button` (-1 for the first hand). Heads up, the button posts the small
 * blind. `deck`: the hole cards, dealt in order from the seat after the
 * button, two rounds; the rest are not kept.
 */
export function startHand({ id, players, button, blinds: [sb, bb], deck = shuffled() }) {
  const cards = [...deck];
  const hand = {
    id, sb, bb, board: [], street: 'preflop', n: 0, actions: [], result: null,
    seats: players.map(({ id: who, stack }) => ({ id: who, stack, inHand: stack > 0, folded: false, allIn: false, bet: 0, total: 0, hole: [], actedN: -1 })),
    button: 0, toAct: null, currentBet: 0, minRaise: bb, fullRaiseN: -1,
  };
  const live = hand.seats.filter((s) => s.inHand).length;
  if (live < 2) throw new Error('A hand needs two players with chips.');
  hand.button = next(hand, button, (s) => s.inHand);
  const sbSeat = live === 2 ? hand.button : next(hand, hand.button, (s) => s.inHand);
  const bbSeat = next(hand, sbSeat, (s) => s.inHand);
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= hand.seats.length; k++) {
      const s = hand.seats[(hand.button + k) % hand.seats.length];
      if (s.inHand) s.hole.push(cards.shift());
    }
  }
  post(hand, sbSeat, sb, 'small blind');
  post(hand, bbSeat, bb, 'big blind');
  hand.currentBet = Math.max(...hand.seats.map((s) => s.bet));
  hand.toAct = next(hand, bbSeat, canAct);
  return settle(hand);
}

function post(hand, seat, amount, what) {
  const s = hand.seats[seat];
  const paid = Math.min(amount, s.stack);
  s.stack -= paid;
  s.bet += paid;
  s.total += paid;
  if (!s.stack) s.allIn = true;
  hand.actions.push({ seat, street: 'preflop', type: what, amount: paid });
}

const due = (hand, s) => canAct(s) && (s.actedN === -1 || s.bet < hand.currentBet);

/**
 * What the seat to act may do: { toCall, check, call, raise: { min, max } | null }.
 * `call` is what calling puts in (all of a short stack); a raise is to a
 * total for the street, from `min` (a full raise) to `max` (all in), or only
 * `max` when the stack is short of a full raise.
 */
export function legal(hand, seat = hand.toAct) {
  const s = hand.seats[seat];
  const toCall = hand.currentBet - s.bet;
  const max = s.bet + s.stack;
  const reopened = s.actedN === -1 || s.actedN < hand.fullRaiseN;
  const canRaise = reopened && max > hand.currentBet && hand.seats.some((o, i) => i !== seat && canAct(o));
  return {
    toCall,
    check: toCall === 0,
    call: toCall > 0 ? Math.min(toCall, s.stack) : 0,
    raise: canRaise ? { min: Math.min(hand.currentBet + hand.minRaise, max), max } : null,
  };
}

// The legal options `l` (`legal`) in words, facing `currentBet`, for a player told what it may do.
export function describeLegal(l, currentBet) {
  const word = currentBet === 0 ? 'bet' : 'raise to';
  return [
    'fold',
    l.check ? 'check' : `call ${l.call}${l.call < l.toCall ? ' (all in)' : ''}`,
    l.raise && (l.raise.min === l.raise.max ? `${word} ${l.raise.max} (all in)` : `${word} ${l.raise.min} to ${l.raise.max} (${l.raise.max} is all in)`),
  ].filter(Boolean).join(', ');
}

/**
 * The seat to act does `action`: { type: fold | check | call | bet | raise | allin, amount }.
 * `amount` is a bet or raise's total for the street. Returns { hand } with
 * the new hand, or { error } saying why it is not legal, the hand unchanged.
 */
export function act(hand, seat, action) {
  if (hand.street === 'done') return { error: 'The hand is over.' };
  if (seat !== hand.toAct) return { error: 'It is not your turn.' };
  const l = legal(hand, seat);
  const type = String(action?.type ?? '').toLowerCase().replace(/[\s_-]/g, '');
  const h = clone(hand);
  const s = h.seats[seat];
  const raiseTo = (to) => {
    const increment = to - h.currentBet;
    const paid = to - s.bet;
    s.stack -= paid;
    s.total += paid;
    s.bet = to;
    if (!s.stack) s.allIn = true;
    if (increment >= h.minRaise) {
      h.minRaise = increment;
      h.fullRaiseN = h.n;
    }
    h.currentBet = to;
    return paid;
  };
  let record;
  if (type === 'fold') {
    s.folded = true;
    record = { type: 'fold' };
  } else if (type === 'check') {
    if (!l.check) return { error: `You cannot check: ${l.toCall} to call.` };
    record = { type: 'check' };
  } else if (type === 'call') {
    if (l.check) return { error: 'Nothing to call: check, or bet.' };
    s.stack -= l.call;
    s.bet += l.call;
    s.total += l.call;
    if (!s.stack) s.allIn = true;
    record = { type: 'call', amount: l.call };
  } else if (['bet', 'raise', 'allin'].includes(type)) {
    const to = type === 'allin' ? l.raise?.max ?? s.bet + s.stack : Number(action.amount);
    if (type === 'allin' && !l.raise) {
      if (l.check) return { error: 'You cannot raise here: check.' };
      return act(hand, seat, { type: 'call' });
    }
    if (!l.raise) return { error: 'You cannot raise now: the betting is not open to you again.' };
    if (!Number.isInteger(to)) return { error: 'A bet or raise needs a whole number amount: the total for this street.' };
    if (to > l.raise.max) return { error: `You have only ${l.raise.max} in all for this street.` };
    if (to < l.raise.min) return { error: `Too small: the least you can ${hand.currentBet ? 'raise to' : 'bet'} is ${l.raise.min}.` };
    const word = hand.currentBet === 0 ? 'bet' : 'raise';
    raiseTo(to);
    record = { type: word, amount: to };
  } else {
    return { error: `No action "${action?.type}": fold, check, call, bet or raise.` };
  }
  s.actedN = h.n;
  h.actions.push({ seat, street: h.street, ...record, allIn: s.allIn || undefined });
  h.n++;
  h.toAct = next(h, seat, (o) => due(h, o));
  return { hand: settle(h) };
}

// After an action: end the street when no one is due, and wait for its
// cards (`owed`); end the hand when one player is left or the river is over.
function settle(h) {
  if (h.seats.filter(inHand).length === 1) return finish(h);
  if (h.toAct !== null && due(h, h.seats[h.toAct])) return h;
  h.toAct = next(h, h.button, (o) => due(h, o)); // e.g. the blinds left no one able to act
  if (h.toAct !== null) return h;
  for (const s of h.seats) {
    s.bet = 0;
    s.actedN = -1;
  }
  h.currentBet = 0;
  h.minRaise = h.bb;
  h.fullRaiseN = -1;
  return h.street === 'river' ? finish(h) : h;
}

const STREETS = { preflop: ['flop', 3], flop: ['turn', 1], turn: ['river', 1] };
// How many cards the hand waits for: the next street's, once the betting before it is over.
export const owed = (hand) => (hand.street !== 'done' && hand.toAct === null ? STREETS[hand.street][1] : 0);

/** The next street's `cards`, as many as the hand is `owed`: { hand }, or { error }. */
export function board(hand, cards) {
  const n = owed(hand);
  if (!n || cards.length !== n) return { error: `The hand is owed ${n} cards.` };
  const h = clone(hand);
  h.board.push(...cards);
  h.street = STREETS[h.street][0];
  h.toAct = h.seats.filter(canAct).length > 1 ? next(h, h.button, canAct) : null;
  return { hand: settle(h) };
}

// The hand's end: an uncalled bet back to its bettor, then each pot to its
// best hand among those eligible, split evenly; odd chips go to the first
// winners left of the button.
function finish(h) {
  h.street = 'done';
  h.toAct = null;
  const sorted = [...h.seats].map((s) => s.total).sort((a, b) => b - a);
  const top = h.seats.findIndex((s) => s.total === sorted[0]);
  if (sorted[0] > sorted[1]) {
    const back = sorted[0] - sorted[1];
    h.seats[top].total -= back;
    h.seats[top].stack += back;
    h.actions.push({ seat: top, street: h.street, type: 'uncalled', amount: back });
  }
  const live = h.seats.flatMap((s, i) => (inHand(s) ? [i] : []));
  const showdown = live.length > 1;
  const best = new Map(showdown ? live.map((i) => [i, bestHand([...h.seats[i].hole, ...h.board])]) : []);
  const won = h.seats.map(() => 0);
  const potsOut = pots(h.seats).map(({ amount, eligible }) => {
    let winners = eligible;
    if (showdown) {
      const top = eligible.reduce((a, i) => (compare(best.get(i).score, a) > 0 ? best.get(i).score : a), [-1]);
      winners = eligible.filter((i) => compare(best.get(i).score, top) === 0);
    }
    const order = winners.toSorted((a, b) => ((a - h.button + h.seats.length - 1) % h.seats.length) - ((b - h.button + h.seats.length - 1) % h.seats.length));
    order.forEach((i, k) => { won[i] += Math.floor(amount / winners.length) + (k < amount % winners.length ? 1 : 0); });
    return { amount, winners: order };
  });
  for (const [i, amount] of won.entries()) h.seats[i].stack += amount;
  h.result = {
    showdown,
    pots: potsOut,
    won,
    hands: Object.fromEntries([...best].map(([i, b]) => [i, { name: b.name, cards: b.cards }])),
  };
  return h;
}

// Everything at the table one seat may see: its own cards, and others'
// only once shown at a showdown. The only way a player's prompt sees a hand.
export function view(hand, seat) {
  const shown = hand.result?.showdown ? new Set(Object.keys(hand.result.hands).map(Number)) : new Set();
  return {
    id: hand.id, n: hand.n, street: hand.street, board: [...hand.board], blinds: [hand.sb, hand.bb], button: hand.button,
    toAct: hand.toAct, currentBet: hand.currentBet, pot: hand.seats.reduce((sum, s) => sum + s.total, 0),
    seats: hand.seats.map((s, i) => ({
      id: s.id, stack: s.stack, bet: s.bet, total: s.total, inHand: s.inHand, folded: s.folded, allIn: s.allIn,
      hole: i === seat || shown.has(i) ? [...s.hole] : null,
    })),
    actions: hand.actions.map((a) => ({ ...a })),
    result: hand.result && structuredClone(hand.result),
  };
}

// ---- a hand in words ----

const WORDS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace' };
const many = (r) => (r === 6 ? 'sixes' : `${WORDS[r]}s`);
const cap = (text) => text[0].toUpperCase() + text.slice(1);

// What a player holds, as a player says it: "Pocket kings" or "Ace-king
// suited" before the flop, then the best hand with the board, "Pair of
// kings", "Queens full of fours".
export function handName(hole, board = []) {
  if (board.length < 3) {
    const [a, b] = hole.map(rankOf).sort((x, y) => y - x);
    return a === b ? `Pocket ${many(a)}` : `${cap(WORDS[a])}-${WORDS[b]} ${hole[0][1] === hole[1][1] ? 'suited' : 'offsuit'}`;
  }
  const [kind, r1, r2] = bestHand([...hole, ...board]).score;
  return [
    () => `${cap(WORDS[r1])} high`,
    () => `Pair of ${many(r1)}`,
    () => `Two pair, ${many(r1)} and ${many(r2)}`,
    () => `Three ${many(r1)}`,
    () => `Straight, ${WORDS[r1]} high`,
    () => `Flush, ${WORDS[r1]} high`,
    () => `${cap(many(r1))} full of ${many(r2)}`,
    () => `Four ${many(r1)}`,
    () => (r1 === 14 ? 'Royal flush' : `Straight flush, ${WORDS[r1]} high`),
  ][kind]();
}
