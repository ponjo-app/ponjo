// The werewolf page (site/werewolf.html): a person, any friends they invite
// and AI players round a fire at one game of werewolf. The rules
// (werewolf-rules.js) own what must be exact; the table is a world
// (werewolf-world.js) on the runtime's core (src/core/): a store in this
// page, kept in the browser's storage on each change (game-kit.js), so a
// refresh goes on with the game. Each member has a controller: an AI
// player's program is one call of the visitor's model (game-page.js, with
// the log's messages and the vote arrows); the person's is this screen,
// which draws their seat's view and lands what they do; the clock's waits
// for each deadline and the narrator's next call. The game is drawn from
// the person's own view alone, with what they know of each player on their
// seat and their own guesses. Friends join by a link (poker-share.js), as
// on the spy page: the host's page holds the store and runs the AI
// players, and sends each friend's page its seat's view; a friend's page,
// opened at `#join=<room>`, only draws and sends what its player does. A
// friend who joins mid-game watches, seeing what everyone sees, and plays
// from the next game; one who leaves mid-game, and is not back within
// RECONNECT_MS (a reload), has each of their turns taken as doing nothing.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, location, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, arrows, el, message, models, notice, typingMessage } from './game-page.js';
import { MAX_LINE, agent, friends, keep, load, openTable } from './game-kit.js';
import { clock, control } from '../src/core/controller.js';
import { createRuntimePanel } from '../web/runtime-panel.js';
import { guestId, join } from './poker-share.js';
import { deal } from './werewolf-rules.js';
import { CALL_MS, CLOCK, DECIDE, HUMAN, MAX_SPEECH, PERSONAS, ROLE_NAMES, TURN, cast, decided, isPerson, newTable, prompt, world } from './werewolf-world.js';

const SVG = 'http://www.w3.org/2000/svg';
const NAME = 'ponjo-poker-name'; // the visitor's name at a friend's table, as the poker page keeps it
const TABLE = 'ponjo-werewolf-table'; // the table the host's page holds: { rev, state }, as its store last saved it
const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the game it joins
const me = ROOM ? guestId(ROOM) : HUMAN; // who this page plays as

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

let shown = null; // the host's page: its seat's view, as its controller last read it
let remote = null; // a friend's page: what the host last sent, { view, presence }
let away = ''; // a friend's page: why the line to the host is down
let notes = new Map(); // the person's guess at each seat's role
let myVote = null; // { day, target }: the person's vote, theirs to see before the vote ends
const ai = models(() => draw()); // the players' model

// ---- the store and its members, on the host's page ----

// The store, kept in this browser on each change. Its members' presence
// (who is at work or typing, whose run failed) is drawn here and sent to friends.
const table = ROOM ? null : openTable(world, TABLE, newTable, () => {
  draw();
  guests.shown();
});
const client = (id) => table.client(id);

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
const NIGHT_THINK = 5000; // ms a night action is thought over at most, so it fits in its call
const typeTime = (id, text) => Math.min(15_000, Math.max(1500, text.length * PACE[id].type));

// With ?debug, the host's page shows each AI player's runs (the runtime
// panel): every player's role and thinking, so only on asking. A task is a
// turn of the game, its day, phase and step, or a line in the chat after it.
const panel = !ROOM && new URLSearchParams(location.search).has('debug') ? createRuntimePanel({
  where: 'this game', faceOf: (id) => faceOf(picture().t, id),
  askText: (given) => {
    const [kind, , day, phase, step] = given.split(':');
    return kind === 'line' ? 'A line in the chat' : `${phase === 'night' ? 'Night' : 'Day'} ${day}${step ? `, ${step}` : ''}`;
  },
}) : null;

// AI player `id`'s program: a run is one call of the model on what its
// seat sees, then the player's own time to think (a night action less, to
// fit in its call), then, for a speech or a line, its time to type it, told as presence.
const think = (id) => agent({
  client: client(id), id, infer: ai.infer, tool: DECIDE, prompt, panel,
  decide: (args, view) => decided(args, view.actions),
  pace(tasks, view) {
    const [from, to] = PACE[id].think.map((ms) => (view.content.game?.phase === 'night' ? Math.min(ms, NIGHT_THINK) : ms));
    return from + Math.random() * (to - from);
  },
  typing: (body) => (['speak', 'chat'].includes(body.type) && body.text?.trim() ? typeTime(id, body.text) : 0),
});

