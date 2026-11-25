// The poker page's dealer and its table as a world (preview/poker-dealer.js,
// preview/poker-world.js), on the runtime's core (src/core/: the store, the
// ledger, the controllers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, control, limits } from '../src/core/controller.js';
import { ledger } from '../src/core/ledger.js';
import { createStore } from '../src/core/store.js';
import { act, bestHand, board, compare, draw, handName, legal, owed, pots, shuffled, startHand, view } from '../preview/poker-dealer.js';
import { CLOCK, DEALER, HUMAN, MAX_SEATS, PERSONAS, REACTIONS, STACK, TURN, decided, freeSeats, lineup, myChips, newTable, prompt, rolls, world } from '../preview/poker-world.js';
import { until } from './helpers.js';

const rank = (cards) => bestHand(cards.split(' '));
const beats = (a, b) => compare(rank(a).score, rank(b).score);

test('hands are named by their best five of seven', () => {
  const cases = {
    'High card': 'As Kd 9h 7c 4s 3d 2h',
    Pair: 'As Ad 9h 7c 4s 3d 2h',
    'Two pair': 'As Ad 9h 9c 4s 3d 2h',
    'Three of a kind': 'As Ad Ah 7c 4s 3d 2h',
    Straight: 'Ts 9d 8h 7c 6s Ad Ah',
    Flush: 'As Ks 9s 7s 2s Ad Ah',
    'Full house': 'As Ad Ah 7c 7s 3d 2h',
    'Four of a kind': 'As Ad Ah Ac 7s 3d 2h',
    'Straight flush': '9s 8s 7s 6s 5s As Ad',
  };
  for (const [name, cards] of Object.entries(cases)) assert.equal(rank(cards).name, name, cards);
});

test('the wheel is a five-high straight, and ace high beats it', () => {
  assert.equal(rank('As 2d 3h 4c 5s Kd Qh').name, 'Straight');
  assert.ok(beats('6s 2d 3h 4c 5s Kd Qh', 'As 2d 3h 4c 5s Kd Qh') > 0);
  assert.ok(beats('As Kd Qh Jc Ts 2d 3h', '6s 2d 3h 4c 5s Kd 9h') > 0);
  assert.deepEqual(rank('5s 4s 3s 2s As Kd Qh').score, [8, 5]);
});

test('kickers and ties', () => {
  assert.ok(beats('As Ad Kh 7c 4s 3d 2h', 'As Ad Qh 7c 4s 3d 2h') > 0, 'pair, king kicker');
  assert.ok(beats('Ks Kd 4h 4c As 3d 2h', 'Ks Kd 4h 4c Qs 3d 2h') > 0, 'two pair, ace kicker');
  assert.ok(beats('9s 9d 9h 2c 2s 3d 4h', '8s 8d 8h Ac As 3d 4h') > 0, 'full house by trips');
  assert.ok(beats('As Qs 9s 7s 2s 3d 4h', 'Ks Qs Js 7s 2s 3d 4h') > 0, 'flush by high card');
  assert.equal(beats('As Kd Qh Jc 9s 3d 2h', 'Ad Kh Qc Js 9d 3s 2c'), 0, 'same ranks tie');
  assert.equal(beats('2s 3d Ah Ac Ad Ks Qh', '4s 5d Ah Ac Ad Ks Qh'), 0, 'the board plays');
});

test('a hand in words, as a player says it', () => {
  const name = (hole, board = '') => handName(hole.split(' '), board ? board.split(' ') : []);
  assert.equal(name('Kh Kd'), 'Pocket kings');
  assert.equal(name('6h 6d'), 'Pocket sixes');
  assert.equal(name('As Ks'), 'Ace-king suited');
  assert.equal(name('Kd As'), 'Ace-king offsuit');
  assert.equal(name('Kh Kd', '2c 7s Ks'), 'Three kings');
  assert.equal(name('Kh Qd', '2c 7s Ks'), 'Pair of kings');
  assert.equal(name('Kh 7d', '2c 7s Ks'), 'Two pair, kings and sevens');
  assert.equal(name('Qh Qd', 'Qc 4s 4d'), 'Queens full of fours');
  assert.equal(name('Ah 2d', '3c 4s 5d'), 'Straight, five high');
  assert.equal(name('Ah 2h', '9h 4h Kh'), 'Flush, ace high');
  assert.equal(name('Ah Kh', 'Qh Jh Th'), 'Royal flush');
  assert.equal(name('Ah 3d', '9c 7s Kd'), 'Ace high');
});

test('side pots: each all-in caps the pot it can win, folded chips stay in', () => {
  const seats = [
    { total: 100, folded: false },
    { total: 300, folded: false },
    { total: 500, folded: false },
    { total: 200, folded: true },
  ];
  assert.deepEqual(pots(seats), [
    { amount: 400, eligible: [0, 1, 2] },
    { amount: 500, eligible: [1, 2] },
    { amount: 200, eligible: [2] },
  ]);
  assert.equal(pots(seats).reduce((s, p) => s + p.amount, 0), 1100);
});

test('a shuffle is a whole deck', () => {
  const deck = shuffled();
  assert.equal(new Set(deck).size, 52);
});

