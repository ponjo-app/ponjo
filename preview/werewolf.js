// The werewolf page (site/werewolf.html): a person and AI players at one
// game of werewolf. The rules (werewolf-rules.js) own what must be exact;
// the players decide the rest from the rules and what their seat may see
// (werewolf-runtime.js). Here, as on the poker page (preview/poker.js): the
// controller, which on every change looks at the game and starts the runs
// `plan` says are due, never acting on an event itself; a run, one call of
// the visitor's model through INFER (agents/ponjo-core.mjs); and the game
// drawn from the person's own view alone, with the app's classes and faces.
// The players run on Claude Haiku through infer.ponjo.app (relay/worker.js),
// or on the visitor's own key and model, kept in this browser.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, matchMedia, HTMLDialogElement */

import { INFER } from '../agents/ponjo-core.mjs';
import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { DECIDE, HUMAN, MAX_SPEECH, PERSONAS, ROLE_NAMES, begin, decided, expire, fail, isPerson, land, newGame, plan, prompt, retry, show, turn } from './werewolf-runtime.js';

const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const SAVED = 'ponjo-poker'; // the visitor's own provider, key and model: the poker page's, so one key serves both
const HOSTED = 'https://infer.ponjo.app/infer/anthropic'; // Ponjo's key and model, for ponjo.app's pages only
const TURN = 90_000; // ms a turn may take; then everyone still due is taken as doing nothing
const NIGHT = 6000; // ms a night lasts at least, so its length says nothing about who acted in it

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

let game = null;
const running = new Set(); // players with a run going
const typing = new Set(); // players typing their speech, shown in the log
let settings = load(SAVED); // the visitor's own provider, key and model, or null for Ponjo's

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? null;
  } catch {
    return null;
  }
}
function store(value, key = SAVED) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
}
const infer = () => (!settings ? INFER.anthropic({ model: 'claude-haiku-5-5', key: 'ponjo' }, HOSTED) // the Worker sets the key, model and effort
  : settings.provider === 'openai' ? INFER.openai({ endpoint: settings.endpoint, model: settings.model, key: settings.key })
    : INFER.anthropic({ model: settings.model, key: settings.key, effort: 'low' }));

// ---- the controller ----

// Every change: draw it, then look again. A look starts what `plan` says is
// due and times the turn; that is all it does. A night is held on screen
// till NIGHT has passed, and nothing more starts till then.
function changed() {
  if (!game || holdNight()) return;
  draw();
  for (const due of plan(game, running)) run(due);
  timeTurn();
}
let night = { day: 0, from: 0 };
function holdNight() {
  const s = game.state;
  if (s.phase === 'night' && night.day !== s.day) night = { day: s.day, from: Date.now() };
  const left = night.from + NIGHT - Date.now();
  if (s.phase === 'night' || night.day !== s.day || left <= 0) return false;
  clearTimeout(holdNight.timer);
  holdNight.timer = setTimeout(changed, left);
  return true;
}

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
setInterval(() => game && drawClock(show(game)), 1000);

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
    const { calls, text } = await infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
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
  running.clear();
  typing.clear();
  clearTimeout(clock.timer);
  clock = { at: '', ends: 0 };
  night = { day: 0, from: 0 };
  picked = null;
  formAt = '';
  seats = game.players.map((id, i) => seatNode(id, i, game.players.length));
  $('.ww-ring').replaceChildren(...seats);
  changed();
}

// ---- the circle ----