// A new game: the AI players fill the seats the people leave, each with its
// hello, which the clock says for it round the fire; then night falls.
function startGame(size) {
  myVote = null;
  table.commit(HUMAN, { body: { type: 'start', size, roles: deal(size) } });
}

// ---- what this page draws: its seat's view of the table ----

const EMPTY = { content: { people: [], names: {}, players: [], no: 0, greeting: false, hellos: [], game: null, call: null, lines: [], thoughts: {}, moment: '' }, actions: [], tasks: [] };
// The view this page draws (`t` its content, `v` the game as its seat sees it: round the fire while everyone says hello).
function picture() {
  const view = (ROOM ? remote?.view : shown) ?? EMPTY;
  const t = view.content;
  return { t, v: t.game && (t.greeting ? { ...t.game, phase: 'gather', due: null, log: [] } : t.game), view };
}
const presence = () => (ROOM ? remote?.presence : shown && client(HUMAN).present()) ?? {};

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const label = (t, id) => (id === me ? 'You' : isPerson(id) ? t.names[id] ?? (id === HUMAN ? 'Host' : 'Friend') : id);
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
function faceOf(t, id) {
  const avatar = el('span', `pj-avatar${isPerson(id) ? '' : ' pj-avatar-agent'}`);
  avatar.append(isPerson(id) ? personFace(t.names[id] ?? 'You', id) : agentFace(id)); // drawn from their name, the same on every page
  return avatar;
}

// ---- the clearing: a seat for each player round the fire, this page's at the bottom ----

let seats = [];
let seatsFor = '';
// A seat: the face, with its badges round it and, for this page's player, the ring that drains on their turn; the plate, a name and vote dots.
function seatNode(t, id, at, i, n) {
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
  face.append(faceOf(t, id), mark('ww-badge', 'status'), Object.assign(el('span', 'ww-claw'), { hidden: true }));
  if (id === me) {
    const ring = document.createElementNS(SVG, 'svg');
    ring.classList.add('ww-timer');
    ring.setAttribute('viewBox', '0 0 40 40');
    ring.innerHTML = '<circle cx="20" cy="20" r="18" pathLength="100"/>';
    face.append(ring);
  }
  const plate = el('div', 'pk-plate');
  const name = el('span', 'pk-name');
  name.append(Object.assign(el('span', 'pk-position', String(i + 1)), { title: `Seat ${i + 1}` }), label(t, id));
  const roles = el('span', 'ww-idents');
  roles.append(mark('ww-ident', 'fact'), mark('ww-ident', 'note'));
  plate.append(name, roles, el('span', 'ww-dots'), el('span', 'pk-tag'));
  node.append(face, plate);
  return node;
}
// The seats of a new game round the fire: the person's notes and vote start again.
function layout(t) {
  const key = `${t.no}:${t.players.join()}`;
  if (key === seatsFor) return;
  seatsFor = key;
  $('.site-theme').hidden = Boolean(t.game); // the game sets light and dark now
  notes = new Map();
  myVote = null;
  formAt = '';
  arrowsFor = '';
  for (const node of seats) node.remove();
  const mine = Math.max(0, t.players.indexOf(me));
  seats = t.players.map((id, i) => seatNode(t, id, (i - mine + t.players.length) % t.players.length, i, t.players.length));
  $('.ww-ring').append(...seats);
}

// What the person may do to seat `i` now, if anything: { verb, type }.
function actionOn(v, i) {
  if (!v.due || !v.seats[i].alive) return null;
  const k = v.due.kind;
  if (k === 'kill' && !v.pack.includes(i)) return { verb: 'Kill', type: 'kill' };
  if (i === v.seat) return null;
  if (k === 'check') return { verb: 'Check', type: 'check' };
  if (k === 'vote') return { verb: 'Vote out', type: 'vote' };
  if (k === 'potion' && v.due.poison) return { verb: 'Poison', type: 'poison' };
  return null;
}

// The last vote, while it shows: from its result until the next vote begins.
const lastVote = (v) => (v.phase === 'vote' ? null : v.log.findLast((e) => e.type === 'vote'));

/**
 * What the person knows of seat `i`, as marks on its face, and in words for
 * its tooltip: `fact` (its role, or the seer's check), `note` (the person's
 * guess, dashed), `status` (voted, or how it died, as `deathOf` says),
 * `claw` (the night's victim, to the pack and the witch), `dots` (its votes).
 * Each mark is [key, node, kind, words].
 */