// A deck whose first cards are dealt in this order: seat after the button first, two rounds; then burn, flop, burn, turn, burn, river.
const stacked = (cards) => [...cards.split(' '), ...shuffled().filter((c) => !cards.split(' ').includes(c))];
const players = (...stacks) => stacks.map((stack, i) => ({ id: `p${i}`, stack }));
// A hand dealt from `deck` (stacked, or shuffled), and `play(seat, action)`,
// which acts, then deals each street the hand is owed from the rest of the
// deck, burning one first, as a dealer would.
function dealt(options, deck = shuffled()) {
  let hand = startHand({ ...options, deck });
  const rest = deck.slice(hand.seats.filter((s) => s.inHand).length * 2);
  const deals = () => {
    while (owed(hand)) {
      rest.shift();
      hand = board(hand, rest.splice(0, owed(hand))).hand;
    }
  };
  deals();
  return {
    hand: () => hand,
    play(seat, action) {
      const out = act(hand, seat, action);
      assert.ok(out.hand, out.error);
      hand = out.hand;
      deals();
      return hand;
    },
  };
}

test('blinds, the order of play and the big blind\'s option', () => {
  let hand = startHand({ id: 1, players: players(1000, 1000, 1000, 1000), button: -1, blinds: [10, 20] });
  assert.equal(hand.button, 0);
  assert.deepEqual(hand.seats.map((s) => s.bet), [0, 10, 20, 0]);
  assert.equal(hand.toAct, 3);
  assert.ok(!('deck' in hand), 'a hand holds no deck');
  for (const seat of [3, 0, 1]) hand = act(hand, seat, { type: 'call' }).hand;
  assert.equal(hand.toAct, 2, 'the big blind may still raise');
  assert.ok(legal(hand).check && legal(hand).raise);
  hand = act(hand, 2, { type: 'check' }).hand;
  assert.deepEqual([hand.street, hand.toAct, owed(hand)], ['preflop', null, 3], 'the betting over, the hand waits for the flop');
  assert.match(board(hand, ['2c']).error, /owed 3/);
  hand = board(hand, draw(hand.seats.flatMap((s) => s.hole), 3)).hand;
  assert.equal(hand.street, 'flop');
  assert.equal(hand.board.length, 3);
  assert.equal(hand.toAct, 1, 'the small blind acts first after the flop');
});

test('heads up, the button posts the small blind and acts first preflop', () => {
  const hand = startHand({ id: 1, players: players(1000, 1000), button: 1, blinds: [10, 20] });
  assert.equal(hand.button, 0);
  assert.deepEqual(hand.seats.map((s) => s.bet), [10, 20]);
  assert.equal(hand.toAct, 0);
});

test('illegal actions are turned away and change nothing', () => {
  const hand = startHand({ id: 1, players: players(1000, 1000, 1000), button: -1, blinds: [10, 20] });
  assert.match(act(hand, 1, { type: 'call' }).error, /not your turn/);
  assert.match(act(hand, 0, { type: 'check' }).error, /cannot check/);
  assert.match(act(hand, 0, { type: 'raise', amount: 30 }).error, /least you can raise to is 40/);
  assert.match(act(hand, 0, { type: 'raise', amount: 5000 }).error, /only 1000/);
  assert.match(act(hand, 0, { type: 'shove' }).error, /No action/);
  assert.equal(hand.seats[0].stack, 1000);
  const raised = act(hand, 0, { type: 'raise', amount: 60 }).hand;
  assert.equal(legal(raised).raise.min, 100, 'a re-raise is at least the last raise more');
});

test('a short all-in does not reopen the betting', () => {
  let hand = startHand({ id: 1, players: players(1000, 1000, 70), button: -1, blinds: [10, 20] });
  hand = act(hand, 0, { type: 'raise', amount: 60 }).hand; // button raises
  hand = act(hand, 1, { type: 'fold' }).hand;
  hand = act(hand, 2, { type: 'allin' }).hand; // big blind all in for 70: 10 more, not a full raise
  assert.equal(hand.toAct, 0);
  assert.equal(legal(hand).raise, null);
  assert.equal(legal(hand).call, 10);
});

test('a hand with side pots pays each pot to its best eligible hand', () => {
  // Button p0 (500), p1 small blind (100), p2 big blind (300). Cards: p1 p2 p0, twice.
  const h = dealt({ id: 1, players: players(500, 100, 300), button: -1, blinds: [10, 20] }, stacked('As Ks 2c Ad Kd 2d 9h Qs Js 7c 3h 4d 8s 5h'));
  h.play(0, { type: 'allin' });
  h.play(1, { type: 'call' });
  const hand = h.play(2, { type: 'call' });
  assert.equal(hand.street, 'done');
  assert.deepEqual(hand.board, ['Qs', 'Js', '7c', '4d', '5h']);
  // p1 (aces) wins the main pot of 300, p2 (kings) the side pot of 400, p0's 200 uncalled comes back.
  assert.deepEqual(hand.result.pots, [{ amount: 300, winners: [1] }, { amount: 400, winners: [2] }]);
  assert.deepEqual(hand.seats.map((s) => s.stack), [200, 300, 400]);
});

