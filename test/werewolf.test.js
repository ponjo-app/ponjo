// The werewolf page's rules and its table as a world (preview/werewolf-rules.js,
// preview/werewolf-world.js), on the runtime's core (src/core/: the store,
// the ledger, the controllers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { control, limits } from '../src/core/controller.js';
import { ledger } from '../src/core/ledger.js';
import { createStore } from '../src/core/store.js';
import { MAX_SPEECH, SIZES, act, daybreak, deal, due, fallback, newGame, turn, view } from '../preview/werewolf-rules.js';
import { CALL_MS, CLOCK, HUMAN, PERSONAS, ROLE_NAMES, TURN, decided, newTable, prompt, world } from '../preview/werewolf-world.js';
import { until } from './helpers.js';

// Seats 0 and 5 are the wolves, 1 the seer, 2 the witch, the rest villagers.
const ROLES = ['wolf', 'seer', 'witch', 'villager', 'villager', 'wolf', 'villager'];
// `seat` does `action` on the game as it is now; an error fails the test.
const play = (game, seat, action) => {
  const out = act(game, seat, { ...action, at: turn(game) });
  assert.ok(!out.error, `seat ${seat} ${action.type}: ${out.error}`);
  return out;
};
// A night: the wolves' kills, the seer's check, the witch's potion, then the
// narrator calls dawn (none: she is left to act, and it is still night).
const night = (game, kills, { check = 3, potion = { type: 'pass' } } = {}) => {
  for (const [seat, target] of kills) game = play(game, seat, { type: 'kill', target });
  const seer = due(game).find((d) => d.kind === 'check');
  if (seer) game = play(game, seer.seat, { type: 'check', target: check });
  const witch = due(game).find((d) => d.kind === 'potion');
  if (witch && potion) game = play(game, witch.seat, potion);
  return potion ? daybreak(game) : game;
};
const speeches = (game) => {
  while (game.phase === 'day') game = play(game, game.speaker, { type: 'speak', text: 'I am a villager.' });
  return game;
};
const vote = (game, votes) => {
  for (const { seat } of due(game)) game = play(game, seat, votes(seat));
  return game;
};

test('roles are dealt by size: two wolves, a seer and a witch, the rest villagers', () => {
  for (const size of SIZES) {
    const roles = deal(size);
    assert.equal(roles.length, size);
    assert.equal(roles.filter((r) => r === 'wolf').length, 2);
    assert.equal(roles.filter((r) => r === 'seer').length, 1);
    assert.equal(roles.filter((r) => r === 'witch').length, 1);
  }
  assert.throws(() => deal(5));
});

test('the first night, as a narrator calls it: the wolves at once, then the seer, then the witch', () => {
  let game = newGame(ROLES);
  assert.deepEqual(due(game), [{ seat: 0, kind: 'kill' }, { seat: 5, kind: 'kill' }]);
  assert.equal(view(game, 3).step, 'wolves', 'which role the night is at is public');
  game = play(game, 0, { type: 'kill', target: 3 });
  assert.deepEqual(due(game), [{ seat: 5, kind: 'kill' }], 'a pick in, the other wolf still due');
  game = play(game, 5, { type: 'kill', target: 3 });
  assert.deepEqual(due(game), [{ seat: 1, kind: 'check' }]);
  assert.equal(view(game, 3).step, 'seer');
  game = play(game, 1, { type: 'check', target: 5 });
  assert.equal(view(game, 1).log.at(-1).wolf, true, 'the seer learns at once');
  assert.deepEqual(due(game), [{ seat: 2, kind: 'potion' }]);
  assert.deepEqual(view(game, 2).log.at(-1), { day: 1, type: 'attacked', target: 3 });
  game = play(game, 2, { type: 'pass' });
  assert.deepEqual([game.phase, due(game)], ['night', []], 'the night waits for the narrator to call dawn');
  game = daybreak(game);
  assert.equal(game.phase, 'day');
  assert.deepEqual(game.log.at(-1), { day: 1, type: 'dawn', deaths: [3] });
  assert.equal(game.speaker, 4, 'speeches start after the first who died');
  assert.deepEqual(game.order, [4, 5, 6, 0, 1, 2]);
});

test('illegal and stale actions are turned away and change nothing', () => {
  const game = newGame(ROLES);
  const before = structuredClone(game);
  const no = (seat, action, why) => assert.match(act(game, seat, { at: turn(game), ...action }).error, why);
  no(3, { type: 'kill', target: 4 }, /not your turn/);
  no(0, { type: 'kill', target: 5 }, /a wolf/);
  no(0, { type: 'kill', target: 9 }, /living player/);
  no(0, { type: 'vote', target: 3 }, /only kill/);
  no(1, { type: 'check', target: 3 }, /not your turn/, 'the seer waits for the wolves');
  no(0, { type: 'kill', target: 3, text: 'x'.repeat(MAX_SPEECH + 1) }, /Too long/);
  assert.match(act(game, 0, { type: 'kill', target: 3, at: '0:night:wolves1' }).error, /Stale/);
  assert.match(act(game, 0, { type: 'kill', target: 3 }).error, /Stale/, 'an action names the moment it was made on');
  assert.deepEqual(game, before);
  const once = play(game, 0, { type: 'kill', target: 3 });
  assert.match(act(once, 0, { type: 'kill', target: 4, at: turn(once) }).error, /acted already/);
  const seer = play(once, 5, { type: 'kill', target: 3 });
  assert.match(act(seer, 1, { type: 'check', target: 1, at: turn(seer) }).error, /another living player/);
});

