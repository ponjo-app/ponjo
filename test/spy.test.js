// The spy page's rules and its table as a world (preview/spy-rules.js,
// preview/spy-world.js), on the runtime's core (src/core/: the store, the
// ledger, the controllers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { control, limits } from '../src/core/controller.js';
import { ledger } from '../src/core/ledger.js';
import { createStore } from '../src/core/store.js';
import { MAX_LINES, PAIRS, SIZES, act, deal, due, endTalk, fallback, newGame, says, spiesFor, targets, view } from '../preview/spy-rules.js';
import { CLOCK, HUMAN, MAX_PEOPLE, PERSONAS, TURN, decided, newTable, prompt, world } from '../preview/spy-world.js';
import { until } from './helpers.js';

const WORDS = { civilian: 'coffee', spy: 'tea' };
// A game of `roles` written as letters: c a civilian, s a spy.
const game = (roles) => newGame({ words: WORDS, roles: [...roles].map((r) => (r === 's' ? 'spy' : 'civilian')) });
const clue = (g, seat, text = `clue ${seat}`) => act(g, seat, { type: 'clue', text });
const vote = (g, seat, target) => act(g, seat, { type: 'vote', target });
// Every clue of the round given, the discussion over; then everyone votes as `votes` says (seat → target).
function round(g, votes) {
  while (g.phase === 'clue') g = clue(g, g.speaker);
  g = endTalk(g);
  for (const [seat, target] of Object.entries(votes)) g = vote(g, Number(seat), target);
  return g;
}

test('a deal: one pair, a spy or two by size, the sides shuffled', () => {
  for (const size of SIZES) {
    const { words, roles } = deal(size);
    assert.equal(roles.length, size);
    assert.equal(roles.filter((r) => r === 'spy').length, spiesFor(size));
    assert.ok(PAIRS.some(([a, b]) => (a === words.civilian && b === words.spy) || (b === words.civilian && a === words.spy)));
  }
  assert.throws(() => deal(4));
  assert.ok(PAIRS.every(([a, b]) => !says(a, b) && !says(b, a)), 'no word in a pair says the other');
});

test('clues go round in seat order, never saying the word; then everyone votes at once', () => {
  let g = game('scccc');
  assert.deepEqual(due(g), [{ seat: 0, kind: 'clue' }]);
  assert.match(act(g, 1, { type: 'clue', text: 'hot' }).error, /not your turn/);
  assert.match(act(g, 0, { type: 'vote', target: 1 }).error, /give a clue/);
  assert.match(clue(g, 0, 'I drink TEAS every morning').error, /says your word/, 'the spy may not say tea');
  assert.equal(clue(g, 0, 'a teacher would know').error, undefined, 'a word inside another is not the word');
  g = clue(g, 0, 'Goes with milk');
  assert.match(clue(g, 1, 'Coffee, obviously').error, /says your word/);
  g = clue(g, 1, 'Bitter and dark');
  for (const seat of [2, 3, 4]) g = clue(g, seat);
  assert.equal(g.phase, 'talk', 'the clues in, a discussion');
  g = endTalk(g);
  assert.equal(g.phase, 'vote');
  assert.deepEqual(due(g).map((d) => d.kind), Array(5).fill('vote'));
  assert.match(vote(g, 1, 1).error, /another living player/);
  g = vote(g, 1, 0);
  assert.match(vote(g, 1, 2).error, /voted already/);
  assert.deepEqual(view(g, 2).voted, [1], 'who has voted shows; for whom, not yet');
  assert.ok(!view(g, 2).log.some((e) => e.type === 'vote'));
});

test('the first clue is from a seat dealt at random, and each round starts one seat on', () => {
  const firsts = new Set(Array.from({ length: 200 }, () => deal(6).first));
  assert.deepEqual([...firsts].sort(), [0, 1, 2, 3, 4, 5], 'any seat may start');
  let g = newGame({ words: WORDS, roles: ['civilian', 'civilian', 'civilian', 'civilian', 'spy'], first: 3 });
  assert.equal(g.speaker, 3);
  assert.deepEqual(g.order, [3, 4, 0, 1, 2]);
  assert.equal(g.log[0].from, 3);
  g = round(g, { 0: 1, 1: 0, 2: 1, 3: 1, 4: 1 });
  assert.deepEqual(g.order, [4, 0, 2, 3], 'round 2 from seat 4, without the player out');
});

