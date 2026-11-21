// The spy page (site/spy.html): a person, any friends they invite and AI
// players round one table at a game of Who's the Spy. The rules
// (spy-rules.js) own what must be exact; the players decide the rest from
// the rules and what their seat may see (spy-world.js). As on the poker page
// (preview/poker.js), Ponjo's agent runtime (src/core/runtime.js) runs them
// on the table as a world: here, a run is one call of the visitor's model
// (game-page.js, with the log's messages and the vote arrows). The table is
// drawn as the werewolf page draws its clearing, from a seat's own view
// alone. Friends join by a link (poker-share.js): the host's page holds the
// table and runs the AI players, and sends each friend's page its seat's
// view; a friend's page, opened at `#join=<room>`, only draws and sends what
// its player does. preview/build.js bundles it into dist/preview.

/* global document, location, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, arrows, el, load, message, models, notice, store, typingMessage } from './game-page.js';
import { createRuntime } from '../src/core/runtime.js';
import { createRuntimePanel } from '../web/runtime-panel.js';
import { RECONNECT_MS, guestId, host, join } from './poker-share.js';
import { DECIDE, HUMAN, MAX_CLUE, PERSONAS, begin, createWorld, decided, due, expire, intros, introduce, isPerson, land, leave, newTable, playing, seatFriend, show, start } from './spy-world.js';

const TURN = 90_000; // ms a turn may take; then everyone still due is taken as doing nothing
const NAME = 'ponjo-poker-name'; // the visitor's name at a friend's table, as the poker page keeps it
const HELLO_MS = 1800;
const SVG = 'http://www.w3.org/2000/svg';

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the table it joins
const me = ROOM ? guestId(ROOM) : HUMAN; // who this page plays as
const table = newTable(); // the host's; a friend's page draws what the host sends (`remote`)
let remote = null; // a friend's page: the host's last state
const running = new Set(); // players with a run going
const typing = new Set(); // players typing their clue
let failed = new Map(); // players whose run failed → why, until Retry
let clock = { key: '', ends: 0 };
let myVote = null; // { at, target }: this page's vote, its own to see before the vote ends
let away = ''; // a friend's page: why the line to the host is down
// What the page last drew: the seats, for which game; the last vote's arrows and when its dots land; the dealt word; the turn the chat box is for.
let seats = [];
let seatsFor = '';
let votesIn = 0;
let arrowsFor = '';
let dealt = 0;
let chatAt = '';
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

// The players' model. Once the visitor picks another, what failed is tried again.
const ai = models(() => {
  runtime?.retry();
  changed();
});

// ---- the controller ----

// Every change: on the host's page, a friend gone from the table is taken
// as doing nothing on their turn; then draw it, and tell the world, whose
// runtime looks again and starts the runs that are due; time the turn, and
// send friends the table. A friend's page only draws.
function changed() {
  if (ROOM) return draw();
  for (;;) {
    const gone = playing(table) ? due(table.game).map((d) => table.players[d.seat]).filter((id) => isPerson(id) && !table.people.includes(id)) : [];
    if (!gone.length) break;
    expire(table, gone);
  }
  draw();
  world.changed();
  runtime?.sync(); // who is at the table may have changed
  timeTurn();
  share();
}

function timeTurn() {
  const key = playing(table) ? table.turnKey : '';
  if (key === clock.key) return;
  clearTimeout(clock.timer);
  clock = { key, ends: key ? Date.now() + TURN : 0, timer: key && setTimeout(() => {
    if (table.turnKey === key && playing(table)) expire(table);
    changed();
  }, TURN) };
}

// Each player's pace, as a person's at a table: ms from and to before they act.
const PACE = { Ivy: [3000, 5500], Max: [1200, 2500], Juno: [2500, 4500], Sam: [2000, 3500], Lou: [2500, 5000], Remy: [3500, 6500], Pip: [1200, 2600] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const typeTime = (text) => Math.min(6000, Math.max(1200, text.length * 60));

// A run: one call of the model on what the player sees, then the player's
// own time to think; its proposal goes to the world, which lands a clue
// once the player is seen typing it.
async function run({ agent }, { prompt: { rules, situation } }) {
  const at = Date.now();
  const started = performance.now();
  try {
    const { calls, text, usage } = await ai.infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === 'decide')?.args ?? '{}');
    } catch {}
    const [from, to] = PACE[agent.id] ?? [2000, 4000];
    await wait(from + Math.random() * (to - from) - (performance.now() - started));
    return { at, ms: performance.now() - started, outcome: 'ok', usage, made: decided({ thinking: text, ...args }) };
  } catch (error) {
    return { at, ms: performance.now() - started, outcome: 'failed', body: String(error.message).split('\n')[0] };
  }
}

// With ?debug, the host's page shows what the runtime does (the runtime
// panel): every player's word and thinking, so only on asking. An ask is a
// turn of the game: its round, phase, a runoff, the speaker (turn, spy-rules.js).
const panel = !ROOM && new URLSearchParams(location.search).has('debug') ? createRuntimePanel({
  where: 'this table', faceOf: (id) => faceOf(table, id), retry: (id) => runtime.retry(id),
  askText: (id) => {
    const [, , round, phase, runoff] = id.split(':');
    return `Round ${round}, ${phase}${runoff ? ' (runoff)' : ''}`;
  },
}) : null;

// The table as a world, and on the host's page, Ponjo's runtime on it. What
// it says of the players (statuses): who is at work, and whose run failed.
const world = createWorld(() => table, {
  async typing(id, text) {
    typing.add(id);
    draw();
    share();
    await wait(typeTime(text));
    typing.delete(id);
  },
});
const runtime = ROOM ? null : await createRuntime({
  world, run,
  breaker: async () => ({ pauseAfter: Infinity, pauseWithin: 10 }), // the table has no watches to pause
  watching: { read: async () => ({}), note: () => {} },
  trace: (event) => panel?.add(event),
  emit(type, statuses) {
    if (type !== 'agents') return;
    panel?.agents(statuses);
    running.clear();
    for (const s of statuses) if (s.asks.length) running.add(s.id);
    failed = new Map(statuses.filter((s) => s.failed.length).map((s) => [s.id, s.failed.at(-1).why]));
    draw();
    share();
  },
});

// A new game: the players say hello round the table, a line every second
// or two, written for them, so no model is asked; then the first clue.
function startGame(size) {
  start(table, size);
  myVote = null;
  const no = table.gameNo;
  const lines = intros(table);
  changed();
  lines.forEach((line, k) => setTimeout(() => {
    if (table.gameNo !== no) return;
    introduce(table, line);
    changed();
  }, 600 + k * HELLO_MS));
  setTimeout(() => {
    if (table.gameNo !== no) return;
    begin(table);
    changed();
  }, 600 + lines.length * HELLO_MS + 800);
}

// ---- what this page draws: the table as it is here, and its own seat's view ----

const empty = { people: [], names: {}, players: [], hellos: [], greeting: false, gameNo: 0, notes: {} };
const picture = () => (ROOM ? (remote ? { t: remote.table, v: remote.view } : { t: empty, v: null }) : { t: table, v: show(table, HUMAN) });
const label = (t, id) => (id === me ? 'You' : isPerson(id) ? t.names[id] ?? (id === HUMAN ? 'Host' : 'Friend') : id);
const cap = (text) => text[0].toUpperCase() + text.slice(1);
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(''));
function faceOf(t, id) {
  const avatar = el('span', `pj-avatar${isPerson(id) ? '' : ' pj-avatar-agent'}`);
  avatar.append(isPerson(id) ? personFace(label(t, id), id) : agentFace(id));
  return avatar;
}
// One of the page's symbols (site/spy.html): a side's, or the ballot.
function symbol(name) {
  const mark = document.createElementNS(SVG, 'svg');
  mark.classList.add('ww-role-mark');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#${name}`);
  mark.append(use);
  return mark;
}
const SIDE = { spy: 'Spy', civilian: 'Civilian' };
// A side's token, as the campfire's role tokens: a disc in its colour with its symbol, then its word.
function token(role) {
  const node = el('span', 'ww-token');
  node.dataset.role = role;
  const disc = el('span', 'ww-token-disc');
  disc.append(symbol(`sp-${role}`));
  node.append(disc, SIDE[role]);
  return node;
}

// ---- the table: a seat for each player, round it, this page's at the bottom ----

function seatNode(t, id, i, n, mine) {
  const node = el('button', 'ww-seat');
  node.type = 'button';
  node.dataset.seat = i;
  node.style.setProperty('--a', `${90 + (360 * (i - mine)) / n}deg`);
  const face = el('span', 'pj-agent-face');
  face.dataset.presence = 'idle';
  const status = Object.assign(el('span', 'ww-badge'), { hidden: true });
  status.dataset.at = 'status';
  face.append(faceOf(t, id), status);
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
  const idents = el('span', 'ww-idents');
  idents.append(Object.assign(el('span', 'ww-ident'), { hidden: true }));
  plate.append(name, idents, el('span', 'ww-dots'), el('span', 'pk-tag'));
  node.append(face, plate);
  return node;
}
function layout(t) {
  const key = `${t.gameNo}:${t.players.join()}`;
  if (key === seatsFor) return;
  seatsFor = key;
  for (const node of seats) node.remove();
  const mine = Math.max(0, t.players.indexOf(me));
  seats = t.players.map((id, i) => seatNode(t, id, i, t.players.length, mine));
  $('.ww-ring').append(...seats);
}

// The last vote, while it shows: from its result until the next vote begins.
const lastVote = (v) => (v.phase === 'vote' ? null : v.log.findLast((e) => e.type === 'vote'));
const canVote = (t, v, i) => !t.greeting && v.due?.kind === 'vote' && v.due.targets.includes(i);

// A badge on a face: changed, it flips in; gone, it goes.
function badge(node, mark) {
  const key = mark?.[0] ?? '';
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.hidden = !mark;
  if (!mark) return;
  node.replaceChildren(mark[1]());
  node.dataset.kind = mark[2];
  if (!still) node.animate([{ transform: 'rotateY(90deg) scale(0.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(0.3, 1.5, 0.5, 1)' });
}

function drawSeats(t, v) {
  const vote = lastVote(v);
  for (const [i, node] of seats.entries()) {
    const id = t.players[i];
    const s = v.seats[i];
    const out = v.log.findLast((e) => e.type === 'vote' && e.out === i);
    const dots = vote ? Object.values(vote.votes).filter((x) => x === i).length : 0;
    node.toggleAttribute('data-dead', !s.alive);
    node.toggleAttribute('data-turn', !t.greeting && v.phase === 'clue' && v.speaker === i);
    node.toggleAttribute('data-pickable', canVote(t, v, i));
    $('.pj-agent-face', node).dataset.presence = !s.alive ? 'away' : running.has(id) || typing.has(id) || (!t.greeting && v.phase === 'clue' && v.speaker === i) || (i === v.seat && v.due && !t.greeting) ? 'working' : 'idle';
    const status = out ? [`out:${out.round}`, () => symbol('ww-ballot'), 'dead', `Voted out, round ${out.round}`]
      : v.voted.includes(i) ? ['voted', () => symbol('ww-ballot'), 'voted', 'Has voted'] : null;
    badge($('[data-at="status"]', node), status);
    const ident = $('.ww-ident', node);
    if (ident.dataset.role !== (s.role ?? '')) {
      ident.dataset.role = s.role ?? '';
      ident.replaceChildren(...(s.role ? [token(s.role)] : []));
      ident.hidden = !s.role;
    }
    const dotsNode = $('.ww-dots', node);
    if (dotsNode.childElementCount !== dots) dotsNode.replaceChildren(...Array.from({ length: dots }, (_, k) => Object.assign(el('i'), { style: `animation-delay: ${votesIn + k * 120}ms` })));
    $('.pk-tag', node).textContent = failed.has(id) ? 'Can\'t reach the model' : '';
    $('.pk-tag', node).dataset.kind = 'failed';
    const words = [i === v.seat ? 'You' : label(t, id), status?.[3], s.role && SIDE[s.role], vote && i in vote.votes && (vote.votes[i] === null ? 'No vote' : `Voted ${label(t, t.players[vote.votes[i]])}`), dots && `${dots} vote${dots > 1 ? 's' : ''}`, !isPerson(id) && PERSONAS.find((p) => p.id === id).blurb];
    node.title = words.filter(Boolean).join(' · ');
  }
  const ring = seats[v.seat] && $('.ww-timer', seats[v.seat]);
  if (!ring) return;
  const on = Boolean(v.due) && !t.greeting && clock.ends > 0;
  ring.classList.toggle('ww-timer-on', on);
  if (!on || ring.dataset.at === v.due.at) return;
  ring.dataset.at = v.due.at;
  const circle = ring.firstChild;
  circle.style.animation = 'none';
  void circle.getBoundingClientRect();
  circle.style.animation = `ww-drain ${TURN}ms linear ${clock.ends - TURN - Date.now()}ms forwards`;
}

// Arrows from face to face: who voted for whom, from the vote's result until
// the next vote, drawn in one by one when the result comes; during a vote, only this page's own.
function drawVotes(t, v) {
  const vote = lastVote(v);
  const pairs = vote ? Object.entries(vote.votes).filter(([, x]) => x !== null).map(([s, x]) => [Number(s), x, '']) : [];
  if (v.phase === 'vote' && myVote?.at === v.log.length && myVote.target !== null) pairs.push([v.seat, myVote.target, 'mine']);
  const key = vote ? `${t.gameNo}:${v.log.lastIndexOf(vote)}` : '';
  const fresh = vote && arrowsFor !== key;
  if (vote) arrowsFor = key;
  const ms = arrows($('.ww-votes'), pairs, (i) => $('.pj-avatar', seats[i]), fresh && !still);
  if (ms !== null) votesIn = ms;
}
addEventListener('resize', () => draw());

// Over the table: the round, and one line that changes with the moment.
function drawCenter(t, v) {
  const over = v?.phase === 'over';
  const mine = v && v.seat !== null ? v.seats[v.seat].role : null;
  $('.ww-phase-text').textContent = !v || t.greeting ? 'Who\'s the Spy' : over ? (v.winner === 'civilians' ? 'The civilians win' : `The ${v.seats.filter((s) => s.role === 'spy').length > 1 ? 'spies win' : 'spy wins'}`) : `Round ${v.round}`;
  const speaker = v && v.speaker !== null ? (v.speaker === v.seat ? 'Your' : `${label(t, t.players[v.speaker])}'s`) : '';
  const tied = v?.runoff ? list(v.runoff.map((i) => (i === v.seat ? 'you' : label(t, t.players[i])))) : '';
  const [key, mark, words] = !v ? ['wait', null, ROOM ? 'Waiting for the host to start a game' : '']
    : t.greeting ? ['hello', null, 'Everyone says hello']
      : over ? ['over', null, mine ? ((mine === 'spy') === (v.winner === 'spies') ? 'You won' : 'You lost') : '']
        : v.phase === 'vote' ? [`vote:${v.runoff}`, symbol('ww-ballot'), v.runoff ? `Vote between ${tied}` : 'Vote for the spy']
          : [`clue:${v.speaker}`, null, v.runoff ? `A tie: ${cap(tied)} give one more clue. ${speaker} clue` : `${speaker} clue`];
  const sub = $('.ww-sub');
  if (sub.dataset.key !== key) {
    sub.dataset.key = key;
    sub.replaceChildren(...[mark, words].filter(Boolean));
    if (!still && words) sub.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'ease-out' });
  }
  $('.ww-over').hidden = !over;
  $('[data-action="new"]').hidden = Boolean(ROOM);
}

// The middle of the table: your word, face up; once it is over, both.
function drawWord(t, v) {
  const card = $('.sp-word');
  const over = v?.phase === 'over';
  card.hidden = !v || (!v.word && !over);
  if (card.hidden) return;
  card.toggleAttribute('data-over', over);
  $('.sp-word-label', card).textContent = over ? 'Civilians · Spies' : 'Your word';
  $('.sp-word-text', card).textContent = over ? `${v.words.civilian} · ${v.words.spy}` : v.word;
  if (dealt !== t.gameNo) {
    dealt = t.gameNo;
    card.removeAttribute('data-dealt');
    void card.offsetWidth;
    card.toggleAttribute('data-dealt', true);
  }
}

// Under the table: what this page's player may do now.
function drawMe(t, v) {
  const seated = v && v.seat !== null;
  const voted = v?.phase === 'vote' && v.voted.includes(v.seat);
  $('.ww-ask').textContent = away || (!v ? (ROOM && remote?.table.people.includes(me) ? 'You are at the table: you play from the next game.' : '')
    : t.greeting || v.phase === 'over' ? ''
      : !seated ? (t.people.includes(me) ? 'Watching: you play from the next game.' : 'Watching.')
        : !v.alive ? 'You are out: watch the rest.'
          : v.due?.kind === 'clue' ? 'Your turn: give a clue to your word in the chat, without saying it.'
            : v.due?.kind === 'vote' ? 'Click the player you think is a spy.'
              : voted ? 'You voted. Waiting for the others.' : '');
}

// The chat box: your clue on your turn; muted otherwise, and why.
const chat = $('.ww-chat-box');
const box = chat.elements.text;
function drawChat(t, v) {
  const mine = !t.greeting && v?.due?.kind === 'clue';
  if (chatAt !== (v?.due?.at ?? '')) {
    chatAt = v?.due?.at ?? '';
    box.value = '';
    $('.ww-error').hidden = true;
  }
  chat.dataset.audience = mine ? 'all' : 'muted';
  box.disabled = !mine;
  box.maxLength = MAX_CLUE;
  box.placeholder = mine ? 'Your clue, without your word…' : '';
  $('[type=submit]', chat).disabled = !mine || !box.value.trim();
  const speaker = v && v.speaker !== null && v.speaker !== v.seat ? label(t, t.players[v.speaker]) : null;
  const why = mine ? [icon('users'), 'Everyone hears your clue.']
    : [symbol('ww-muted'), !v ? 'No game yet.'
      : t.greeting ? 'Muted while everyone says hello.'
        : v.phase === 'over' ? 'The game is over.'
          : v.seat === null ? 'Watching: you play from the next game.'
            : !v.alive ? 'You are out: the out don\'t clue.'
              : v.phase === 'vote' ? 'Muted while everyone votes.'
                : speaker ? `Muted: ${speaker} is giving a clue. You clue in turn.` : 'Muted.'];
  const line = $('.ww-audience');
  if (line.dataset.key !== why.at(-1)) {
    line.dataset.key = why.at(-1);
    line.dataset.audience = mine ? 'all' : 'muted';
    line.replaceChildren(...why);
  }
}
chat.addEventListener('submit', (event) => {
  event.preventDefault();
  if (chat.dataset.audience === 'all') perform({ type: 'clue' });
});
box.addEventListener('input', () => draw());
box.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chat.requestSubmit();
  }
});

// What this page's player does: landed here through the writer, as an AI
// player's proposal, or on a friend's page sent to the host, which lands it.
function perform(action) {
  const { v } = picture();
  if (!v?.due) return;
  const say = action.type === 'clue' ? box.value : '';
  if (action.type === 'vote') myVote = { at: v.log.length, target: action.target };
  if (ROOM) {
    guest.send({ type: 'act', action: { ...action, at: v.due.at }, say });
    return draw();
  }
  const { rejected } = land(table, HUMAN, { at: v.due.at }, { action, say });
  refused(rejected);
  changed();
}
function refused(why) {
  $('.ww-error').textContent = why ?? '';
  $('.ww-error').hidden = !why;
  if (why) myVote = null;
}

// ---- the log: what this page's seat saw, as a chat app shows it ----

function drawFeed(t, v) {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const name = (i) => (i === v.seat ? 'you' : label(t, t.players[i]));
  const Name = (i) => cap(name(i));
  const say = (id, text, more = false) => {
    const side = v?.seats[t.players.indexOf(id)]?.role;
    rows.push(message({ face: id !== me && faceOf(t, id), name: [label(t, id), ...(side ? [token(side)] : [])], text, mine: id === me, more }));
  };
  for (const h of t.hellos) {
    say(h.id, h.text, last === h.id);
    last = h.id;
  }
  for (const e of v?.log ?? []) {
    if (e.type === 'clue' && !e.silent) {
      say(t.players[e.seat], e.text, last === e.seat);
      last = e.seat;
      continue;
    }
    last = null;
    if (e.type === 'round') rows.push(notice(`${e.round === 1 ? 'Round 1. Everyone has their word: one clue each, in seat order' : `Round ${e.round}`}, from ${name(e.from)}.`));
    else if (e.type === 'clue') rows.push(notice(`${Name(e.seat)} gave no clue.`));
    else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, x]) => `${Name(Number(s))} → ${x === null ? 'no vote' : name(x)}`);
      const row = notice(`The vote${e.second ? ' between the tied' : ''}: ${votes.join(', ')}. `);
      if (e.out !== null) row.append(`${Name(e.out)} ${e.out === v.seat ? 'are' : 'is'} out: `, token(e.role));
      else row.append(e.runoff ? `A tie between ${list(e.runoff.map(name))}: one more clue each, then a vote between them.` : 'No one is out.');
      rows.push(row);
    } else if (e.type === 'over') {
      rows.push(notice(`${e.winner === 'civilians' ? 'Every spy is out: the civilians win.' : 'The spies made it: they win.'} The civilians' word was "${e.words.civilian}"; the spies', "${e.words.spy}".`));
    }
  }
  for (const id of typing) rows.push(typingMessage(faceOf(t, id), id));
  for (const [id, why] of failed) {
    const row = notice(`${id} could not reach the model: ${why}`);
    row.dataset.failed = '';
    if (!ROOM) {
      const again = el('button', 'pj-link-button', 'Retry');
      again.type = 'button';
      again.addEventListener('click', () => runtime.retry(id));
      row.append(' ', again);
    } else row.append(' Waiting for the host to retry.');
    rows.push(row);
  }
  feed.replaceChildren(...rows);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function draw() {
  const { t, v } = picture();
  layout(t);
  if (v) {
    drawVotes(t, v);
    drawSeats(t, v);
  }
  drawCenter(t, v);
  drawWord(t, v);
  drawMe(t, v);
  drawChat(t, v);
  drawFeed(t, v);
}

// ---- a seat's menu: your vote ----

const menu = el('ul', 'pj-block-menu pk-menu ww-menu');
menu.setAttribute('role', 'menu');
menu.hidden = true;
document.body.append(menu);
$('.ww-ring').addEventListener('click', (event) => {
  const node = event.target.closest('.ww-seat');
  const { t, v } = picture();
  if (!node || !v) return;
  const i = Number(node.dataset.seat);
  const id = t.players[i];
  if (!canVote(t, v, i)) return;
  const head = el('li', 'pk-menu-head');
  const who = el('span', 'pk-menu-text');
  who.append(el('b', '', label(t, id)));
  if (!isPerson(id)) who.append(el('span', '', PERSONAS.find((p) => p.id === id).blurb));
  head.append(faceOf(t, id), who);
  const doIt = el('li', '', `Vote for ${label(t, id)}`);
  doIt.setAttribute('role', 'menuitem');
  doIt.dataset.do = '';
  doIt.addEventListener('click', () => {
    menu.hidden = true;
    perform({ type: 'vote', target: i });
  });
  menu.replaceChildren(head, doIt);
  menu.hidden = false;
  const at = node.querySelector('.pk-plate').getBoundingClientRect();
  const left = Math.min(Math.max(8, at.left + at.width / 2 - menu.offsetWidth / 2), innerWidth - menu.offsetWidth - 8);
  const top = at.bottom + 4 + menu.offsetHeight < innerHeight ? at.bottom + 4 : Math.max(8, at.top - menu.offsetHeight - 4);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
});
document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !event.target.closest('.ww-menu, .ww-seat')) menu.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') menu.hidden = true;
});

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
    meta.append(token(v.seats[seat].role), ` "${v.seats[seat].word}"`);
    summary.append(icon('chevron'), faceOf(t, id), el('span', 'pj-trace-title', id), meta);
    part.append(summary);
    const thoughts = t.notes[id]?.thoughts ?? [];
    if (!thoughts.length) part.append(el('p', 'pj-empty', 'No decisions.'));
    for (const th of thoughts) {
      const target = Number.isInteger(th.action?.target) ? ` ${label(t, t.players[th.action.target])}` : '';
      part.append(el('h3', 'pj-setting-group', `Round ${th.round}${th.kind ? ` · ${th.kind}${target}` : ''}`));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', th.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- a new game: how many players, with whoever is at the table ----

const starting = $('.ww-start');
let size = 6;
function openStart() {
  const people = table.people.length;
  size = Math.max(size, people, 5);
  for (const b of starting.querySelectorAll('[data-size]')) {
    b.setAttribute('aria-checked', String(Number(b.dataset.size) === size));
    b.disabled = Number(b.dataset.size) < people;
  }
  const names = table.people.map((id) => label(table, id));
  $('.sp-people').textContent = `At the table: ${names.join(', ')}. AI players take the ${size - people === 1 ? 'other seat' : `other ${size - people} seats`}.`;
  starting.hidden = false;
  document.body.classList.add('pk-buying-in');
}
starting.addEventListener('click', (event) => {
  const b = event.target.closest('[data-size]');
  if (!b || b.disabled) return;
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
  inviting.elements.name.value = table.names[HUMAN] ?? load(NAME) ?? '';
  room ??= await host({ joined, heard: (peer, message) => peers.has(peer) && apply(peer, message), left });
  inviting.elements.link.value = room.link;
}
function closeInvite() {
  const name = inviting.elements.name.value.trim().slice(0, 20);
  if (name) {
    table.names[HUMAN] = name;
    store(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-setting-up');
  if (!starting.hidden) openStart();
  changed();
}
// A friend's page opens. One that was at the table (its page reloaded) is
// back in its seat, by the name it had.
function joined(peer, hello) {
  if (!/^f[0-9a-f]{8}$/.test(String(hello?.id))) return room.turnAway(peer, 'Not a player');
  peers.set(peer, hello.id);
  if (table.names[hello.id]) seatFriend(table, hello.id, table.names[hello.id]);
  if (!starting.hidden) openStart();
  changed();
}
// A friend's page goes: they leave the table unless a page of theirs is back within RECONNECT_MS (a reload).
function left(peer) {
  const id = peers.get(peer);
  peers.delete(peer);
  setTimeout(() => {
    if (!id || [...peers.values()].includes(id)) return;
    leave(table, id);
    if (!starting.hidden) openStart();
    changed();
  }, RECONNECT_MS);
}
// What a friend's page sends: to sit at the table, or what its player does.
function apply(peer, message) {
  const id = peers.get(peer);
  if (message.type === 'sit') {
    seatFriend(table, id, String(message.name ?? '').trim().slice(0, 20) || 'Friend');
    if (!starting.hidden) openStart();
  } else if (message.type === 'act' && message.action && typeof message.action === 'object') {
    const { type, target, at } = message.action;
    const { rejected } = land(table, id, { at }, { action: { type: String(type), ...(Number.isInteger(target) ? { target } : {}) }, say: String(message.say ?? '') });
    if (rejected) room.send(peer, { type: 'rejected', why: rejected });
  } else return;
  changed();
}

// Each friend's page gets the table as its player may see it: its own
// seat's view, who is at the table, and the AI players' thinking once the game is over.
function share() {
  if (!room) return;
  const over = table.game?.phase === 'over';
  for (const [peer, id] of peers) {
    const { people, names, players, hellos, greeting, gameNo } = table;
    const notes = over ? table.notes : {};
    room.send(peer, { type: 'state', table: { people, names, players, hellos, greeting, gameNo, notes }, view: show(table, id), running: [...running], typing: [...typing], failed: [...failed], clock: clock.ends ? clock.ends - Date.now() : 0 });
  }
}

// A friend's page: the table as the host sends it.
const guest = ROOM && join(ROOM, { id: me }, {
  heard(message) {
    away = '';
    if (message.type === 'rejected') {
      refused(message.why);
      return draw();
    }
    if (message.type !== 'state') return;
    remote = message;
    if (!joining.hidden && message.table.people.includes(me)) closeJoin(); // back at the table after a reload
    for (const [set, ids] of [[running, message.running], [typing, message.typing]]) set.clear() || ids.forEach((id) => set.add(id));
    failed = new Map(message.failed);
    clock = { ends: message.clock && Date.now() + message.clock };
    draw();
  },
  away(reason) {
    away = reason === 'host' ? 'The host is away. Waiting for them…' : reason === 'line' ? 'Reconnecting…' : reason;
    draw();
  },
});
const joining = $('.sp-join');
function closeJoin() {
  joining.hidden = true;
  document.body.classList.remove('pk-buying-in');
}
joining.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = joining.elements.name.value.trim().slice(0, 20) || 'Friend';
  store(name, NAME);
  guest.send({ type: 'sit', name });
  closeJoin();
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
  } else if (action === 'watch') closeJoin();
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});

if (ROOM) {
  for (const node of document.querySelectorAll('[data-action="invite"], [data-action="key"]')) node.hidden = true;
  $('.pk-model').textContent = 'You joined a friend\'s table: the AI players run on their page.';
  joining.elements.name.value = load(NAME) ?? '';
  joining.hidden = false;
  document.body.classList.add('pk-buying-in');
} else {
  ai.draw();
  openStart();
}
draw();
