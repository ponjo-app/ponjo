// The werewolf page's rules and runtime (preview/werewolf-rules.js, preview/werewolf-runtime.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SPEECH, SIZES, act, deal, due, fallback, newGame, turn, view } from '../preview/werewolf-rules.js';
import { HUMAN, PERSONAS, ROLE_NAMES, begin, decided, expire, land, newGame as newTable, plan, prompt, seatOf } from '../preview/werewolf-runtime.js';

// Seats 0 and 5 are the wolves, 1 the seer, 2 the witch, the rest villagers.
const ROLES = ['wolf', 'seer', 'witch', 'villager', 'villager', 'wolf', 'villager'];
// `seat` does `action` on the game as it is now; an error fails the test.
const play = (game, seat, action) => {
  const out = act(game, seat, { ...action, at: turn(game) });
  assert.ok(!out.error, `seat ${seat} ${action.type}: ${out.error}`);
  return out;
};
// A night: the wolves' kills, the seer's check, the witch's potion (none: she is left to act).
const night = (game, kills, { check = 3, potion = { type: 'pass' } } = {}) => {
  for (const [seat, target] of kills) game = play(game, seat, { type: 'kill', target });
  const seer = due(game).find((d) => d.kind === 'check');
  if (seer) game = play(game, seer.seat, { type: 'check', target: check });
  const witch = due(game).find((d) => d.kind === 'potion');
  if (witch && potion) game = play(game, witch.seat, potion);
  return game;
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
  game = play(game, 2, { type: 'save' });
  game = vote(speeches(game), () => ({ type: 'abstain' }));
  game = night(game, [[0, 1], [5, 1]], { potion: null });
  assert.notEqual(game.phase, 'night', 'with no potions left the witch is not woken');
  assert.ok(!view(game, 2).log.some((e) => e.type === 'attacked' && e.day === 3), 'nor told whom they attacked');
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

// ---- the runtime ----

test('plan: everyone due at once, but not the person, a player running, or one whose run failed', () => {
  const game = newTable(7, { roles: ['villager', 'seer', 'witch', 'wolf', 'villager', 'wolf', 'villager'] }); // wolves in seats 3 and 5
  assert.deepEqual(game.players, [HUMAN, 'Rosa', 'Jax', 'Wen', 'Otis', 'Priya', 'Bo']);
  assert.deepEqual(plan(game).map((d) => [d.id, d.kind]), [['Wen', 'kill'], ['Priya', 'kill']]);
  assert.deepEqual(plan(game, new Set(['Wen'])).map((d) => d.id), ['Priya']);
  game.notes.Wen.failed = { at: turn(game.state), why: 'offline' };
  assert.deepEqual(plan(game).map((d) => d.id), ['Priya']);
  game.notes.Wen.failed = null;
  game.state = act(game.state, 3, { type: 'kill', target: 4, at: turn(game.state) });
  game.state = act(game.state, 5, { type: 'kill', target: 4, at: turn(game.state) });
  assert.deepEqual(plan(game).map((d) => [d.id, d.kind]), [['Rosa', 'check']]);
  assert.equal(game.state.round, 1);
  const person = newTable(7, { roles: ['wolf', ...ROLES.slice(1)] });
  land(person, HUMAN, { at: turn(person.state) }, { action: { type: 'pass' } });
  assert.deepEqual(plan(person).map((d) => d.id), ['Priya'], 'the person is never planned');
});

test('the writer turns away a stale proposal, asks again, then plays the fallback', () => {
  const game = newTable(7, { roles: ROLES });
  const basis = begin(game, 'Priya'); // seat 5, a wolf, as is the person
  assert.equal(land(game, 'Priya', basis, decided({ thinking: 'The quiet one.', action: { type: 'kill', target: 4 }, say: 'Seat 4 talks too little.' })).landed, true);
  assert.deepEqual(game.state.picks, { 5: 3 }, 'seats from 1 in the prompt, from 0 here');
  assert.equal(game.state.log.at(-1).text, 'Seat 4 talks too little.', 'a wolf\'s say is a line to the pack');
  land(game, HUMAN, { at: turn(game.state) }, { action: { type: 'kill', target: 4 } }); // the person, a wolf, disagrees
  assert.equal(game.state.round, 2);
  assert.match(land(game, 'Priya', basis, { action: { type: 'kill', target: 3 } }).rejected, /Stale/, 'made on the first pick');
  land(game, HUMAN, { at: turn(game.state) }, { action: { type: 'kill', target: 3 } });
  land(game, 'Priya', begin(game, 'Priya'), { action: { type: 'kill', target: 3 } });
  const rosa = begin(game, 'Rosa');
  assert.match(land(game, 'Rosa', rosa, { action: { type: 'check', target: 1 } }).rejected, /another living player/);
  assert.match(prompt(game, 'Rosa').situation, /Your last action was turned away: Pick another living player/);
  land(game, 'Rosa', rosa, { action: { type: 'check', target: 1 } });
  assert.equal(game.state.step, 'seer', 'still due');
  land(game, 'Rosa', rosa, { action: { type: 'check', target: 1 } });
  assert.equal(game.state.step, 'witch', 'turned away three times: the seer checks no one, and the night goes on');
});

test('a speech is the speaker\'s action; a run that says nothing is asked again', () => {
  const game = newTable(7, { roles: ROLES });
  game.state = night(game.state, [[0, 3], [5, 3]]);
  const speaker = game.players[game.state.speaker];
  const basis = begin(game, speaker);
  assert.match(land(game, speaker, basis, { thinking: 'Hm.' }).rejected, /Say something/);
  assert.equal(land(game, speaker, basis, { say: 'I trust seat 2.' }).landed, true);
  assert.equal(game.state.log.at(-1).text, 'I trust seat 2.');
  expire(game);
  assert.equal(game.state.log.at(-1).silent, true, 'out of time: the next speaker said nothing');
});

test('each AI player has its own persona, and a prompt names the player and its role', () => {
  assert.equal(new Set(PERSONAS.map((p) => p.id)).size, PERSONAS.length);
  assert.ok(PERSONAS.length >= Math.max(...SIZES) - 1);
  const game = newTable(8, { roles: ['villager', 'wolf', 'seer', 'witch', 'villager', 'wolf', 'villager', 'villager'] });
  const { rules, situation } = prompt(game, 'Rosa');
  assert.match(rules, /You are Rosa, in seat 2\. You are a retired schoolteacher/);
  assert.match(situation, /Your role: werewolf\. The werewolves: seat 2, you \(werewolf\) and seat 6, Priya \(werewolf\)\./);
  assert.match(situation, /Now: Pick the player the werewolves kill tonight/);
  assert.doesNotMatch(prompt(game, 'Jax').situation, /Now:/, 'the seer sleeps till the wolves have picked');
  assert.doesNotMatch(prompt(game, 'Wen').situation, /Now:/, 'and the witch');
});

// Every secret a game holds, with the seats that may know it: each seat's
// role as a prompt shows it (and must, to those seats), the pack's lines,
// the seer's checks and the witch's night. A prompt holds a secret only if
// its seat may know it.
function secrets(game) {
  const s = game.state;
  const wolves = s.seats.flatMap((x, i) => (x.role === 'wolf' ? [i] : []));
  const seer = s.seats.findIndex((x) => x.role === 'seer');
  const witch = s.seats.findIndex((x) => x.role === 'witch');
  const out = [];
  for (const [i, x] of s.seats.entries()) {
    out.push({ test: (me) => new RegExp(`seat ${i + 1}, ${me === i ? 'you' : i === 0 ? 'the person' : game.players[i]} \\(${ROLE_NAMES[x.role]}\\)`), may: x.role === 'wolf' ? wolves : [i], shown: true });
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
  }[kind] ?? (() => ({ type: 'pass' })))();
  let lines = 0;
  for (let k = 0; k < 200; k++) {
    const game = newTable(pick(SIZES));
    for (let step = 0; game.state.phase !== 'over'; step++) {
      assert.ok(step < 2000, 'a game ends');
      for (const id of game.players.slice(1)) {
        const me = seatOf(game, id);
        const { rules, situation } = prompt(game, id);
        for (const secret of secrets(game)) {
          const re = secret.test(me);
          const has = re.test(`${rules}\n${situation}`);
          assert.ok(secret.shown ? has === secret.may.includes(me) : !has || secret.may.includes(me), `${id} (${game.state.seats[me].role}) and ${re} on day ${game.state.day}, ${game.state.phase}`);
        }
      }
      const now = due(game.state);
      if (Math.random() < 0.03) {
        expire(game);
        continue;
      }
      const d = pick(now);
      const id = game.players[d.seat];
      const basis = Math.random() < 0.05 ? { at: 'stale' } : id === HUMAN ? { at: turn(game.state) } : begin(game, id);
      const say = Math.random() < 0.1 ? '' : `line${lines++}`;
      if (id === HUMAN) land(game, HUMAN, basis, { action: action(d.kind), say });
      else land(game, id, basis, decided({ thinking: 'hm', action: { ...action(d.kind), target: undefined, ...(Math.random() < 0.9 ? { target: seat() + 1 } : {}) }, say }));
    }
    const live = game.state.seats.filter((x) => x.alive);
    const wolves = live.filter((x) => x.role === 'wolf').length;
    assert.ok(game.state.winner === 'village' ? wolves === 0 : wolves >= live.length - wolves, `${game.state.winner} won`);
  }
});