test('the most votes is out, their side shown; every spy out and the civilians win', () => {
  let g = game('csccc');
  g = round(g, { 0: 1, 1: 0, 2: 1, 3: 1, 4: 0 });
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'civilians');
  const v = g.log.find((e) => e.type === 'vote');
  assert.deepEqual([v.out, v.role], [1, 'spy']);
});

test('a civilian out goes on to the next round, which starts a seat further on', () => {
  let g = game('csccccc'.slice(0, 6));
  g = round(g, { 0: 2, 1: 2, 2: 0, 3: 2, 4: 2, 5: 2 });
  assert.equal(g.round, 2);
  assert.equal(g.seats[2].alive, false);
  assert.equal(g.log.findLast((e) => e.type === 'vote').role, 'civilian');
  assert.deepEqual(g.order, [1, 3, 4, 5, 0], 'round 2 starts at seat 1, without the player out');
  assert.equal(view(g, 0).seats[2].role, 'civilian', 'the side of a player out is shown');
  assert.equal(view(g, 0).seats[1].role, null, 'a living player\'s is not');
});

test('a tie: the tied give one more clue each, then a vote between them; a second tie, no one is out', () => {
  let g = game('csccc');
  g = round(g, { 0: 1, 1: 0, 2: 1, 3: 0, 4: 2 });
  assert.deepEqual([g.phase, g.runoff, g.speaker], ['clue', [0, 1], 0]);
  g = clue(g, 0);
  g = clue(g, 1);
  assert.equal(g.phase, 'vote');
  assert.deepEqual(targets(g, 2), [0, 1]);
  assert.deepEqual(targets(g, 0), [1], 'not yourself');
  assert.match(vote(g, 2, 3).error, /tied/);
  const runoff = g;
  for (const [s, t] of [[0, 1], [1, 0], [2, 1], [3, 1], [4, 0]]) g = vote(g, s, t);
  assert.equal(g.winner, 'civilians', 'the spy, with three votes of five, is out');
  g = runoff;
  for (const [s, t] of [[0, 1], [1, 0], [2, 1], [3, 0]]) g = vote(g, s, t);
  g = fallback(g); // seat 4 abstains: two and two
  assert.equal(g.round, 2, 'a second tie: on to the next round');
  assert.ok(g.seats.every((s) => s.alive));
  assert.ok(g.log.findLast((e) => e.type === 'vote').second);
});

test('a spy among the last three wins; so do spies as many as the civilians', () => {
  let g = game('scccc');
  g = round(g, { 0: 1, 1: 0, 2: 1, 3: 1, 4: 1 });
  g = round(g, { 0: 2, 2: 0, 3: 2, 4: 2 });
  assert.equal(g.winner, 'spies');
  assert.equal(view(g, 3).words.spy, 'tea', 'once it is over, everything shows');
  assert.equal(view(g, 3).seats[0].word, 'tea');
  let h = game('ssccccc');
  h = round(h, { 0: 2, 1: 2, 2: 0, 3: 2, 4: 2, 5: 2, 6: 2 });
  h = round(h, { 0: 3, 1: 3, 3: 0, 4: 3, 5: 3, 6: 3 });
  assert.equal(h.phase, 'clue', 'two spies, three civilians: on');
  h = round(h, { 0: 4, 1: 4, 4: 0, 5: 4, 6: 4 });
  assert.equal(h.winner, 'spies', 'two and two');
});

test('the fallback: a speaker says nothing, a voter abstains', () => {
  let g = game('scccc');
  g = fallback(g);
  assert.equal(g.log.at(-1).silent, true);
  assert.equal(g.speaker, 1);
  while (g.phase === 'clue') g = clue(g, g.speaker);
  assert.deepEqual(fallback(g).log, g.log, 'in a discussion no one is due');
  g = vote(endTalk(g), 0, 1);
  g = fallback(g);
  assert.equal(g.log.findLast((e) => e.type === 'vote').out, 1, 'one vote, four abstentions');
});

