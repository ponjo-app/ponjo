// The spy page (site/spy.html): a person, any friends they invite and AI
// players round one table at a game of Who's the Spy. The rules
// (spy-rules.js) own what must be exact; the table is a world
// (spy-world.js) on the runtime's core (src/core/), kept by the table's
// room on the relay (relay/table.js), which also runs the AI players (on
// the visitor's model, game-page.js) and the clock. This page is one
// seat's client: it draws its seat's view, as the room sends it, and sends
// what its person does. The table is drawn as the werewolf page draws its
// clearing, from a seat's own view alone. The page that opens the table
// plays as its host; friends join by a link, at `#join=<room>`
// (game-kit.js, `sit`). preview/build.js bundles it into dist/preview.

/* global document, location, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, arrows, closeTable, el, message, models, notice, translate, typingMessage, unreached } from './game-page.js';
import { keep, load, sit, typer } from './game-kit.js';
import { L, LANG, list } from './lang.js';
import { HUMAN, MAX_CLUE, MAX_LINES, PERSONAS, TALK, TURN, isPerson } from './spy-world.js';

const NAME = 'ponjo-poker-name'; // the visitor's name at a friend's table, as the poker page keeps it
const SVG = 'http://www.w3.org/2000/svg';

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the table it joins
let me = ROOM ? null : HUMAN; // who this page plays as, once the room says
let shown = null; // what the room last sent: { view, presence, ai }
let myVote = null; // { at, target }: this page's vote, its own to see before the vote ends
let away = ''; // why the line to the room is down
// What the page last drew: the seats, for which game; the last vote's arrows and when its dots land; the dealt word; the moment the chat box is for.
let seats = [];
let seatsFor = '';
let votesIn = 0;
let arrowsFor = '';
let dealt = 0;
let chatAt = '';
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

// The players' model: the host's page gives the room the visitor's own key, when they pick one.
const ai = models(() => {
  table.giveKey();
  draw();
}, Boolean(ROOM));

const typeTime = (text) => Math.min(6000, Math.max(1200, text.length * 60));

// A new game, dealt by the room: the people at the table and the AI players
// sitting with them, in the seats the host picked; then the first clue.
function startGame(size) {
  myVote = null;
  table.act('', { type: 'start', size });
}

// ---- what this page draws: its seat's view of the table ----

const EMPTY = { content: { people: [], names: {}, size: 6, seated: [], players: [], gameNo: 0, game: null, lines: [], thoughts: {}, moment: '', ends: 0 }, actions: [], tasks: [] };
// The view this page draws (`t` its content, `v` the game as its seat sees it), and the presence it may see.
function picture() {
  const view = shown?.view ?? EMPTY;
  return { t: view.content, v: view.content.game, view };
}
const presence = () => shown?.presence ?? {};

const label = (t, id) => (id === me ? L('You', '你') : isPerson(id) ? t.names[id] ?? (id === HUMAN ? L('Host', '房主') : L('Friend', '朋友')) : id);
const cap = (text) => text[0].toUpperCase() + text.slice(1);
function blurb(id) {
  const p = PERSONAS.find((x) => x.id === id);
  return L(p.blurb, p.zh.blurb);
}
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
const SIDE = { spy: L('Spy', '卧底'), civilian: L('Civilian', '平民') };
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
  name.append(Object.assign(el('span', 'pk-position', String(i + 1)), { title: L(`Seat ${i + 1}`, `${i + 1} 号位`) }), label(t, id));
  const idents = el('span', 'ww-idents');
  idents.append(Object.assign(el('span', 'ww-ident'), { hidden: true }));
  plate.append(name, idents, el('span', 'ww-dots'), el('span', 'pk-tag'));
  node.append(face, plate);
  return node;
}
// The seats of a game round the table, or before any, of whoever sits at it.
function layout(t) {
  const ids = t.game ? t.players : t.seated;
  const key = `${t.gameNo}:${ids.join()}`;
  if (key === seatsFor) return;
  seatsFor = key;
  for (const node of seats) node.remove();
  const mine = Math.max(0, ids.indexOf(me));
  seats = ids.map((id, i) => seatNode(t, id, i, ids.length, mine));
  $('.ww-ring').append(...seats);
}

// The last vote, while it shows: from its result until the next vote begins.
const lastVote = (v) => (v.phase === 'vote' ? null : v.log.findLast((e) => e.type === 'vote'));
const canVote = (t, v, i) => v.due?.kind === 'vote' && v.due.targets.includes(i);

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
    node.toggleAttribute('data-turn', v.phase === 'clue' && v.speaker === i);
    node.toggleAttribute('data-pickable', canVote(t, v, i));
    $('.pj-agent-face', node).dataset.presence = !s.alive ? 'away' : present[id]?.working || typing.has(id) || (v.phase === 'clue' && v.speaker === i) || (i === v.seat && v.due) ? 'working' : 'idle';
    const status = out ? [`out:${out.round}`, () => symbol('ww-ballot'), 'dead', L(`Voted out, round ${out.round}`, `第 ${out.round} 轮被投出`)]
      : v.voted.includes(i) ? ['voted', () => symbol('ww-ballot'), 'voted', L('Has voted', '已投票')] : null;
    badge($('[data-at="status"]', node), status);
    const ident = $('.ww-ident', node);
    if (ident.dataset.role !== (s.role ?? '')) {
      ident.dataset.role = s.role ?? '';
      ident.replaceChildren(...(s.role ? [token(s.role)] : []));
      ident.hidden = !s.role;
    }
    const dotsNode = $('.ww-dots', node);
    if (dotsNode.childElementCount !== dots) dotsNode.replaceChildren(...Array.from({ length: dots }, (_, k) => Object.assign(el('i'), { style: `animation-delay: ${votesIn + k * 120}ms` })));
    $('.pk-tag', node).textContent = present[id]?.failed ? L('Can\'t reach the model', '连不上模型') : '';
    $('.pk-tag', node).dataset.kind = 'failed';
    const votedFor = vote && i in vote.votes && vote.votes[i] !== null && label(t, t.players[vote.votes[i]]);
    const words = [i === v.seat ? L('You', '你') : label(t, id), status?.[3], s.role && SIDE[s.role], vote && i in vote.votes && (votedFor ? L(`Voted ${votedFor}`, `投给了 ${votedFor}`) : L('No vote', '弃票')), dots && L(`${dots} vote${dots > 1 ? 's' : ''}`, `${dots} 票`), !isPerson(id) && blurb(id)];
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
  $('.ww-phase-text').textContent = !v ? L('Who\'s the Spy', '谁是卧底') : over ? (v.winner === 'civilians' ? L('The civilians win', '平民获胜') : L(`The ${v.seats.filter((s) => s.role === 'spy').length > 1 ? 'spies win' : 'spy wins'}`, '卧底获胜')) : L(`Round ${v.round}`, `第 ${v.round} 轮`);
  const name = v && v.speaker !== null && v.speaker !== v.seat ? label(t, t.players[v.speaker]) : null;
  const speaker = name ? L(`${name}'s clue`, `轮到 ${name} 描述`) : L('Your clue', '轮到你描述');
  const tied = v?.runoff ? list(v.runoff.map((i) => (i === v.seat ? L('you', '你') : label(t, t.players[i])))) : '';
  const [key, mark, words] = !v ? [`wait:${away}`, null, away || (ROOM ? L('Waiting for the host to start a game', '等房主开局') : '')]
    : over ? ['over', null, mine ? ((mine === 'spy') === (v.winner === 'spies') ? L('You won', '你赢了') : L('You lost', '你输了')) : '']
        : v.phase === 'vote' ? [`vote:${v.runoff}`, symbol('ww-ballot'), v.runoff ? L(`Vote between ${tied}`, `在${tied}之间投票`) : L('Vote for the spy', '投出卧底')]
          : v.phase === 'talk' ? ['talk', icon('users'), L(`Discussion · ${Math.max(0, Math.ceil((t.ends - Date.now()) / 1000))}s, then the vote`, `讨论 · 还有 ${Math.max(0, Math.ceil((t.ends - Date.now()) / 1000))} 秒，然后投票`)]
            : [`clue:${v.speaker}`, null, v.runoff ? L(`A tie: ${cap(tied)} give one more clue. ${speaker}`, `平票：${tied}再各描述一次。${speaker}`) : speaker];
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
  $('.sp-word-label', card).textContent = over ? L('Civilians · Spies', '平民 · 卧底') : L('Your word', '你的词');
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
  $('.ww-ask').textContent = away || (!v ? (ROOM && t.people.includes(me) ? L('You are at the table: you play from the next game.', '你已在牌桌上：从下一局起上场。') : '')
    : v.phase === 'over' ? ''
      : !seated ? (t.people.includes(me) ? L('Watching: you play from the next game.', '观战中：从下一局起上场。') : L('Watching.', '观战中。'))
        : !v.alive ? L('You are out: watch the rest.', '你出局了：看他们打完吧。')
          : v.due?.kind === 'clue' ? L('Your turn: give a clue to your word in the chat, without saying it.', '轮到你了：在聊天里描述你的词，但不能说出它。')
            : v.phase === 'talk' ? (v.due ? L(`Talk it over in the chat: ${v.due.left} line${v.due.left === 1 ? '' : 's'} left, never your word.`, `在聊天里讨论：还能说 ${v.due.left} 句，不能说出你的词。`) : L(`You have said your ${MAX_LINES} lines. The vote comes next.`, `你的 ${MAX_LINES} 句已说完。接下来投票。`))
            : v.due?.kind === 'vote' ? L('Click the player you think is a spy.', '点你认为是卧底的玩家。')
              : voted ? L('You voted. Waiting for the others.', '你已投票，等其他人。') : '');
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
  box.placeholder = !mine ? '' : !talking ? L('Chat with the table…', '和大家聊聊…') : says(view) === 'say' ? L('Say something to the table…', '对大家说点什么…') : L('Your clue, without your word…', '你的描述，别说出你的词…');
  $('[type=submit]', chat).disabled = !mine || !box.value.trim();
  const speaker = v && v.speaker !== null && v.speaker !== v.seat ? label(t, t.players[v.speaker]) : null;
  const why = mine ? [icon('users'), !talking ? L('Everyone at the table hears you.', '桌上所有人都听得到你。') : says(view) === 'say' ? L(`Everyone hears you · ${v.due.left} line${v.due.left === 1 ? '' : 's'} left.`, `所有人都听得到你 · 还能说 ${v.due.left} 句。`) : L('Everyone hears your clue.', '所有人都听得到你的描述。')]
    : [symbol('ww-muted'), !v ? L('Join the table to chat.', '加入牌桌才能聊天。')
      : v.phase === 'over' ? L('Join the table to chat.', '加入牌桌才能聊天。')
          : v.seat === null ? L('Watching: you play from the next game.', '观战中：从下一局起上场。')
            : !v.alive ? L('You are out: the out don\'t clue.', '你出局了：出局的人不再描述。')
              : v.phase === 'vote' ? L('Muted while everyone votes.', '投票时不能说话。')
                : v.phase === 'talk' ? L(`Muted: you have said your ${MAX_LINES} lines.`, `不能说话：你的 ${MAX_LINES} 句已说完。`)
                : speaker ? L(`Muted: ${speaker} is giving a clue. You clue in turn.`, `不能说话：${speaker} 正在描述，你按顺序描述。`) : L('Muted.', '不能说话。')];
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

// What this page's player does, on the moment it sees, sent to the room,
// which lands it (a person's change answers no task: refused, it lands
// nothing, and the room says why).
function perform(body) {
  const { t, v, view } = picture();
  if (!view.actions.includes(body.type)) return;
  if (body.type === 'vote') myVote = { at: v.log.length, target: body.target };
  if ('text' in body) box.value = '';
  table.act(t.moment, body);
  draw();
}
// What the world (spy-world.js, game-tables.js) and the rules (spy-rules.js) say when they refuse a person's change, in Chinese.
const KNOWN = [
  ['Stale: the game moved on before your action landed.', '慢了一步：你的操作送到前，游戏已经往下走了。'],
  ['Wait for everyone to say hello.', '等大家打完招呼。'],
  ['There is no game on: chat instead.', '现在没在玩：聊聊天吧。'],
  ['There is nothing to pass on now.', '现在没有可以跳过的。'],
  ['Only the host starts a game.', '只有房主能开局。'],
  ['A game is on.', '正在玩一局。'],
  ['Only a person sits at the table.', '只有真人能上桌。'],
  ['You are not at the table.', '你不在牌桌上。'],
  ['Not now: the game is on.', '现在不行：游戏进行中。'],
  ['Say something.', '说点什么吧。'],
  [/^A game has (.+) seats\.$/, '一局的人数是 $1。'],
  ['Say something: a clue is your turn.', '说点什么：轮到你描述了。'],
  ['Say something: a line is a few words.', '说点什么：一句话就行。'],
  [/^Too long: at most (\d+) characters, you wrote (\d+)\.$/, '太长了：最多 $1 个字，你写了 $2 个。'],
  ['Your clue says your word: talk about it without saying it.', '你的描述说出了你的词：描述它，但别说出来。'],
  ['Your line says your word: talk about it without saying it.', '你的话说出了你的词：聊它，但别说出来。'],
  ['The game is over.', '这局已经结束了。'],
  ['There is no discussion now.', '现在不是讨论时间。'],
  ['It is the discussion: you may only talk.', '现在是讨论：只能说话。'],
  ['You are out: the out don\'t talk.', '你出局了：出局的人不能说话。'],
  [/^You have said your (\d+) lines in this discussion\.$/, '这轮讨论你的 $1 句已说完。'],
  ['You have voted already: wait for the others.', '你已经投过票了：等其他人。'],
  ['It is not your turn.', '还没轮到你。'],
  ['It is your turn to give a clue.', '轮到你描述了。'],
  ['Now you may only vote.', '现在只能投票。'],
  ['Vote for one of the tied players, not yourself.', '投给平票的玩家之一，不能投自己。'],
  ['Vote for another living player.', '投给另一位还在场的玩家。'],
];
// The kinds of an AI player's thinking (spy-world.js `think`).
const KIND = { clue: L('clue', '描述'), talk: L('talk', '讨论'), vote: L('vote', '投票'), chat: L('chat', '聊天') };
function refused(why) {
  $('.ww-error').textContent = why ? translate(why, KNOWN) : '';
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
  const name = (i) => (i === v.seat ? L('you', '你') : label(t, t.players[i]));
  const Name = (i) => cap(name(i));
  const say = (id, text, more = false, note = '') => {
    const side = v?.seats[t.players.indexOf(id)]?.role;
    rows.push(message({ face: id !== me && faceOf(t, id), name: [label(t, id), ...(side ? [token(side)] : [])], text, note, mine: id === me, more }));
  };
  // Whether line `key` shows yet; if not, its player is typing it.
  typed.clear();
  const shows = (key, id, text) => isPerson(id) || typed.shows(key, id, text);
  // the chat: before this game (or before any), and after it
  const chatted = (no) => t.lines.filter((l) => l.game === no);
  const chatLines = (list) => {
    for (const l of list) {
      if (!shows(`l:${l.id}`, l.by, l.text)) continue;
      say(l.by, l.text, last === l.by);
      last = l.by;
    }
  };
  chatLines(chatted(v ? t.gameNo - 1 : t.gameNo));
  for (const [k, e] of (v?.log ?? []).entries()) {
    if ((e.type === 'clue' && !e.silent) || e.type === 'line') {
      if (!shows(`g:${t.gameNo}:${k}`, t.players[e.seat], e.text)) continue;
      say(t.players[e.seat], e.text, last === e.seat, e.type === 'clue' ? L('clue', '描述') : '');
      last = e.seat;
      continue;
    }
    last = null;
    if (e.type === 'talk') rows.push(notice(L(`The clues are in. Talk it over: ${TALK / 1000} seconds, up to ${MAX_LINES} lines each, never your word.`, `描述完毕。开始讨论：${TALK / 1000} 秒，每人最多 ${MAX_LINES} 句，不能说出自己的词。`)));
    else if (e.type === 'vote-called') rows.push(notice(L('Time to vote.', '开始投票。')));
    else if (e.type === 'round') rows.push(notice(e.round === 1 ? L(`Round 1. Everyone has their word: one clue each, in seat order, from ${name(e.from)}.`, `第 1 轮。每人都拿到了词：从${name(e.from)}开始，按座位顺序每人描述一句。`) : L(`Round ${e.round}, from ${name(e.from)}.`, `第 ${e.round} 轮，从${name(e.from)}开始。`)));
    else if (e.type === 'clue') rows.push(notice(L(`${Name(e.seat)} gave no clue.`, `${name(e.seat)}没有描述。`)));
    else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, x]) => `${Name(Number(s))} → ${x === null ? L('no vote', '弃票') : name(x)}`);
      const row = notice(L(`The vote${e.second ? ' between the tied' : ''}: ${votes.join(', ')}. `, `${e.second ? '平票者之间的' : ''}投票：${votes.join('，')}。`));
      if (e.out !== null) row.append(L(`${Name(e.out)} ${e.out === v.seat ? 'are' : 'is'} out: `, `${name(e.out)}出局，身份是`), token(e.role));
      else row.append(e.runoff ? L(`A tie between ${list(e.runoff.map(name))}: one more clue each, then a vote between them.`, `${list(e.runoff.map(name))}平票：各再描述一次，然后在他们之间投票。`) : L('No one is out.', '没有人出局。'));
      rows.push(row);
    } else if (e.type === 'over') {
      rows.push(notice(e.winner === 'civilians'
        ? L(`Every spy is out: the civilians win. The civilians' word was "${e.words.civilian}"; the spies', "${e.words.spy}".`, `卧底全部出局：平民获胜。平民的词是“${e.words.civilian}”，卧底的是“${e.words.spy}”。`)
        : L(`The spies made it: they win. The civilians' word was "${e.words.civilian}"; the spies', "${e.words.spy}".`, `卧底撑到了最后：卧底获胜。平民的词是“${e.words.civilian}”，卧底的是“${e.words.spy}”。`)));
    }
  }
  if (v) chatLines(chatted(t.gameNo));
  for (const id of typing) rows.push(typingMessage(faceOf(t, id), id));
  for (const [id, p] of Object.entries(presence())) {
    if (!p.failed) continue;
    const row = notice(L(`${id} could not reach the model: ${p.failed}`, `${id} 连不上模型：${p.failed}`));
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
  ai.draw(shown?.ai);
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
  if (!isPerson(id)) who.append(el('span', '', blurb(id)));
  head.append(faceOf(t, id), who);
  const doIt = el('li', '', L(`Vote for ${label(t, id)}`, `投给 ${label(t, id)}`));
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
  $('h2', dialog).textContent = L('Their thinking', '他们的想法');
  $('.pk-thinking-body', dialog).replaceChildren(...t.players.filter((id) => !isPerson(id)).map((id) => {
    const seat = t.players.indexOf(id);
    const part = el('details', 'pj-trace-part');
    part.open = true;
    const summary = el('summary');
    const meta = el('span', 'pj-trace-meta');
    meta.append(token(v.seats[seat].role), L(` "${v.seats[seat].word}"`, ` “${v.seats[seat].word}”`));
    summary.append(icon('chevron'), faceOf(t, id), el('span', 'pj-trace-title', id), meta);
    part.append(summary);
    const thoughts = t.thoughts[id] ?? [];
    if (!thoughts.length) part.append(el('p', 'pj-empty', L('No decisions.', '没有决定。')));
    for (const th of thoughts) {
      const target = Number.isInteger(th.action?.target) ? ` ${label(t, t.players[th.action.target])}` : '';
      part.append(el('h3', 'pj-setting-group', `${L(`Round ${th.round}`, `第 ${th.round} 轮`)}${th.kind ? ` · ${KIND[th.kind]}${target}` : ''}`));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', th.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- a new game: how many players, with whoever is at the table ----

const starting = $('.ww-start');
function openStart() {
  starting.hidden = false;
  document.body.classList.add('pk-buying-in');
  drawStart();
}
// The table's size, and who is at it.
function drawStart() {
  const { t } = picture();
  const people = Math.min(t.people.length, t.size);
  for (const b of starting.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === t.size));
  const names = t.people.map((id) => label(t, id));
  const watch = t.people.length > t.size ? L(` The last ${t.people.length - t.size === 1 ? 'one watches' : `${t.people.length - t.size} watch`}.`, `最后 ${t.people.length - t.size} 人观战。`) : '';
  $('.sp-people').textContent = L(`At the table: ${names.join(', ')}.${watch} AI players take the ${t.size - people === 1 ? 'other seat' : `other ${t.size - people} seats`}.`, `桌上：${names.join('、')}。${watch}其余 ${t.size - people} 个座位由 AI 玩家坐。`);
}
starting.addEventListener('click', (event) => {
  const b = event.target.closest('[data-size]');
  if (b) table.act('', { type: 'size', size: Number(b.dataset.size) }); // AI players sit down or get up for it
});
starting.addEventListener('submit', (event) => {
  event.preventDefault();
  starting.hidden = true;
  document.body.classList.remove('pk-buying-in');
  startGame(picture().t.size);
});
// ---- the table's room: the host's page invites friends; a friend's page joins ----

const inviting = $('.pk-invite');
async function invite() {
  inviting.hidden = false;
  document.body.classList.add('pk-setting-up');
  inviting.elements.name.value = picture().t.names[HUMAN] ?? load(NAME) ?? '';
  inviting.elements.link.value = await table.link();
}
function closeInvite() {
  const name = inviting.elements.name.value.trim();
  if (name) {
    table.act('', { type: 'join', name });
    keep(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-setting-up');
}

const joining = $('.sp-join');
function closeJoin() {
  joining.hidden = true;
  document.body.classList.remove('pk-buying-in');
}
joining.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = joining.elements.name.value.trim().slice(0, 20) || L('Friend', '朋友');
  keep(name, NAME);
  table.act('', { type: 'join', name });
  closeJoin();
});

// This page's seat at the table. A friend's page that was at the table (a
// reload) is back in its seat, by the name it had.
const table = sit('spy', HUMAN, {
  key: ai.key,
  lang: LANG,
  hello(id) {
    me = id;
    draw();
  },
  heard(message) {
    away = '';
    if (message.type === 'rejected') {
      if ('text' in message.body && !box.value) box.value = message.body.text;
      refused(message.why);
      return draw();
    }
    if (message.type !== 'state') return;
    shown = message;
    const { people, names } = message.view.content;
    if (ROOM && !joining.hidden && names[me]) {
      closeJoin();
      if (!people.includes(me)) table.act('', { type: 'join', name: names[me] });
    }
    draw();
  },
  away(why) {
    away = unreached(why, shown);
    draw();
  },
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
  else if (action === 'new-table') closeTable(table);
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
  joining.elements.name.value = load(NAME) ?? '';
  joining.hidden = false;
  document.body.classList.add('pk-buying-in');
}
draw();