function marks(t, v, i) {
  const id = t.players[i];
  const out = { ...identity(v, i), status: null, claw: null, dots: 0, words: [] };
  for (const e of v.log) {
    if (e.type === 'save' && e.target === i && v.seats[i].alive) out.status = [`saved:${e.day}`, () => symbol('witch'), '', `You saved them, night ${e.day}`];
  }
  const death = deathOf(v, i);
  if (death) out.status = [`${death.how}:${death.day}`, () => deathMark(death.how), death.how, deathText(death)];
  if (v.phase === 'vote' && v.voted.includes(i)) out.status = ['voted', () => symbol('ballot'), 'voted', 'Has voted'];
  const tonight = (type) => v.phase === 'night' && v.log.some((e) => e.type === type && e.day === v.day && e.target === i);
  if ((tonight('kill') && v.pack) || tonight('attacked')) out.claw = v.pack ? 'The pack\'s kill tonight' : 'Attacked tonight';
  const vote = lastVote(v);
  if (vote) {
    out.dots = Object.values(vote.votes).filter((x) => x === i).length;
    if (i in vote.votes) out.words.push(vote.votes[i] === null ? 'Abstained' : `Voted ${label(t, t.players[vote.votes[i]])}`);
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

/**
 * How seat `i` died, as far as this view may know: `how` is vote (voted
 * out, with its `votes`), wolves (the pack's kill), poison (the witch's),
 * both, or night (died in the night, how not known). Everyone sees who
 * died at dawn; how stays with the pack (its kill) and the witch (her
 * poison) until the game is over, when everyone sees it. Null while alive.
 */
function deathOf(v, i) {
  if (v.seats[i].alive) return null;
  const vote = v.log.find((e) => e.type === 'vote' && e.out === i);
  if (vote) return { how: 'vote', day: vote.day, votes: Object.values(vote.votes).filter((x) => x === i).length };
  const dawn = v.log.find((e) => e.type === 'dawn' && e.deaths.includes(i));
  if (!dawn) return null;
  const by = (type) => v.log.some((e) => e.type === type && e.day === dawn.day && e.target === i);
  const [wolves, poison] = [by('kill'), by('poison')];
  return { how: wolves && poison ? 'both' : wolves ? 'wolves' : poison ? 'poison' : 'night', day: dawn.day };
}
// A death's mark: the claw, the poison, both, the ballot, or the moon for a death not yet told.
const deathMark = (how) => (how === 'vote' ? symbol('ballot') : how === 'night' ? icon('moon') : how === 'both' ? [symbol('claw'), symbol('poison')] : symbol(how === 'wolves' ? 'claw' : 'poison'));
const HOW = { wolves: 'killed by the wolves', poison: 'poisoned by the witch', both: 'attacked by the wolves and poisoned by the witch' };
function deathText({ how, day, votes }) {
  if (how === 'vote') return `Voted out on day ${day}, by ${votes} vote${votes === 1 ? '' : 's'}`;
  return how === 'night' ? `Died in night ${day}: how stays secret until the game ends` : `${cap(HOW[how])}, night ${day}`;
}

// A player dies: a start, then the fall, and over the face, how: the claw
// slashing, the poison dripping, the ballot dropping, or the moon rising.
function die(node, how) {
  if (still) return;
  const face = $('.pj-agent-face', node);
  face.animate([
    { transform: 'none' },
    { transform: 'translateY(-10px) scale(1.12)', offset: 0.18 },
    { transform: 'translateX(-4px) rotate(5deg)', offset: 0.32 },
    { transform: 'translateX(4px) rotate(-5deg)', offset: 0.44 },
    { transform: 'none', offset: 0.56 },
  ], { duration: 1600, easing: 'ease-out' });
  const strike = el('span', 'ww-death');
  strike.dataset.how = how;
  strike.append(...[deathMark(how)].flat());
  face.append(strike);
  strike.addEventListener('animationend', (event) => event.target === strike && strike.remove());
}

// A face's eyes: shut at night unless the narrator called its role and the person may know it; shut for good once dead.
const ROLE_CALL = { wolf: 'wolves', seer: 'seer', witch: 'witch' };
function eyes(t, v, i) {
  const p = presence()[t.players[i]];
  if (!v.seats[i].alive) return 'dead';
  if (v.phase === 'night') {
    const role = i === v.seat ? v.role : v.pack?.includes(i) ? 'wolf' : null;
    if (!role || t.call?.step !== ROLE_CALL[role]) return 'away';
    return (i === v.seat && v.due) || p?.working ? 'working' : 'idle';
  }
  if (v.phase === 'over') return 'idle';
  return p?.working || p?.typing || v.speaker === i || (i === v.seat && v.due) ? 'working' : 'idle';
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

function drawRing(t, v, view) {
  for (const [i, node] of seats.entries()) {
    const m = marks(t, v, i);
    if (!v.seats[i].alive && !node.hasAttribute('data-dead') && node.hasAttribute('data-drawn')) die(node, deathOf(v, i)?.how ?? 'night');
    node.toggleAttribute('data-drawn', true); // a seat already dead when first drawn does not die again
    node.toggleAttribute('data-dead', !v.seats[i].alive);
    node.toggleAttribute('data-turn', v.speaker === i);
    node.toggleAttribute('data-pickable', Boolean(actionOn(v, i)));
    node.title = [label(t, t.players[i]), ...m.words].join(' · ');
    $('.pj-agent-face', node).dataset.presence = eyes(t, v, i);
    for (const at of ['fact', 'note', 'status']) badge($(`[data-at="${at}"]`, node), m[at]);
    $('.ww-claw', node).hidden = !m.claw;
    if (!$('.ww-claw', node).firstChild) $('.ww-claw', node).append(symbol('claw'));
    // votes as dots, each popping in after its arrow lands
    const dots = $('.ww-dots', node);
    if (dots.childElementCount !== m.dots) dots.replaceChildren(...Array.from({ length: m.dots }, (_, k) => Object.assign(el('i'), { style: `animation-delay: ${votesIn + k * 120}ms` })));
    // only a model that can't be reached is said in words
    $('.pk-tag', node).textContent = presence()[t.players[i]]?.failed ? 'Can\'t reach the model' : '';
    $('.pk-tag', node).dataset.kind = 'failed';
  }
  drawTimer(t, v, view);
}

// Your turn: a ring round your face that drains as your time runs out: a turn's by day, the call's at night.
function drawTimer(t, v, view) {
  if (v.seat < 0) return; // watching
  const ring = $('.ww-timer', seats[v.seat]);
  const task = view.tasks.find((x) => x.given.startsWith('turn:'));
  ring.classList.toggle('ww-timer-on', Boolean(task));
  if (!task || ring.dataset.at === task.given) return;
  ring.dataset.at = task.given;
  const ms = t.call ? CALL_MS[t.call.step] : TURN;
  const circle = ring.firstChild;
  circle.style.animation = 'none';
  void circle.getBoundingClientRect();
  circle.style.animation = `ww-drain ${ms}ms linear ${task.at - ms - Date.now()}ms forwards`;
}

// Arrows from face to face: who voted for whom, from the vote's result until
// the next vote, drawn in one by one when the result comes; during a vote,
// only the person's own; at night, to a wolf, the pack's picks.
let votesIn = 0; // ms until the last arrow of a new result lands, for the dots
let arrowsFor = ''; // the result whose arrows were drawn in
function drawVotes(t, v) {
  const vote = lastVote(v);
  const pairs = vote ? Object.entries(vote.votes).filter(([, x]) => x !== null).map(([s, x]) => [Number(s), x, '']) : [];
  if (v.phase === 'vote' && myVote?.day === v.day && myVote.target !== null) pairs.push([v.seat, myVote.target, 'mine']);
  if (v.phase === 'night' && v.pack && t.call?.step === 'wolves') {
    const picks = new Map(v.log.filter((e) => e.type === 'pick' && e.day === v.day).map((e) => [e.seat, e.target]));
    for (const [s, x] of picks) pairs.push([s, x, 'pack']);
  }
  const fresh = vote && arrowsFor !== `${vote.day}` && v.phase !== 'gather';
  if (vote) arrowsFor = `${vote.day}`;
  const ms = arrows($('.ww-votes'), pairs, (i) => $('.pj-avatar', seats[i]), fresh && !still);
  if (ms !== null) votesIn = ms;
}
addEventListener('resize', () => draw());

// Over the clearing: the sun or the moon and the day, and one line that
// changes with the moment: the narrator's call, the vote, last words.
const CALL_TEXT = {
  dusk: 'Night falls. Everyone, close your eyes.',
  wolves: 'Werewolves, open your eyes and pick a kill.',
  seer: 'Seer, open your eyes and check a player.',
  witch: 'Witch, open your eyes.',
};
function drawCenter(t, v) {
  const night = v.phase === 'night';
  $('.ww-board').dataset.time = night ? 'night' : 'day';
  document.documentElement.dataset.theme = night ? 'dark' : 'light'; // the game's clock is the page's theme
  const time = $('.ww-time');
  if (time.dataset.icon !== (night ? 'moon' : 'sun')) time.replaceChildren(icon(night ? 'moon' : 'sun'));
  time.dataset.icon = night ? 'moon' : 'sun';
  $('.ww-phase-text').textContent = v.phase === 'gather' ? 'Round the fire' : v.phase === 'over' ? (v.winner === 'village' ? 'The village wins' : 'The werewolves win') : `${night ? 'Night' : 'Day'} ${v.day}`;
  const call = t.call?.step ?? 'dusk';
  const [key, mark, words] = away ? ['away', null, away]
    : v.phase === 'gather' ? ['gather', null, 'Everyone says hello']
      : v.phase === 'over' ? ['over', null, v.seat < 0 ? '' : (v.role === 'wolf') === (v.winner === 'wolves') ? 'You won' : 'You lost']
        : night ? [`call:${call}`, call === 'dusk' ? null : symbol(call === 'wolves' ? 'wolf' : call), CALL_TEXT[call]]
          : v.phase === 'vote' ? ['vote', symbol('ballot'), 'Vote']
            : v.phase === 'last' ? ['last', null, 'Last words'] : ['day', null, ''];
  const sub = $('.ww-sub');
  if (sub.dataset.key !== key) {
    sub.dataset.key = key;
    sub.replaceChildren(...[mark, words].filter(Boolean));
    if (!still && words) sub.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'ease-out' });
  }
  $('.ww-over').hidden = v.phase !== 'over';
  $('[data-action="new"]').hidden = Boolean(ROOM);
  $('[data-action="thinking"]').hidden = false;
}

// ---- you: what you may do now ----

let formAt = ''; // the turn the form was set up for
const form = $('.ww-act');
function drawMe(t, v) {
  $('.ww-hint').hidden = notes.size > 0 || v.phase === 'over';
  form.hidden = !v.due;
  if (form.hidden) return;
  if (formAt !== v.due.at) {
    formAt = v.due.at;
    $('.ww-error').hidden = true;
  }
  const kind = v.due.kind;
  const attacked = v.log.findLast((e) => e.type === 'attacked' && e.day === v.day);
  const victim = attacked && (attacked.target === v.seat ? 'You were' : `${label(t, t.players[attacked.target])} was`);
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
  if (attacked) $('[data-do="save"]', form).textContent = `Save ${label(t, t.players[attacked.target])}`;
  $('[data-do="pass"]', form).hidden = kind !== 'potion';
}

// The chat box: what you say, and over it, who will hear you, or that you
// are muted and why. On your turn to speak, everyone; with your kill, only
// the pack, the line going with your pick; out of a game, the table; else no one.
const chat = $('.ww-chat-box');
const box = chat.elements.text;
let chatAt = ''; // the turn the box was set up for
function drawChat(t, v, view) {
  const kind = v?.due?.kind ?? null;
  const chatting = view.actions.includes('chat');
  const audience = kind === 'speak' || kind === 'last' || chatting ? 'all' : kind === 'kill' ? 'pack' : 'muted';
  if (chatAt !== (v?.due?.at ?? '')) {
    chatAt = v?.due?.at ?? '';
    box.value = '';
  }
  chat.dataset.audience = audience;
  box.disabled = audience === 'muted';
  box.maxLength = kind ? MAX_SPEECH : MAX_LINE;
  box.placeholder = { all: !kind ? 'Chat with the table…' : kind === 'last' ? 'Your last words…' : 'Speak to the village…', pack: 'A line to the pack, sent with your pick', muted: '' }[audience];
  $('[type=submit]', chat).disabled = audience !== 'all' || !box.value.trim();
  const speaker = v?.speaker == null ? null : label(t, t.players[v.speaker]);
  const why = audience === 'all' ? [icon('users'), kind ? 'Everyone hears you.' : 'Everyone at the table hears you.']
    : audience === 'pack' ? [token('wolf'), 'Only the pack hears you.']
      : [symbol('muted'), !v ? 'Join the table to chat.'
        : v.seat < 0 && v.phase !== 'over' ? 'You are watching: you play from the next game.'
          : !v.alive && !['over', 'last'].includes(v.phase) ? 'You are out: the dead don\'t speak.'
            : v.phase === 'over' ? 'The game is over: you watched it.'
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
  if (chat.dataset.audience !== 'all') return;
  perform(picture().view.actions.includes('chat') ? 'chat' : 'speak');
});
box.addEventListener('input', () => draw());
box.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chat.requestSubmit();
  }
});

