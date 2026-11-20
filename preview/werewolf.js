// The werewolf page (site/werewolf.html): a person and AI players round a
// fire at one game of werewolf. The rules (werewolf-rules.js) own what must
// be exact; the players decide the rest from the rules and what their seat
// may see (werewolf-runtime.js). Here, as on the poker page
// (preview/poker.js): the controller, which on every change looks at the
// game and starts the runs `plan` says are due, never acting on an event
// itself; a run, one call of the visitor's model (game-page.js, shared with
// the poker page, with the log's messages); a narrator, who calls the night
// a role at a time; and the game drawn from the person's own view alone,
// with what they know of each player on their seat and their own guesses.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, el, message, models, notice, typingMessage } from './game-page.js';
import { DECIDE, HUMAN, MAX_SPEECH, PERSONAS, ROLE_NAMES, begin, decided, expire, fail, isPerson, land, newGame, plan, prompt, retry, show, turn } from './werewolf-runtime.js';

const TURN = 90_000; // ms a turn may take; then everyone still due is taken as doing nothing

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

let game = null;
const running = new Set(); // players with a run going
const typing = new Set(); // players typing their speech
let notes = new Map(); // the person's guess at each seat's role
let myVote = null; // { day, target }: the person's vote, theirs to see before the vote ends
// The players' model. Once the visitor picks another, what failed is tried again.
const ai = models(() => {
  if (game) for (const [id, n] of Object.entries(game.notes)) if (n.failed) retry(game, id);
  changed();
});

// ---- the controller ----

// Every change: draw it, then look again. A look starts what `plan` says is
// due and times the turn; that is all it does. While the narrator is behind
// the game at dawn, the day waits for it: no one speaks in the dark.
function changed() {
  if (!game || hellos.going) return void draw();
  const held = draw();
  if (!held || game.state.phase === 'night') for (const due of plan(game, running)) run(due);
  timeTurn();
}

// The narrator: at night it calls each role in turn, alive or not, as at a
// real table, and each call lasts at least its time, so how long it takes
// says nothing of who acted in it. It follows the game a call at a time.
const CALLS = ['dusk', 'wolves', 'seer', 'witch'];
const CALL_MS = [2500, 4000, 4000, 4000];
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
setInterval(() => game && drawClock(), 1000);

// One run of a player: one model call, and its proposal to the writer. A
// model answers faster than a person can follow, so a player takes at least
// its own time to think, and a speech comes after it is seen typing it.
const PACE = { Rosa: [1600, 3000], Jax: [600, 1400], Wen: [1800, 3400], Otis: [1200, 2600], Priya: [900, 1800], Bo: [1400, 2800], Nell: [1600, 3200] }; // ms, from and to
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const typeTime = (text) => Math.min(4000, Math.max(800, text.length * 30));

async function run({ id, kind }) {
  const here = game;
  const basis = begin(game, id);
  const started = performance.now();
  running.add(id);
  draw();
  const { rules, situation } = prompt(game, id);
  try {
    const { calls, text } = await ai.infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === 'decide')?.args ?? '{}');
    } catch {}
    const proposal = decided({ thinking: text, ...args });
    const [from, to] = PACE[id];
    await wait(from + Math.random() * (to - from) - (performance.now() - started));
    if (here !== game) return;
    if ((kind === 'speak' || kind === 'last') && proposal.say.trim()) {
      typing.add(id);
      draw();
      await wait(typeTime(proposal.say));
      typing.delete(id);
    }
    if (here !== game) return;
    land(game, id, basis, proposal);
  } catch (error) {
    if (here !== game) return;
    typing.delete(id);
    fail(game, id, basis, String(error.message).split('\n')[0]);
  }
  running.delete(id);
  changed();
}

function startGame(size) {
  game = newGame(size);
  $('.site-theme').hidden = true; // the game sets light and dark now
  running.clear();
  typing.clear();
  notes = new Map();
  myVote = null;
  clearTimeout(clock.timer);
  clock = { at: '', ends: 0 };
  call = { day: 0, at: 0, since: 0 };
  formAt = '';
  shown = null;
  for (const node of seats) node.remove();
  seats = game.players.map((id, i) => seatNode(id, i, game.players.length));
  $('.ww-ring').append(...seats);
  greet();
}