test('a seat sees its own word, never its side, nor another\'s word, until the game is over', () => {
  const g = game('csccc');
  for (const seat of [0, 1]) {
    const seen = JSON.stringify(view(g, seat));
    assert.equal(view(g, seat).word, g.seats[seat].word);
    assert.ok(!seen.includes(`"${seat === 1 ? 'coffee' : 'tea'}"`), `seat ${seat} sees the other word`);
    assert.ok(!/spy|civilian/.test(seen), `seat ${seat} sees a side`);
  }
  assert.equal(view(g, null).word, null, 'a watcher has no word');
});


// ---- the table as a world, on the core ----

const spy = ledger(world);
const AIS = PERSONAS.map(({ id, hello }) => ({ id, hello }));
// A table in a store, kept as the page keeps it: `box.kept` is what it last
// saved. `as(id)` is member `id`'s client.
function open(kept = { rev: 0, state: spy.wrap(newTable()) }) {
  const box = { kept };
  const store = createStore(spy, { load: () => box.kept, save: (k) => (box.kept = k), now: () => 1000 });
  const clients = new Map();
  const as = (id) => clients.get(id) ?? clients.set(id, store.client(id)).get(id);
  return { box, as, state: () => box.kept.state.world };
}
const view_ = (t, id) => t.as(id).read().view;
const tasks = (t, id) => view_(t, id).tasks;
// What a person does: no tasks answered, made on the moment it sees.
const does = (t, id, body) => t.as(id).commit({ base: view_(t, id).content.moment, body });
// An AI player's run: it answers the tasks it is given now.
function runs(t, id, body) {
  const v = view_(t, id);
  return t.as(id).commit({ as: id, base: v.content.moment, answers: v.tasks.map((x) => x.given), body });
}
// The clock's next task lands.
function tick(t) {
  const [task] = tasks(t, CLOCK);
  return t.as(CLOCK).commit({ as: task.as, answers: [task.given], body: {} });
}
// A game of `roles` (c, s) with the people at the table first, the first clue
// seat `first`'s, its hellos said.
function play(t, roles = 'csccc', first = 0) {
  does(t, HUMAN, { type: 'start', size: roles.length, dealt: { words: WORDS, roles: [...roles].map((r) => (r === 's' ? 'spy' : 'civilian')), first }, ais: AIS });
  while (t.state().greeting) tick(t);
  return t;
}
const seatOf = (t, id) => t.state().players.indexOf(id);
const act_ = (t, id, body) => (PERSONAS.some((p) => p.id === id) ? runs : does)(t, id, body);
// The clues given, everyone passing in the discussion; then each votes as `votes` says (player → seat).
function playRound(t, votes) {
  while (t.state().game.phase === 'clue') act_(t, t.state().players[t.state().game.speaker], { type: 'clue', text: 'Hot' });
  for (const id of t.state().players) if (tasks(t, id).length) act_(t, id, { type: 'pass' });
  for (const [id, target] of Object.entries(votes)) act_(t, id, { type: 'vote', target });
}

test('a turn is a task of its seat, a person\'s too: the clue of the one whose turn it is; in a vote, every living seat at once', () => {
  const t = play(open(), 'ccsccc');
  assert.deepEqual(tasks(t, HUMAN).map((x) => [x.kind, x.why, x.at]), [['turn', 'Your clue', 1000 + TURN]]);
  assert.deepEqual(tasks(t, 'Ivy'), []);
  assert.deepEqual(view_(t, HUMAN).actions, ['clue']);
  does(t, HUMAN, { type: 'clue', text: 'A morning thing' });
  assert.deepEqual(tasks(t, 'Ivy').map((x) => [x.given, x.from, x.depth]), [[`turn:${view_(t, 'Ivy').content.moment}`, [], 0]]);
  while (t.state().game.phase === 'clue') runs(t, t.state().players[t.state().game.speaker], { type: 'clue', text: 'Hot' });
  assert.deepEqual(t.state().players.map((id) => tasks(t, id)[0]?.given), Array(6).fill('talk:1:1:0'), 'the discussion: every seat');
  for (const id of t.state().players) act_(t, id, { type: 'pass' });
  assert.equal(t.state().game.phase, 'vote', 'no one has more to say: the vote');
  const given = t.state().players.map((id) => tasks(t, id)[0]?.given);
  assert.ok(given[0].startsWith('turn:') && given.every((g) => g === given[0]), 'the vote: everyone at once');
});