// What this page's player does, on the moment it sees, with what they wrote
// (a speech, last words, a line in the chat, or with a kill a line to the
// pack): landed here (a person's change answers no task: refused, it lands
// nothing, and they see why), or, on a friend's page, sent to the host, which lands it.
function perform(type, target) {
  const { t, v, view } = picture();
  if (!view.actions.includes(type)) return;
  const body = { type, ...(target !== undefined ? { target } : {}), ...(['speak', 'kill', 'chat'].includes(type) ? { text: box.value } : {}) };
  if (type === 'vote' || type === 'abstain') myVote = { day: v.day, target: target ?? null };
  if ('text' in body) box.value = '';
  if (ROOM) {
    guest.send({ type: 'act', base: t.moment, body });
    return draw();
  }
  const { refused: why } = table.commit(HUMAN, { base: t.moment, body });
  if (why && 'text' in body) box.value = body.text;
  refused(why);
  draw();
}
function refused(why) {
  const error = $('.ww-error');
  error.textContent = why ?? '';
  error.hidden = !why;
  if (why) myVote = null;
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
  const { t, v } = picture();
  const i = Number(node.dataset.seat);
  const id = t.players[i];
  const act = actionOn(v, i);
  const guess = (role) => item(token(role, true), () => {
    notes.set(i, role);
    draw();
  }, notes.get(i) === role);
  const head = el('li', 'pk-menu-head');
  const who = el('span', 'pk-menu-text');
  who.append(el('b', '', label(t, id)));
  if (!isPerson(id)) who.append(el('span', '', PERSONAS.find((p) => p.id === id).blurb));
  head.append(faceOf(t, id), who);
  const items = [head];
  if (act) {
    const doIt = item(`${act.verb} ${label(t, id)}`, () => perform(act.type, i));
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
  if (node && picture().v) openMenu(node);
});
document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !event.target.closest('.ww-menu, .ww-seat')) menu.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') menu.hidden = true;
});

