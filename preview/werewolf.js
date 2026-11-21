// The werewolf page (site/werewolf.html): a person, any friends they invite
// and AI players round a fire at one game of werewolf. The rules
// (werewolf-rules.js) own what must be exact; the players decide the rest
// from the rules and what their seat may see (werewolf-world.js). Ponjo's agent runtime (src/core/runtime.js)
// runs them on each game as a world, as on the poker page (preview/poker.js).
// Here: a run, one call of the visitor's model (game-page.js, shared with
// the poker page, with the log's messages); a narrator, who calls the night
// a role at a time; and the game drawn from the person's own view alone,
// with what they know of each player on their seat and their own guesses.
// Friends join by a link (poker-share.js), as on the spy page: the host's
// page holds the game and runs the AI players, and sends each friend's page
// its seat's view; a friend's page, opened at `#join=<room>`, only draws and
// sends what its player does. A friend who joins mid-game watches, seeing
// what everyone sees, and plays from the next game; one who leaves
// mid-game has each of their turns taken as doing nothing.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, location, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, arrows, el, load, message, models, notice, store, typingMessage } from './game-page.js';
import { host, join } from './poker-share.js';
import { DECIDE, HUMAN, MAX_SPEECH, PERSONAS, ROLE_NAMES, cast, createWorld, decided, expire, isPerson, land, newGame, show, turn } from './werewolf-world.js';
import { createRuntime } from '../src/core/runtime.js';
import { createRuntimePanel } from '../web/runtime-panel.js';

const TURN = 90_000; // ms a turn may take; then everyone still due is taken as doing nothing
const SVG = 'http://www.w3.org/2000/svg';
const NAME = 'ponjo-poker-name'; // the visitor's name at a friend's table, as the poker page keeps it
const MAX_PEOPLE = 8; // at the table, as at the largest game
const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the game it joins
const me = ROOM ? `f${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}` : HUMAN; // who this page plays as

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

let game = null; // the host's; a friend's page draws what the host sends (`remote`)
let remote = null; // a friend's page: the host's last state
let away = ''; // a friend's page: why the line to the host is down
let people = [HUMAN]; // the host and the friends at the table, in the order they joined
let names = {}; // the people's names, by id
let players = []; // the game's seats' ids
let world = null; // the game as a world, and Ponjo's runtime on it: new with each game
let runtime = null;
let held = false; // the narrator is behind the game: no one speaks in the dark
const running = new Set(); // players with a run going
let failed = new Map(); // players whose run failed → why, until Retry or the turn's time is up
const typing = new Set(); // players typing their speech
let notes = new Map(); // the person's guess at each seat's role
let myVote = null; // { day, target }: the person's vote, theirs to see before the vote ends
// The players' model. Once the visitor picks another, what failed is tried again.
const ai = models(() => {
  runtime?.retry();
  changed();
});

// ---- the controller ----

// Every change: draw it, tell the world, and have the runtime look again,
// for the page may have let the players act (the narrator moved on); time
// the turn. While the narrator is behind the game at dawn, the day waits
// for it: no one speaks in the dark (the world's `ready`).
function changed() {
  if (!game) return share();
  const gone = players.filter((id) => isPerson(id) && !people.includes(id));
  while (!hellos.going && game.state.phase !== 'over' && expire(game, gone)); // a friend gone: their turns are taken as doing nothing
  held = draw();
  world.changed();
  runtime.look('the page drew the game');
  if (!hellos.going) timeTurn();
}

// The narrator: at night it calls each role in turn, alive or not, as at a
// real table, and each call lasts at least its time, so how long it takes
// says nothing of who acted in it. It follows the game a call at a time.
const CALLS = ['dusk', 'wolves', 'seer', 'witch'];
const CALL_MS = [3000, 8000, 8000, 8000]; // long enough for a player's thinking (at night at most NIGHT_THINK) and the model's answer
const CALL_TEXT = {
  dusk: 'Night falls. Everyone, close your eyes.',
  wolves: 'Werewolves, open your eyes and pick a kill.',
  seer: 'Seer, open your eyes and check a player.',
  witch: 'Witch, open your eyes.',
};
const ROLE_CALL = { wolf: 'wolves', seer: 'seer', witch: 'witch' };
const KIND_CALL = { kill: 'wolves', check: 'seer', potion: 'witch' };
let call = { day: 0, at: 0, since: 0 };
// Moves the narrator on as far as it may; returns whether it is behind the game, and looks again when it may move.
function pace() {
  if (ROOM) {
    call = remote.call;
    return remote.held;
  }
  const s = game.state;
  if (s.phase === 'night' && call.day !== s.day) call = { day: s.day, at: 0, since: Date.now() };
  const to = s.phase === 'night' ? CALLS.indexOf(s.step) : call.day === s.day ? CALLS.length : call.at;
  while (call.at < to && Date.now() - call.since >= CALL_MS[call.at]) call = { day: call.day, at: call.at + 1, since: Date.now() };
  if (call.at >= to) return false;
  clearTimeout(pace.timer);
  pace.timer = setTimeout(changed, call.since + CALL_MS[call.at] - Date.now());
  return true;
}
const called = (step) => call.at >= CALLS.indexOf(step); // the narrator has called `step` tonight

let clock = { at: '', ends: 0 };
function timeTurn() {
  const at = game.state.phase === 'over' ? '' : turn(game.state);
  if (at === clock.at) return;
  clearTimeout(clock.timer);
  clock = { at, ends: at ? Date.now() + TURN : 0, timer: at && setTimeout(() => {
    if (turn(game.state) === at) expire(game);
    changed();
  }, TURN) };
}

