// The spy page's rules and its table as a world (preview/spy-rules.js,
// preview/spy-world.js), on Ponjo's runtime (src/core/runtime.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/core/due.js';
import { createRuntime } from '../src/core/runtime.js';
import { MAX_LINES, PAIRS, SIZES, act, deal, due, endTalk, fallback, linesLeft, newGame, says, spiesFor, targets, turn, view } from '../preview/spy-rules.js';
import { HUMAN, MAX_PEOPLE, begin, callVote, createWorld, decided, expire, intros, introduce, land, leave, newTable, prompt, seatFriend, show, start } from '../preview/spy-world.js';
import { until } from './helpers.js';

const WORDS = { civilian: 'coffee', spy: 'tea' };
// A game of `roles` written as letters: c a civilian, s a spy.
const game = (roles) => newGame({ words: WORDS, roles: [...roles].map((r) => (r === 's' ? 'spy' : 'civilian')) });
const clue = (g, seat, text = `clue ${seat}`) => act(g, seat, { type: 'clue', text, at: turn(g) });
const vote = (g, seat, target) => act(g, seat, { type: 'vote', target, at: turn(g) });
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
  assert.match(act(g, 1, { type: 'clue', text: 'hot', at: turn(g) }).error, /not your turn/);
  assert.match(act(g, 0, { type: 'vote', target: 1, at: turn(g) }).error, /give a clue/);
  assert.match(clue(g, 0, 'I drink TEAS every morning').error, /says your word/, 'the spy may not say tea');
  assert.equal(clue(g, 0, 'a teacher would know').error, undefined, 'a word inside another is not the word');
  g = clue(g, 0, 'Goes with milk');
  assert.match(clue(g, 1, 'Coffee, obviously').error, /says your word/);
  const stale = turn(g);
  g = clue(g, 1, 'Bitter and dark');
  assert.match(act(g, 2, { type: 'clue', text: 'hot', at: stale }).error, /Stale/);
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

// ---- the table as a world ----

// Who Ponjo's runtime finds due on `table` (src/core/due.js, plan, on the world's asks).
async function dueNow(table, given = new Map()) {
  const world = createWorld(() => table);
  const members = await world.members();
  const { start: started } = plan({
    agents: members.filter((m) => m.kind === 'agent'), asks: await world.asks(), askers: members.filter((m) => m.mayAsk).map((m) => m.id), notes: given,
    changedAt: new Map(), running: new Set(), prints: new Map(), woken: new Set(), limit: world.limits.depth, settleMs: 0, paused: false, now: 0,
  });
  return started.map(({ agent, asks }) => ({ id: agent.id, asks }));
}
function give(given, due_) {
  if (!given.has(due_.id)) given.set(due_.id, { seen: new Map(), lookedAt: null, print: null, wake: null, watch: null });
  for (const a of due_.asks) given.get(due_.id).seen.set(a.id, Date.parse(a.until));
}
const tableOf = (roles = 'csccc', ids) => {
  const table = newTable();
  start(table, roles.length, { ids, dealt: { words: WORDS, roles: [...roles].map((r) => (r === 's' ? 'spy' : 'civilian')) } });
  begin(table);
  return table;
};
const at = (table) => ({ at: turn(table.game) });

test('the one whose clue it is is due; in a vote, every AI player at once; a person never', async () => {
  const table = tableOf('ccsccc');
  assert.deepEqual(await dueNow(table), [], 'seat 0 is the host\'s');
  land(table, HUMAN, at(table), { say: 'A morning thing' });
  const given = new Map();
  const [first] = await dueNow(table, given);
  assert.equal(first.id, table.players[1]);
  give(given, first);
  assert.deepEqual(await dueNow(table, given), [], 'what a run was given asks no more');
  while (table.game.phase === 'clue') land(table, table.players[table.game.speaker], at(table), { say: 'Hot' });
  const talk = await dueNow(table, given);
  assert.deepEqual(talk.map((d) => d.id).sort(), table.players.slice(1).sort(), 'the discussion: everyone is asked a word');
  for (const d of talk) give(given, d);
  callVote(table);
  assert.deepEqual((await dueNow(table, given)).map((d) => d.id).sort(), table.players.slice(1).sort(), 'the vote: everyone at once');
});

