// The spy page (site/spy.html): a person, any friends they invite and AI
// players round one table at a game of Who's the Spy. The rules
// (spy-rules.js) own what must be exact; the table is a world
// (spy-world.js) on the runtime's core (src/core/): a store in this page,
// kept in the browser's storage on each change, so a refresh goes on with
// the game. Each member has a controller: an AI player's program is one
// call of the visitor's model (game-page.js, with the log's messages and the
// vote arrows); the person's is this screen, which draws their seat's view
// and lands what they do; the clock's waits for each deadline. The table is
// drawn as the werewolf page draws its clearing, from a seat's own view
// alone. Friends join by a link (poker-share.js): the host's page holds the
// store and runs the AI players, and sends each friend's page its seat's
// view; a friend's page, opened at `#join=<room>`, only draws and sends what
// its player does. preview/build.js bundles it into dist/preview.

/* global document, location, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, arrows, el, message, models, notice, typingMessage } from './game-page.js';
import { agent, friends, keep, load, openTable, typer } from './game-kit.js';
import { clock, control } from '../src/core/controller.js';
import { createRuntimePanel } from '../web/runtime-panel.js';
import { guestId, join } from './poker-share.js';
import { deal } from './spy-rules.js';
import { CLOCK, DECIDE, HUMAN, MAX_CLUE, MAX_LINES, PERSONAS, TALK, TURN, decided, isPerson, newTable, prompt, world } from './spy-world.js';

const NAME = 'ponjo-poker-name'; // the visitor's name at a friend's table, as the poker page keeps it
const TABLE = 'ponjo-spy-table'; // the table the host's page holds: { rev, state }, as its store last saved it
const SVG = 'http://www.w3.org/2000/svg';

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the table it joins
const me = ROOM ? guestId(ROOM) : HUMAN; // who this page plays as
let shown = null; // the host's page: its seat's view, as its controller last read it
let remote = null; // a friend's page: what the host last sent, { view, presence }
let myVote = null; // { at, target }: this page's vote, its own to see before the vote ends
let away = ''; // a friend's page: why the line to the host is down
// What the page last drew: the seats, for which game; the last vote's arrows and when its dots land; the dealt word; the moment the chat box is for.
let seats = [];
let seatsFor = '';
let votesIn = 0;
let arrowsFor = '';
let dealt = 0;
let chatAt = '';
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

const ai = models(() => draw()); // the players' model

// ---- the store and its members, on the host's page ----

// The store, kept in this browser on each change. Its members' presence
// (who is at work, whose run failed) is drawn here and sent to friends.
const table = ROOM ? null : openTable(world, TABLE, newTable, () => {
  draw();
  guests.shown();
});
const client = (id) => table.client(id);
const commit = (id, change) => table.commit(id, change);

// Each player's pace, as a person's at a table: ms from and to before they act.
const PACE = { Ivy: [3000, 5500], Max: [1200, 2500], Juno: [2500, 4500], Sam: [2000, 3500], Lou: [2500, 5000], Remy: [3500, 6500], Pip: [1200, 2600] };
const typeTime = (text) => Math.min(6000, Math.max(1200, text.length * 60));

// With ?debug, the host's page shows each AI player's runs (the runtime
// panel): every player's word and thinking, so only on asking. A task is
// a turn of the game: its round, phase, a runoff; a line in a discussion;
// or a line in the chat after it.
const panel = !ROOM && new URLSearchParams(location.search).has('debug') ? createRuntimePanel({
  where: 'this table', faceOf: (id) => faceOf(picture().t, id),
  askText: (given) => {
    const [kind, , round, phase, runoff] = given.split(':');
    return kind === 'talk' ? `The discussion (round ${round})` : kind === 'chat' ? 'A line in the chat' : `Round ${round}, ${phase}${runoff ? ' (runoff)' : ''}`;
  },
}) : null;

// AI player `id`'s program: a run is one call of the model on what its
// seat sees, then the player's own time to think. What it decided lands at
// once; each page types a line out after.
const think = (id) => agent({
  client: client(id), id, infer: ai.infer, tool: DECIDE, prompt, panel,
  decide: (args, view) => decided(args, view.actions),
  pace: () => PACE[id][0] + Math.random() * (PACE[id][1] - PACE[id][0]),
});

// A new game: the AI players fill the seats the people leave, each with its
// hello, which the clock says for it round the table; then the first clue.
function startGame(size) {
  const ais = PERSONAS.slice(0, Math.max(0, size - picture().t.people.length)).map(({ id, hello }) => ({ id, hello }));
  myVote = null;
  commit(HUMAN, { body: { type: 'start', size, dealt: deal(size), ais } });
}

// ---- what this page draws: its seat's view of the table ----

const EMPTY = { content: { people: [], names: {}, players: [], gameNo: 0, greeting: false, hellos: [], game: null, lines: [], thoughts: {}, moment: '', ends: 0 }, actions: [], tasks: [] };
// The view this page draws (`t` its content, `v` the game as its seat sees it), and the presence it may see.
function picture() {
  const view = (ROOM ? remote?.view : shown) ?? EMPTY;
  return { t: view.content, v: view.content.game, view };
}
const presence = () => (ROOM ? remote?.presence : shown && client(HUMAN).present()) ?? {};

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

function drawSeats(t, v, view) {
  const vote = lastVote(v);
  const present = presence();
  for (const [i, node] of seats.entries()) {
    const id = t.players[i];
    const s = v.seats[i];
    const out = v.log.findLast((e) => e.type === 'vote' && e.out === i);
    const dots = vote ? Object.values(vote.votes).filter((x) => x === i).length : 0;
    node.toggleAttribute('data-dead', !s.alive);
    node.toggleAttribute('data-turn', !t.greeting && v.phase === 'clue' && v.speaker === i);
    node.toggleAttribute('data-pickable', canVote(t, v, i));
    $('.pj-agent-face', node).dataset.presence = !s.alive ? 'away' : present[id]?.working || typing.has(id) || (!t.greeting && v.phase === 'clue' && v.speaker === i) || (i === v.seat && v.due && !t.greeting) ? 'working' : 'idle';
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
    $('.pk-tag', node).textContent = present[id]?.failed ? 'Can\'t reach the model' : '';
    $('.pk-tag', node).dataset.kind = 'failed';
    const words = [i === v.seat ? 'You' : label(t, id), status?.[3], s.role && SIDE[s.role], vote && i in vote.votes && (vote.votes[i] === null ? 'No vote' : `Voted ${label(t, t.players[vote.votes[i]])}`), dots && `${dots} vote${dots > 1 ? 's' : ''}`, !isPerson(id) && PERSONAS.find((p) => p.id === id).blurb];
    node.title = words.filter(Boolean).join(' · ');
  }
  const ring = seats[v.seat] && $('.ww-timer', seats[v.seat]);
  if (!ring) return;
  const task = view.tasks.find((x) => x.given.startsWith('turn:')); // a discussion's clock is over the table
  ring.classList.toggle('ww-timer-on', Boolean(task));
  if (!task || ring.dataset.at === task.given) return;
  ring.dataset.at = task.given;
  const circle = ring.firstChild;
  circle.style.animation = 'none';
  void circle.getBoundingClientRect();
  circle.style.animation = `ww-drain ${TURN}ms linear ${task.at - TURN - Date.now()}ms forwards`;
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

// Over the table: the round, and one line that changes with the moment; in a discussion, its clock, and a way to pass.
function drawCenter(t, v, view) {
  const over = v?.phase === 'over';
  const mine = v && v.seat !== null ? v.seats[v.seat].role : null;
  $('.ww-phase-text').textContent = !v || t.greeting ? 'Who\'s the Spy' : over ? (v.winner === 'civilians' ? 'The civilians win' : `The ${v.seats.filter((s) => s.role === 'spy').length > 1 ? 'spies win' : 'spy wins'}`) : `Round ${v.round}`;
  const speaker = v && v.speaker !== null ? (v.speaker === v.seat ? 'Your' : `${label(t, t.players[v.speaker])}'s`) : '';
  const tied = v?.runoff ? list(v.runoff.map((i) => (i === v.seat ? 'you' : label(t, t.players[i])))) : '';
  const [key, mark, words] = !v ? ['wait', null, ROOM ? 'Waiting for the host to start a game' : '']
    : t.greeting ? ['hello', null, 'Everyone says hello']
      : over ? ['over', null, mine ? ((mine === 'spy') === (v.winner === 'spies') ? 'You won' : 'You lost') : '']
        : v.phase === 'vote' ? [`vote:${v.runoff}`, symbol('ww-ballot'), v.runoff ? `Vote between ${tied}` : 'Vote for the spy']
          : v.phase === 'talk' ? ['talk', icon('users'), `Discussion · ${Math.max(0, Math.ceil((t.ends - Date.now()) / 1000))}s, then the vote`]
            : [`clue:${v.speaker}`, null, v.runoff ? `A tie: ${cap(tied)} give one more clue. ${speaker} clue` : `${speaker} clue`];
  const sub = $('.ww-sub');
  const fresh = sub.dataset.key !== key;
  if (fresh || key === 'talk') {
    sub.dataset.key = key;
    sub.replaceChildren(...[mark, words].filter(Boolean));
    if (fresh && !still && words) sub.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'ease-out' });
  }
  $('.sp-pass').hidden = !view.tasks.some((x) => x.given.startsWith('talk:'));
  $('.ww-over').hidden = !over && (Boolean(v) || Boolean(ROOM)); // before any game, the host's way to start one
  $('[data-action="thinking"]').hidden = !over;
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
  $('.ww-ask').textContent = away || (!v ? (ROOM && t.people.includes(me) ? 'You are at the table: you play from the next game.' : '')
    : t.greeting || v.phase === 'over' ? ''
      : !seated ? (t.people.includes(me) ? 'Watching: you play from the next game.' : 'Watching.')
        : !v.alive ? 'You are out: watch the rest.'
          : v.due?.kind === 'clue' ? 'Your turn: give a clue to your word in the chat, without saying it.'
            : v.phase === 'talk' ? (v.due ? `Talk it over in the chat: ${v.due.left} line${v.due.left === 1 ? '' : 's'} left, never your word.` : `You have said your ${MAX_LINES} lines. The vote comes next.`)
            : v.due?.kind === 'vote' ? 'Click the player you think is a spy.'
              : voted ? 'You voted. Waiting for the others.' : '');
}

// The chat box: your clue on your turn, your lines in a discussion, the
// chat out of a game; muted otherwise, and why. What you wrote stays as the
// moment moves on.
const chat = $('.ww-chat-box');
const box = chat.elements.text;
const says = (view) => ['clue', 'say', 'chat'].find((a) => view.actions.includes(a));
function drawChat(t, v, view) {
  const talking = ['clue', 'say'].includes(says(view));
  const mine = Boolean(says(view));
  if (chatAt !== t.moment) {
    chatAt = t.moment;
    $('.ww-error').hidden = true;
  }
  chat.dataset.audience = mine ? 'all' : 'muted';
  box.disabled = !mine;
  box.maxLength = MAX_CLUE;
  box.placeholder = !mine ? '' : !talking ? 'Chat with the table…' : says(view) === 'say' ? 'Say something to the table…' : 'Your clue, without your word…';
  $('[type=submit]', chat).disabled = !mine || !box.value.trim();
  const speaker = v && v.speaker !== null && v.speaker !== v.seat ? label(t, t.players[v.speaker]) : null;
  const why = mine ? [icon('users'), !talking ? 'Everyone at the table hears you.' : says(view) === 'say' ? `Everyone hears you · ${v.due.left} line${v.due.left === 1 ? '' : 's'} left.` : 'Everyone hears your clue.']
    : [symbol('ww-muted'), !v ? 'Join the table to chat.'
      : t.greeting ? 'Muted while everyone says hello.'
        : v.phase === 'over' ? 'Join the table to chat.'
          : v.seat === null ? 'Watching: you play from the next game.'
            : !v.alive ? 'You are out: the out don\'t clue.'
              : v.phase === 'vote' ? 'Muted while everyone votes.'
                : v.phase === 'talk' ? `Muted: you have said your ${MAX_LINES} lines.`
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
  const type = says(picture().view);
  if (type) perform({ type, text: box.value });
});
box.addEventListener('input', () => draw());
box.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chat.requestSubmit();
  }
});

// What this page's player does, on the moment it sees: landed here as
// they act (a person's change answers no task: refused, it lands nothing,
// and they see why), or, on a friend's page, sent to the host, which lands it.
function perform(body) {
  const { t, v, view } = picture();
  if (!view.actions.includes(body.type)) return;
  if (body.type === 'vote') myVote = { at: v.log.length, target: body.target };
  if ('text' in body) box.value = '';
  if (ROOM) {
    guest.send({ type: 'act', base: t.moment, body });
    return draw();
  }
  const { refused: why } = commit(HUMAN, { base: t.moment, body });
  if (why && 'text' in body) box.value = body.text;
  refused(why);
}
function refused(why) {
  $('.ww-error').textContent = why ?? '';
  $('.ww-error').hidden = !why;
  if (why) myVote = null;
}

// ---- the log: what this page's seat saw, as a chat app shows it ----

// A line an AI player said lands at once; this page types it out first,
// one after another, unless it was there when the page opened.
const typed = typer(() => draw(), typeTime);
const typing = typed.typing;

function drawFeed(t, v, view) {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const name = (i) => (i === v.seat ? 'you' : label(t, t.players[i]));
  const Name = (i) => cap(name(i));
  const say = (id, text, more = false, note = '') => {
    const side = v?.seats[t.players.indexOf(id)]?.role;
    rows.push(message({ face: id !== me && faceOf(t, id), name: [label(t, id), ...(side ? [token(side)] : [])], text, note, mine: id === me, more }));
  };
  // Whether line `key` shows yet; if not, its player is typing it.
  typed.clear();
  const shows = (key, id, text) => isPerson(id) || typed.shows(key, id, text);
  // the chat: before this game (or the next, before any), and after it
  const chatted = (after) => t.lines.filter((l) => l.kind === 'chat' && l.after === after && l.game === (v || after ? t.gameNo : t.gameNo + 1));
  const chatLines = (list) => {
    for (const l of list) {
      if (!shows(`l:${l.id}`, l.by, l.text)) continue;
      say(l.by, l.text, last === l.by);
      last = l.by;
    }
  };
  chatLines(chatted(false));
  for (const h of t.hellos) {
    say(h.id, h.text, last === h.id);
    last = h.id;
  }
  for (const [k, e] of (v?.log ?? []).entries()) {
    if ((e.type === 'clue' && !e.silent) || e.type === 'line') {
      if (!shows(`g:${t.gameNo}:${k}`, t.players[e.seat], e.text)) continue;
      say(t.players[e.seat], e.text, last === e.seat, e.type === 'clue' ? 'clue' : '');
      last = e.seat;
      continue;
    }
    last = null;
    if (e.type === 'talk') rows.push(notice(`The clues are in. Talk it over: ${TALK / 1000} seconds, up to ${MAX_LINES} lines each, never your word.`));
    else if (e.type === 'vote-called') rows.push(notice('Time to vote.'));
    else if (e.type === 'round') rows.push(notice(`${e.round === 1 ? 'Round 1. Everyone has their word: one clue each, in seat order' : `Round ${e.round}`}, from ${name(e.from)}.`));
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
  if (v) chatLines(chatted(true));
  for (const id of typing) rows.push(typingMessage(faceOf(t, id), id));
  for (const [id, p] of Object.entries(presence())) {
    if (!p.failed) continue;
    const row = notice(`${id} could not reach the model: ${p.failed}`);
    row.dataset.failed = '';
    rows.push(row);
  }
  feed.replaceChildren(...rows);
  if (stick) feed.scrollTop = feed.scrollHeight;
  if (view !== EMPTY) typed.open();
}

function draw() {
  const { t, v, view } = picture();
  layout(t);
  drawFeed(t, v, view); // first: it says who is typing
  if (v) {
    drawVotes(t, v);
    drawSeats(t, v, view);
  }
  drawCenter(t, v, view);
  drawWord(t, v);
  drawMe(t, v);
  drawChat(t, v, view);
  if (!ROOM && !starting.hidden) drawStart();
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
    const thoughts = t.thoughts[id] ?? [];
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
  starting.hidden = false;
  document.body.classList.add('pk-buying-in');
  drawStart();
}
// The sizes the people at the table fit, and who they are.
function drawStart() {
  const { t } = picture();
  const people = t.people.length;
  size = Math.max(size, people, 5);
  for (const b of starting.querySelectorAll('[data-size]')) {
    b.setAttribute('aria-checked', String(Number(b.dataset.size) === size));
    b.disabled = Number(b.dataset.size) < people;
  }
  const names = t.people.map((id) => label(t, id));
  $('.sp-people').textContent = `At the table: ${names.join(', ')}. AI players take the ${size - people === 1 ? 'other seat' : `other ${size - people} seats`}.`;
}
starting.addEventListener('click', (event) => {
  const b = event.target.closest('[data-size]');
  if (!b || b.disabled) return;
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
    if (names[id] && !people.includes(id)) commit(id, { body: { type: 'join', name: names[id] } });
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
    commit(HUMAN, { body: { type: 'join', name } });
    keep(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-setting-up');
}
// What a friend's page sends: to sit at the table, or what its player does, made on `base`.
function act(id, message) {
  const b = message.body ?? {};
  const body = message.type === 'sit' ? { type: 'join', name: message.name } : { type: String(b.type), ...(typeof b.text === 'string' ? { text: b.text } : {}), ...(Number.isInteger(b.target) ? { target: b.target } : {}) };
  const { refused: why } = commit(id, { base: String(message.base ?? ''), body });
  if (why) guests.send(id, { type: 'rejected', why });
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
    if (!joining.hidden && message.view.content.people.includes(me)) closeJoin(); // back at the table after a reload
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
  else if (action === 'pass') perform({ type: 'pass' });
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
setInterval(() => picture().v?.phase === 'talk' && draw(), 1000); // the discussion's clock

if (ROOM) {
  for (const node of document.querySelectorAll('[data-action="invite"], [data-action="key"]')) node.hidden = true;
  $('.pk-model').textContent = 'You joined a friend\'s table: the AI players run on their page.';
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