test('a split pot gives the odd chip to the first winner left of the button', () => {
  const h = dealt({ id: 1, players: players(1000, 1000, 1000), button: -1, blinds: [10, 25] }, stacked('2c 3c 4c 2d 3d 4d 5h As Ks Qs 6h Js 7h Ts')); // the board is a royal flush: everyone left ties
  h.play(0, { type: 'call' });
  h.play(1, { type: 'call' });
  h.play(2, { type: 'check' });
  h.play(1, { type: 'bet', amount: 25 });
  h.play(2, { type: 'call' });
  let hand = h.play(0, { type: 'fold' });
  for (const street of ['turn', 'river']) {
    assert.equal(hand.street, street);
    h.play(1, { type: 'check' });
    hand = h.play(2, { type: 'check' });
  }
  assert.deepEqual(hand.result.pots, [{ amount: 125, winners: [1, 2] }]);
  assert.deepEqual(hand.seats.map((s) => s.stack), [975, 1013, 1012]);
});

test('a seat sees only its own cards until a showdown', async () => {
  const hand = startHand({ id: 1, players: players(1000, 1000, 1000), button: -1, blinds: [10, 20] });
  const v = view(hand, 1);
  assert.deepEqual(v.seats.map((s) => Boolean(s.hole)), [false, true, false]);
  const seen = JSON.stringify(v); // a card is looked for quoted: "Ac" is also in "toAct"
  for (const card of [...hand.seats[0].hole, ...hand.seats[2].hole]) assert.ok(!seen.includes(`"${card}"`), `${card} is in seat 1's view`);
});

// ---- the table as a world, on the core ----

const pokerworld = ledger(world);
// A table in a store, kept as the page keeps it: `box.kept` is what it last
// saved; `now`, the store's clock. `as(id)` is member `id`'s client. A new
// table is `newTable(ids)`, as `edit` changes it.
// A new table's AI players have said hello, quietly, unless `hellos` is false.
function open({ ids, edit = () => {}, kept, hellos = true } = {}) {
  const fresh = newTable(ids);
  edit(fresh);
  const box = { kept: kept ?? { rev: 0, state: pokerworld.wrap(fresh) }, now: 1000 };
  const store = createStore(pokerworld, { load: () => box.kept, save: (k) => (box.kept = k), now: () => box.now });
  const clients = new Map();
  const as = (id) => clients.get(id) ?? clients.set(id, store.client(id)).get(id);
  const t = { box, as, state: () => box.kept.state.world, hand: () => box.kept.state.world.hand };
  if (!kept && hellos) for (const { id } of lineup(fresh)) if (isAI(id)) runs(t, id, null);
  return t;
}
const view_ = (t, id) => t.as(id).read().view;
const tasks = (t, id) => view_(t, id).tasks;
// What a person does: no tasks answered, a move made on the turn it sees.
const does = (t, id, body) => t.as(id).commit({ base: view_(t, id).content.moment, body });
// An AI player's run: it answers the tasks it is given now.
function runs(t, id, body) {
  const v = view_(t, id);
  return t.as(id).commit({ as: id, base: v.content.moment, answers: v.tasks.map((x) => x.given), body });
}
// The dealer deals all it is due to: the next hand, each street.
function deals(t) {
  for (let [task] = tasks(t, DEALER); task; [task] = tasks(t, DEALER)) {
    const { out, need } = view_(t, DEALER).content;
    assert.equal(t.as(DEALER).commit({ as: DEALER, answers: [task.given], body: { cards: draw(out, need) } }).refused, undefined);
  }
}
const isAI = (id) => PERSONAS.some((p) => p.id === id);
const toAct = (t) => (t.hand()?.street !== 'done' && t.hand()?.toAct !== null ? t.hand()?.seats[t.hand().toAct].id : null);
// The player to act moves: `move(legal)`, a check or a call by default.
function moves(t, move = (l) => ({ type: l.check ? 'check' : 'call' })) {
  const id = toAct(t);
  const action = move(view_(t, id).content.legal);
  return isAI(id) ? runs(t, id, { action, thinking: 'hm' }) : does(t, id, { action });
}
// The hand played out, as `move` says.
function playOut(t, move) {
  deals(t);
  while (t.hand()?.street !== 'done') {
    moves(t, move);
    deals(t);
  }
}
// A table the host sat at with `buyIn`, its first hand dealt.
function seated(options, buyIn = 1000) {
  const t = open(options);
  does(t, HUMAN, { type: 'sit', buyIn });
  deals(t);
  return t;
}
// The next hand, the host asking for it.
function next(t) {
  does(t, HUMAN, { type: 'next' });
  deals(t);
}
const chips = (t) => t.hand().seats.reduce((sum, s) => sum + s.stack, 0);
const rebuys = (t) => t.state().chat.filter((l) => l.by === DEALER && /buys back in/.test(l.text)).length * STACK;