test('a clue turned away is asked again, told why; after three, the player says nothing', async () => {
  const table = tableOf('cscccc'.slice(0, 5));
  land(table, HUMAN, at(table), { say: 'Morning' });
  const id = table.players[1]; // the spy: tea
  const given = new Map();
  give(given, (await dueNow(table, given))[0]);
  assert.match(land(table, id, at(table), { thinking: 'x', action: { type: 'clue' }, say: 'Tea time!' }).rejected, /says your word/);
  assert.equal((await dueNow(table, given))[0]?.id, id, 'asked again');
  assert.match(prompt(table, id).situation, /turned away: Your clue says your word/);
  land(table, id, at(table), { say: 'tea' });
  land(table, id, at(table), { say: 'teas' });
  assert.equal(table.game.speaker, 2);
  assert.ok(table.game.log.some((e) => e.type === 'clue' && e.seat === 1 && e.silent));
  assert.ok(table.log.some((c) => c.type === 'action' && c.by === id && c.forced));
});

test('a prompt has the player\'s word and the clues, never another word or a living player\'s side', () => {
  const table = tableOf('csccc');
  land(table, HUMAN, at(table), { say: 'Starts my day' });
  for (const id of table.players.slice(1)) {
    const mine = table.game.seats[table.players.indexOf(id)].word;
    const { rules, situation } = prompt(table, id);
    assert.match(situation, new RegExp(`Your word: "${mine}"`));
    assert.match(situation, /seat 1, the host: "Starts my day"/);
    const other = mine === 'tea' ? 'coffee' : 'tea';
    assert.ok(!new RegExp(`\\b${other}\\b`).test(situation), `${id} is shown ${other}`);
    assert.ok(!/was a (spy|civilian)/.test(situation));
    assert.ok(rules.includes(`You are ${id}`));
  }
});

test('the model\'s answer: seats from 1 to 0, and a clue no longer than a clue', () => {
  assert.deepEqual(decided({ thinking: 'hm', action: { type: 'vote', target: 3 } }), { thinking: 'hm', action: { type: 'vote', target: 2 }, say: '' });
  assert.equal(decided({ action: { type: 'clue' }, say: 'x'.repeat(500) }).say.length, 200);
});

test('friends join by name and play from the next game; a friend who leaves is taken as doing nothing', async () => {
  const table = newTable();
  assert.equal(seatFriend(table, 'fann', 'Ann'), true);
  assert.equal(seatFriend(table, 'fann', 'Ann'), false);
  for (let k = 2; k < MAX_PEOPLE; k++) seatFriend(table, `f${k}`, `F${k}`);
  assert.equal(seatFriend(table, 'f9', 'Late'), false, 'full');
  for (let k = 2; k < MAX_PEOPLE; k++) leave(table, `f${k}`);
  start(table, 5, { dealt: { ...deal(5), first: 0 } }); // the host's clue first
  begin(table);
  assert.deepEqual(table.players.slice(0, 2), [HUMAN, 'fann']);
  assert.equal(table.players.length, 5);
  assert.equal(show(table, 'fann').word, table.game.seats[1].word);
  assert.equal(show(table, 'fnew').seat, null, 'not in the game: a watcher');
  assert.equal(show(table, 'fnew').word, null);
  land(table, HUMAN, at(table), { say: 'Hmm' });
  assert.equal(table.game.speaker, 1);
  leave(table, 'fann');
  expire(table, ['fann']);
  assert.equal(table.game.speaker, 2, 'her clue is taken as none');
  assert.ok((await createWorld(() => table).members()).every((m) => m.id !== 'fann'));
});

test('the players say hello in seat order, and no one is asked a clue till the hellos are over', async () => {
  const table = newTable();
  start(table, 5, { dealt: { words: WORDS, roles: ['spy', 'civilian', 'civilian', 'civilian', 'civilian'] } });
  land(table, HUMAN, at(table), { say: 'Mornings' });
  assert.equal(table.game.speaker, 0, 'the host may not clue yet either');
  for (const line of intros(table)) introduce(table, line);
  assert.deepEqual(table.hellos.map((h) => h.id), table.players.slice(1));
  begin(table);
  land(table, HUMAN, at(table), { say: 'Mornings' });
  assert.deepEqual((await dueNow(table)).map((d) => d.id), [table.players[1]]);
});