test('a change made on a moment the game has left is turned away', () => {
  const t = play(open());
  const stale = view_(t, 'Ivy').content.moment;
  does(t, HUMAN, { type: 'clue', text: 'Hot' });
  assert.match(t.as('Ivy').commit({ base: stale, body: { type: 'clue', text: 'Warm' } }).refused, /Stale/);
});

test('a clue turned away is due again, told why; after three tries, the player says nothing', () => {
  const t = play(open(), 'csccc'); // Ivy, in seat 1, is the spy: tea
  does(t, HUMAN, { type: 'clue', text: 'Morning' });
  const out = runs(t, 'Ivy', { type: 'clue', text: 'Tea time!', thinking: 'x' });
  assert.match(out.refused, /says your word/);
  assert.ok(out.rev, 'the try lands in the ledger');
  assert.match(tasks(t, 'Ivy')[0].refused, /says your word/);
  assert.match(prompt(view_(t, 'Ivy'), 'Ivy').situation, /turned away: Your clue says your word/);
  assert.equal(tasks(t, 'Max')[0]?.refused, undefined);
  runs(t, 'Ivy', { type: 'clue', text: 'tea' });
  runs(t, 'Ivy', { type: 'clue', text: 'teas' });
  assert.equal(t.state().game.speaker, 2);
  assert.ok(t.state().game.log.some((e) => e.type === 'clue' && e.seat === 1 && e.silent));
  assert.deepEqual(does(t, HUMAN, { type: 'clue', text: 'coffee' }).refused, 'It is not your turn.', 'a person\'s refusal lands nothing');
});

test('a run that fails takes its turn\'s fallback at once', () => {
  const t = play(open(), 'ccccs', 1);
  t.as('Ivy').commit({ as: 'Ivy', answers: [tasks(t, 'Ivy')[0].given], failed: 'Can\'t reach the model' });
  assert.equal(t.state().game.log.at(-1).silent, true);
  assert.equal(t.state().game.speaker, 2);
});

test('a discussion is a channel: each line is a task for everyone else; a pass or quiet answers it; no one due, the vote', () => {
  const t = play(open(), 'ccsccc');
  while (t.state().game.phase === 'clue') act_(t, t.state().players[t.state().game.speaker], { type: 'clue', text: 'Hot' });
  runs(t, 'Ivy', { type: 'say', text: 'Max, your clue was odd.', thinking: 'Max?' });
  assert.deepEqual(t.state().lines.at(-1), { id: 1, by: 'Ivy', text: 'Max, your clue was odd.', to: ['Max'], depth: 1, from: [], game: 1, kind: 'talk', round: 1 });
  assert.deepEqual(tasks(t, 'Ivy'), [], 'her own line is the latest');
  assert.deepEqual(tasks(t, 'Max').map((x) => [x.given, x.depth]), [['talk:1:1:1', 1]]);
  does(t, HUMAN, { type: 'say', text: 'Who is the spy, everyone?' });
  assert.deepEqual(tasks(t, 'Ivy').map((x) => [x.given, x.from, x.depth]), [['talk:1:1:2', [HUMAN], 0]], 'a new line, a new task');
  runs(t, 'Max', null); // quiet
  assert.deepEqual(tasks(t, 'Max'), [], 'quiet is a pass');
  assert.equal(t.state().passed.Max, 'talk:1:1:2');
  const word = t.state().game.seats[seatOf(t, 'Juno')].word;
  assert.match(runs(t, 'Juno', { type: 'say', text: `I love ${word}` }).refused, /says your word/);
  runs(t, 'Sam', { type: 'say', text: 'Hot drinks are hot' });
  assert.ok(tasks(t, 'Max').length, 'Sam\'s line asks Max again');
  does(t, HUMAN, { type: 'say', text: 'One' });
  does(t, HUMAN, { type: 'say', text: 'Two' });
  assert.match(does(t, HUMAN, { type: 'say', text: 'Three' }).refused, new RegExp(`${MAX_LINES} lines`));
  assert.deepEqual(view_(t, HUMAN).actions, [], 'three lines said');
  for (const id of t.state().players) if (tasks(t, id).length) act_(t, id, { type: 'pass' });
  assert.equal(t.state().game.phase, 'vote');
  assert.deepEqual(t.state().thoughts.Ivy, [{ round: 1, kind: 'talk', text: 'Max?', action: null }]);
});