test('random play: chips are kept, the table holds no deck, and a prompt never holds a card it may not see', () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const inPlay = (t) => t.hand().seats.reduce((sum, s) => sum + s.stack + s.total, 0);
  for (let game = 0; game < 20; game++) {
    const t = seated();
    for (let k = 0; k < 15 && t.hand(); k++) {
      const dealt = inPlay(t);
      while (t.hand().street !== 'done') {
        for (const { id } of t.hand().seats.filter((s) => isAI(s.id))) {
          const seat = t.hand().seats.findIndex((s) => s.id === id);
          const { rules, situation } = prompt(view_(t, id), id);
          for (const [i, s] of t.hand().seats.entries()) {
            for (const card of s.hole) assert.equal(new RegExp(`\\b${card}\\b`).test(`${rules}\n${situation}`), i === seat, `${id}'s prompt and seat ${i}'s ${card}`);
          }
        }
        moves(t, (l) => pick([{ type: 'fold' }, l.check ? { type: 'check' } : { type: 'call' }, { type: 'call' }, l.raise ? { type: 'raise', amount: l.raise.min + Math.floor(Math.random() * (l.raise.max - l.raise.min + 1)) } : { type: 'fold' }, { type: 'allin' }]));
        deals(t);
      }
      assert.ok(!JSON.stringify(t.state()).includes('deck'), 'no deck in the state');
      assert.equal(chips(t), dealt, 'no chip made or lost in a hand');
      // between hands, now and then a player leaves or another sits down
      const out = PERSONAS.find((p) => !lineup(t.state()).some((q) => q.id === p.id));
      if (Math.random() < 0.3 && out) does(t, HUMAN, { type: 'add', id: out.id });
      if (Math.random() < 0.3) does(t, HUMAN, { type: 'remove', id: pick(lineup(t.state()).filter((q) => q.id !== HUMAN)).id });
      if (!myChips(t.state())) does(t, HUMAN, { type: 'sit', buyIn: 1000 });
      next(t);
      for (const s of t.hand().seats) if (isAI(s.id)) assert.ok(s.stack + s.total > 0, 'an AI player out of chips bought back in');
    }
  }
});

test('the player to act is due, a person too; a line to the table asks one AI player, a named one whom it names; a reply to a reply, no one', () => {
  const t = seated();
  const due = ['Gary', 'Duke', 'Penny', HUMAN].filter((id) => tasks(t, id).length);
  assert.deepEqual(due, [toAct(t)]);
  assert.deepEqual(tasks(t, toAct(t)).map((x) => [x.kind, x.why]), [['turn', 'Your turn']]);
  while (toAct(t) !== HUMAN) moves(t);
  does(t, HUMAN, { say: 'Nice weather for poker.' });
  assert.deepEqual(['Gary', 'Duke', 'Penny'].map((id) => tasks(t, id).filter((x) => x.kind === 'ask').length), [1, 0, 0], 'to the whole table: the next AI player after the host');
  runs(t, 'Gary', null);
  assert.deepEqual(tasks(t, 'Gary'), [], 'quiet answers it');
  does(t, HUMAN, { say: 'Penny, what are the odds?' });
  assert.deepEqual(['Gary', 'Duke', 'Penny'].map((id) => tasks(t, id).length), [0, 0, 1], 'named, Penny is asked');
  runs(t, 'Penny', { say: 'About one in three, Duke.', thinking: 'x' });
  assert.deepEqual([t.state().chat.at(-1).depth, t.state().chat.at(-1).from], [1, [HUMAN]], 'for whom her run was');
  const duke = tasks(t, 'Duke');
  assert.equal(duke.length, rolls('Duke', `line:${t.state().chat.at(-1).id}`) ? 1 : 0, 'an AI player\'s line asks whom it names as they roll');
  if (duke.length) {
    runs(t, 'Duke', { say: 'Penny, you always say that.' });
    assert.equal(t.state().chat.at(-1).depth, 2);
    assert.deepEqual(tasks(t, 'Penny'), [], 'a reply to a reply asks no one');
  }
});

test('a stale move is turned away; an illegal one is a try, told why; three, and the dealer checks or folds', () => {
  const t = seated();
  while (toAct(t) === HUMAN || toAct(t) === 'Gary') moves(t); // Gary, after the host, is never the big blind on the first hand
  const id = toAct(t);
  const stale = view_(t, id).content.moment;
  const out = runs(t, id, { action: { type: 'raise', amount: 1 }, thinking: 'hm' });
  assert.match(out.refused, /Too small/);
  assert.match(tasks(t, id)[0].refused, /Too small/, 'due again, told why');
  assert.match(prompt(view_(t, id), id).situation, /turned away: Too small/);
  assert.ok(!t.state().thoughts[id], 'a refused change lands nothing, not its thinking');
  runs(t, id, { action: { type: 'call' } });
  assert.match(t.as(id).commit({ base: stale, body: { action: { type: 'call' } } }).refused ?? 'none', /Stale/);
  const next_ = toAct(t);
  const n = t.hand().n;
  if (isAI(next_)) {
    for (let k = 0; k < 3; k++) runs(t, next_, { action: { type: 'raise', amount: 1 } });
    assert.equal(t.hand().n, n + 1, 'three tries: played for');
    assert.ok(['fold', 'check'].includes(t.hand().actions.at(-1).type));
  }
  assert.match(does(t, HUMAN, { action: { type: 'raise', amount: 1 } }).refused, /Stale|Too small/, 'a person\'s refused move lands nothing');
});