let seats = [];
let picked = null; // the seat the person picked as their action's target
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const label = (id) => (isPerson(id) ? 'You' : id);
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
  plate.append(el('span', 'pk-name', label(id)), el('span', 'pk-stack', `Seat ${i + 1}`), el('span', 'ww-role-of'), el('span', 'pk-tag'));
  node.append(face, plate);
  return node;
}
const cap = (text) => text[0].toUpperCase() + text.slice(1);
const roleName = (role) => cap(ROLE_NAMES[role]);
const article = (role) => (role === 'seer' || role === 'witch' ? 'the' : 'a');
// Whom the person may pick now, for their action: none when it takes no target.
function pickable(v, i) {
  if (!v.due || !v.seats[i].alive) return false;
  if (v.due.kind === 'kill') return !v.pack.includes(i);
  if (['check', 'vote'].includes(v.due.kind) || (v.due.kind === 'potion' && v.due.poison)) return i !== v.seat;
  return false;
}
// What a seat shows under its name: what it is doing, as far as the person may know.
function tag(v, i) {
  const id = game.players[i];
  const s = v.seats[i];
  const awake = v.phase !== 'night' || v.pack?.includes(i) || i === v.seat; // at night, others' runs would say who has a role
  if (v.phase === 'over') return [s.alive ? '' : 'Dead', 'fold'];
  if (!s.alive && !(v.phase === 'last' && v.speaker === i)) return ['Dead', 'fold'];
  if (awake && game.notes[id]?.failed) return ['Can\'t reach the model', 'failed'];
  if (v.speaker === i) return [typing.has(id) ? 'Speaking…' : i === v.seat ? 'Your turn' : 'Thinking…', 'wait'];
  if (v.phase === 'vote') return v.voted.includes(i) ? ['Voted', ''] : ['Voting…', 'wait'];
  if (v.phase === 'night' && v.pack?.includes(i)) {
    const pick = v.log.findLast((e) => e.type === 'pick' && e.day === v.day && e.seat === i);
    return pick ? [`Kill: ${label(game.players[pick.target])}`, ''] : ['Choosing…', 'wait'];
  }
  return ['', ''];
}
function presence(v, i) {
  const id = game.players[i];
  if (!v.seats[i].alive) return 'away';
  if (v.phase === 'night') return (i === v.seat && v.due) || (v.pack?.includes(i) && running.has(id)) ? 'working' : 'away'; // the village sleeps
  if (v.phase === 'over') return 'idle';
  return running.has(id) || (i === v.seat && v.due) ? 'working' : 'idle';
}
function drawRing(v) {
  const ring = $('.ww-ring');
  ring.toggleAttribute('data-picking', seats.some((_, i) => pickable(v, i)));
  for (const [i, node] of seats.entries()) {
    const s = v.seats[i];
    node.toggleAttribute('data-dead', !s.alive);
    node.toggleAttribute('data-turn', v.speaker === i);
    node.setAttribute('aria-disabled', String(!pickable(v, i)));
    node.setAttribute('aria-pressed', String(picked === i));
    $('.pj-agent-face', node).dataset.presence = presence(v, i);
    $('.ww-role-of', node).textContent = s.role ? roleName(s.role) : '';
    const [text, kind] = tag(v, i);
    const tagNode = $('.pk-tag', node);
    if (tagNode.textContent !== text) {
      Object.assign(tagNode, { textContent: text }).dataset.kind = kind;
      if (!still) tagNode.animate([{ opacity: 0, transform: 'scale(0.8)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'ease-out' });
    }
  }
}
function drawCenter(v) {
  const name = (i) => (i === v.seat ? 'You' : game.players[i]);
  const alive = v.seats.filter((s) => s.alive).length;
  $('.ww-phase').textContent = v.phase === 'over' ? (v.winner === 'village' ? 'The village wins' : 'The werewolves win')
    : `${v.phase === 'night' ? 'Night' : 'Day'} ${v.day}${v.phase === 'vote' ? ' · Vote' : v.phase === 'last' ? ' · Last words' : ''}`;
  $('.ww-sub').textContent = v.phase === 'over' ? `${v.seats[v.seat].role === 'wolf' ? (v.winner === 'wolves' ? 'You won' : 'You lost') : v.winner === 'village' ? 'You won' : 'You lost'}. Every role is shown.`
    : v.phase === 'night' ? 'The village sleeps.'
      : v.phase === 'vote' ? `${v.voted.length} of ${alive} have voted.`
        : v.speaker === v.seat ? (v.phase === 'last' ? 'Your last words.' : 'Your turn to speak.') : `${name(v.speaker)} ${v.phase === 'last' ? 'gives last words' : 'is speaking'}.`;
  $('.ww-over').hidden = v.phase !== 'over';
}

// ---- you: your role, and what you may do ----

let formAt = ''; // the turn the form was set up for
const form = $('.ww-act');
function drawMe(v) {
  const role = v.seats[v.seat].role;
  const others = v.pack?.filter((i) => i !== v.seat).map((i) => game.players[i]) ?? [];
  const line = $('.ww-role');
  line.replaceChildren(`You are ${article(role)} `, el('b', '', ROLE_NAMES[role]), '.');
  if (others.length) line.append(` The other werewolf${others.length > 1 ? 's' : ''}: ${others.join(' and ')}.`);
  if (v.potions && role === 'witch') line.append(` Save ${v.potions.save ? 'unused' : 'used'}, poison ${v.potions.poison ? 'unused' : 'used'}.`);
  if (!v.alive && v.phase !== 'over' && v.phase !== 'last') line.append(' You are dead: the game plays on.');
  form.hidden = !v.due;
  if (!v.due) return;
  if (formAt !== v.due.at) {
    formAt = v.due.at;
    picked = null;
    form.elements.text.value = '';
    $('.ww-error').hidden = true;
  }
  const kind = v.due.kind;
  const who = picked === null ? null : game.players[picked];
  const attacked = v.log.findLast((e) => e.type === 'attacked' && e.day === v.day);
  $('.ww-ask').textContent = {
    kill: () => (v.due.round === 2 ? 'The pack disagreed: pick once more.' : 'Pick a player for the pack to kill tonight.'),
    check: () => 'Pick a player to check.',
    potion: () => `${attacked ? `The wolves attacked ${attacked.target === v.seat ? 'you' : game.players[attacked.target]} tonight.` : v.potions.save ? 'The wolves attacked no one tonight.' : 'You no longer learn whom the wolves attack.'}${v.due.poison ? ' Pick a player to poison, or not.' : ''}`,
    speak: () => 'Your turn to speak.',
    last: () => 'You were voted out. Your last words?',
    vote: () => 'Pick a player to vote out.',
  }[kind]();
  const text = form.elements.text;
  text.hidden = !['speak', 'last', 'kill'].includes(kind);
  text.maxLength = MAX_SPEECH;
  text.placeholder = kind === 'kill' ? 'A line only the pack hears (optional)' : 'Say it to the village';
  const main = $('[data-do="main"]', form);
  main.hidden = kind === 'potion' && !v.due.poison;
  main.textContent = { kill: 'Kill', check: 'Check', potion: 'Poison', speak: 'Speak', last: 'Speak', vote: 'Vote' }[kind] + (who && !['speak', 'last'].includes(kind) ? ` ${label(who)}` : '');
  main.disabled = ['speak', 'last'].includes(kind) ? !text.value.trim() : picked === null;
  $('[data-do="abstain"]', form).hidden = kind !== 'vote';
  $('[data-do="save"]', form).hidden = kind !== 'potion' || !v.due.save;
  if (attacked) $('[data-do="save"]', form).textContent = `Save ${label(game.players[attacked.target])}`;
  $('[data-do="pass"]', form).hidden = kind !== 'potion';
  drawClock(v);
}
function drawClock(v) {
  $('.ww-clock').textContent = v.due && clock.ends ? `${Math.max(0, Math.ceil((clock.ends - Date.now()) / 1000))}s left` : '';
}

// What the person does, through the writer, as an AI player's proposal.
function perform(type) {
  const v = show(game);
  if (!v.due) return;
  const kind = v.due.kind;
  const action = { type: type === 'main' ? { kill: 'kill', check: 'check', potion: 'poison', speak: 'speak', last: 'speak', vote: 'vote' }[kind] : type };
  if (['kill', 'check', 'poison', 'vote'].includes(action.type)) action.target = picked;
  const { rejected } = land(game, HUMAN, { at: v.due.at }, { action, say: form.elements.text.value });
  const error = $('.ww-error');
  error.textContent = rejected ?? '';
  error.hidden = !rejected;
  if (!rejected) form.hidden = true; // drawn again once the night, if held, is over
  changed();
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  perform('main');
});
form.addEventListener('click', (event) => {
  const type = event.target.closest('[data-do]:not([type=submit])')?.dataset.do;
  if (type) perform(type);
});
form.elements.text.addEventListener('input', () => drawMe(show(game)));
form.elements.text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
$('.ww-ring').addEventListener('click', (event) => {
  const node = event.target.closest('.ww-seat');
  if (!node || node.getAttribute('aria-disabled') === 'true') return;
  const i = Number(node.dataset.seat);
  picked = picked === i ? null : i;
  draw();
});

// ---- the log: what the person's seat saw, as a chat app shows it ----

const SECRET = { pick: 'Pack', kill: 'Pack', check: 'Seer', attacked: 'Witch', save: 'Witch', poison: 'Witch' };
function drawFeed(v) {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const name = (i) => (i === v.seat ? 'you' : game.players[i]);
  const Name = (i) => cap(name(i));
  const names = (list) => list.map(Name).join(' and ');
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const say = (i, text, note) => {
    rows.push(message(game.players[i], text, note, last === i));
    last = i;
  };
  const line = (text, secret) => {
    const row = el('li', 'pk-dealer', secret ? `${secret}: ${text}` : text);
    if (secret) row.dataset.secret = '';
    rows.push(row);
    last = null;
  };
  for (const e of v.log) {
    const secret = SECRET[e.type];
    if (e.type === 'night') line(`Night ${e.day} falls. Everyone closes their eyes.`);
    else if (e.type === 'pick') {
      line(`${Name(e.seat)} ${e.seat === v.seat ? 'want' : 'wants'} to kill ${name(e.target)}${e.round === 2 ? ' (second pick)' : ''}.`, secret);
      if (e.text) say(e.seat, e.text, 'to the pack');
    } else if (e.type === 'kill') line(e.target === null ? 'The pack kills no one.' : `The pack kills ${name(e.target)}.`, secret);
    else if (e.type === 'check') line(`${Name(e.seat)} checked ${name(e.target)}: ${e.wolf ? 'a werewolf' : 'not a werewolf'}.`, secret);
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
  for (const id of typing) {
    const row = message(id, '', '', false);
    row.classList.add('pk-typing');
    $('.pk-msg-text', row).append(el('i'), el('i'), el('i'));
    $('.pk-msg-text', row).setAttribute('aria-label', `${id} is typing`);
    rows.push(row);
  }
  for (const [id, n] of Object.entries(game.notes)) {
    if (!n.failed) continue;
    const named = v.phase !== 'night' || v.pack?.includes(game.players.indexOf(id)); // at night, who failed would say who has a role
    const row = el('li', 'pk-dealer', `${named ? id : 'A player'} could not reach the model: ${n.failed.why}`);
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
// A message: yours on the right; others' on the left with their face and,
// first in a run of theirs, their name.
function message(id, text, note, more) {
  const item = el('li', 'pk-msg');
  if (more) item.dataset.more = '';
  const col = el('div', 'pk-msg-col');
  if (isPerson(id)) item.dataset.mine = '';
  else item.append(faceOf(id));
  if (!more && (!isPerson(id) || note)) {
    const head = el('span', 'pk-msg-name', isPerson(id) ? '' : id);
    if (note) head.append(el('small', '', note));
    col.append(head);
  }
  col.append(el('div', 'pk-msg-text', text));
  item.append(col);
  return item;
}

function draw() {
  if (!game || holdNight()) return;
  const v = show(game);
  if (!v.due) picked = null;
  drawRing(v);
  drawCenter(v);
  drawMe(v);
  drawFeed(v);
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
    summary.append(icon('chevron'), faceOf(id), el('span', 'pj-trace-title', id), el('span', 'pj-trace-meta', `${roleName(roles[seat])}, ${game.state.seats[seat].alive ? 'alive' : 'dead'}`));
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

// ---- setup: the visitor's provider, key and model, as on the poker page ----

const setup = $('.pk-setup');
let provider = settings?.provider ?? 'anthropic';
let model = settings?.provider === 'anthropic' ? settings.model : 'claude-haiku-5-5';

function pick(attr, value) {
  for (const b of setup.querySelectorAll(`[${attr}]`)) b.setAttribute('aria-checked', String(b.getAttribute(attr) === value));
}
function drawSetup() {
  pick('data-provider', provider);
  pick('data-model', model);
  for (const f of setup.querySelectorAll('[data-for]')) f.hidden = f.dataset.for !== provider;
  const endpoint = setup.elements.endpoint.value || setup.elements.endpoint.placeholder;
  let host = 'api.anthropic.com';
  if (provider === 'openai') try { host = new URL(endpoint).host; } catch { host = 'the base URL above'; }
  $('[data-host]', setup).textContent = host;
  const key = setup.elements.key;
  key.required = !(settings && settings.provider === provider);
  key.placeholder = settings?.provider === provider ? `••••••••${settings.key.slice(-4)}` : provider === 'anthropic' ? 'sk-ant-…' : '';
}
function openSetup() {
  if (settings?.provider) provider = settings.provider;
  if (settings?.provider === 'openai') {
    setup.elements.endpoint.value = settings.endpoint;
    setup.elements.model.value = settings.model;
  }
  setup.elements.key.value = '';
  $('.pk-error', setup).hidden = true;
  forget.hidden = !settings;
  drawSetup();
  setup.hidden = false;
  document.body.classList.add('pk-setting-up');
  setup.elements.key.focus();
}
setup.addEventListener('click', (event) => {
  const b = event.target.closest('[data-provider], [data-model]');
  if (!b) return;
  if (b.dataset.provider) provider = b.dataset.provider;
  if (b.dataset.model) model = b.dataset.model;
  drawSetup();
});
setup.elements.endpoint.addEventListener('input', drawSetup);
setup.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = setup.elements;
  const key = f.key.value.trim() || (settings?.provider === provider ? settings.key : '');
  const next = provider === 'openai'
    ? { provider, key, endpoint: f.endpoint.value.trim() || f.endpoint.placeholder, model: f.model.value.trim() || f.model.placeholder }
    : { provider, key, model };
  const error = $('.pk-error', setup);
  if (!key) {
    error.textContent = 'Paste an API key.';
    error.hidden = false;
    return;
  }
  use(next);
});
// From now on the players run on `next`, the visitor's own, or null for Ponjo's: what failed is tried again.
function use(next) {
  settings = next;
  store(settings);
  setup.hidden = true;
  document.body.classList.remove('pk-setting-up');
  drawModel();
  if (game) for (const [id, n] of Object.entries(game.notes)) if (n.failed) retry(game, id);
  changed();
}
const forget = el('button', 'pj-link-button pk-forget', 'Forget my key and play on Ponjo\'s');
forget.type = 'button';
forget.addEventListener('click', () => use(null));
function drawModel() {
  $('.pk-model').textContent = !settings ? 'The players run on Claude Haiku 5.5.' : `The players run on ${settings.provider === 'anthropic' ? `Claude ${$(`[data-model="${settings.model}"]`, setup).textContent}` : settings.model}, with your key.`;
  $('[data-action="key"]').textContent = settings ? 'Change' : 'Use your own key';
}

// ---- wiring ----

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'new') openStart();
  else if (action === 'thinking') showThinking();
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') openSetup();
  else if (action === 'cancel') {
    setup.hidden = true;
    document.body.classList.remove('pk-setting-up');
  }
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});

setup.querySelector('.pk-error').after(forget);
drawModel();
openStart();