test('on Ponjo\'s runtime: the AI players play a game to its end, refusals fall back, no word leaks, and the table comes to rest', async () => {
  const table = newTable();
  const world = createWorld(() => table);
  const leaks = [];
  let runs = 0;
  // A model: Max always says his word, which the rules turn away; the
  // others clue and vote for the next living seat after their own. In a
  // discussion Ivy asks Max a question, and the others stay quiet.
  async function run({ agent }, { files, prompt: { situation } }) {
    runs++;
    const t = table.game;
    const seat = table.players.indexOf(agent.id);
    const other = t.seats[seat].word === WORDS.spy ? WORDS.civilian : WORDS.spy;
    if (new RegExp(`\\b${other}\\b`).test(situation)) leaks.push(`${agent.id} saw ${other}`);
    const d = due(t).find((x) => x.seat === seat) ?? (linesLeft(t, seat) ? { kind: 'talk' } : null);
    if (!d || files.at !== turn(t)) return { at: Date.now(), ms: 0, outcome: 'ok', made: null };
    const made = d.kind === 'talk' ? { thinking: 'hm', action: { type: 'say' }, say: agent.id === 'Max' ? `My ${t.seats[seat].word} is fine` : agent.id === 'Ivy' ? 'Max, explain your clue.' : '' }
      : d.kind === 'clue'
      ? { thinking: 'hm', action: { type: 'clue' }, say: agent.id === 'Max' ? `It is ${t.seats[seat].word}` : 'You know it when you see it' }
      : { thinking: 'hm', action: { type: 'vote', target: targets(t, seat)[0] } };
    return { at: Date.now(), ms: 0, outcome: 'ok', made };
  }
  const runtime = await createRuntime({
    world, run, breaker: async () => ({ pauseAfter: Infinity, pauseWithin: 10 }),
    watching: { read: async () => ({}), note: () => {} }, trace: () => {}, emit: () => {},
  });
  try {
    start(table, 6, { dealt: { words: WORDS, roles: ['civilian', 'civilian', 'spy', 'civilian', 'civilian', 'civilian'] } });
    for (const line of intros(table)) introduce(table, line);
    begin(table);
    world.changed();
    await until(() => {
      const g = table.game;
      if (g.phase === 'over') return true;
      if (g.phase === 'talk' && !runtime.running().length) { // the discussion has come to rest: the host starts the vote
        callVote(table);
        world.changed();
        return false;
      }
      const mine = due(g).find((d) => d.seat === 0);
      if (mine) {
        land(table, HUMAN, at(table), mine.kind === 'clue' ? { say: 'Mornings' } : { action: { type: 'vote', target: targets(g, 0)[0] } });
        world.changed();
      }
      return false;
    }, 'the game to end');
    await until(() => runtime.running().length === 0, 'the last runs to end');
    const settled = runs;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(runs, settled, 'the table comes to rest');
  } finally {
    await runtime.close();
  }
  assert.deepEqual(leaks, []);
  assert.ok(table.game.winner);
  assert.ok(table.log.some((c) => c.type === 'action' && c.by === 'Max' && c.forced), 'Max, turned away three times, says nothing');
});

test('a discussion: a line wakes whom it names, a reply to a reply no one; one answer to a line to everyone; never the word, three lines each', async () => {
  const table = tableOf('ccsccc', ['Ivy', 'Max', 'Juno', 'Sam', 'Lou']);
  while (table.game.phase === 'clue') land(table, table.players[table.game.speaker], at(table), { say: 'Hot' });
  const given = new Map();
  for (const d of await dueNow(table, given)) give(given, d); // everyone's word as it began
  assert.deepEqual(await dueNow(table, given), []);
  const ask = (d) => ({ at: turn(table.game), about: d.asks.map((a) => Number(a.id.split(':').at(-1))).at(-1) ?? null });
  land(table, 'Ivy', at(table), { say: 'Max, your clue was odd.', for: [HUMAN] });
  const [max] = await dueNow(table, given);
  assert.equal(max.id, 'Max', 'named, Max is asked');
  give(given, max);
  land(table, 'Max', ask(max), { say: 'Ivy, it was fine.', for: [HUMAN] });
  assert.equal(table.lines.at(-1).depth, 2);
  assert.deepEqual(await dueNow(table, given), [], 'a reply to a reply wakes no one');
  land(table, HUMAN, at(table), { say: 'Who is the spy, everyone?' });
  const all = await dueNow(table, given);
  assert.equal(all.length, 5, 'a line to everyone asks every AI player');
  for (const d of all) land(table, d.id, ask(d), { say: `${d.id} thinks it is Sam.` });
  assert.equal(table.lines.filter((l) => l.about === 3).length, 1, 'one answer lands');
  assert.match(land(table, 'Sam', at(table), { say: 'Hot drinks are hot' }).rejected ?? '', /^$/, 'a line without the word lands');
  const word = table.game.seats[1].word;
  assert.match(land(table, 'Ivy', at(table), { say: `I love ${word}` }).rejected, /says your word/);
  land(table, HUMAN, at(table), { say: 'One' });
  land(table, HUMAN, at(table), { say: 'Two' });
  assert.match(land(table, HUMAN, at(table), { say: 'Three' }).rejected, new RegExp(`${MAX_LINES} lines`));
  assert.equal(land(table, 'Lou', at(table), { say: '' }).landed, false, 'an empty line is staying quiet');
  callVote(table);
  assert.equal(table.game.phase, 'vote');
  assert.match(land(table, HUMAN, { at: '1:talk::' }, { say: 'Late' }).rejected, /Stale/);
});

