// The poker page's dealer and runtime (preview/poker-dealer.js, preview/poker-runtime.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, bestHand, compare, handName, legal, pots, shuffled, startHand, view } from '../preview/poker-dealer.js';
import { HUMAN, INTROS, PERSONAS, STACK, begin, deal, introduce, land, myChips, newTable, plan, prompt, say, topUp } from '../preview/poker-runtime.js';

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

test('blinds, the order of play and the big blind\'s option', () => {
  let hand = startHand({ id: 1, players: players(1000, 1000, 1000, 1000), button: -1, blinds: [10, 20] });
  assert.equal(hand.button, 0);
  assert.deepEqual(hand.seats.map((s) => s.bet), [0, 10, 20, 0]);
  assert.equal(hand.toAct, 3);
  for (const seat of [3, 0, 1]) hand = act(hand, seat, { type: 'call' }).hand;
  assert.equal(hand.toAct, 2, 'the big blind may still raise');
  assert.ok(legal(hand).check && legal(hand).raise);
  hand = act(hand, 2, { type: 'check' }).hand;
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
  const deck = stacked('As Ks 2c Ad Kd 2d 9h Qs Js 7c 3h 4d 8s 5h');
  let hand = startHand({ id: 1, players: players(500, 100, 300), button: -1, blinds: [10, 20], deck });
  hand = act(hand, 0, { type: 'allin' }).hand;
  hand = act(hand, 1, { type: 'call' }).hand;
  hand = act(hand, 2, { type: 'call' }).hand;
  assert.equal(hand.street, 'done');
  assert.deepEqual(hand.board, ['Qs', 'Js', '7c', '4d', '5h']);
  // p1 (aces) wins the main pot of 300, p2 (kings) the side pot of 400, p0's 200 uncalled comes back.
  assert.deepEqual(hand.result.pots, [{ amount: 300, winners: [1] }, { amount: 400, winners: [2] }]);
  assert.deepEqual(hand.seats.map((s) => s.stack), [200, 300, 400]);
});

test('a split pot gives the odd chip to the first winner left of the button', () => {
  const deck = stacked('2c 3c 4c 2d 3d 4d 5h As Ks Qs 6h Js 7h Ts'); // the board is a royal flush: everyone left ties
  let hand = startHand({ id: 1, players: players(1000, 1000, 1000), button: -1, blinds: [10, 25], deck });
  hand = act(hand, 0, { type: 'call' }).hand;
  hand = act(hand, 1, { type: 'call' }).hand;
  hand = act(hand, 2, { type: 'check' }).hand;
  hand = act(hand, 1, { type: 'bet', amount: 25 }).hand;
  hand = act(hand, 2, { type: 'call' }).hand;
  hand = act(hand, 0, { type: 'fold' }).hand;
  for (const street of ['turn', 'river']) {
    assert.equal(hand.street, street);
    hand = act(hand, 1, { type: 'check' }).hand;
    hand = act(hand, 2, { type: 'check' }).hand;
  }
  assert.deepEqual(hand.result.pots, [{ amount: 125, winners: [1, 2] }]);
  assert.deepEqual(hand.seats.map((s) => s.stack), [975, 1013, 1012]);
});

test('a seat sees only its own cards until a showdown', () => {
  const hand = startHand({ id: 1, players: players(1000, 1000, 1000), button: -1, blinds: [10, 20] });
  const v = view(hand, 1);
  assert.deepEqual(v.seats.map((s) => Boolean(s.hole)), [false, true, false]);
  assert.ok(!JSON.stringify(v).includes(hand.seats[0].hole[0]) || hand.board.includes(hand.seats[0].hole[0]));
});

// ---- the runtime ----

const tableWithHand = () => {
  const table = newTable();
  deal(table);
  return table;
};
const toAct = (table) => table.players[table.hand.toAct].id;

test('random play: chips are kept, and a prompt never holds a card it may not see', () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  for (let game = 0; game < 30; game++) {
    const table = newTable();
    for (let k = 0; k < 20 && deal(table); k++) {
      while (table.hand.street !== 'done') { // nobody's cards are shown before the hand is over
        for (const { id } of PERSONAS) {
          const seat = table.players.findIndex((p) => p.id === id);
          const { rules, situation } = prompt(table, id, { turn: true, lines: [], react: false });
          for (const [i, s] of table.hand.seats.entries()) {
            for (const card of s.hole) assert.equal(new RegExp(`\\b${card}\\b`).test(`${rules}\n${situation}`), i === seat, `${id}'s prompt and seat ${i}'s ${card}`);
          }
        }
        const l = legal(table.hand);
        const action = pick([{ type: 'fold' }, l.check ? { type: 'check' } : { type: 'call' }, { type: 'call' }, l.raise ? { type: 'raise', amount: l.raise.min + Math.floor(Math.random() * (l.raise.max - l.raise.min + 1)) } : { type: 'fold' }, { type: 'allin' }]);
        const id = table.players[table.hand.toAct].id;
        land(table, id, { hand: table.hand.id, n: table.hand.n, turn: true }, { action });
      }
      const rebought = table.log.filter((c) => c.type === 'rebuy').reduce((sum, c) => sum + c.amount, 0);
      assert.equal(table.hand.seats.reduce((sum, s) => sum + s.stack, 0), 4 * STACK + rebought, 'no chip made or lost but by buying in');
      for (const change of table.log) if (change.type === 'action') assert.ok(['fold', 'check', 'call', 'bet', 'raise'].includes(change.action.type), 'the log has the player\'s action');
    }
  }
});