test('the witch saves anyone but herself, poisons once, and one potion a night', () => {
  let game = night(newGame(ROLES), [[0, 2], [5, 2]], { potion: { type: 'pass' } });
  assert.equal(game.seats[2].alive, false, 'no saving herself: she dies');
  game = night(newGame(ROLES), [[0, 2], [5, 2]], { potion: null });
  assert.match(act(game, 2, { type: 'save', at: turn(game) }).error, /not save yourself/);
  game = night(newGame(ROLES), [[0, 4], [5, 4]], { potion: { type: 'save' } });
  assert.deepEqual(game.log.at(-1).deaths, [], 'saved');
  assert.equal(game.potions.save, false);
  game = night(newGame(ROLES), [[0, 4], [5, 4]], { potion: { type: 'poison', target: 6 } });
  assert.deepEqual(game.log.at(-1).deaths, [4, 6], 'the victim and the poisoned, in seat order: dawn says not how');
  game = speeches(game);
  game = vote(game, () => ({ type: 'abstain' }));
  assert.equal(game.phase, 'night');
  game = night(game, [[0, 3], [5, 3]], { potion: null });
  assert.match(act(game, 2, { type: 'poison', target: 1, at: turn(game) }).error, /poison is used/);
  assert.deepEqual(view(game, 2).log.at(-1), { day: 2, type: 'attacked', target: 3 }, 'told whom they attacked while she has the save');
  game = daybreak(play(game, 2, { type: 'save' }));
  game = vote(speeches(game), () => ({ type: 'abstain' }));
  game = night(game, [[0, 1], [5, 1]], { potion: null });
  assert.deepEqual([game.step, due(game)], ['witch', []], 'with no potions left the witch is not woken');
  assert.ok(!view(game, 2).log.some((e) => e.type === 'attacked' && e.day === 3), 'nor told whom they attacked');
  assert.notEqual(daybreak(game).phase, 'night', 'the narrator calls dawn all the same');
});

test('wolves who disagree pick once more; then the most picked, a tie to the first wolf', () => {
  let game = newGame(ROLES);
  game = play(game, 0, { type: 'kill', target: 3, text: 'Three is the seer, I bet.' });
  game = play(game, 5, { type: 'kill', target: 4 });
  assert.equal(game.round, 2);
  assert.deepEqual(due(game), [{ seat: 0, kind: 'kill' }, { seat: 5, kind: 'kill' }]);
  assert.equal(view(game, 5).log.find((e) => e.type === 'pick').text, 'Three is the seer, I bet.', 'the pack sees its picks and lines');
  game = play(game, 0, { type: 'kill', target: 6 });
  game = play(game, 5, { type: 'kill', target: 4 });
  assert.equal(game.log.findLast((e) => e.type === 'kill').target, 6, 'a tie: the first wolf in seat order');
  // out of time on the first pick: the picks stand, with no second round
  game = play(newGame(ROLES), 5, { type: 'kill', target: 4 });
  game = fallback(game);
  assert.equal(game.log.findLast((e) => e.type === 'kill').target, 4);
  assert.equal(game.step, 'seer');
  game = daybreak(game);
  assert.deepEqual(game.log.at(-1).deaths, [4], 'dawn called early: everyone still due tonight does nothing');
});

test('the vote: the most votes is out and gives last words; a tie, no one', () => {
  let game = speeches(night(newGame(ROLES), [[0, 3], [5, 3]]));
  assert.equal(game.phase, 'vote');
  assert.equal(due(game).length, 6, 'everyone alive votes at once');
  assert.match(act(game, 4, { type: 'vote', target: 4, at: turn(game) }).error, /another living player/);
  assert.match(act(game, 4, { type: 'vote', target: 3, at: turn(game) }).error, /another living player/, 'not the dead');
  const out = vote(game, (seat) => ({ type: 'vote', target: seat === 0 ? 1 : 0 })); // 0 gets five, 1 gets one
  assert.equal(out.phase, 'last');
  assert.equal(out.speaker, 0);
  assert.equal(out.seats[0].alive, false);
  assert.deepEqual(due(out), [{ seat: 0, kind: 'last' }], 'the dead speak only their last words');
  assert.match(act(out, 0, { type: 'speak', text: '  ', at: turn(out) }).error, /Say something/);
  const after = play(out, 0, { type: 'speak', text: 'You will regret this.' });
  assert.equal(after.phase, 'night');
  assert.equal(after.day, 2);
  const split = vote(game, (seat) => (seat === 0 || seat === 5 ? { type: 'vote', target: 1 } : seat === 1 ? { type: 'vote', target: 0 } : seat === 2 ? { type: 'vote', target: 0 } : { type: 'abstain' }));
  assert.equal(split.log.findLast((e) => e.type === 'vote').out, null, 'two each: no one is out');
  assert.equal(split.phase, 'night');
});