test('the clock: the hellos one by one, then the first clue; a turn\'s time up takes everyone still due as doing nothing; a discussion\'s, the vote', () => {
  const t = open();
  does(t, HUMAN, { type: 'start', size: 5, dealt: { words: WORDS, roles: ['spy', 'civilian', 'civilian', 'civilian', 'civilian'], first: 0 }, ais: AIS });
  assert.deepEqual(tasks(t, CLOCK).map((x) => [x.given, x.as]), [['hello:1:1', 'Ivy']]);
  assert.match(does(t, HUMAN, { type: 'clue', text: 'Mornings' }).refused, /hello/, 'no clue till the hellos are over');
  assert.match(t.as(CLOCK).commit({ as: CLOCK, answers: ['begin:1'], body: {} }).refused, /Not due/);
  for (let k = 0; k < 4; k++) tick(t);
  assert.deepEqual(t.state().hellos.map((h) => h.id), ['Ivy', 'Max', 'Juno', 'Sam']);
  assert.deepEqual(tasks(t, CLOCK).map((x) => x.given), ['begin:1']);
  tick(t);
  assert.deepEqual(tasks(t, HUMAN).map((x) => x.why), ['Your clue']);
  assert.ok(tasks(t, CLOCK)[0].given.startsWith('expire:'));
  tick(t);
  assert.equal(t.state().game.speaker, 1, 'the host\'s time is up: no clue');
  for (const id of ['Ivy', 'Max', 'Juno', 'Sam']) runs(t, id, { type: 'clue', text: 'Hot' });
  assert.ok(tasks(t, CLOCK)[0].given.startsWith('vote-called:'));
  tick(t);
  assert.equal(t.state().game.phase, 'vote');
});

test('a prompt is built from the seat\'s view alone: its word and the clues, never another word or a living player\'s side', () => {
  const t = play(open(), 'csccc');
  does(t, HUMAN, { type: 'clue', text: 'Starts my day' });
  for (const id of t.state().players.slice(1)) {
    const mine = t.state().game.seats[seatOf(t, id)].word;
    const { rules, situation } = prompt(view_(t, id), id);
    assert.match(situation, new RegExp(`Your word: "${mine}"`));
    assert.match(situation, /seat 1, the host: "Starts my day"/);
    const other = mine === 'tea' ? 'coffee' : 'tea';
    assert.ok(!new RegExp(`\\b${other}\\b`).test(situation), `${id} is shown ${other}`);
    assert.ok(!/was a (spy|civilian)/.test(situation));
    assert.ok(rules.includes(`You are ${id}`));
  }
});

test('the model\'s answer as a change: seats from 1 to 0; an empty line a pass in a discussion, nothing in the chat', () => {
  assert.deepEqual(decided({ thinking: 'hm', action: { type: 'vote', target: 3 } }, ['vote']), { type: 'vote', thinking: 'hm', target: 2 });
  assert.equal(decided({ action: { type: 'clue' }, say: 'x'.repeat(500) }, ['clue']).text.length, 200);
  assert.deepEqual(decided({ thinking: 'hm', action: { type: 'say' }, say: ' ' }, ['say', 'pass']), { type: 'pass', thinking: 'hm' });
  assert.equal(decided({ action: { type: 'say' }, say: '' }, ['chat']), null);
  assert.deepEqual(decided({ action: { type: 'say' }, say: 'GG' }, ['chat']), { type: 'chat', text: 'GG', thinking: '' });
});