// ---- the log: what the person's seat saw, as a chat app shows it ----

const SECRET = { pick: 'wolf', kill: 'wolf', check: 'seer', attacked: 'witch', save: 'witch', poison: 'witch' };
function drawFeed(t, v) {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const name = (i) => (i === v.seat ? 'you' : label(t, t.players[i]));
  const Name = (i) => cap(name(i));
  const names = (list) => list.map(Name).join(' and ');
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const known = (i) => Object.values(identity(v, i)).filter(Boolean).map((m) => m[1]());
  const say = (i, text, note, pack = false) => {
    const id = t.players[i];
    const row = message({ face: id !== me && faceOf(t, id), name: [label(t, id), ...known(i)], text, note: pack ? el('span', 'ww-only', 'only the pack') : note, mine: id === me, more: last === i && !pack });
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
  // the chat before this game, and (below) after it
  const chatted = (after) => t.lines.filter((l) => l.after === after && l.game === t.no);
  const chatLine = (l) => {
    const i = t.players.indexOf(l.by);
    if (i >= 0) return say(i, l.text, '');
    rows.push(message({ face: l.by !== me && faceOf(t, l.by), name: label(t, l.by), text: l.text, mine: l.by === me, more: last === l.by }));
    last = l.by;
  };
  chatted(false).forEach(chatLine);
  for (const h of t.hellos) say(t.players.indexOf(h.id), h.text, '');
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
    else if (e.type === 'dawn') {
      // how, to whoever may know it (deathOf): the pack its kill, the witch her poison, everyone once the game is over
      const told = e.deaths.map((i) => [i, deathOf(v, i)?.how ?? 'night']);
      const known = told.filter(([, how]) => how !== 'night');
      const rest = told.filter(([, how]) => how === 'night').map(([i]) => i);
      const said = [...known.map(([i, how]) => `${Name(i)} ${i === v.seat ? 'were' : 'was'} ${HOW[how]}`), ...(rest.length ? [`${names(rest)} died in the night`] : [])];
      line(`Day ${e.day}. ${said.length ? `${said.join('. ')}.` : 'No one died in the night.'}`);
    } else if (e.type === 'speech' || e.type === 'last') {
      if (e.silent) line(`${Name(e.seat)} said nothing${e.type === 'last' ? ' as last words' : ''}.`);
      else say(e.seat, e.text, e.type === 'last' ? 'last words' : '');
    } else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, x]) => `${Name(Number(s))} → ${x === null ? 'abstained' : name(x)}`);
      line(`The vote: ${votes.join(', ')}. ${e.out === null ? 'A tie: no one is out.' : `${Name(e.out)} ${e.out === v.seat ? 'are' : 'is'} out.`}`);
    } else if (e.type === 'over') line(e.winner === 'village' ? 'Every werewolf is dead: the village wins.' : 'The werewolves are as many as the rest: they win.');
  }
  chatted(true).forEach(chatLine);
  for (const [id, p] of Object.entries(presence())) {
    if (p.typing) rows.push(typingMessage(faceOf(t, id), id));
    if (!p.failed) continue;
    const row = notice(`${id} could not reach the model: ${p.failed}`);
    row.dataset.failed = '';
    rows.push(row);
  }
  feed.replaceChildren(...rows);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// Before any game, the log is the chat of the people at the table.