test('the village wins when the last wolf is out; the wolves, once they are as many', () => {
  let game = speeches(night(newGame(ROLES), [[0, 3], [5, 3]], { potion: { type: 'poison', target: 5 } }));
  game = vote(game, (seat) => ({ type: 'vote', target: seat === 0 ? 1 : 0 }));
  assert.equal(game.phase, 'last', 'last words before the end');
  game = play(game, 0, { type: 'speak', text: 'Well played.' });
  assert.equal(game.phase, 'over');
  assert.equal(game.winner, 'village');
  assert.deepEqual(view(game, 4).seats.map((s) => s.role), ROLES, 'every role shown at the end');
  assert.ok(view(game, 4).log.some((e) => e.type === 'pick'), 'and every secret');

  const six = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];
  game = speeches(night(newGame(six), [[0, 4], [1, 4]]));
  game = vote(game, (seat) => ({ type: 'vote', target: seat === 5 ? 2 : 5 })); // the village votes out a villager
  game = play(game, 5, { type: 'speak', text: 'I was a villager!' });
  assert.equal(game.phase, 'over', 'two wolves against two, after the last words');
  assert.equal(game.winner, 'wolves');
  game = night(newGame(six), [[0, 4], [1, 4]], { potion: { type: 'poison', target: 5 } });
  assert.equal(game.phase, 'over', 'or at dawn, with no speeches');
  assert.equal(game.winner, 'wolves');
});

test('the fallback: a timer that ran out takes everyone due as doing nothing', () => {
  let game = speeches(night(newGame(ROLES), [[0, 3], [5, 3]]));
  game = play(game, 4, { type: 'vote', target: 0 });
  game = fallback(game);
  assert.deepEqual(game.log.findLast((e) => e.type === 'vote').votes, { 0: null, 1: null, 2: null, 4: 0, 5: null, 6: null });
  assert.equal(game.phase, 'last');
  game = fallback(game);
  assert.equal(game.log.findLast((e) => e.type === 'last').silent, true);
  assert.equal(game.phase, 'night');
});

test('a seat sees its own role, its pack, its own secrets and the public log', () => {
  let game = night(newGame(ROLES), [[0, 4], [5, 4]], { check: 0, potion: { type: 'save' } });
  const roles = (seat) => view(game, seat).seats.map((s) => s.role);
  assert.deepEqual(roles(0), ['wolf', null, null, null, null, 'wolf', null]);
  assert.deepEqual(roles(3), [null, null, null, 'villager', null, null, null]);
  assert.deepEqual(view(game, 0).pack, [0, 5]);
  assert.equal(view(game, 3).pack, null);
  const kinds = (seat) => view(game, seat).log.map((e) => e.type).join(' ');
  assert.equal(kinds(3), 'night dawn');
  assert.equal(kinds(0), 'night pick pick kill dawn');
  assert.equal(kinds(1), 'night check dawn');
  assert.equal(kinds(2), 'night attacked save dawn');
  assert.equal(view(game, 3).potions, null);
  game = play(game, game.speaker, { type: 'speak', text: 'hi' });
  game = speeches(game);
  game = play(game, 3, { type: 'vote', target: 0 });
  assert.deepEqual(view(game, 4).voted, [3], 'who has voted, not for whom, till the vote ends');
  assert.ok(!view(game, 4).log.some((e) => e.type === 'vote'));
});

// ---- the table as a world, on the core ----