test('an AI player out of chips buys back in; the host buys in themselves, and a top-up lands before the next hand', () => {
  const t = open({ edit: (s) => { s.players[1].stack = 0; } });
  does(t, HUMAN, { type: 'sit', buyIn: 500 });
  deals(t);
  assert.equal(t.hand().seats[1].stack + t.hand().seats[1].total, STACK);
  assert.deepEqual(t.state().chat.filter((l) => l.by === DEALER).map((l) => l.text), ['Gary buys back in for $1,000.']);
  playOut(t, () => ({ type: 'fold' }));
  assert.match(does(t, HUMAN, { type: 'topup', amount: 900 }).refused, /up to 1000/);
  does(t, HUMAN, { type: 'topup', amount: 300 });
  assert.equal(myChips(view_(t, HUMAN).content), myChips(t.state()), 'a person\'s own chips to come are theirs to see');
  const before = myChips(t.state());
  next(t);
  assert.equal(t.hand().seats[0].stack + t.hand().seats[0].total, before);
  does(t, HUMAN, { type: 'leave' }); // mid-hand: refused
  playOut(t);
  assert.equal(does(t, HUMAN, { type: 'leave' }).refused, undefined);
  next(t);
  assert.equal(t.hand(), null, 'no person with chips: no hand');
});

test('with no person holding chips there is no hand; each AI player at the table says hello from when it opens, in its own words, once', () => {
  const t = open({ hellos: false });
  assert.deepEqual(['Gary', 'Duke', 'Penny'].map((id) => tasks(t, id).map((x) => [x.kind, x.given])), [[['ask', 'hello:Gary']], [['ask', 'hello:Duke']], [['ask', 'hello:Penny']]]);
  assert.match(prompt(view_(t, 'Gary'), 'Gary').situation, /Why you are woken: you just sat down at the table: say hello\./);
  runs(t, 'Gary', { say: 'Hi folks!' });
  assert.deepEqual([tasks(t, 'Gary'), t.state().chat.map((l) => [l.by, l.text])], [[], [['Gary', 'Hi folks!']]], 'once');
  does(t, HUMAN, { type: 'next' });
  deals(t);
  assert.equal(t.hand(), null, 'no chips, no hand');
  does(t, HUMAN, { type: 'sit', buyIn: 500 });
  assert.deepEqual(tasks(t, DEALER).map((x) => [x.given, x.at]), [['deal:2', undefined]], 'the first hand, at once');
});

test('a player reacts with one of the table\'s emoji, which the others see and which asks no one', () => {
  const t = seated();
  runs(t, toAct(t), { action: { type: 'call' }, react: REACTIONS[0], thinking: 'ha' });
  const id = t.state().reactions[0].by;
  does(t, HUMAN, { react: '💩' });
  assert.deepEqual(t.state().reactions.map((r) => [r.by, r.emoji]), [[id, REACTIONS[0]]], 'only the table\'s emoji');
  assert.equal(['Gary', 'Duke', 'Penny'].reduce((n, x) => n + tasks(t, x).filter((y) => y.kind === 'ask').length, 0), 0, 'a reaction asks no one');
  const other = PERSONAS.find((p) => p.id !== id && lineup(t.state()).some((q) => q.id === p.id)).id;
  assert.match(prompt(view_(t, other), other).situation, new RegExp(`Reactions this hand, latest last: ${id} ${REACTIONS[0]}`));
});