// One run of a player: one model call, and its proposal to the writer. A
// model answers faster than a person can follow, so a player takes at least
// its own time to think, and a speech comes after it is seen typing it.
// Each player's pace, as a person's at a table: `think`, ms from and to
// before they act; `type`, ms a character as they type a speech.
const PACE = {
  Rosa: { think: [3500, 6500], type: 75 },
  Jax: { think: [1500, 3000], type: 45 },
  Wen: { think: [4500, 8000], type: 90 },
  Otis: { think: [3000, 6000], type: 60 },
  Priya: { think: [2500, 4500], type: 55 },
  Bo: { think: [3000, 5500], type: 85 },
  Nell: { think: [4000, 7500], type: 80 },
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const NIGHT_THINK = 5000; // ms a night action is thought over at most, so it fits in its call
const typeTime = (id, text) => Math.min(15_000, Math.max(1500, text.length * PACE[id].type));

// A run: one model call on what the player sees, then the player's own time
// to think (a night action less, to fit in its call). Its proposal goes to
// the world, which lands a speech once the player is seen typing it.
async function run({ agent }, { files: basis, prompt: { rules, situation } }) {
  const at = Date.now();
  const started = performance.now();
  try {
    const { calls, text, usage } = await ai.infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === 'decide')?.args ?? '{}');
    } catch {}
    const night = basis.kind === 'kill' || basis.kind === 'check' || basis.kind === 'potion';
    const [from, to] = PACE[agent.id].think.map((ms) => (night ? Math.min(ms, NIGHT_THINK) : ms));
    await wait(from + Math.random() * (to - from) - (performance.now() - started));
    return { at, ms: performance.now() - started, outcome: 'ok', usage, made: decided({ thinking: text, ...args }) };
  } catch (error) {
    return { at, ms: performance.now() - started, outcome: 'failed', body: String(error.message).split('\n')[0] };
  }
}

// With ?debug, the page shows what the runtime does (the runtime panel):
// every player's role and thinking, so only on asking. An ask is a turn of
// the game, its day, phase and step (turn, werewolf-rules.js).
const panel = !ROOM && new URLSearchParams(location.search).has('debug') && createRuntimePanel({
  where: 'this game', faceOf, retry: (id) => runtime.retry(id),
  askText: (id) => {
    const [, day, phase, step] = id.split(':');
    return `${phase === 'night' ? 'Night' : 'Day'} ${day}${step ? `, ${step}` : ''}`;
  },
}) || null; // null without ?debug: `false?.add()` would throw

// A new game is a new world, with Ponjo's runtime on it; the last game's
// runtime ends its runs, which land nothing. What the runtime says of the
// players (statuses): who is at work, and whose run failed.
async function play(here) {
  runtime?.close();
  world = createWorld(here, {
    async typing(id, text) {
      typing.add(id);
      draw();
      await wait(typeTime(id, text));
      typing.delete(id);
    },
    ready: () => !hellos.going && (here.state.phase === 'night' || !held),
  });
  const mine = world;
  runtime = await createRuntime({
    world, run,
    breaker: async () => ({ pauseAfter: Infinity, pauseWithin: 10 }), // the game has no watches to pause
    watching: { read: async () => ({}), note: () => {} },
    trace: (event) => world === mine && panel?.add(event),
    emit(type, statuses) {
      if (type !== 'agents' || world !== mine) return;
      panel?.agents(statuses);
      running.clear();
      for (const s of statuses) if (s.asks.length) running.add(s.id);
      failed = new Map(statuses.filter((s) => s.failed.length).map((s) => [s.id, s.failed.at(-1).why]));
      draw();
    },
  });
  await runtime.sync();
}

let gameNo = 0;
async function startGame(size) {
  game = newGame(size, { people, names: { ...names } });
  gameNo++;
  failed = new Map();
  held = false;
  running.clear();
  typing.clear();
  clearTimeout(clock.timer);
  clock = { at: '', ends: 0 };
  call = { day: 0, at: 0, since: 0 };
  seatUp(game.players);
  hellos = { going: true, said: [] }; // no one acts before the hellos
  await play(game);
  greet();
}

// The seats of a new game round the fire, this page's player at the bottom.
function seatUp(ids) {
  players = ids;
  $('.site-theme').hidden = true; // the game sets light and dark now
  notes = new Map();
  myVote = null;
  formAt = '';
  shown = null;
  arrowsFor = '';
  for (const node of seats) node.remove();
  const mine = Math.max(0, players.indexOf(me));
  seats = players.map((id, i) => seatNode(id, (i - mine + players.length) % players.length, i, players.length));
  $('.ww-ring').append(...seats);
}

// Before the first night, the players say hello round the fire, each in
// seat order, a line every second or so: lines written for them, so no
// model is asked. Then night falls.
const HELLO_MS = 2200;
let hellos = { going: false, said: [] };
function greet() {
  const here = game;
  const lines = game.players.flatMap((id, seat) => (isPerson(id) ? [] : [{ seat, text: PERSONAS.find((p) => p.id === id).hello }]));
  hellos = { going: true, said: [] };
  changed();
  lines.forEach((line, k) => setTimeout(() => {
    if (here !== game) return;
    hellos.said.push(line);
    changed();
  }, 600 + k * HELLO_MS));
  setTimeout(() => {
    if (here !== game) return;
    hellos.going = false;
    changed();
  }, 600 + lines.length * HELLO_MS + 1200);
}

// ---- the clearing ----