const wolfworld = ledger(world);
// A table in a store, kept as the page keeps it: `box.kept` is what it last
// saved; `now`, the store's clock. `as(id)` is member `id`'s client.
function open(kept = { rev: 0, state: wolfworld.wrap(newTable()) }) {
  const box = { kept, now: 1000 };
  const store = createStore(wolfworld, { load: () => box.kept, save: (k) => (box.kept = k), now: () => box.now });
  const clients = new Map();
  const as = (id) => clients.get(id) ?? clients.set(id, store.client(id)).get(id);
  return { box, as, state: () => box.kept.state.world, game: () => box.kept.state.world.game };
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
// The clock's next task lands, at its time.
function tick(t) {
  const [task] = tasks(t, CLOCK);
  t.box.now = Math.max(t.box.now, task.at);
  return t.as(CLOCK).commit({ as: task.as, answers: [task.given], body: {} });
}
// The clock ticks until `ok()`.
const ticks = (t, ok) => {
  while (!ok()) tick(t);
};
const seatOf = (t, id) => t.state().players.indexOf(id);
const actor = (t, id) => (isAI(id) ? runs : does);
const isAI = (id) => PERSONAS.some((p) => p.id === id);
// A game of `roles` with the people at the table first, the wolves called.
function begins(t, roles = ROLES) {
  does(t, HUMAN, { type: 'start', size: roles.length, roles });
  ticks(t, () => t.state().call?.step === 'wolves');
  return t;
}
// The game played to its end: the wolves kill, the seer checks someone alive, the rest pass, speak and abstain, till the wolves win.
function toEnd(t) {
  while (t.game().phase !== 'over') {
    everyone(t, (seat, kind) => ({ kill: { type: 'kill', target: t.game().seats.findIndex((s) => s.alive && s.role !== 'wolf') }, check: { type: 'check', target: t.game().seats.findIndex((s, i) => s.alive && i !== seat) }, potion: { type: 'pass' }, vote: { type: 'abstain' } }[kind] ?? { type: 'speak', text: 'Hm.' }));
    if (t.game().phase !== 'over') tick(t);
  }
}
// Everyone due acts, as `choose(seat, kind)` says, until no one is. A
// person's action turned away lands nothing, so they would be due forever: it fails.
function everyone(t, choose) {
  for (let acted = true; acted;) {
    acted = false;
    for (const id of t.state().players) {
      const v = view_(t, id);
      if (!v.tasks.length) continue;
      const out = actor(t, id)(t, id, choose(v.content.game.seat, v.content.game.due.kind));
      assert.ok(isAI(id) || !out.refused, `${id}: ${out.refused}`);
      acted = true;
    }
  }
}

test('a turn is a task of its seat, a person\'s too; at night, only once the narrator calls its role, and due by the call\'s end', () => {
  const t = open();
  does(t, HUMAN, { type: 'start', size: 7, roles: ['villager', 'seer', 'witch', 'wolf', 'villager', 'wolf', 'villager'] }); // wolves in seats 3 and 5
  assert.deepEqual(t.state().players, [HUMAN, 'Rosa', 'Jax', 'Wen', 'Otis', 'Priya', 'Bo']);
  assert.equal(t.state().call.step, 'dusk', 'night falls at once');
  assert.deepEqual(tasks(t, 'Wen'), [], 'dusk: no one is called');
  tick(t);
  const at = t.box.now + CALL_MS.wolves;
  assert.deepEqual(['Wen', 'Priya'].map((id) => tasks(t, id).map((x) => [x.kind, x.at, x.why])), [[['turn', at, 'Your kill']], [['turn', at, 'Your kill']]], 'the wolves at once');
  runs(t, 'Priya', { type: 'kill', target: 4, thinking: 'The quiet one.' });
  assert.deepEqual(tasks(t, 'Wen').length, 1, 'Priya\'s pick leaves Wen\'s task as it was');
  runs(t, 'Wen', { type: 'kill', target: 4 });
  assert.equal(t.game().step, 'seer', 'the rules are at the seer');
  assert.deepEqual([t.state().call.step, tasks(t, 'Rosa'), view_(t, 'Rosa').content.game.step], ['wolves', [], 'wolves'], 'whose call it is, not the rules\', and the seer waits for hers');
  assert.match(t.as('Rosa').commit({ base: view_(t, 'Rosa').content.moment, body: { type: 'check', target: 2 } }).refused, /narrator/);
  tick(t);
  assert.deepEqual(tasks(t, 'Rosa').map((x) => x.why), ['Your check'], 'the seer\'s call: her turn');
  assert.deepEqual(t.state().thoughts.Priya, [{ day: 1, phase: 'night', text: 'The quiet one.', action: { type: 'kill', target: 4 } }]);
});

test('the narrator calls each role for its whole time, alive or not, so a call\'s length tells nothing; then dawn', () => {
  const lengths = (roles, act) => {
    const t = begins(open(), roles);
    const calls = [];
    while (t.game().phase === 'night') {
      act(t);
      const { step, at } = t.state().call;
      tick(t);
      calls.push([step, t.box.now - at]);
    }
    return [calls, t];
  };
  // everyone acts at once, or no one does: the night takes as long
  const [fast] = lengths(ROLES, (t) => everyone(t, (seat, kind) => ({ kill: { type: 'kill', target: 3 }, check: { type: 'check', target: 3 }, potion: { type: 'pass' } }[kind])));
  const [slow, t] = lengths(ROLES, () => {});
  assert.deepEqual(fast.map(([s]) => s), ['wolves', 'seer', 'witch']);
  assert.deepEqual(fast, slow);
  assert.deepEqual(slow.map(([, ms]) => ms), [CALL_MS.wolves, CALL_MS.seer, CALL_MS.witch]);
  assert.equal(t.game().phase, 'day', 'after the witch, dawn');
  assert.deepEqual(t.game().log.findLast((e) => e.type === 'dawn').deaths, [], 'no one picked: no one died');
  assert.deepEqual(tasks(t, t.state().players[t.game().speaker]).map((x) => x.at), [t.box.now + TURN], 'by day, a turn is due TURN after it began');
});

test('whom the wolves attacked reaches the witch in her call, not before', () => {
  const t = begins(open(), ['seer', 'wolf', 'villager', 'villager', 'villager', 'wolf', 'witch']); // the person is the seer; Bo, in seat 6, the witch
  runs(t, 'Rosa', { type: 'kill', target: 2 });
  runs(t, 'Priya', { type: 'kill', target: 2 });
  tick(t);
  does(t, HUMAN, { type: 'check', target: 3 });
  assert.equal(t.game().step, 'witch');
  assert.ok(!JSON.stringify(view_(t, 'Bo').content.game.log).includes('attacked'), 'the seer\'s call');
  tick(t);
  assert.deepEqual(view_(t, 'Bo').content.game.log.at(-1), { day: 1, type: 'attacked', target: 2 });
});

test('a change turned away is a try, told why; three, and the rules\' fallback plays; a person\'s refused change lands nothing', () => {
  const t = begins(open(), ['wolf', 'villager', 'seer', 'villager', 'villager', 'wolf', 'witch']); // the person and Priya are the wolves; Jax the seer
  const stale = view_(t, 'Priya').content.moment;
  assert.equal(runs(t, 'Priya', decided({ thinking: 'x', action: { type: 'kill', target: 4 }, say: 'Seat 4 talks too little.' }, ['kill'])).refused, undefined);
  assert.deepEqual(t.game().picks, { 5: 3 }, 'seats from 1 in the prompt, from 0 here');
  assert.equal(t.game().log.at(-1).text, 'Seat 4 talks too little.', 'a wolf\'s say is a line to the pack');
  does(t, HUMAN, { type: 'kill', target: 4 }); // the person disagrees
  assert.equal(t.game().round, 2);
  assert.match(t.as('Priya').commit({ as: 'Priya', base: stale, answers: [], body: { type: 'kill', target: 3 } }).refused, /Stale/, 'made on the first pick');
  does(t, HUMAN, { type: 'kill', target: 3 });
  runs(t, 'Priya', { type: 'kill', target: 3 });
  tick(t);
  const out = runs(t, 'Jax', { type: 'check', target: 2 });
  assert.match(out.refused, /another living player/);
  assert.ok(out.rev, 'the try lands in the ledger');
  assert.match(tasks(t, 'Jax')[0].refused, /another living player/, 'due again, told why');
  assert.match(prompt(view_(t, 'Jax'), 'Jax').situation, /Your last action was turned away: Pick another living player/);
  runs(t, 'Jax', { type: 'check', target: 2 });
  assert.equal(t.game().step, 'seer');
  runs(t, 'Jax', { type: 'check', target: 2 });
  assert.equal(t.game().step, 'witch', 'turned away three times: the seer checks no one, and the night goes on');
  assert.match(does(t, HUMAN, { type: 'vote', target: 1 }).refused, /not your turn/);
  assert.equal(tasks(t, HUMAN).length, 0);
});

test('a speech is the speaker\'s action: an empty one is turned away; a failed run, or out of time, says nothing', () => {
  const t = begins(open());
  everyone(t, (seat, kind) => ({ kill: { type: 'kill', target: 3 }, check: { type: 'check', target: 3 }, potion: { type: 'pass' } }[kind]));
  ticks(t, () => t.game().phase === 'day');
  const speaker = () => t.state().players[t.game().speaker];
  assert.equal(speaker(), 'Otis', 'speeches start after the first who died');
  assert.match(runs(t, 'Otis', decided({ thinking: 'Hm.' }, ['speak'])).refused, /Say something/);
  assert.equal(runs(t, 'Otis', { type: 'speak', text: 'I trust seat 2.' }).refused, undefined);
  assert.equal(t.game().log.at(-1).text, 'I trust seat 2.');
  t.as('Priya').commit({ as: 'Priya', answers: tasks(t, 'Priya').map((x) => x.given), failed: 'Can\'t reach the model' });
  assert.deepEqual([t.game().log.at(-1).silent, speaker()], [true, 'Bo'], 'a failed run: its fallback at once');
  tick(t);
  assert.deepEqual([t.game().log.at(-1).seat, t.game().log.at(-1).silent], [6, true], 'out of time: Bo said nothing');
});

test('friends at the table: people sit first, by name; one gone only times out their own turns; a watcher sees no secret', () => {
  const t = open();
  does(t, 'fa1b2c3d4', { type: 'join', name: 'Mia' });
  begins(t, ['villager', 'wolf', 'witch', 'seer', 'villager', 'wolf', 'villager']);
  assert.deepEqual(t.state().players, [HUMAN, 'fa1b2c3d4', 'Rosa', 'Jax', 'Wen', 'Otis', 'Priya']);
  assert.match(prompt(view_(t, 'Otis'), 'Otis').situation, /seat 2, Mia, a person \(werewolf\)/, 'the pack knows its friend by name');
  assert.match(prompt(view_(t, 'Rosa'), 'Rosa').situation, /seat 1, the host, a person: alive/);
  does(t, 'fa1b2c3d4', { type: 'leave' });
  assert.deepEqual(t.game().picks, {}, 'Mia is gone: her pick is taken as none');
  assert.deepEqual(t.game().acted, [1]);
  assert.equal(t.game().step, 'wolves', 'Otis still picks');
  const watcher = view_(t, 'f00000000').content.game;
  assert.equal(watcher.seat, -1);
  assert.ok(watcher.seats.every((x) => x.role === null) && !watcher.pack && !watcher.due);
  assert.ok(!watcher.log.some((e) => e.type === 'pick'), 'not the pack\'s picks');
  assert.match(does(t, 'f9', { type: 'chat', text: 'Hi' }).refused, /game is on/);
});

test('a friend\'s page gets only their own seat\'s secrets: their role, their pack, no one\'s thinking till the end', () => {
  const t = open();
  does(t, 'fann', { type: 'join', name: 'Ann' });
  begins(t, ['villager', 'seer', 'wolf', 'witch', 'villager', 'wolf', 'villager']); // Ann, in seat 1, is the seer
  runs(t, 'Rosa', { type: 'kill', target: 0, thinking: 'The host first' });
  runs(t, 'Otis', { type: 'kill', target: 0, thinking: 'Agreed' });
  tick(t);
  does(t, 'fann', { type: 'check', target: 5 });
  const seen = JSON.stringify({ ...view_(t, 'fann'), rules: '' });
  assert.match(seen, /"role":"seer"/);
  assert.ok(!/"role":"(wolf|witch|villager)"/.test(seen), 'no other role');
  assert.ok(!/"type":"(pick|kill|attacked)"/.test(seen) && !seen.includes('The host first'), 'not the pack\'s night, nor its thinking');
  assert.deepEqual(view_(t, 'fann').content.game.log.filter((e) => e.type === 'check'), [{ day: 1, type: 'check', seat: 1, target: 5, wolf: true }], 'her own check');
  assert.deepEqual(view_(t, 'fann').content.thoughts, { fann: [] });
  assert.deepEqual(view_(t, 'fann').seen, ['fann'], 'at night, no one\'s presence but her own');
  assert.deepEqual(view_(t, 'Rosa').seen, ['Rosa', 'Otis'], 'a wolf\'s: the pack\'s');
});

test('each AI player has its own character, and a prompt gives it with the player\'s role', () => {
  assert.equal(new Set(PERSONAS.map((p) => p.id)).size, PERSONAS.length);
  assert.ok(PERSONAS.length >= Math.max(...SIZES) - 1);
  for (const field of ['blurb', 'voice', 'play', 'wolf', 'claim']) {
    assert.equal(new Set(PERSONAS.map((p) => p[field])).size, PERSONAS.length, `each has its own ${field}`);
  }
  assert.ok(PERSONAS.every((p) => p.words > 0 && p.words * 7 < MAX_SPEECH), 'a speech of their length fits in a speech\'s characters');
  const t = begins(open(), ['villager', 'wolf', 'seer', 'witch', 'villager', 'wolf', 'villager', 'villager']);
  const { rules, situation } = prompt(view_(t, 'Rosa'), 'Rosa');
  assert.match(rules, /You are Rosa, in seat 2: a retired teacher who keeps the record\./);
  assert.match(rules, /How you talk: .*about 50 words\.\nHow you play: You keep score/);
  assert.match(rules, /As a werewolf: .*\nAs the seer or the witch: As the seer you reveal yourself early/);
  assert.match(situation, /Your role: werewolf\. The werewolves: seat 2, you \(werewolf\) and seat 6, Priya \(werewolf\)\./);
  assert.match(situation, /Now: Pick the player the werewolves kill tonight/);
  assert.doesNotMatch(prompt(view_(t, 'Jax'), 'Jax').situation, /Now:/, 'the seer sleeps till the wolves have picked');
  assert.doesNotMatch(prompt(view_(t, 'Wen'), 'Wen').situation, /Now:/, 'and the witch');
});

// Every secret a game holds, with the seats that may know it: each seat's
// role as a prompt shows it (and must, to those seats), the pack's lines,
// the seer's checks and the witch's night. A prompt holds a secret only if
// its seat may know it.
function secrets(t) {
  const s = t.game();
  const wolves = s.seats.flatMap((x, i) => (x.role === 'wolf' ? [i] : []));
  const seer = s.seats.findIndex((x) => x.role === 'seer');
  const witch = s.seats.findIndex((x) => x.role === 'witch');
  const out = [];
  for (const [i, x] of s.seats.entries()) {
    out.push({ test: (me) => new RegExp(`seat ${i + 1}, ${me === i ? 'you' : i === 0 ? 'the host, a person' : t.state().players[i]} \\(${ROLE_NAMES[x.role]}\\)`), may: x.role === 'wolf' ? wolves : [i], shown: true });
  }
  for (const e of s.log) if (e.type === 'pick' && e.text) out.push({ test: () => new RegExp(`\\b${e.text}\\b`), may: wolves });
  out.push({ test: () => /wants to kill seat|The pack (chose|killed)/, may: wolves });
  out.push({ test: () => /checked seat/, may: [seer] });
  out.push({ test: () => /The werewolves attacked seat|used the save on|poisoned seat/, may: [witch] });
  return out;
}

test('random games: no role or night secret ever reaches a prompt that may not see it', () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const seat = () => Math.floor(Math.random() * 9) - 1; // now and then not a seat at all
  const action = (kind) => ({
    kill: () => ({ type: 'kill', target: seat() }),
    check: () => ({ type: 'check', target: seat() }),
    potion: () => pick([{ type: 'save' }, { type: 'poison', target: seat() }, { type: 'pass' }]),
    speak: () => ({ type: 'speak' }),
    last: () => ({ type: 'speak' }),
    vote: () => pick([{ type: 'vote', target: seat() }, { type: 'abstain' }]),
  }[kind])();
  let lines = 0;
  for (let k = 0; k < 100; k++) {
    const size = pick(SIZES);
    const t = begins(open(), deal(size));
    for (let step = 0; t.game().phase !== 'over'; step++) {
      assert.ok(step < 3000, 'a game ends');
      for (const id of t.state().players.slice(1)) {
        const me = seatOf(t, id);
        const { rules, situation } = prompt(view_(t, id), id);
        for (const secret of secrets(t)) {
          const re = secret.test(me);
          const has = re.test(`${rules}\n${situation}`);
          assert.ok(secret.shown ? has === secret.may.includes(me) : !has || secret.may.includes(me), `${id} (${t.game().seats[me].role}) and ${re} on day ${t.game().day}, ${t.game().phase}`);
        }
      }
      const due_ = t.state().players.filter((id) => tasks(t, id).length);
      if (!due_.length || Math.random() < 0.03) {
        tick(t);
        continue;
      }
      const id = pick(due_);
      const v = view_(t, id);
      const say = Math.random() < 0.1 ? '' : `line${lines++}`;
      const made = { ...action(v.content.game.due.kind), target: undefined, ...(Math.random() < 0.9 ? { target: seat() + 1 } : {}) };
      const body = decided({ thinking: 'hm', action: made, say }, v.actions);
      if (Math.random() < 0.05) t.as(id).commit({ as: id, base: 'stale', answers: isAI(id) ? v.tasks.map((x) => x.given) : [], body });
      else actor(t, id)(t, id, body);
    }
    const live = t.game().seats.filter((x) => x.alive);
    const wolves = live.filter((x) => x.role === 'wolf').length;
    assert.ok(t.game().winner === 'village' ? wolves === 0 : wolves >= live.length - wolves, `${t.game().winner} won`);
  }
});