// Before the first night, the players say hello round the fire, each in
// seat order, a line every second or so: lines written for them, so no
// model is asked. Then night falls.
const HELLO_MS = 1400;
let hellos = { going: false, said: [] };
function greet() {
  const here = game;
  const players = game.players.flatMap((id, seat) => (isPerson(id) ? [] : [{ seat, text: PERSONAS.find((p) => p.id === id).hello }]));
  hellos = { going: true, said: [] };
  changed();
  players.forEach((line, k) => setTimeout(() => {
    if (here !== game) return;
    hellos.said.push(line);
    changed();
  }, 600 + k * HELLO_MS));
  setTimeout(() => {
    if (here !== game) return;
    hellos.going = false;
    changed();
  }, 600 + players.length * HELLO_MS + 1200);
}

// ---- the clearing ----

let seats = [];
let shown = null; // the view last drawn
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const label = (id) => (isPerson(id) ? 'You' : id);
const cap = (text) => text[0].toUpperCase() + text.slice(1);
const roleName = (role) => cap(ROLE_NAMES[role]);
function roleLabel(role) {
  const label = el('span', 'ww-role-label');
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.classList.add('ww-role-mark');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(mark.namespaceURI, 'use');
  use.setAttribute('href', `#ww-${role}`);
  mark.append(use);
  label.append(mark, roleName(role));
  return label;
}
function faceOf(id) {
  const avatar = el('span', `pj-avatar${isPerson(id) ? '' : ' pj-avatar-agent'}`);
  avatar.append(isPerson(id) ? personFace('You', id) : agentFace(id));
  return avatar;
}
function seatNode(id, i, n) {
  const node = el('button', 'ww-seat');
  node.type = 'button';
  node.dataset.seat = i;
  node.style.setProperty('--a', `${90 + (360 * i) / n}deg`); // you at the bottom, the rest round in seat order
  const face = el('span', 'pj-agent-face');
  face.dataset.presence = 'idle';
  face.append(faceOf(id));
  const plate = el('div', 'pk-plate');
  const name = el('span', 'pk-name');
  name.append(Object.assign(el('span', 'pk-position', String(i + 1)), { title: `Seat ${i + 1}` }), label(id));
  plate.append(name, el('span', 'pk-tag'), el('span', 'ww-chips'));
  node.append(face, plate, el('span', 'ww-say'));
  return node;
}