let seats = [];
let shown = null; // the view last drawn
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const label = (id) => (id === me ? 'You' : isPerson(id) ? names[id] ?? (id === HUMAN ? 'Host' : 'Friend') : id);
const cap = (text) => text[0].toUpperCase() + text.slice(1);
const roleName = (role) => cap(ROLE_NAMES[role]);
const WORD = { wolf: 'Wolf', seer: 'Seer', witch: 'Witch', villager: 'Villager', good: 'Good' }; // a role on its token; good: the seer found them no wolf
// One of the page's symbols (site/werewolf.html): a role's, the claw or the ballot.
function symbol(name) {
  const mark = document.createElementNS(SVG, 'svg');
  mark.classList.add('ww-role-mark');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#ww-${name}`);
  mark.append(use);
  return mark;
}
// A role token: a disc in the role's colour with its symbol, then its word;
// a guess has its disc dashed and empty, and a question mark.
function token(role, guess = false) {
  const node = el('span', 'ww-token');
  node.dataset.role = role;
  if (guess) node.dataset.guess = '';
  const disc = el('span', 'ww-token-disc');
  disc.append(role === 'good' ? icon('check') : symbol(role));
  node.append(disc, `${WORD[role]}${guess ? '?' : ''}`);
  return node;
}
function faceOf(id) {
  const avatar = el('span', `pj-avatar${isPerson(id) ? '' : ' pj-avatar-agent'}`);
  avatar.append(isPerson(id) ? personFace(names[id] ?? 'You', id) : agentFace(id)); // drawn from their name, the same on every page
  return avatar;
}
// A seat: the face, with its badges round it and, for this page's player, the ring that drains on their turn; the plate, a name and vote dots.
function seatNode(id, at, i, n) {
  const node = el('button', 'ww-seat');
  node.type = 'button';
  node.dataset.seat = i;
  node.style.setProperty('--a', `${90 + (360 * at) / n}deg`); // you at the bottom, the rest round in seat order
  const face = el('span', 'pj-agent-face');
  face.dataset.presence = 'idle';
  const mark = (className, at) => {
    const node = Object.assign(el('span', className), { hidden: true });
    node.dataset.at = at;
    return node;
  };
  face.append(faceOf(id), mark('ww-badge', 'status'), Object.assign(el('span', 'ww-claw'), { hidden: true }));
  if (id === me) {
    const ring = document.createElementNS(SVG, 'svg');
    ring.classList.add('ww-timer');
    ring.setAttribute('viewBox', '0 0 40 40');
    ring.innerHTML = '<circle cx="20" cy="20" r="18" pathLength="100"/>';
    face.append(ring);
  }
  const plate = el('div', 'pk-plate');
  const name = el('span', 'pk-name');
  name.append(Object.assign(el('span', 'pk-position', String(i + 1)), { title: `Seat ${i + 1}` }), label(id));
  const roles = el('span', 'ww-idents');
  roles.append(mark('ww-ident', 'fact'), mark('ww-ident', 'note'));
  plate.append(name, roles, el('span', 'ww-dots'), el('span', 'pk-tag'));
  node.append(face, plate);
  return node;
}

// What the person may do to seat `i` now, if anything: { verb, type }.
function actionOn(v, i) {
  if (!myTurn(v) || !v.seats[i].alive) return null;
  const k = v.due.kind;
  if (k === 'kill' && !v.pack.includes(i)) return { verb: 'Kill', type: 'kill' };
  if (i === v.seat) return null;
  if (k === 'check') return { verb: 'Check', type: 'check' };
  if (k === 'vote') return { verb: 'Vote out', type: 'vote' };
  if (k === 'potion' && v.due.poison) return { verb: 'Poison', type: 'poison' };
  return null;
}
// The person may act now: it is their turn, and at night the narrator has called them.
const myTurn = (v) => Boolean(v.due) && (v.phase !== 'night' || called(KIND_CALL[v.due.kind]));

// The last vote, while it shows: from its result until the next vote begins.
const lastVote = (v) => (v.phase === 'vote' ? null : v.log.findLast((e) => e.type === 'vote'));

/**
 * What the person knows of seat `i`, as marks on its face, and in words for
 * its tooltip: `fact` (its role, or the seer's check), `note` (the person's
 * guess, dashed), `status` (voted, or how it died: a ballot or the moon),
 * `claw` (the night's victim, to the pack and the witch), `dots` (its votes).
 * Each mark is [key, node, kind, words].
 */
function marks(v, i) {
  const id = players[i];
  const out = { ...identity(v, i), status: null, claw: null, dots: 0, words: [] };
  for (const e of v.log) {
    if (e.type === 'dawn' && e.deaths.includes(i)) out.status = [`died:${e.day}`, () => icon('moon'), 'dead', `Died, night ${e.day}`];
    if (e.type === 'vote' && e.out === i) out.status = [`out:${e.day}`, () => symbol('ballot'), 'dead', `Voted out, day ${e.day}`];
    if (e.type === 'save' && e.target === i && v.seats[i].alive) out.status = [`saved:${e.day}`, () => symbol('witch'), '', `You saved them, night ${e.day}`];
  }
  if (v.phase === 'vote' && v.voted.includes(i)) out.status = ['voted', () => symbol('ballot'), 'voted', 'Has voted'];
  const tonight = (type) => v.phase === 'night' && v.log.some((e) => e.type === type && e.day === v.day && e.target === i);
  if ((tonight('kill') && v.pack) || (tonight('attacked') && called('witch'))) out.claw = v.pack ? 'The pack\'s kill tonight' : 'Attacked tonight';
  const vote = lastVote(v);
  if (vote) {
    out.dots = Object.values(vote.votes).filter((t) => t === i).length;
    if (i in vote.votes) out.words.push(vote.votes[i] === null ? 'Abstained' : `Voted ${label(players[vote.votes[i]])}`);
    if (out.dots) out.words.push(`${out.dots} vote${out.dots > 1 ? 's' : ''}`);
  }
  out.words.unshift(...[out.fact, out.status, out.note].filter(Boolean).map((m) => m[3]), ...(out.claw ? [out.claw] : []));
  if (!isPerson(id)) out.words.push(PERSONAS.find((p) => p.id === id).blurb);
  return out;
}