// The clock as a test runs it: each hello and each of the narrator's calls
// at once; a turn by day never runs out.
const quickClock = { pick: (view) => view.tasks.filter((x) => !x.given.startsWith('expire:')).slice(0, 1), program: () => new Promise((resolve) => setTimeout(() => resolve({ body: {} }), 5)) };
// A player's program, as `choose` plays: the wolves kill a villager, never
// Jax, the seer checks, the witch passes, everyone speaks and votes at
// random. It counts its runs, and notes any secret its prompt holds that
// its seat may not know.
function player(t, id, { leaks = [], ran = [], choose = (seat, kind, view) => ({ kill: { type: 'kill', target: (view.content.game.seats.findIndex((s, i) => s.alive && !view.content.game.pack.includes(i) && t.state().players[i] !== 'Jax')) }, check: { type: 'check', target: seat === 0 ? 1 : 0 }, potion: { type: 'pass' }, vote: { type: 'abstain' } }[kind] ?? { type: 'speak', text: 'I am a villager.' }) } = {}) {
  return async (tasks_, view) => {
    ran.push(id);
    if (isAI(id)) {
      const { rules, situation } = prompt(view, id);
      for (const secret of secrets(t)) if (!secret.shown && secret.test(seatOf(t, id)).test(`${rules}\n${situation}`) && !secret.may.includes(seatOf(t, id))) leaks.push(`${id}: ${secret.test(seatOf(t, id))}`);
    }
    if (view.actions.includes('chat')) return null;
    const g = view.content.game;
    return { base: view.content.moment, body: id === 'Jax' ? { type: 'dance' } : { ...choose(g.seat, g.due.kind, view), thinking: 'hm' } };
  };
}