test('outside a game the table chats: before it, the people; once it is over, the AI players of the game answer', async () => {
  const table = newTable();
  seatFriend(table, 'fann', 'Ann');
  assert.equal(land(table, 'fann', { at: '' }, { say: 'Hi! Ready?' }).landed, true, 'before any game, a friend chats');
  assert.equal(land(table, 'fbob', { at: '' }, { say: 'Me too' }).rejected, 'You are not at the table.');
  assert.deepEqual(await dueNow(table), [], 'no AI player is at the table yet');
  assert.deepEqual(table.lines.map((l) => [l.by, l.game, l.after]), [['fann', 1, false]], 'it goes with the next game');
  start(table, 5, { ids: ['Ivy', 'Max', 'Juno'] });
  assert.match(land(table, HUMAN, { at: '' }, { say: 'Hello' }).rejected, /hello/, 'not while everyone says hello');
  table.game = { ...table.game, phase: 'over', winner: 'spies' };
  table.greeting = false;
  land(table, HUMAN, { at: '' }, { say: 'Max, were you the spy?' });
  const [max] = await dueNow(table);
  assert.deepEqual([max.id, (await dueNow(table)).length], ['Max', 1], 'named, Max is asked');
  assert.match(prompt(table, 'Max', [table.lines.at(-1)]).situation, /The game is over[\s\S]*the host said "Max, were you the spy\?"/);
  land(table, 'Max', { at: '', about: table.lines.at(-1).id }, { say: 'Ivy, tell them it was not me.', for: [HUMAN] });
  const given = new Map();
  for (const d of await dueNow(table)) give(given, d);
  land(table, 'Ivy', { at: '', about: table.lines.at(-1).id }, { say: 'Max, it was you.', for: [HUMAN] });
  assert.deepEqual(await dueNow(table, given), [], 'a reply to a reply wakes no one');
  land(table, 'fann', { at: '' }, { say: 'Good game, everyone!' });
  const all = await dueNow(table, given);
  assert.equal(all.length, 3, 'a line to everyone asks every AI player');
  for (const d of all) land(table, d.id, { at: '', about: table.lines.at(-1).id }, { say: `${d.id}: thanks!` });
  assert.equal(table.lines.filter((l) => l.about === table.lines.find((x) => x.text === 'Good game, everyone!').id).length, 1, 'one answer lands');
  assert.ok(table.lines.filter((l) => l.kind === 'chat' && l.after).every((l) => l.game === table.gameNo));
});

test('a friend whose page reloads is back in their seat: their turns are theirs again', () => {
  const table = newTable();
  seatFriend(table, 'fann', 'Ann');
  start(table, 5, { dealt: { ...deal(5), first: 0 } }); // the host's clue first
  begin(table);
  leave(table, 'fann'); // the page went
  assert.equal(seatFriend(table, 'fann', table.names.fann), true, 'and came back');
  land(table, HUMAN, at(table), { say: 'Mornings' });
  assert.equal(table.game.speaker, 1, 'her clue is hers to give, not taken as none');
  assert.equal(land(table, 'fann', at(table), { say: 'Every day' }).landed, true);
});