// What the person knows of seat `i`'s role, as tokens, each [key, node, kind,
// words]: `fact` (its role, if they know it, or the seer's check), `note`
// (their own guess). On its seat, and by its name in the chat.
function identity(v, i) {
  const role = v.seats[i].role;
  const check = !role && v.log.findLast((e) => e.type === 'check' && e.target === i);
  const guess = v.phase === 'over' ? null : notes.get(i);
  return {
    fact: role ? [`role:${role}`, () => token(role), '', roleName(role)]
      : check ? [`check:${check.wolf}`, () => token(check.wolf ? 'wolf' : 'good'), '', check.wolf ? 'The seer found a werewolf' : 'The seer found them good'] : null,
    note: guess ? [`note:${guess}`, () => token(guess, true), '', `Your guess: ${roleName(guess)}`] : null,
  };
}

// A face's eyes: shut at night unless the narrator called its role and the person may know it; shut for good once dead.
function presence(v, i) {
  const id = players[i];
  if (!v.seats[i].alive) return 'away';
  if (v.phase === 'night') {
    const role = i === v.seat ? v.role : v.pack?.includes(i) ? 'wolf' : null;
    if (!role || CALLS[call.at] !== ROLE_CALL[role]) return 'away';
    return (i === v.seat && v.due) || running.has(id) ? 'working' : 'idle';
  }
  if (v.phase === 'over') return 'idle';
  return running.has(id) || v.speaker === i || (i === v.seat && v.due) ? 'working' : 'idle';
}

// A badge on a face: changed, it flips in; gone, it goes.
function badge(node, mark) {
  const key = mark?.[0] ?? '';
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.hidden = !mark;
  if (!mark) return;
  node.replaceChildren(...[mark[1]()].flat());
  if (mark[2]) node.dataset.kind = mark[2];
  else delete node.dataset.kind;
  if (!still) node.animate([{ transform: 'rotateY(90deg) scale(0.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(0.3, 1.5, 0.5, 1)' });
}

function drawRing(v) {
  for (const [i, node] of seats.entries()) {
    const id = players[i];
    const m = marks(v, i);
    node.toggleAttribute('data-dead', !v.seats[i].alive);
    node.toggleAttribute('data-turn', v.speaker === i);
    node.toggleAttribute('data-pickable', Boolean(actionOn(v, i)));
    node.title = [label(id), ...m.words].join(' · ');
    $('.pj-agent-face', node).dataset.presence = presence(v, i);
    for (const at of ['fact', 'note', 'status']) badge($(`[data-at="${at}"]`, node), m[at]);
    $('.ww-claw', node).hidden = !m.claw;
    if (!$('.ww-claw', node).firstChild) $('.ww-claw', node).append(symbol('claw'));
    // votes as dots, each popping in after its arrow lands
    const dots = $('.ww-dots', node);
    if (dots.childElementCount !== m.dots) dots.replaceChildren(...Array.from({ length: m.dots }, (_, k) => Object.assign(el('i'), { style: `animation-delay: ${votesIn + k * 120}ms` })));
    // only a model that can't be reached is said in words
    const failing = (v.phase !== 'night' || v.pack?.includes(i) || i === v.seat) && failed.has(id);
    $('.pk-tag', node).textContent = failing ? 'Can\'t reach the model' : '';
    $('.pk-tag', node).dataset.kind = 'failed';
  }
  drawTimer(v);
}

// Your turn: a ring round your face that drains as your time runs out.
function drawTimer(v) {
  if (v.seat < 0) return; // watching
  const ring = $('.ww-timer', seats[v.seat]);
  const on = myTurn(v) && clock.ends > 0;
  ring.classList.toggle('ww-timer-on', on);
  if (!on || ring.dataset.at === clock.at) return;
  ring.dataset.at = clock.at;
  const circle = ring.firstChild;
  circle.style.animation = 'none';
  void circle.getBoundingClientRect();
  circle.style.animation = `ww-drain ${TURN}ms linear ${clock.ends - TURN - Date.now()}ms forwards`;
}

// Arrows from face to face: who voted for whom, from the vote's result until
// the next vote, drawn in one by one when the result comes; during a vote,
// only the person's own; at night, to a wolf, the pack's picks.
let votesIn = 0; // ms until the last arrow of a new result lands, for the dots
let arrowsFor = ''; // the result whose arrows were drawn in
function drawVotes(v) {
  const vote = lastVote(v);
  const pairs = vote ? Object.entries(vote.votes).filter(([, t]) => t !== null).map(([s, t]) => [Number(s), t, '']) : [];
  if (v.phase === 'vote' && myVote?.day === v.day && myVote.target !== null) pairs.push([v.seat, myVote.target, 'mine']);
  if (v.phase === 'night' && v.pack && call.at === CALLS.indexOf('wolves')) {
    const picks = new Map(v.log.filter((e) => e.type === 'pick' && e.day === v.day).map((e) => [e.seat, e.target]));
    for (const [s, t] of picks) pairs.push([s, t, 'pack']);
  }
  const fresh = vote && arrowsFor !== `${vote.day}` && v.phase !== 'gather';
  if (vote) arrowsFor = `${vote.day}`;
  const ms = arrows($('.ww-votes'), pairs, (i) => $('.pj-avatar', seats[i]), fresh && !still);
  if (ms !== null) votesIn = ms;
}
addEventListener('resize', () => draw());

// Over the clearing: the sun or the moon and the day, and one line that
// changes with the moment: the narrator's call, the vote, last words.
function drawCenter(v) {
  const night = v.phase === 'night';
  $('.ww-board').dataset.time = night ? 'night' : 'day';
  document.documentElement.dataset.theme = night ? 'dark' : 'light'; // the game's clock is the page's theme
  const time = $('.ww-time');
  if (time.dataset.icon !== (night ? 'moon' : 'sun')) time.replaceChildren(icon(night ? 'moon' : 'sun'));
  time.dataset.icon = night ? 'moon' : 'sun';
  $('.ww-phase-text').textContent = v.phase === 'gather' ? 'Round the fire' : v.phase === 'over' ? (v.winner === 'village' ? 'The village wins' : 'The werewolves win') : `${night ? 'Night' : 'Day'} ${v.day}`;
  const call_ = CALLS[Math.min(call.at, CALLS.length - 1)];
  const [key, mark, words] = away ? ['away', null, away]
    : v.phase === 'gather' ? ['gather', null, 'Everyone says hello']
    : v.phase === 'over' ? ['over', null, v.seat < 0 ? '' : (v.role === 'wolf') === (v.winner === 'wolves') ? 'You won' : 'You lost']
      : night ? [`call:${call_}`, call_ === 'dusk' ? null : symbol(call_ === 'wolves' ? 'wolf' : call_), CALL_TEXT[call_]]
        : v.phase === 'vote' ? ['vote', symbol('ballot'), 'Vote']
          : v.phase === 'last' ? ['last', null, 'Last words'] : ['day', null, ''];
  const sub = $('.ww-sub');
  if (sub.dataset.key !== key) {
    sub.dataset.key = key;
    sub.replaceChildren(...[mark, words].filter(Boolean));
    if (!still && words) sub.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'ease-out' });
  }
  $('.ww-over').hidden = v.phase !== 'over';
}