test('on the core: each AI player\'s controller and the clock\'s play a whole game with a person; no secret reaches a prompt; refusals fall back', async () => {
  const t = open();
  does(t, HUMAN, { type: 'start', size: 7, roles: deal(7) });
  const leaks = [];
  const ran = [];
  const wallet = limits();
  const members = [...t.state().players.map((id) => control(t.as(id), { program: player(t, id, { leaks, ran }), wallet })), control(t.as(CLOCK), quickClock)];
  try {
    await until(() => t.game().phase === 'over', 'the game to end', 60_000);
  } finally {
    for (const m of members) m.stop();
  }
  assert.deepEqual(leaks, []);
  assert.ok(['village', 'wolves'].includes(t.game().winner));
  const jax = ran.filter((id) => id === 'Jax').length;
  assert.ok(jax >= 3 && jax % 3 === 0, `Jax, turned away three times on each turn, is played for by the rules: ${jax} runs`);
});

test('a refresh mid-game resumes it: the night\'s picks and the call stay, and the controllers on the reloaded store play on', async () => {
  const t = begins(open());
  runs(t, 'Priya', { type: 'kill', target: 3 }); // seat 5, a wolf, as is the person
  const page = open(JSON.parse(JSON.stringify(t.box.kept))); // what the browser kept, read by a new page
  page.box.now = t.box.now;
  assert.deepEqual(page.game().picks, { 5: 3 });
  assert.equal(page.state().call.step, 'wolves');
  assert.deepEqual(tasks(page, HUMAN).map((x) => x.why), ['Your kill'], 'the person\'s turn is back on their screen');
  assert.deepEqual(tasks(page, 'Priya'), [], 'Priya\'s pick is not asked again');
  does(page, HUMAN, { type: 'kill', target: 3 });
  const members = [...page.state().players.slice(1).map((id) => control(page.as(id), { program: player(page, id) })), control(page.as(CLOCK), quickClock)];
  try {
    await until(() => page.game().phase === 'day', 'dawn');
  } finally {
    for (const m of members) m.stop();
  }
  assert.deepEqual(page.game().log.find((e) => e.type === 'dawn').deaths, [3]);
  assert.ok(page.box.kept.rev > t.box.kept.rev, 'on from the rev kept');
});