test('friends join by name and play from the next game; a friend who leaves is taken as doing nothing; one back takes their turns again', () => {
  const t = open();
  assert.equal(does(t, 'fann', { type: 'join', name: 'Ann' }).rev, 1);
  for (let k = 2; k < MAX_PEOPLE; k++) does(t, `f${k}`, { type: 'join', name: `F${k}` });
  assert.match(does(t, 'f9', { type: 'join', name: 'Late' }).refused, /full/);
  for (let k = 2; k < MAX_PEOPLE; k++) does(t, `f${k}`, { type: 'leave' });
  play(t, 'ccccs', 0);
  assert.deepEqual(t.state().players.slice(0, 2), [HUMAN, 'fann']);
  assert.equal(view_(t, 'fann').content.game.word, t.state().game.seats[1].word);
  assert.equal(view_(t, 'fnew').content.game.seat, null, 'not in the game: a watcher');
  assert.equal(view_(t, 'fnew').content.game.word, null);
  does(t, 'fann', { type: 'leave' });
  does(t, 'fann', { type: 'join', name: 'Ann' }); // her page came back
  does(t, HUMAN, { type: 'clue', text: 'Hmm' });
  assert.equal(t.state().game.speaker, 1, 'back in her seat: her clue is hers');
  assert.equal(does(t, 'fann', { type: 'clue', text: 'Every day' }).refused, undefined);
  for (const id of ['Ivy', 'Max', 'Juno']) runs(t, id, { type: 'clue', text: 'Hot' });
  does(t, 'fann', { type: 'leave' });
  assert.deepEqual(tasks(t, 'fann'), [], 'gone: no discussion task holds the table up');
  for (const id of t.state().players) if (tasks(t, id).length) act_(t, id, { type: 'pass' });
  assert.equal(t.state().game.phase, 'vote');
  assert.equal(t.state().game.votes[1], null, 'her vote is taken as none');
});

test('a friend\'s page gets their own seat\'s view: their word, no other, and no one\'s thinking until the game is over', () => {
  const t = open();
  does(t, 'fann', { type: 'join', name: 'Ann' });
  play(t, 'cscccc', 2); // Ann, in seat 1, is the spy
  runs(t, 'Ivy', { type: 'clue', text: 'Leaves', thinking: 'I think coffee is the civilians\' word' });
  const seen = JSON.stringify({ ...view_(t, 'fann'), rules: '' });
  assert.match(seen, /"word":"tea"/);
  assert.ok(!seen.includes('coffee'), 'neither the other word, nor anyone\'s thinking');
  assert.ok(!/"role":"(spy|civilian)"/.test(seen), 'no side');
  assert.deepEqual(view_(t, 'fann').content.thoughts, { fann: [] });
});

test('outside a game the table chats: before it, the people; once it is over, the AI players answer what names them, one a line to everyone', () => {
  const t = open();
  does(t, 'fann', { type: 'join', name: 'Ann' });
  assert.equal(does(t, 'fann', { type: 'chat', text: 'Hi! Ready?' }).refused, undefined, 'before any game, a friend chats');
  assert.equal(does(t, 'fbob', { type: 'chat', text: 'Me too' }).refused, 'You are not at the table.');
  assert.deepEqual(t.state().lines.map((l) => [l.by, l.game, l.after]), [['fann', 1, false]], 'it goes with the next game');
  play(t, 'cccsc'); // Max, in seat 3, is the spy
  assert.match(does(t, HUMAN, { type: 'chat', text: 'Hello' }).refused, /game is on/);
  playRound(t, { [HUMAN]: 3, fann: 3, Ivy: 3, Max: 0, Juno: 3 });
  assert.equal(t.state().game.winner, 'civilians');
  does(t, HUMAN, { type: 'chat', text: 'Max, were you the spy?' });
  assert.deepEqual(['Ivy', 'Max', 'Juno'].map((id) => tasks(t, id).map((x) => [x.kind, x.from, x.depth])), [[], [['ask', [HUMAN], 0]], []], 'named, Max is asked');
  assert.match(prompt(view_(t, 'Max'), 'Max').situation, /The game is over[\s\S]*Now: the host said "Max, were you the spy\?"/);
  runs(t, 'Max', { type: 'chat', text: 'Ivy, tell them it was not me.' });
  assert.deepEqual(tasks(t, 'Max'), [], 'answered');
  assert.deepEqual(tasks(t, 'Ivy').map((x) => [x.from, x.depth]), [[[HUMAN], 1]], 'a line an AI player said asks for whom its run was');
  runs(t, 'Ivy', { type: 'chat', text: 'Max, it was you.' });
  assert.equal(t.state().lines.at(-1).depth, 2);
  assert.deepEqual(tasks(t, 'Max'), [], 'a reply to a reply asks no one');
  does(t, 'fann', { type: 'chat', text: 'Good game, everyone!' });
  assert.deepEqual(['Ivy', 'Max', 'Juno'].map((id) => tasks(t, id).length), [1, 0, 0], 'a line to everyone: the first AI player after the speaker');
  runs(t, 'Ivy', null);
  assert.deepEqual(tasks(t, 'Ivy'), [], 'quiet answers it');
  assert.ok(t.state().lines.filter((l) => l.kind === 'chat' && l.after).every((l) => l.game === 1));
});