// ---- you: what you may do now ----

let formAt = ''; // the turn the form was set up for
const form = $('.ww-act');
function drawMe(v) {
  $('.ww-hint').hidden = notes.size > 0 || v.phase === 'over';
  form.hidden = !myTurn(v);
  if (form.hidden) return;
  if (formAt !== v.due.at) {
    formAt = v.due.at;
    $('.ww-error').hidden = true;
  }
  const kind = v.due.kind;
  const attacked = v.log.findLast((e) => e.type === 'attacked' && e.day === v.day);
  const victim = attacked && (attacked.target === v.seat ? 'You were' : `${label(players[attacked.target])} was`);
  $('.ww-ask').textContent = {
    kill: () => (v.due.round === 2 ? 'The pack disagreed: pick again.' : 'Pick tonight\'s kill.'),
    check: () => 'Pick a player to check.',
    potion: () => (attacked ? `${victim} attacked tonight.` : 'Use a potion?'),
    speak: () => 'Your turn to speak: say it in the chat.',
    last: () => 'Your last words: say them in the chat.',
    vote: () => 'Pick a player to vote out.',
  }[kind]();
  $('[data-do="abstain"]', form).hidden = kind !== 'vote';
  $('[data-do="save"]', form).hidden = kind !== 'potion' || !v.due.save;
  if (attacked) $('[data-do="save"]', form).textContent = `Save ${label(players[attacked.target])}`;
  $('[data-do="pass"]', form).hidden = kind !== 'potion';
}

// The chat box: what you say, and over it, who will hear you, or that you
// are muted and why. On your turn to speak, everyone; with your kill, only
// the pack, the line going with your pick; else no one.
const chat = $('.ww-chat-box');
const box = chat.elements.text;
let chatAt = ''; // the turn the box was set up for
function drawChat(v) {
  const kind = myTurn(v) ? v.due.kind : null;
  const audience = kind === 'speak' || kind === 'last' ? 'all' : kind === 'kill' ? 'pack' : 'muted';
  if (chatAt !== (v.due?.at ?? '')) {
    chatAt = v.due?.at ?? '';
    box.value = '';
  }
  chat.dataset.audience = audience;
  box.disabled = audience === 'muted';
  box.maxLength = MAX_SPEECH;
  box.placeholder = { all: kind === 'last' ? 'Your last words…' : 'Speak to the village…', pack: 'A line to the pack, sent with your pick', muted: '' }[audience];
  $('[type=submit]', chat).disabled = audience !== 'all' || !box.value.trim();
  const speaker = v.speaker === null ? null : label(players[v.speaker]);
  const why = audience === 'all' ? [icon('users'), 'Everyone hears you.']
    : audience === 'pack' ? [token('wolf'), 'Only the pack hears you.']
      : [symbol('muted'), v.seat < 0 && v.phase !== 'over' ? 'You are watching: you play from the next game.'
        : !v.alive && !['over', 'last'].includes(v.phase) ? 'You are out: the dead don\'t speak.'
        : v.phase === 'over' ? 'The game is over.'
          : v.phase === 'gather' ? 'Muted while everyone says hello.'
            : v.phase === 'night' ? 'Muted: it is night, and everyone\'s eyes are shut.'
              : v.phase === 'vote' ? 'Muted while everyone votes.'
                : speaker ? `Muted: ${speaker} ${speaker === 'You' ? 'have' : 'has'} the floor. You speak in turn.` : 'Muted.'];
  const line = $('.ww-audience');
  if (line.dataset.key !== `${audience}:${why.at(-1)}`) {
    line.dataset.key = `${audience}:${why.at(-1)}`;
    line.dataset.audience = audience;
    line.replaceChildren(...why);
  }
}
chat.addEventListener('submit', (event) => {
  event.preventDefault();
  if (chat.dataset.audience === 'all') perform('speak');
});
box.addEventListener('input', () => shown && drawChat(shown));
box.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chat.requestSubmit();
  }
});