test('the table chats outside a game: each AI player at it says hello as it sits down; a line asks those it names; to everyone, one; a reply to a reply, no one', async () => {
  const t = open();
  does(t, 'fann', { type: 'join', name: 'Ann' });
  assert.deepEqual(view_(t, HUMAN).content.seated, [HUMAN, 'fann', 'Rosa', 'Jax', 'Wen', 'Otis', 'Priya'], 'before any game, the AI players sit with the people');
  assert.deepEqual(tasks(t, 'Rosa').map((x) => [x.kind, x.given]), [['ask', 'hello:Rosa']], 'each says hello');
  assert.match(does(t, 'fann', { type: 'size', size: 6 }).refused, /host/);
  does(t, HUMAN, { type: 'size', size: 6 });
  assert.deepEqual([tasks(t, 'Priya'), view_(t, 'Priya').actions], [[], []], 'one seat less: Priya gets up');
  assert.match(prompt(view_(t, 'Rosa'), 'Rosa').situation, /At the table now: the host, a person, Ann, a person, you, Jax, Wen, Otis\.\n\nNow: You just sat down at the table: say hello/);
  runs(t, 'Rosa', decided({ say: 'Good evening.' }, ['chat']));
  assert.deepEqual(tasks(t, 'Rosa'), [], 'once');
  for (const id of ['Jax', 'Wen', 'Otis']) runs(t, id, null);
  assert.deepEqual(tasks(t, 'Jax'), [], 'quiet answers it');
  does(t, 'fann', { type: 'chat', text: '我们用中文吧' });
  assert.deepEqual(['Rosa', 'Jax', 'Wen', 'Otis'].map((id) => tasks(t, id).length), [0, 1, 0, 0], 'to everyone: the AI player whose last line is oldest, Jax');
  runs(t, 'Jax', { type: 'chat', text: '好！' });
  begins(t, deal(6));
  assert.match(does(t, HUMAN, { type: 'chat', text: 'Hi' }).refused, /game is on/);
  assert.match(prompt(view_(t, 'Otis'), 'Otis').situation, /The table's chat, latest last:\n- Rosa: "Good evening\."\n- Ann, a person: "我们用中文吧"\n- Jax: "好！"/, 'what the table agreed, through the game');
  toEnd(t);
  does(t, HUMAN, { type: 'chat', text: 'Rosa, were you a wolf?' });
  const ais = ['Rosa', 'Jax', 'Wen', 'Otis'];
  assert.deepEqual(ais.map((id) => tasks(t, id).map((x) => [x.kind, x.from, x.depth])), [[['ask', [HUMAN], 0]], [], [], []], 'named, Rosa is asked');
  assert.match(prompt(view_(t, 'Rosa'), 'Rosa').situation, /The game is over[\s\S]*Now: the host said "Rosa, were you a wolf\?"/);
  runs(t, 'Rosa', decided({ say: 'Not me, dear. Ask Jax.' }, ['chat']));
  assert.deepEqual(tasks(t, 'Jax').map((x) => [x.from, x.depth]), [[[HUMAN], 1]], 'Rosa named Jax: for whom her run was');
  runs(t, 'Jax', { type: 'chat', text: 'Rosa, nope!' });
  assert.deepEqual(tasks(t, 'Rosa'), [], 'a reply to a reply asks no one');
  does(t, 'fann', { type: 'chat', text: 'Good game, all!' });
  assert.deepEqual(ais.map((id) => tasks(t, id).length), [0, 0, 1, 0], 'to everyone: the AI player whose last line is oldest, Wen');
  assert.equal(does(t, 'fbob', { type: 'chat', text: 'Hi' }).refused, 'You are not at the table.');
  assert.deepEqual(t.state().lines.map((l) => l.no), [0, 0, 0, 1, 1, 1, 1], 'each line with the last game begun');
});

test('a line to the whole table costs a bounded number of model calls: one answer, and its replies as deep as DEPTH', async () => {
  const t = open();
  begins(t, deal(8));
  toEnd(t);
  const ran = [];
  // Each AI player answers what asks it with a line to someone, or to everyone.
  const talker = (id) => async (tasks_, view) => {
    ran.push(id);
    return { base: view.content.moment, body: { type: 'chat', text: ran.length % 2 ? 'Rosa, Jax, Wen: well played.' : 'Well played, all.' } };
  };
  const members = t.state().players.slice(1).map((id) => control(t.as(id), { program: talker(id) }));
  try {
    does(t, HUMAN, { type: 'chat', text: 'Good game, everyone!' });
    await until(() => ran.length && t.state().players.every((id) => !tasks(t, id).length), 'the table to come to rest');
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    for (const m of members) m.stop();
  }
  assert.ok(ran.length <= 4, `one answer, then the three it names at depth 1: ${ran.length} runs`);
  assert.equal(ran[0], 'Rosa', 'the first AI player in seat order: no one has said a line');
});