// A model for the AI players: Max always says his word, which the rules
// turn away; the others clue, and vote for the first seat they may. In a
// discussion Ivy asks Max a question, and the others stay quiet. It notes
// any word a player's prompt shows that is not its own.
function model(leaks, ran = []) {
  return (id) => (tasks_, view) => {
    ran.push(id);
    const v = view.content.game;
    const other = v.word === WORDS.spy ? WORDS.civilian : WORDS.spy;
    if (new RegExp(`\\b${other}\\b`).test(prompt(view, id).situation) && v.phase !== 'over') leaks.push(`${id} saw ${other}`);
    const [kind] = view.actions;
    const say = kind === 'clue' ? (id === 'Max' ? `It is ${v.word}` : 'You know it when you see it') : id === 'Max' ? `My ${v.word} is fine` : id === 'Ivy' ? 'Max, explain your clue.' : '';
    return { base: view.content.moment, body: decided({ thinking: 'hm', action: { type: kind, target: (v.due?.targets?.[0] ?? 0) + 1 }, say }, view.actions) };
  };
}

test('on the core: each AI player\'s controller plays a game to its end with a person, refusals fall back, no word leaks, and the table comes to rest', async () => {
  const t = play(open(), 'ccsccc');
  const leaks = [];
  const ran = [];
  const think = model(leaks, ran);
  const wallet = limits();
  const players = t.state().players.slice(1).map((id) => control(t.as(id), { program: think(id), wallet }));
  try {
    await until(() => {
      if (t.state().game.phase === 'over') return true;
      const [task] = tasks(t, HUMAN);
      const v = view_(t, HUMAN).content.game;
      if (task) does(t, HUMAN, v.due?.kind === 'clue' ? { type: 'clue', text: 'Mornings' } : v.due?.kind === 'vote' ? { type: 'vote', target: v.due.targets[0] } : { type: 'pass' });
      return false;
    }, 'the game to end');
    const settled = ran.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ran.length, settled, 'the table comes to rest');
  } finally {
    for (const p of players) p.stop();
  }
  assert.deepEqual(leaks, []);
  assert.ok(t.state().game.winner);
  assert.ok(t.state().game.log.some((e) => e.type === 'clue' && e.seat === seatOf(t, 'Max') && e.silent), 'Max, turned away three times, says nothing');
  assert.ok(t.state().thoughts.Ivy.length, 'thinking lands with each change');
});

test('a refresh in the middle of a vote resumes it: the votes cast stay, and the AI players\' controllers on the reloaded store finish it', async () => {
  const t = play(open(), 'csccc'); // Ivy is the spy
  while (t.state().game.phase === 'clue') act_(t, t.state().players[t.state().game.speaker], { type: 'clue', text: 'Hot' });
  for (const id of t.state().players) if (tasks(t, id).length) act_(t, id, { type: 'pass' });
  does(t, HUMAN, { type: 'vote', target: 1 });
  runs(t, 'Max', { type: 'vote', target: 1 });
  const page = open(JSON.parse(JSON.stringify(t.box.kept))); // what the browser kept, read by a new page
  assert.deepEqual(view_(page, HUMAN).content.game.voted, [0, 2]);
  assert.deepEqual(['Ivy', 'Juno', 'Sam'].map((id) => tasks(page, id).length), [1, 1, 1]);
  const votes = (id) => (tasks_, view) => ({ base: view.content.moment, body: { type: 'vote', target: id === 'Ivy' ? 0 : 1 } });
  const players = ['Ivy', 'Max', 'Juno', 'Sam'].map((id) => control(page.as(id), { program: votes(id) }));
  await until(() => page.state().game.phase === 'over', 'the vote to end');
  for (const p of players) p.stop();
  assert.equal(page.state().game.winner, 'civilians');
  assert.deepEqual(page.state().game.log.findLast((e) => e.type === 'vote').votes, { 0: 1, 1: 0, 2: 1, 3: 1, 4: 1 });
  assert.equal(page.box.kept.rev, t.box.kept.rev + 3, 'each vote a rev, on from the one kept');
});