// What the person does, through the writer, as an AI player's proposal:
// what they said goes with it. On a friend's page, it goes to the host,
// which lands it, and says if it was turned away.
function perform(type, target) {
  const v = ROOM ? remote.view : show(game);
  if (!v.due) return;
  const action = { type, ...(target !== undefined ? { target } : {}) };
  let rejected = null;
  if (ROOM) guest.send({ type: 'act', action: { ...action, at: v.due.at }, say: box.value });
  else ({ rejected } = land(game, HUMAN, { at: v.due.at }, { action, say: box.value }));
  refused(rejected);
  if (!rejected) {
    form.hidden = true; // drawn again once the narrator has moved on
    if (type === 'vote' || type === 'abstain') myVote = { day: v.day, target: target ?? null };
  }
  if (ROOM) draw();
  else changed();
}
function refused(why) {
  const error = $('.ww-error');
  error.textContent = why ?? '';
  error.hidden = !why;
}
form.addEventListener('submit', (event) => event.preventDefault());
form.addEventListener('click', (event) => {
  const type = event.target.closest('[data-do]')?.dataset.do;
  if (type) perform(type);
});

// ---- a player's menu: what you may do to them, and your guess at what they are ----

const menu = el('ul', 'pj-block-menu pk-menu ww-menu');
menu.setAttribute('role', 'menu');
menu.hidden = true;
document.body.append(menu);
function item(content, run, selected = false) {
  const li = el('li');
  li.setAttribute('role', 'menuitem');
  li.append(...[content].flat());
  if (selected) li.setAttribute('aria-selected', 'true');
  li.addEventListener('click', () => {
    menu.hidden = true;
    run();
  });
  return li;
}
function openMenu(node) {
  const i = Number(node.dataset.seat);
  const v = shown;
  const id = players[i];
  const act = actionOn(v, i);
  const guess = (role) => item(token(role, true), () => {
    notes.set(i, role);
    draw();
  }, notes.get(i) === role);
  const head = el('li', 'pk-menu-head');
  const who = el('span', 'pk-menu-text');
  who.append(el('b', '', label(id)));
  if (!isPerson(id)) who.append(el('span', '', PERSONAS.find((p) => p.id === id).blurb));
  head.append(faceOf(id), who);
  const items = [head];
  if (act) {
    const doIt = item(`${act.verb} ${label(id)}`, () => perform(act.type, i));
    doIt.dataset.do = '';
    items.push(doIt);
  }
  if (i !== v.seat && v.phase !== 'over') {
    items.push(...['wolf', 'seer', 'witch', 'villager'].map(guess));
    if (notes.has(i)) items.push(item('Clear the note', () => {
      notes.delete(i);
      draw();
    }));
  }
  if (items.length === 1) return;
  menu.replaceChildren(...items);
  menu.hidden = false;
  const at = node.querySelector('.pk-plate').getBoundingClientRect();
  const left = Math.min(Math.max(8, at.left + at.width / 2 - menu.offsetWidth / 2), innerWidth - menu.offsetWidth - 8);
  const top = at.bottom + 4 + menu.offsetHeight < innerHeight ? at.bottom + 4 : Math.max(8, at.top - menu.offsetHeight - 4);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
}
$('.ww-ring').addEventListener('click', (event) => {
  const node = event.target.closest('.ww-seat');
  if (node && shown) openMenu(node);
});
document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !event.target.closest('.ww-menu, .ww-seat')) menu.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') menu.hidden = true;
});

// ---- the log: what the person's seat saw, as a chat app shows it ----