test('players come and go between hands: a seat is taken at the next hand, given up after this one; two at least, six at most', () => {
  const t = open();
  assert.match(does(t, HUMAN, { type: 'add', id: 'Gary' }).refused, /no seat/, 'already here');
  assert.match(does(t, HUMAN, { type: 'add', id: 'Nobody' }).refused, /no seat/);
  assert.equal(does(t, HUMAN, { type: 'add', id: 'Mabel' }).refused, undefined);
  assert.deepEqual(tasks(t, 'Mabel').map((x) => x.given), ['hello:Mabel'], 'she says hello');
  runs(t, 'Mabel', null);
  assert.match(t.as('Mabel').commit({ body: { type: 'add', id: 'Lex' } }).refused, /host/);
  does(t, HUMAN, { type: 'sit', buyIn: 500 });
  deals(t);
  assert.deepEqual(t.hand().seats.map((s) => s.id), [HUMAN, 'Gary', 'Mabel', 'Duke', 'Penny'], 'Mabel took the first free seat, 2, between Gary and Duke');
  assert.match(does(t, HUMAN, { type: 'add', id: 'Lex', seat: 3 }).refused, /no seat/, 'Duke is in seat 3 until he leaves');
  does(t, HUMAN, { type: 'add', id: 'Lex' });
  assert.deepEqual(freeSeats(t.state()), []);
  does(t, HUMAN, { type: 'remove', id: 'Duke' });
  assert.ok(tasks(t, 'Duke').some((x) => x.kind === 'ask' && x.given.startsWith('bye:Duke:')), 'he says goodbye, in his own words');
  assert.match(prompt(view_(t, 'Duke'), 'Duke').situation, /the host asked you to leave the table once this hand is over: say goodbye/);
  assert.match(does(t, HUMAN, { type: 'add', id: 'Hank' }).refused, /no seat/, 'his seat is his till the hand ends');
  assert.deepEqual(lineup(t.state()).map((p) => [p.id, p.joining, p.leaving]), [[HUMAN, false, false], ['Gary', false, false], ['Mabel', false, false], ['Duke', false, true], ['Penny', false, false], ['Lex', true, false]]);
  assert.deepEqual(tasks(t, 'Lex').map((x) => x.given), ['hello:Lex'], 'not seated yet: due only to say hello');
  does(t, HUMAN, { type: 'add', id: 'Duke' });
  assert.ok(!t.state().leaving.includes('Duke'), 'asked back before the hand ends, Duke stays');
  does(t, HUMAN, { type: 'remove', id: 'Duke' });
  playOut(t);
  next(t);
  assert.deepEqual(t.hand().seats.map((s) => s.id), [HUMAN, 'Gary', 'Mabel', 'Lex', 'Penny'], 'Lex took seat 4 once Duke left seat 3');
  const two = open({ ids: ['Gary'] });
  assert.match(does(two, HUMAN, { type: 'remove', id: 'Gary' }).refused, /someone to play/);
  for (const id of ['Duke', 'Penny', 'Mabel', 'Lex']) does(two, HUMAN, { type: 'add', id });
  assert.equal(lineup(two.state()).length, MAX_SEATS);
  assert.match(does(two, HUMAN, { type: 'add', id: 'Hank' }).refused, /no seat/);
});

test('the button stays with its player as seats change, or passes on from the seat before', () => {
  const t = seated({ ids: ['Gary', 'Duke', 'Penny'] });
  assert.equal(t.hand().seats[t.hand().button].id, HUMAN);
  playOut(t);
  does(t, HUMAN, { type: 'add', id: 'Mabel' });
  next(t);
  assert.equal(t.hand().seats[t.hand().button].id, 'Gary', 'the button moves one on');
  does(t, HUMAN, { type: 'remove', id: 'Gary' });
  playOut(t);
  next(t);
  assert.equal(t.hand().seats[t.hand().button].id, 'Mabel', 'Gary left with the button: it moves on from the seat before his, to the seat after it');
});

test('a player talks as often as its character: a turn it may not talk on says nothing; a person is always answered', () => {
  // A turn Penny's roll keeps quiet on.
  const t = seated();
  for (let k = 0; toAct(t) !== 'Penny' || rolls('Penny', tasks(t, 'Penny')[0].given); k++) {
    assert.ok(k < 500, 'Penny is quiet now and then');
    if (t.hand().street === 'done') next(t);
    else moves(t);
    deals(t);
  }
  assert.match(prompt(view_(t, 'Penny'), 'Penny').situation, /Stay quiet this time/);
  assert.equal(runs(t, 'Penny', { action: { type: view_(t, 'Penny').content.legal.check ? 'check' : 'call' }, say: 'Call.', thinking: 'x' }).refused, undefined);
  assert.ok(!t.state().chat.some((l) => l.by === 'Penny' && l.text === 'Call.'), 'a quiet run says nothing');
  assert.equal(t.state().thoughts.Penny.at(-1).text, 'x', 'its move and its thinking land');
  does(t, HUMAN, { say: 'Penny, how are you?' });
  assert.doesNotMatch(prompt(view_(t, 'Penny'), 'Penny').situation, /Stay quiet/);
  runs(t, 'Penny', { say: 'Fine.' });
  assert.equal(t.state().chat.at(-1).by, 'Penny');
});

test('after a big hand, the winner and one other have a word, not the whole table', () => {
  const t = seated({ ids: ['Gary', 'Duke', 'Penny', 'Mabel'] });
  playOut(t, () => ({ type: 'allin' }));
  const due = ['Gary', 'Duke', 'Penny', 'Mabel'].filter((id) => tasks(t, id).some((x) => x.given.startsWith('react:')));
  assert.ok(due.length <= 2 && due.length >= 1);
  const won = t.hand().seats[t.hand().result.won.findIndex(Boolean)].id;
  assert.ok(due.includes(won) || won === HUMAN, 'the winner, if an AI player, has a word');
  runs(t, due[0], null);
  assert.ok(!tasks(t, due[0]).length, 'nothing to say answers it');
});