// What the person may do to seat `i` now, if anything: { verb, type }.
function actionOn(v, i) {
  if (!v.due || !v.seats[i].alive || (v.phase === 'night' && !called(KIND_CALL[v.due.kind]))) return null;
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
// How each dead player died, as everyone saw it.
function deaths(v) {
  const out = new Map();
  for (const e of v.log) {
    if (e.type === 'dawn') for (const i of e.deaths) out.set(i, `Died, night ${e.day}`);
    if (e.type === 'vote' && e.out !== null) out.set(e.out, `Voted out, day ${e.day}`);
  }
  return out;
}

// What a seat shows under its name: what it is doing or did, as far as the person may know.
function tag(v, i, died) {
  const id = game.players[i];
  const s = v.seats[i];
  const awake = v.phase !== 'night' || (v.pack?.includes(i) && call.at === 1) || i === v.seat; // at night, others' runs would say who has a role
  if (!s.alive && !(v.phase === 'last' && v.speaker === i)) return [died.get(i) ?? 'Dead', 'dead'];
  if (v.phase === 'over') return ['', ''];
  if (awake && game.notes[id]?.failed) return ['Can\'t reach the model', 'failed'];
  if (v.speaker === i) return [typing.has(id) ? 'Speaking…' : i === v.seat ? 'Your turn' : v.phase === 'last' ? 'Last words…' : 'Thinking…', 'wait'];
  if (v.phase === 'vote') return v.voted.includes(i) ? ['Voted', ''] : ['Voting…', 'wait'];
  if (v.phase === 'night' && v.pack?.includes(i) && call.at === 1) {
    const pick = v.log.findLast((e) => e.type === 'pick' && e.day === v.day && e.seat === i);
    return pick ? [`Kill: ${label(game.players[pick.target])}`, ''] : ['Choosing…', 'wait'];
  }
  const vote = lastVote(v);
  if (vote && i in vote.votes) return [vote.votes[i] === null ? 'Abstained' : `Voted ${label(game.players[vote.votes[i]])}`, 'fold'];
  return ['', ''];
}

// What the person knows of seat `i`, as chips on its plate: [text, kind].
// Facts first (its role, the seer's check, the witch's night, the pack's
// pick, its votes), then the person's own guess, dashed.
function chips(v, i) {
  const out = [];
  const role = v.seats[i].role;
  if (role) out.push([roleLabel(role), role === 'wolf' ? 'wolf' : '']);
  else {
    const check = v.log.findLast((e) => e.type === 'check' && e.target === i);
    if (check) out.push([check.wolf ? roleLabel('wolf') : 'Good', check.wolf ? 'wolf' : '']);
  }
  const tonight = (type) => v.phase === 'night' && v.log.some((e) => e.type === type && e.day === v.day && e.target === i);
  if (tonight('attacked') && called('witch')) out.push(['Attacked tonight', '']);
  if (tonight('kill') && v.pack) out.push(['The pack\'s kill', 'wolf']);
  for (const e of v.log) {
    if (e.type === 'save' && e.target === i) out.push([`Saved, night ${e.day}`, '']);
    if (e.type === 'poison' && e.target === i) out.push([`Poisoned, night ${e.day}`, '']);
  }
  const vote = lastVote(v);
  const votes = vote ? Object.values(vote.votes).filter((t) => t === i).length : 0;
  if (votes) out.push([`${votes} vote${votes > 1 ? 's' : ''}`, '']);
  if (notes.has(i) && v.phase !== 'over') out.push([[roleLabel(notes.get(i)), '?'], 'note']);
  return out;
}

// A face's eyes: shut at night unless the narrator called its role and the person may know it; shut for good once dead.
function presence(v, i) {
  const id = game.players[i];
  if (!v.seats[i].alive) return 'away';
  if (v.phase === 'night') {
    const role = i === v.seat ? v.role : v.pack?.includes(i) ? 'wolf' : null;
    if (!role || CALLS[call.at] !== ROLE_CALL[role]) return 'away';
    return (i === v.seat && v.due) || running.has(id) ? 'working' : 'idle';
  }
  if (v.phase === 'over') return 'idle';
  return running.has(id) || v.speaker === i || (i === v.seat && v.due) ? 'working' : 'idle';
}

function drawRing(v) {
  const died = deaths(v);
  const said = v.phase === 'gather' ? hellos.said.at(-1) : v.log.findLast((e) => (e.type === 'speech' || e.type === 'last') && e.day === v.day && !e.silent);
  for (const [i, node] of seats.entries()) {
    const id = game.players[i];
    node.toggleAttribute('data-dead', !v.seats[i].alive);
    node.toggleAttribute('data-turn', v.speaker === i);
    node.toggleAttribute('data-pickable', Boolean(actionOn(v, i)));
    $('.pj-agent-face', node).dataset.presence = presence(v, i);
    const [text, kind] = tag(v, i, died);
    const tagNode = $('.pk-tag', node);
    if (tagNode.textContent !== text) {
      Object.assign(tagNode, { textContent: text }).dataset.kind = kind;
      if (!still) tagNode.animate([{ opacity: 0, transform: 'scale(0.8)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'ease-out' });
    }
    $('.ww-chips', node).replaceChildren(...chips(v, i).map(([t, k]) => {
      const chip = el('span', 'ww-chip');
      chip.append(...[t].flat());
      if (k) chip.dataset.kind = k;
      return chip;
    }));
    // what was said last, in a bubble toward the fire, while the day lasts
    const bubble = $('.ww-say', node);
    const isTyping = typing.has(id) && v.speaker === i;
    bubble.classList.toggle('pk-typing', isTyping);
    if (isTyping) bubble.replaceChildren(el('i'), el('i'), el('i'));
    else bubble.textContent = said?.seat === i && v.phase !== 'vote' && v.phase !== 'night' ? said.text : '';
    bubble.title = bubble.textContent;
  }
}

// Who voted for whom: an arrow from each voter's face to their pick's, from
// the vote's result until the next vote; during a vote, only the person's own.
function drawVotes(v) {
  const svg = $('.ww-votes');
  for (const line of svg.querySelectorAll('line')) line.remove();
  const vote = lastVote(v);
  const pairs = vote ? Object.entries(vote.votes).filter(([, t]) => t !== null).map(([s, t]) => [Number(s), t, false]) : [];
  if (v.phase === 'vote' && myVote?.day === v.day && myVote.target !== null) pairs.push([v.seat, myVote.target, true]);
  if (!pairs.length) return;
  const box = svg.getBoundingClientRect();
  const at = (i) => {
    const r = $('.pj-agent-face', seats[i]).getBoundingClientRect();
    return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
  };
  for (const [from, to, mine] of pairs) {
    const [x1, y1] = at(from);
    const [x2, y2] = at(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
    const gap = $('.pj-agent-face', seats[0]).offsetWidth / 2 + 6;
    const side = from < to ? 3 : -3; // two who voted for each other: side by side
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const set = { x1: x1 + ux * gap - uy * side, y1: y1 + uy * gap + ux * side, x2: x2 - ux * gap - uy * side, y2: y2 - uy * gap + ux * side, 'marker-end': 'url(#ww-head)' };
    for (const [k, value] of Object.entries(set)) line.setAttribute(k, value);
    if (mine) line.dataset.mine = '';
    svg.append(line);
  }
}
addEventListener('resize', () => game && draw());

function drawCenter(v) {
  const name = (i) => (i === v.seat ? 'You' : game.players[i]);
  const alive = v.seats.filter((s) => s.alive).length;
  $('.ww-board').dataset.time = v.phase === 'night' ? 'night' : 'day';
  document.documentElement.dataset.theme = v.phase === 'night' ? 'dark' : 'light'; // the game's clock is the page's theme
  $('.ww-phase').textContent = v.phase === 'gather' ? 'Round the fire' : v.phase === 'over' ? (v.winner === 'village' ? 'The village wins' : 'The werewolves win')
    : `${v.phase === 'night' ? 'Night' : 'Day'} ${v.day}${v.phase === 'vote' ? ' · Vote' : v.phase === 'last' ? ' · Last words' : ''}`;
  const dawn = v.log.findLast((e) => e.type === 'dawn');
  const firstWord = v.phase === 'day' && !v.log.some((e) => e.type === 'speech' && e.day === v.day);
  $('.ww-sub').textContent = v.phase === 'gather' ? 'Everyone says hello before night falls.' : v.phase === 'over' ? `${(v.role === 'wolf') === (v.winner === 'wolves') ? 'You won' : 'You lost'}. Every role is shown.`
    : v.phase === 'night' ? CALL_TEXT[CALLS[Math.min(call.at, CALLS.length - 1)]]
      : v.phase === 'vote' ? `${v.voted.length} of ${alive} have voted.`
        : `${firstWord && dawn?.day === v.day ? `The sun rises. ${dawn.deaths.length ? `${dawn.deaths.map(name).join(' and ')} died in the night.` : 'No one died.'} ` : ''}${v.speaker === v.seat ? (v.phase === 'last' ? 'Your last words.' : 'Your turn to speak.') : `${name(v.speaker)} ${v.phase === 'last' ? 'gives last words' : 'is speaking'}.`}`;
  $('.ww-over').hidden = v.phase !== 'over';
}

// ---- you: your role, and what you may do ----

let formAt = ''; // the turn the form was set up for
const form = $('.ww-act');
function drawMe(v) {
  const others = v.pack?.filter((i) => i !== v.seat).map((i) => game.players[i]) ?? [];
  const line = $('.ww-role');
  line.replaceChildren('Your role: ', roleLabel(v.role), '.');
  if (others.length) line.append(` Your pack: ${others.join(' and ')}.`);
  if (v.potions && v.role === 'witch') line.append(` Save ${v.potions.save ? 'unused' : 'used'}, poison ${v.potions.poison ? 'unused' : 'used'}.`);
  if (!v.alive && v.phase !== 'over' && v.phase !== 'last') line.append(' You are dead: the game plays on.');
  line.append(el('span', 'ww-hint', v.phase === 'over' ? '' : ' Click a player to note what you think they are.'));
  form.hidden = !v.due || (v.phase === 'night' && !called(KIND_CALL[v.due.kind]));
  if (form.hidden) return;
  if (formAt !== v.due.at) {
    formAt = v.due.at;
    form.elements.text.value = '';
    $('.ww-error').hidden = true;
  }
  const kind = v.due.kind;
  const attacked = v.log.findLast((e) => e.type === 'attacked' && e.day === v.day);
  $('.ww-ask').textContent = {
    kill: () => (v.due.round === 2 ? 'The pack disagreed: click a player to pick once more.' : 'Click a player for the pack to kill tonight.'),
    check: () => 'Click a player to check.',
    potion: () => `${attacked ? `The wolves attacked ${attacked.target === v.seat ? 'you' : game.players[attacked.target]} tonight.` : v.potions.save ? 'The wolves attacked no one tonight.' : 'You no longer learn whom the wolves attack.'}${v.due.poison ? ' Click a player to poison, or not.' : ''}`,
    speak: () => 'Your turn to speak.',
    last: () => 'You were voted out. Your last words?',
    vote: () => 'Click a player to vote them out, or abstain.',
  }[kind]();
  const text = form.elements.text;
  const speaking = kind === 'speak' || kind === 'last';
  text.hidden = !speaking && kind !== 'kill';
  text.maxLength = MAX_SPEECH;
  text.placeholder = kind === 'kill' ? 'A line only the pack hears (optional), then click a player' : 'Say it to the village';
  $('[data-do="speak"]', form).hidden = !speaking;
  $('[data-do="speak"]', form).disabled = !text.value.trim();
  $('[data-do="abstain"]', form).hidden = kind !== 'vote';
  $('[data-do="save"]', form).hidden = kind !== 'potion' || !v.due.save;
  if (attacked) $('[data-do="save"]', form).textContent = `Save ${label(game.players[attacked.target])}`;
  $('[data-do="pass"]', form).hidden = kind !== 'potion';
  drawClock();
}
function drawClock() {
  $('.ww-clock').textContent = !form.hidden && clock.ends ? `${Math.max(0, Math.ceil((clock.ends - Date.now()) / 1000))}s left` : '';
}

// What the person does, through the writer, as an AI player's proposal.
function perform(type, target) {
  const v = show(game);
  if (!v.due) return;
  const action = { type, ...(target !== undefined ? { target } : {}) };
  const { rejected } = land(game, HUMAN, { at: v.due.at }, { action, say: form.elements.text.value });
  const error = $('.ww-error');
  error.textContent = rejected ?? '';
  error.hidden = !rejected;
  if (!rejected) {
    form.hidden = true; // drawn again once the narrator has moved on
    if (type === 'vote' || type === 'abstain') myVote = { day: v.day, target: target ?? null };
  }
  changed();
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  perform('speak');
});
form.addEventListener('click', (event) => {
  const type = event.target.closest('[data-do]:not([type=submit])')?.dataset.do;
  if (type) perform(type);
});
form.elements.text.addEventListener('input', () => drawMe(show(game)));
form.elements.text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !$('[data-do="speak"]', form).hidden) {
    event.preventDefault();
    form.requestSubmit();
  }
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
  const id = game.players[i];
  const act = actionOn(v, i);
  const guess = (role) => item([roleLabel(role), '?'], () => {
    notes.set(i, role);
    draw();
  }, notes.get(i) === role);
  const head = el('li', 'pk-menu-head');
  const who = el('span', 'pk-menu-text');
  who.append(el('b', '', i === v.seat ? 'You' : id));
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
  if (node && game) openMenu(node);
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
  const name = (i) => (i === v.seat ? 'you' : game.players[i]);
  const Name = (i) => cap(name(i));
  const names = (list) => list.map(Name).join(' and ');
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const say = (i, text, note) => {
    const id = game.players[i];
    rows.push(message({ face: !isPerson(id) && faceOf(id), name: id, text, note, mine: isPerson(id), more: last === i }));
    last = i;
  };
  const line = (text, secret, ...suffix) => {
    const row = notice(text);
    if (secret) {
      row.dataset.secret = '';
      row.prepend(roleLabel(secret), ': ');
    }
    row.append(...suffix);
    rows.push(row);
    last = null;
  };
  for (const h of hellos.said) say(h.seat, h.text, '');
  for (const e of v.log) {
    const secret = SECRET[e.type];
    if (e.type === 'night') line(`Night ${e.day} falls. Everyone closes their eyes.`);
    else if (e.type === 'pick') {
      line(`${Name(e.seat)} ${e.seat === v.seat ? 'want' : 'wants'} to kill ${name(e.target)}${e.round === 2 ? ' (second pick)' : ''}.`, secret);
      if (e.text) say(e.seat, e.text, 'to the pack');
    } else if (e.type === 'kill') line(e.target === null ? 'The pack kills no one.' : `The pack kills ${name(e.target)}.`, secret);
    else if (e.type === 'check') line(`${Name(e.seat)} checked ${name(e.target)}: ${e.wolf ? '' : 'not '}`, secret, roleLabel('wolf'), '.');
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
  for (const [id, n] of Object.entries(game.notes)) {
    if (!n.failed) continue;
    const named = v.phase !== 'night' || v.pack?.includes(game.players.indexOf(id)); // at night, who failed would say who has a role
    const row = notice(`${named ? id : 'A player'} could not reach the model: ${n.failed.why}`);
    row.dataset.failed = '';
    const again = el('button', 'pj-link-button', 'Retry');
    again.type = 'button';
    again.addEventListener('click', () => {
      retry(game, id);
      changed();
    });
    row.append(' ', again);
    rows.push(row);
  }
  feed.replaceChildren(...rows);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// Draws the person's view: while the players say hello, round the fire
// before night falls; while the narrator has not yet called dawn, the night
// as it was. Returns whether the narrator is behind the game.
function draw() {
  if (!game) return false;
  if (hellos.going) {
    const v = { ...show(game), phase: 'gather', due: null, log: [] };
    for (const part of [drawRing, drawCenter, drawMe, drawFeed, drawVotes]) part(v);
    return true;
  }
  const held = pace();
  const v = held && game.state.phase !== 'night' && shown ? { ...shown, due: null } : show(game);
  shown = v;
  drawRing(v);
  drawCenter(v);
  drawMe(v);
  drawFeed(v);
  drawVotes(v);
  return held;
}

// ---- their thinking, after the game ----

function showThinking() {
  const dialog = $('.pk-thinking');
  $('h2', dialog).textContent = 'Their thinking';
  const roles = game.state.seats.map((s) => s.role);
  $('.pk-thinking-body', dialog).replaceChildren(...game.players.filter((id) => !isPerson(id)).map((id) => {
    const seat = game.players.indexOf(id);
    const part = el('details', 'pj-trace-part');
    part.open = true;
    const summary = el('summary');
    const meta = el('span', 'pj-trace-meta');
    meta.append(roleLabel(roles[seat]), game.state.seats[seat].alive ? ', alive' : ', dead');
    summary.append(icon('chevron'), faceOf(id), el('span', 'pj-trace-title', id), meta);
    part.append(summary);
    const thoughts = game.notes[id].thoughts;
    if (!thoughts.length) part.append(el('p', 'pj-empty', 'No decisions.'));
    for (const t of thoughts) {
      const target = Number.isInteger(t.action?.target) ? ` ${isPerson(game.players[t.action.target]) ? 'you' : game.players[t.action.target]}` : '';
      part.append(el('h3', 'pj-setting-group', `${t.phase === 'night' ? 'Night' : 'Day'} ${t.day}${t.action ? ` · ${t.action.type}${target}` : ''}`));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', t.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- a new game: how many players ----

const starting = $('.ww-start');
let size = 7;
function openStart() {
  for (const b of starting.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === size));
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

// ---- wiring ----

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'new') openStart();
  else if (action === 'thinking') showThinking();
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') ai.open();
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});

ai.draw();
openStart();