const SECRET = { pick: 'wolf', kill: 'wolf', check: 'seer', attacked: 'witch', save: 'witch', poison: 'witch' };
function drawFeed(v) {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const name = (i) => (i === v.seat ? 'you' : label(players[i]));
  const Name = (i) => cap(name(i));
  const names = (list) => list.map(Name).join(' and ');
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const known = (i) => Object.values(identity(v, i)).filter(Boolean).map((m) => m[1]());
  const say = (i, text, note, pack = false) => {
    const id = players[i];
    const row = message({ face: id !== me && faceOf(id), name: [label(id), ...known(i)], text, note: pack ? el('span', 'ww-only', 'only the pack') : note, mine: id === me, more: last === i && !pack });
    if (pack) row.dataset.audience = 'pack';
    rows.push(row);
    last = pack ? null : i;
  };
  // a line only some saw: its role's token, and who saw it while the game is on
  const line = (text, secret, ...more) => {
    const row = notice(text);
    row.append(...more);
    if (secret) {
      row.dataset.secret = '';
      row.prepend(token(secret), ' ');
      if (v.phase !== 'over') row.append(el('span', 'ww-only', secret === 'wolf' ? 'only the pack' : 'only you'));
    }
    rows.push(row);
    last = null;
  };
  for (const h of hellos.said) say(h.seat, h.text, '');
  for (const e of v.log) {
    const secret = SECRET[e.type];
    if (e.type === 'night') line(`Night ${e.day} falls. Everyone closes their eyes.`);
    else if (e.type === 'pick') {
      line(`${Name(e.seat)} ${e.seat === v.seat ? 'want' : 'wants'} to kill ${name(e.target)}${e.round === 2 ? ' (second pick)' : ''}.`, secret);
      if (e.text) say(e.seat, e.text, '', true);
    } else if (e.type === 'kill') line(e.target === null ? 'The pack kills no one.' : `The pack kills ${name(e.target)}.`, secret);
    else if (e.type === 'check') line(`${Name(e.seat)} checked ${name(e.target)}: `, secret, token(e.wolf ? 'wolf' : 'good'));
    else if (e.type === 'attacked') line(`The wolves attacked ${name(e.target)}.`, secret);
    else if (e.type === 'save') line(`${Name(e.seat)} saved ${name(e.target)}.`, secret);
    else if (e.type === 'poison') line(`${Name(e.seat)} poisoned ${name(e.target)}.`, secret);
    else if (e.type === 'dawn') line(`Day ${e.day}. ${e.deaths.length ? `${names(e.deaths)} died in the night.` : 'No one died in the night.'}`);
    else if (e.type === 'speech' || e.type === 'last') {
      if (e.silent) line(`${Name(e.seat)} said nothing${e.type === 'last' ? ' as last words' : ''}.`);
      else say(e.seat, e.text, e.type === 'last' ? 'last words' : '');
    } else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, t]) => `${Name(Number(s))} → ${t === null ? 'abstained' : name(t)}`);
      line(`The vote: ${votes.join(', ')}. ${e.out === null ? 'A tie: no one is out.' : `${Name(e.out)} ${e.out === v.seat ? 'are' : 'is'} out.`}`);
    } else if (e.type === 'over') line(e.winner === 'village' ? 'Every werewolf is dead: the village wins.' : 'The werewolves are as many as the rest: they win.');
  }
  for (const id of typing) rows.push(typingMessage(faceOf(id), id));
  for (const [id, why] of failed) {
    const named = v.phase !== 'night' || v.pack?.includes(players.indexOf(id)); // at night, who failed would say who has a role
    const row = notice(`${named ? id : 'A player'} could not reach the model: ${why}`);
    row.dataset.failed = '';
    if (ROOM) row.append(' Waiting for the host to retry.');
    else {
      const again = el('button', 'pj-link-button', 'Retry');
      again.type = 'button';
      again.addEventListener('click', () => runtime.retry(id));
      row.append(' ', again);
    }
    rows.push(row);
  }
  feed.replaceChildren(...rows);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// Draws this page's player's view: while the players say hello, round the
// fire before night falls; while the narrator has not yet called dawn, the
// night as it was. Returns whether the narrator is behind the game. On the
// host's page, friends get theirs.
function draw() {
  const behind = paint();
  if (!ROOM) share(behind);
  return behind;
}
function paint() {
  const look = () => (ROOM ? remote.view : show(game));
  if (ROOM ? !remote?.view : !game) {
    if (ROOM) $('.ww-phase-text').textContent = away || 'Waiting for the host to start a game';
    return false;
  }
  if (hellos.going) {
    const v = { ...look(), phase: 'gather', due: null, log: [] };
    for (const part of [drawVotes, drawRing, drawCenter, drawMe, drawChat, drawFeed]) part(v);
    return true;
  }
  const held = pace();
  const v = held && look().phase !== 'night' && shown ? { ...shown, due: null } : look();
  shown = v;
  drawVotes(v);
  drawRing(v);
  drawCenter(v);
  drawMe(v);
  drawChat(v);
  drawFeed(v);
  return held;
}

// ---- their thinking, after the game ----