test('friends sit with their own chips, by name; one with none sits a hand out; one who leaves cashes out; one gone mid-hand is folded for', () => {
  const t = open({ ids: ['Gary', 'Duke'] });
  does(t, HUMAN, { type: 'sit', buyIn: 500 });
  deals(t);
  assert.match(does(t, 'fann', { type: 'sit', seat: 0, name: 'Ann', buyIn: 300 }).refused, /taken/, 'the host\'s seat');
  assert.match(does(t, 'fann', { type: 'sit', seat: 3, name: 'Ann', buyIn: 50 }).refused, /Buy in/);
  does(t, 'fann', { type: 'sit', seat: 3, name: 'Ann', buyIn: 300 });
  assert.match(does(t, 'fann', { type: 'sit', seat: 4, name: 'Ann', buyIn: 300 }).refused, /taken/, 'already at the table');
  playOut(t);
  next(t);
  assert.deepEqual(t.hand().seats.map((s) => s.id), [HUMAN, 'Gary', 'Duke', 'fann']);
  assert.equal(t.hand().seats[3].stack + t.hand().seats[3].total, 300);
  assert.match(prompt(view_(t, 'Gary'), 'Gary').situation, /- Ann: stack/, 'the AI players see her by name');
  does(t, 'fann', { say: 'Gary, nice hat.' });
  assert.deepEqual(t.state().chat.at(-1).to, ['Gary']);
  assert.ok(tasks(t, 'Gary').some((x) => x.kind === 'ask'));
  playOut(t);
  does(t, 'fann', { type: 'leave' });
  next(t);
  assert.deepEqual(t.hand().seats.map((s) => s.id), [HUMAN, 'Gary', 'Duke']);
  assert.ok(freeSeats(t.state()).includes(3));
  // one who leaves before being dealt in gives the seat back at once
  does(t, 'fbob', { type: 'sit', seat: 3, name: 'Bob', buyIn: 300 });
  does(t, 'fbob', { type: 'leave' });
  assert.ok(freeSeats(t.state()).includes(3));
  // one gone mid-hand is checked or folded for, and is out at the next deal
  does(t, 'fbob', { type: 'sit', seat: 3, name: 'Bob', buyIn: 300 });
  playOut(t);
  next(t);
  does(t, 'fbob', { type: 'leave' });
  assert.notEqual(toAct(t), 'fbob');
  playOut(t);
  assert.ok(t.hand().seats[3].folded || t.hand().actions.some((a) => a.seat === 3 && a.type === 'check'));
  next(t);
  assert.ok(!t.hand().seats.some((s) => s.id === 'fbob'));
});

test('the clock: an AI player\'s turn and a person\'s with another person at the table are due in TURN; then the dealer checks or folds', () => {
  const t = seated();
  const id = toAct(t);
  assert.equal(tasks(t, id)[0].at, t.box.now + TURN);
  assert.deepEqual(tasks(t, CLOCK).map((x) => x.at), [t.box.now + TURN]);
  while (toAct(t) !== HUMAN) moves(t);
  assert.equal(tasks(t, HUMAN)[0].at, undefined, 'the host alone with AI players has no deadline');
  assert.deepEqual(tasks(t, CLOCK), []);
  does(t, 'fann', { type: 'sit', seat: 2, name: 'Ann', buyIn: 300 });
  const [task] = tasks(t, CLOCK);
  assert.ok(task, 'with a friend at the table, the host has one');
  t.box.now = task.at;
  const n = t.hand().actions.length;
  t.as(CLOCK).commit({ as: CLOCK, answers: [task.given], body: {} });
  assert.ok(['check', 'fold'].includes(t.hand().actions[n].type));
});

test('the dealer\'s cards are checked: as many as owed, none out already', () => {
  const t = seated();
  const [task] = tasks(t, DEALER);
  assert.equal(task, undefined, 'dealt');
  while (!owed(t.hand())) moves(t);
  const [flop] = tasks(t, DEALER);
  const hole = t.hand().seats[0].hole;
  assert.match(t.as(DEALER).commit({ as: DEALER, answers: [flop.given], body: { cards: [hole[0], ...draw(hole, 2)] } }).refused, /rest of the deck/);
  assert.match(t.as(HUMAN).commit({ answers: [flop.given], body: { cards: draw(hole, 3) } }).refused, /Say something/, 'only the dealer deals');
  deals(t);
  assert.equal(t.hand().board.length, 3);
});

test('a friend\'s page gets only their seat\'s secrets: their own cards, the AI players\' once the hand is over, no one\'s thinking till then', () => {
  const t = open({ ids: ['Gary', 'Duke'] });
  does(t, HUMAN, { type: 'sit', buyIn: 500 });
  does(t, 'fann', { type: 'sit', seat: 3, name: 'Ann', buyIn: 300 });
  deals(t);
  while (toAct(t) !== 'Gary') moves(t);
  runs(t, 'Gary', { action: { type: 'call' }, thinking: 'I hold a secret' });
  const holes = (id) => t.hand().seats.find((s) => s.id === id).hole;
  const seen = JSON.stringify(view_(t, 'fann'));
  for (const id of [HUMAN, 'Gary', 'Duke']) for (const card of holes(id)) assert.ok(!seen.includes(`"${card}"`), `${id}'s ${card} in Ann's view`);
  for (const card of holes('fann')) assert.ok(seen.includes(`"${card}"`));
  assert.ok(!seen.includes('I hold a secret'));
  playOut(t, () => ({ type: 'fold' }));
  const after = view_(t, 'fann').content.hand;
  assert.deepEqual(after.seats.find((s) => s.id === 'Gary').hole, holes('Gary'), 'once over, the AI players\' cards');
  assert.ok(!t.hand().result.showdown && after.seats.find((s) => s.id === HUMAN).hole === null, 'not the host\'s, with no showdown');
  assert.ok(view_(t, 'fann').content.thoughts.Gary.some((x) => x.text === 'I hold a secret'), 'and their thinking');
});