function drawLobby(t) {
  $('.ww-phase-text').textContent = ROOM ? away || 'Waiting for the host to start a game' : 'Round the fire';
  $('.ww-over').hidden = Boolean(ROOM); // before any game, the host's way to start one
  $('[data-action="thinking"]').hidden = true;
  const feed = $('.pk-feed');
  let last = null;
  feed.replaceChildren(...t.lines.filter((l) => !l.after && l.game === t.no + 1).map((l) => {
    const row = message({ face: l.by !== me && faceOf(t, l.by), name: label(t, l.by), text: l.text, mine: l.by === me, more: last === l.by });
    last = l.by;
    return row;
  }));
  feed.scrollTop = feed.scrollHeight;
}

// Draws this page's player's view: while the players say hello, round the
// fire before night falls; the night as the narrator calls it.
function draw() {
  const { t, v, view } = picture();
  layout(t);
  if (!v) {
    drawChat(t, null, view);
    drawLobby(t);
  } else {
    drawVotes(t, v);
    drawRing(t, v, view);
    drawCenter(t, v);
    drawMe(t, v);
    drawChat(t, v, view);
    drawFeed(t, v);
  }
  if (!ROOM && !starting.hidden) drawStart();
}

// ---- their thinking, after the game ----

function showThinking() {
  const { t, v } = picture();
  const dialog = $('.pk-thinking');
  $('h2', dialog).textContent = 'Their thinking';
  $('.pk-thinking-body', dialog).replaceChildren(...t.players.filter((id) => !isPerson(id)).map((id) => {
    const seat = t.players.indexOf(id);
    const part = el('details', 'pj-trace-part');
    part.open = true;
    const summary = el('summary');
    const meta = el('span', 'pj-trace-meta');
    if (v.seats[seat].role) meta.append(token(v.seats[seat].role)); // the game is over: every role shows
    meta.append(v.seats[seat].alive ? ' alive' : ' dead');
    summary.append(icon('chevron'), faceOf(t, id), el('span', 'pj-trace-title', id), meta);
    part.append(summary);
    const thoughts = t.thoughts[id] ?? [];
    if (!thoughts.length) part.append(el('p', 'pj-empty', 'No decisions.'));
    for (const th of thoughts) {
      const target = Number.isInteger(th.action?.target) ? ` ${label(t, t.players[th.action.target])}` : '';
      part.append(el('h3', 'pj-setting-group', `${th.phase === 'night' ? 'Night' : 'Day'} ${th.day}${th.action ? ` · ${th.action.type}${target}` : ''}`));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', th.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- a new game: how many players, who is at the table, and the roles that makes ----

const starting = $('.ww-start');
let size = 7;
function openStart() {
  starting.hidden = false;
  document.body.classList.add('pk-buying-in');
  drawStart();
}
function drawStart() {
  const { people } = picture().t;
  for (const b of starting.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === size));
  const roles = cast(size);
  $('.ww-cast', starting).replaceChildren(...[...new Set(roles)].map((role) => {
    const li = el('li', '', `${roles.filter((r) => r === role).length} × `);
    li.append(token(role));
    return li;
  }));
  const seated = Math.min(people.length, size);
  const list = people.map((id) => label(picture().t, id));
  const watch = people.length > size ? ` The last ${people.length - size === 1 ? 'one watches' : `${people.length - size} watch`}.` : '';
  $('.ww-people').textContent = people.length <= 1 ? '' : `At the table: ${list.slice(0, -1).join(', ')} and ${list.at(-1)}.${watch} AI players take the ${size - seated === 1 ? 'other seat' : `other ${size - seated} seats`}.`;
}
starting.addEventListener('click', (event) => {
  const b = event.target.closest('[data-size]');
  if (!b) return;
  size = Number(b.dataset.size);
  drawStart();
});
starting.addEventListener('submit', (event) => {
  event.preventDefault();
  starting.hidden = true;
  document.body.classList.remove('pk-buying-in');
  startGame(size);
});

// ---- friends: the host's page invites them; a friend's page joins ----

// Each friend's page gets its seat's view, with the presence it may see
// (game-kit.js). One that was at the table (its page reloaded) is back in
// its seat, by the name it had.
const guests = friends(table, {
  heard: act,
  joined(id) {
    const { people, names } = picture().t;
    if (names[id] && !people.includes(id)) table.commit(id, { body: { type: 'join', name: names[id] } });
  },
});
const inviting = $('.pk-invite');
async function invite() {
  inviting.hidden = false;
  document.body.classList.add('pk-setting-up');
  inviting.elements.name.value = picture().t.names[HUMAN] ?? load(NAME) ?? '';
  inviting.elements.link.value = await guests.link();
}
function closeInvite() {
  const name = inviting.elements.name.value.trim();
  if (name) {
    table.commit(HUMAN, { body: { type: 'join', name } });
    keep(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-setting-up');
}
// What a friend's page sends: to sit at the table, or what its player does, made on `base`.
function act(id, message) {
  const b = message.body ?? {};
  const body = message.type === 'sit' ? { type: 'join', name: message.name } : { type: String(b.type), ...(typeof b.text === 'string' ? { text: b.text } : {}), ...(Number.isInteger(b.target) ? { target: b.target } : {}) };
  const { refused: why } = table.commit(id, { base: String(message.base ?? ''), body });
  if (why) guests.send(id, { type: 'rejected', why });
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
    remote = message;
    if (!joining.hidden && message.view.content.people.includes(me)) closeJoin(); // back at the table after a reload
    draw();
  },
  away(reason) {
    away = reason === 'host' ? 'The host is away. Waiting for them…' : reason === 'line' ? 'Reconnecting…' : reason;
    draw();
  },
});
const joining = $('.ww-join');
function closeJoin() {
  joining.hidden = true;
  document.body.classList.remove('pk-buying-in');
}
joining.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = joining.elements.name.value.trim().slice(0, 20) || 'Friend';
  keep(name, NAME);
  guest.send({ type: 'sit', name });
  closeJoin();
});

// ---- wiring ----

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'new') openStart();
  else if (action === 'later') { // chat first: the start is under New game
    starting.hidden = true;
    document.body.classList.remove('pk-buying-in');
    draw();
  }
  else if (action === 'thinking') showThinking();
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') ai.open();
  else if (action === 'invite') invite();
  else if (action === 'invite-done') closeInvite();
  else if (action === 'copy') {
    inviting.elements.link.select();
    navigator.clipboard?.writeText(inviting.elements.link.value).catch(() => {});
  } else if (action === 'watch') closeJoin();
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});

if (ROOM) {
  for (const node of document.querySelectorAll('[data-action="new"], [data-action="key"], [data-action="invite"]')) node.hidden = true;
  $('.pk-model').textContent = 'You joined a friend\'s game: the AI players run on their page.';
  joining.elements.name.value = load(NAME) ?? '';
  joining.hidden = false;
  document.body.classList.add('pk-buying-in');
} else {
  ai.draw();
  // The members' controllers: each AI player's, the clock's, and this screen's, the host's seat.
  for (const { id } of PERSONAS) control(client(id), { program: think(id), wallet: table.wallet });
  control(client(CLOCK), clock());
  control(client(HUMAN), {
    show(view) {
      shown = view;
      draw();
    },
  });
  // Friends at a table this page held before it reloaded: the room is new, so they are gone.
  for (const id of shown.content.people) if (id !== HUMAN) guests.gone(id);
  if (!shown.content.game) openStart();
}
draw();