function showThinking() {
  const dialog = $('.pk-thinking');
  $('h2', dialog).textContent = 'Their thinking';
  const { seats: all } = shown; // the game is over: every role shows
  const thinking = ROOM ? remote.notes : game.notes;
  $('.pk-thinking-body', dialog).replaceChildren(...players.filter((id) => !isPerson(id)).map((id) => {
    const seat = players.indexOf(id);
    const part = el('details', 'pj-trace-part');
    part.open = true;
    const summary = el('summary');
    const meta = el('span', 'pj-trace-meta');
    meta.append(token(all[seat].role), all[seat].alive ? ' alive' : ' dead');
    summary.append(icon('chevron'), faceOf(id), el('span', 'pj-trace-title', id), meta);
    part.append(summary);
    const thoughts = thinking[id]?.thoughts ?? [];
    if (!thoughts.length) part.append(el('p', 'pj-empty', 'No decisions.'));
    for (const t of thoughts) {
      const target = Number.isInteger(t.action?.target) ? ` ${label(players[t.action.target])}` : '';
      part.append(el('h3', 'pj-setting-group', `${t.phase === 'night' ? 'Night' : 'Day'} ${t.day}${t.action ? ` · ${t.action.type}${target}` : ''}`));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', t.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- a new game: how many players, who is at the table, and the roles that makes ----

const starting = $('.ww-start');
let size = 7;
function openStart() {
  for (const b of starting.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === size));
  const roles = cast(size);
  $('.ww-cast', starting).replaceChildren(...[...new Set(roles)].map((role) => {
    const item = el('li', '', `${roles.filter((r) => r === role).length} × `);
    item.append(token(role));
    return item;
  }));
  const seated = Math.min(people.length, size);
  const list = people.map(label);
  const watch = people.length > size ? ` The last ${people.length - size === 1 ? 'one watches' : `${people.length - size} watch`}.` : '';
  $('.ww-people').textContent = people.length === 1 ? '' : `At the table: ${list.slice(0, -1).join(', ')} and ${list.at(-1)}.${watch} AI players take the ${size - seated === 1 ? 'other seat' : `other ${size - seated} seats`}.`;
  starting.hidden = false;
  document.body.classList.add('pk-buying-in');
}
starting.addEventListener('click', (event) => {
  const b = event.target.closest('[data-size]');
  if (!b) return;
  size = Number(b.dataset.size);
  openStart();
});
starting.addEventListener('submit', (event) => {
  event.preventDefault();
  starting.hidden = true;
  document.body.classList.remove('pk-buying-in');
  startGame(size);
});

// ---- friends: the host's page invites them; a friend's page joins ----

const peers = new Map(); // a friend's page in the room → its player's id
let room = null; // the room, once the host invites friends
const inviting = $('.pk-invite');
async function invite() {
  inviting.hidden = false;
  document.body.classList.add('pk-setting-up');
  inviting.elements.name.value = names[HUMAN] ?? load(NAME) ?? '';
  room ??= await host({ joined, heard: (peer, message) => peers.has(peer) && apply(peer, message), left });
  inviting.elements.link.value = room.link;
}
function closeInvite() {
  const name = inviting.elements.name.value.trim().slice(0, 20);
  if (name) {
    names[HUMAN] = name;
    store(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-setting-up');
  if (!starting.hidden) openStart();
  changed();
}
function joined(peer, hello) {
  if (!/^f[0-9a-f]{8}$/.test(String(hello?.id))) return room.turnAway(peer, 'Not a player');
  peers.set(peer, hello.id);
  changed();
}
function left(peer) {
  const id = peers.get(peer);
  peers.delete(peer);
  people = people.filter((p) => p !== id);
  if (!starting.hidden) openStart();
  changed();
}
// What a friend's page sends: to sit at the table, or what its player does.
function apply(peer, message) {
  const id = peers.get(peer);
  if (message.type === 'sit') {
    if (people.includes(id)) return;
    if (people.length >= MAX_PEOPLE) return room.turnAway(peer, 'The table is full.');
    people.push(id);
    names[id] = String(message.name ?? '').trim().slice(0, 20) || 'Friend';
    if (!starting.hidden) openStart();
  } else if (message.type === 'act' && message.action && typeof message.action === 'object') {
    const { type, target, at } = message.action;
    if (!game?.players.includes(id)) return;
    const { rejected } = land(game, id, { at }, { action: { type: String(type), ...(Number.isInteger(target) ? { target } : {}) }, say: String(message.say ?? '') });
    if (rejected) room.send(peer, { type: 'rejected', why: rejected });
  } else return;
  changed();
}

// Each friend's page gets the game as its player may see it: its own
// seat's view (what everyone sees, if it is watching), the narrator's call,
// and the AI players' thinking once the game is over.
function share(behind = held) {
  if (!room) return;
  const over = game?.state.phase === 'over';
  for (const [peer, id] of peers) {
    room.send(peer, { type: 'state', gameNo, players, names, view: game && show(game, id), hellos, call, held: behind, notes: over ? game.notes : {}, running: [...running], typing: [...typing], failed: [...failed], clock: clock.ends ? clock.ends - Date.now() : 0, clockAt: clock.at });
  }
}

// A friend's page: the game as the host sends it.
const guest = ROOM && join(ROOM, { id: me }, {
  heard(message) {
    away = '';
    if (message.type === 'rejected') {
      refused(message.why);
      return draw();
    }
    if (message.type !== 'state') return;
    const fresh = message.gameNo !== remote?.gameNo;
    remote = message;
    names = message.names;
    if (fresh && message.view) seatUp(message.players);
    hellos = message.hellos;
    for (const [set, ids] of [[running, message.running], [typing, message.typing]]) set.clear() || ids.forEach((id) => set.add(id));
    failed = new Map(message.failed);
    clock = { at: message.clockAt, ends: message.clock && Date.now() + message.clock };
    draw();
  },
  away(reason) {
    away = reason === 'host' ? 'The host is away. Waiting for them…' : reason === 'line' ? 'Reconnecting…' : reason;
    draw();
  },
});
const joining = $('.ww-join');
joining.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = joining.elements.name.value.trim().slice(0, 20) || 'Friend';
  store(name, NAME);
  guest.send({ type: 'sit', name });
  joining.hidden = true;
  document.body.classList.remove('pk-buying-in');
});

// ---- wiring ----

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'new') openStart();
  else if (action === 'thinking') showThinking();
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') ai.open();
  else if (action === 'invite') invite();
  else if (action === 'invite-done') closeInvite();
  else if (action === 'copy') {
    inviting.elements.link.select();
    navigator.clipboard?.writeText(inviting.elements.link.value).catch(() => {});
  } else if (action === 'watch') {
    joining.hidden = true;
    document.body.classList.remove('pk-buying-in');
  }
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});

if (ROOM) {
  for (const node of document.querySelectorAll('[data-action="new"], [data-action="key"]')) node.hidden = true;
  $('.pk-model').textContent = 'You joined a friend\'s game: the AI players run on their page.';
  joining.elements.name.value = load(NAME) ?? '';
  joining.hidden = false;
  document.body.classList.add('pk-buying-in');
  draw();
} else {
  ai.draw();
  openStart();
}