test('a refresh mid-hand resumes it: the cards, the pot and the turn stay, and the controllers on the reloaded store play on', async () => {
  const t = seated();
  moves(t);
  const page = open({ kept: JSON.parse(JSON.stringify(t.box.kept)) }); // what the browser kept, read by a new page
  assert.equal(JSON.stringify(page.hand()), JSON.stringify(t.hand()));
  assert.equal(view_(page, HUMAN).content.moment, view_(t, HUMAN).content.moment);
  const play = (id) => async (tasks_, view) => ({ base: view.content.moment, body: view.content.legal ? { action: { type: view.content.legal.check ? 'check' : 'call' } } : null });
  const dealer = async (tasks_, view) => ({ body: { cards: draw(view.content.out, view.content.need) } });
  const members = [...PERSONAS.map(({ id }) => control(page.as(id), { program: play(id) })), control(page.as(DEALER), { program: dealer })];
  try {
    await until(() => {
      if (toAct(page) === HUMAN) does(page, HUMAN, { action: { type: view_(page, HUMAN).content.legal.check ? 'check' : 'call' } });
      return page.hand().street === 'done';
    }, 'the hand to end');
  } finally {
    for (const m of members) m.stop();
  }
  assert.equal(chips(page), 4 * STACK);
});

test('a line to the whole table costs a bounded number of model calls: one answer, and its replies as deep as DEPTH', async () => {
  const t = open();
  does(t, HUMAN, { type: 'sit', buyIn: 500 }); // the hellos said; the first hand not dealt: no turns
  const ran = [];
  const talker = (id) => async (tasks_, view) => {
    ran.push(id);
    return { base: view.content.moment, body: { say: 'Gary, Duke, Penny: what a table.' } };
  };
  const members = PERSONAS.map(({ id }) => control(t.as(id), { program: talker(id) }));
  try {
    does(t, HUMAN, { say: 'Good luck, everyone!' });
    await until(() => ran.length && PERSONAS.every(({ id }) => !tasks(t, id).length), 'the table to come to rest');
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    for (const m of members) m.stop();
  }
  assert.equal(ran[0], 'Gary', 'the next AI player after the host');
  assert.ok(ran.length <= 3, `one answer, then at most the two it names: ${ran.length} runs`);
});

test('on the core: the AI players\', the dealer\'s and the clock\'s controllers play hand after hand; chips are kept, no card leaks, refusals fall back', async () => {
  const t = open();
  does(t, HUMAN, { type: 'sit', buyIn: 1000 });
  t.box.now = Date.now();
  const leaks = [];
  // Duke always raises by 1, which the dealer turns away; the others check or call, and now and then say something.
  const play = (id) => async (tasks_, view) => {
    const { rules, situation } = prompt(view, id);
    const me = t.hand()?.seats.findIndex((s) => s.id === id);
    for (const [i, s] of (t.hand()?.street === 'done' ? [] : t.hand()?.seats ?? []).entries()) for (const card of s.hole) if (i !== me && new RegExp(`\\b${card}\\b`).test(`${rules}\n${situation}`)) leaks.push(`${id} saw ${card}`);
    const l = view.content.legal;
    const action = !l ? null : id === 'Duke' ? { type: 'raise', amount: 1 } : { type: l.check ? 'check' : 'call' };
    return { base: view.content.moment, body: decided({ thinking: 'hm', action, say: Math.random() < 0.3 ? 'Penny, your move.' : '' }) };
  };
  const dealer = async (tasks_, view) => ({ body: { cards: draw(view.content.out, view.content.need) } });
  const wallet = limits();
  const members = [...PERSONAS.map(({ id }) => control(t.as(id), { program: play(id), wallet })), control(t.as(DEALER), { program: dealer }), control(t.as(CLOCK), clock({ now: () => t.box.now }))];
  let dukeRuns = 0;
  try {
    for (let hand = 1; hand <= 6; hand++) {
      await until(() => {
        if (t.hand()?.street === 'done' && t.hand().id === hand) return true;
        if (toAct(t) === HUMAN) does(t, HUMAN, { action: { type: view_(t, HUMAN).content.legal.check ? 'check' : 'call' } });
        return false;
      }, `hand ${hand} to end`);
      dukeRuns += t.hand().actions.filter((a) => t.hand().seats[a.seat].id === 'Duke' && ['check', 'fold'].includes(a.type)).length;
      if (hand < 6) does(t, HUMAN, { type: 'next' });
    }
  } finally {
    for (const m of members) m.stop();
  }
  assert.equal(chips(t), 4 * STACK + rebuys(t), 'no chip made or lost but by buying in');
  assert.deepEqual(leaks, []);
  assert.ok(dukeRuns > 0, 'Duke, turned away three times, is checked or folded for by the dealer');
});