test('the player to act is due; a line to the table wakes the players, a reply to a reply no one', () => {
  const table = tableWithHand();
  const due = plan(table);
  assert.deepEqual(due.filter((d) => d.turn).map((d) => d.id), toAct(table) === HUMAN ? [] : [toAct(table)]);
  for (const d of due) begin(table, d.id, d);
  assert.ok(plan(table).every((d) => d.turn), 'seen lines do not wake again');

  say(table, HUMAN, 'Nice weather for poker.');
  assert.equal(plan(table).length, 3);
  for (const d of plan(table)) begin(table, d.id, d);
  say(table, HUMAN, 'Penny, what are the odds?');
  assert.deepEqual(plan(table).map((d) => d.id).filter((id) => !plan(table).find((d) => d.id === id).turn || plan(table).find((d) => d.id === id).lines.length), ['Penny']);
  const basis = begin(table, 'Penny', plan(table).find((d) => d.id === 'Penny'));
  land(table, 'Penny', basis, { thinking: 'x', say: 'About one in three, Duke.' });
  assert.equal(table.chat.at(-1).depth, 1);
  const duke = plan(table).find((d) => d.id === 'Duke');
  assert.equal(duke.lines.length, 1, 'named, Duke is due');
  land(table, 'Duke', begin(table, 'Duke', duke), { thinking: 'x', say: 'Penny, you always say that.' });
  assert.equal(table.chat.at(-1).depth, 2);
  assert.ok(!plan(table).find((d) => d.id === 'Penny')?.lines.length, 'a reply to a reply wakes no one');
});

test('only one answer lands to a line the person says to the whole table', () => {
  const table = tableWithHand();
  const line = say(table, HUMAN, 'Who is winning tonight?');
  const runs = plan(table).filter((d) => d.lines.length).map((d) => [d.id, begin(table, d.id, d)]);
  for (const [id, basis] of runs) land(table, id, basis, { thinking: 'x', say: `${id} is.` });
  assert.equal(table.chat.filter((l) => l.about === line.id).length, 1);
});

test('a stale action is turned away, an illegal one too, and the player is asked again', () => {
  const table = tableWithHand();
  while (toAct(table) === HUMAN) land(table, HUMAN, { hand: table.hand.id, n: table.hand.n, turn: true }, { action: { type: 'call' } });
  const id = toAct(table);
  const basis = begin(table, id, { turn: true, lines: [], react: false });
  const out = land(table, id, basis, { thinking: 'check it', action: { type: 'check' } }); // preflop, facing the big blind: illegal unless it is the big blind
  if (out.rejected) {
    assert.match(out.rejected, /cannot check/);
    assert.equal(plan(table).find((d) => d.id === id).turn, true, 'asked again');
    assert.match(prompt(table, id, { turn: true, lines: [], react: false }).situation, /turned away: You cannot check/);
  }
  const fresh = begin(table, id, { turn: true, lines: [], react: false });
  assert.equal(land(table, id, fresh, { thinking: 'fine', action: { type: 'call' } }).landed, true);
  const again = land(table, id, fresh, { thinking: 'twice', action: { type: 'call' } });
  assert.match(again.rejected, /stale/);
});

test('three proposals turned away on one turn: the dealer checks or folds for the player', () => {
  const table = tableWithHand();
  while (toAct(table) === HUMAN) land(table, HUMAN, { hand: table.hand.id, n: table.hand.n, turn: true }, { action: { type: 'call' } });
  const id = toAct(table);
  const n = table.hand.n;
  for (let k = 0; k < 3; k++) land(table, id, begin(table, id, { turn: true, lines: [], react: false }), { thinking: 'hm', action: { type: 'raise', amount: 1 } });
  assert.equal(table.hand.n, n + 1);
  const forced = table.log.findLast((c) => c.type === 'action');
  assert.ok(forced.forced && ['fold', 'check'].includes(forced.action.type));
});

test('an AI player out of chips buys back in; the person must buy in themselves, and a top-up lands before the next hand', () => {
  const table = newTable(500);
  deal(table);
  table.hand.street = 'done';
  table.hand.seats[1].stack = 0;
  table.hand.seats[0].stack = 0;
  assert.equal(deal(table), false, 'no chips, no hand');
  assert.equal(myChips(table), 0);
  topUp(table, 300);
  assert.equal(myChips(table), 300);
  assert.equal(deal(table), true);
  assert.equal(table.hand.seats[0].stack + table.hand.seats[0].total, 300);
  assert.equal(table.hand.seats[1].stack + table.hand.seats[1].total, STACK);
  assert.deepEqual(table.log.filter((c) => c.type === 'rebuy').map((c) => c.by), [PERSONAS[0].id]);
});

test('the players\' hellos are theirs to say, and wake no one', () => {
  const table = newTable(500);
  for (const line of INTROS) introduce(table, line);
  assert.deepEqual(table.chat.map((l) => l.by), INTROS.map(([id]) => id));
  assert.deepEqual(plan(table), [], 'no one is due: there is no hand, and no line asks anything');
});
