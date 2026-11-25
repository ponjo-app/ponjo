// The werewolf page (site/werewolf.html): a person, any friends they invite
// and AI players round a fire at one game of werewolf. The rules
// (werewolf-rules.js) own what must be exact; the table is a world
// (werewolf-world.js) on the runtime's core (src/core/), kept by the
// table's room on the relay (relay/table.js), which also runs the AI
// players (on the visitor's model, game-page.js) and the clock, with its
// deadlines and the narrator's calls. This page is one seat's client: it
// draws its seat's view, as the room sends it, with what the person knows
// of each player on their seat and their own guesses, and sends what they
// do. The page that opens the table plays as its host; friends join by a
// link, at `#join=<room>` (game-kit.js, `sit`), as on the spy page. A
// friend who joins mid-game watches, seeing what everyone sees, and plays
// from the next game; one who leaves mid-game, and is not back within
// RECONNECT_MS (a reload), has each of their turns taken as doing nothing.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, location, matchMedia, HTMLDialogElement, innerWidth, innerHeight, addEventListener */

import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { $, arrows, closeTable, el, message, models, notice, translate, typingMessage, unreached } from './game-page.js';
import { L, LANG, list } from './lang.js';
import { MAX_LINE, keep, load, sit } from './game-kit.js';
import { CALL_MS, HUMAN, MAX_SPEECH, PERSONAS, TURN, cast, isPerson } from './werewolf-world.js';

const SVG = 'http://www.w3.org/2000/svg';
const NAME = 'ponjo-poker-name'; // the visitor's name at a friend's table, as the poker page keeps it
const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the game it joins
let me = ROOM ? null : HUMAN; // who this page plays as, once the room says

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

let shown = null; // what the room last sent: { view, presence, ai }
let away = ''; // why the line to the room is down
let notes = new Map(); // the person's guess at each seat's role
let myVote = null; // { day, target }: the person's vote, theirs to see before the vote ends
// The players' model: the host's page gives the room the visitor's own key, when they pick one.
const ai = models(() => {
  table.giveKey();
  draw();
}, Boolean(ROOM));

// A new game, dealt by the room: the people at the table and the AI players
// sitting with them, in the seats the host picked; then night falls.
function startGame(size) {
  myVote = null;
  table.act('', { type: 'start', size });
}

// ---- what this page draws: its seat's view of the table ----

const EMPTY = { content: { people: [], names: {}, size: 7, seated: [], players: [], no: 0, game: null, call: null, lines: [], thoughts: {}, moment: '' }, actions: [], tasks: [] };
// The view this page draws (`t` its content, `v` the game as its seat sees it).
function picture() {
  const view = shown?.view ?? EMPTY;
  const t = view.content;
  return { t, v: t.game, view };
}
const presence = () => shown?.presence ?? {};

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const YOU = L('You', '你');
const label = (t, id) => (id === me ? YOU : isPerson(id) ? t.names[id] ?? (id === HUMAN ? L('Host', '房主') : L('Friend', '朋友')) : id);
const cap = (text) => text[0].toUpperCase() + text.slice(1);
const ROLE = { wolf: L('Werewolf', '狼人'), seer: L('Seer', '预言家'), witch: L('Witch', '女巫'), villager: L('Villager', '村民') };
const roleName = (role) => ROLE[role];
const WORD = { wolf: L('Wolf', '狼人'), seer: L('Seer', '预言家'), witch: L('Witch', '女巫'), villager: L('Villager', '村民'), good: L('Good', '好人') }; // a role on its token; good: the seer found them no wolf
const blurb = (id) => {
  const p = PERSONAS.find((x) => x.id === id);
  return L(p.blurb, p.zh.blurb);
};
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
  name.append(Object.assign(el('span', 'pk-position', String(i + 1)), { title: L(`Seat ${i + 1}`, `${i + 1} 号位`) }), label(t, id));
  const roles = el('span', 'ww-idents');
  roles.append(mark('ww-ident', 'fact'), mark('ww-ident', 'note'));
  plate.append(name, roles, el('span', 'ww-dots'), el('span', 'pk-tag'));
  node.append(face, plate);
  return node;
}
// The seats of a new game round the fire, or before any, of whoever sits
// at the table: the person's notes and vote start again.
function layout(t) {
  const ids = t.game ? t.players : t.seated;
  const key = `${t.no}:${ids.join()}`;
  if (key === seatsFor) return;
  seatsFor = key;
  $('.site-theme').hidden = Boolean(t.game); // the game sets light and dark now
  notes = new Map();
  myVote = null;
  formAt = '';
  arrowsFor = '';
  for (const node of seats) node.remove();
  const mine = Math.max(0, ids.indexOf(me));
  seats = ids.map((id, i) => seatNode(t, id, (i - mine + ids.length) % ids.length, i, ids.length));
  $('.ww-ring').append(...seats);
}

// What the person may do to seat `i` now, if anything: { verb, type }.
function actionOn(v, i) {
  if (!v.due || !v.seats[i].alive) return null;
  const k = v.due.kind;
  if (k === 'kill' && !v.pack.includes(i)) return { verb: L('Kill', '刀'), type: 'kill' };
  if (i === v.seat) return null;
  if (k === 'check') return { verb: L('Check', '查验'), type: 'check' };
  if (k === 'vote') return { verb: L('Vote out', '投票放逐'), type: 'vote' };
  if (k === 'potion' && v.due.poison) return { verb: L('Poison', '毒'), type: 'poison' };
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
    if (e.type === 'save' && e.target === i && v.seats[i].alive) out.status = [`saved:${e.day}`, () => symbol('witch'), '', L(`You saved them, night ${e.day}`, `第 ${e.day} 夜你救了他们`)];
  }
  const death = deathOf(v, i);
  if (death) out.status = [`${death.how}:${death.day}`, () => deathMark(death.how), death.how, deathText(death)];
  if (v.phase === 'vote' && v.voted.includes(i)) out.status = ['voted', () => symbol('ballot'), 'voted', L('Has voted', '已投票')];
  const tonight = (type) => v.phase === 'night' && v.log.some((e) => e.type === type && e.day === v.day && e.target === i);
  if ((tonight('kill') && v.pack) || tonight('attacked')) out.claw = v.pack ? L('The pack\'s kill tonight', '狼队今晚的刀口') : L('Attacked tonight', '今晚被袭击');
  const vote = lastVote(v);
  if (vote) {
    out.dots = Object.values(vote.votes).filter((x) => x === i).length;
    if (i in vote.votes) out.words.push(vote.votes[i] === null ? L('Abstained', '弃票') : L(`Voted ${label(t, t.players[vote.votes[i]])}`, `投给了 ${label(t, t.players[vote.votes[i]])}`));
    if (out.dots) out.words.push(L(`${out.dots} vote${out.dots > 1 ? 's' : ''}`, `${out.dots} 票`));
  }
  out.words.unshift(...[out.fact, out.status, out.note].filter(Boolean).map((m) => m[3]), ...(out.claw ? [out.claw] : []));
  if (!isPerson(id)) out.words.push(blurb(id));
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
      : check ? [`check:${check.wolf}`, () => token(check.wolf ? 'wolf' : 'good'), '', check.wolf ? L('The seer found a werewolf', '预言家查出是狼人') : L('The seer found them good', '预言家查出是好人')] : null,
    note: guess ? [`note:${guess}`, () => token(guess, true), '', L(`Your guess: ${roleName(guess)}`, `你猜：${roleName(guess)}`)] : null,
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
const HOW = { wolves: L('killed by the wolves', '被狼人杀害'), poison: L('poisoned by the witch', '被女巫毒死'), both: L('attacked by the wolves and poisoned by the witch', '被狼人袭击，又被女巫毒死') };
function deathText({ how, day, votes }) {
  if (how === 'vote') return L(`Voted out on day ${day}, by ${votes} vote${votes === 1 ? '' : 's'}`, `第 ${day} 天以 ${votes} 票被放逐`);
  return how === 'night' ? L(`Died in night ${day}: how stays secret until the game ends`, `死于第 ${day} 夜：死因在游戏结束前保密`) : L(`${cap(HOW[how])}, night ${day}`, `第 ${day} 夜${HOW[how]}`);
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
    $('.pk-tag', node).textContent = presence()[t.players[i]]?.failed ? L('Can\'t reach the model', '连不上模型') : '';
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
  const fresh = vote && arrowsFor !== `${vote.day}`;
  if (vote) arrowsFor = `${vote.day}`;
  const ms = arrows($('.ww-votes'), pairs, (i) => $('.pj-avatar', seats[i]), fresh && !still);
  if (ms !== null) votesIn = ms;
}
addEventListener('resize', () => draw());

// Over the clearing: the sun or the moon and the day, and one line that
// changes with the moment: the narrator's call, the vote, last words.
const CALL_TEXT = {
  dusk: L('Night falls. Everyone, close your eyes.', '天黑请闭眼。'),
  wolves: L('Werewolves, open your eyes and pick a kill.', '狼人请睁眼，选择要杀的人。'),
  seer: L('Seer, open your eyes and check a player.', '预言家请睁眼，选择要查验的人。'),
  witch: L('Witch, open your eyes.', '女巫请睁眼。'),
};
function drawCenter(t, v) {
  const night = v.phase === 'night';
  $('.ww-board').dataset.time = night ? 'night' : 'day';
  document.documentElement.dataset.theme = night ? 'dark' : 'light'; // the game's clock is the page's theme
  const time = $('.ww-time');
  if (time.dataset.icon !== (night ? 'moon' : 'sun')) time.replaceChildren(icon(night ? 'moon' : 'sun'));
  time.dataset.icon = night ? 'moon' : 'sun';
  $('.ww-phase-text').textContent = v.phase === 'over' ? (v.winner === 'village' ? L('The village wins', '好人胜利') : L('The werewolves win', '狼人胜利')) : night ? L(`Night ${v.day}`, `第 ${v.day} 夜`) : L(`Day ${v.day}`, `第 ${v.day} 天`);
  const call = t.call?.step ?? 'dusk';
  const [key, mark, words] = away ? ['away', null, away]
    : v.phase === 'over' ? ['over', null, v.seat < 0 ? '' : (v.role === 'wolf') === (v.winner === 'wolves') ? L('You won', '你赢了') : L('You lost', '你输了')]
        : night ? [`call:${call}`, call === 'dusk' ? null : symbol(call === 'wolves' ? 'wolf' : call), CALL_TEXT[call]]
          : v.phase === 'vote' ? ['vote', symbol('ballot'), L('Vote', '投票')]
            : v.phase === 'last' ? ['last', null, L('Last words', '遗言')] : ['day', null, ''];
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
  const victim = attacked && (attacked.target === v.seat ? L('You were', '你') : L(`${label(t, t.players[attacked.target])} was`, label(t, t.players[attacked.target])));
  $('.ww-ask').textContent = {
    kill: () => (v.due.round === 2 ? L('The pack disagreed: pick again.', '狼队意见不一：再选一次。') : L('Pick tonight\'s kill.', '选择今晚要杀的人。')),
    check: () => L('Pick a player to check.', '选一名玩家查验。'),
    potion: () => (attacked ? L(`${victim} attacked tonight.`, `${victim}今晚被袭击了。`) : L('Use a potion?', '要用药吗？')),
    speak: () => L('Your turn to speak: say it in the chat.', '轮到你发言了：在聊天框里说。'),
    last: () => L('Your last words: say them in the chat.', '你的遗言：在聊天框里说。'),
    vote: () => L('Pick a player to vote out.', '选一名玩家放逐。'),
  }[kind]();
  $('[data-do="abstain"]', form).hidden = kind !== 'vote';
  $('[data-do="save"]', form).hidden = kind !== 'potion' || !v.due.save;
  if (attacked) $('[data-do="save"]', form).textContent = L(`Save ${label(t, t.players[attacked.target])}`, `救 ${label(t, t.players[attacked.target])}`);
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
  box.placeholder = { all: !kind ? L('Chat with the table…', '和大家聊聊…') : kind === 'last' ? L('Your last words…', '你的遗言…') : L('Speak to the village…', '对村子发言…'), pack: L('A line to the pack, sent with your pick', '给狼队的一句话，随刀口一起发出'), muted: '' }[audience];
  $('[type=submit]', chat).disabled = audience !== 'all' || !box.value.trim();
  const speaker = v?.speaker == null ? null : label(t, t.players[v.speaker]);
  const why = audience === 'all' ? [icon('users'), kind ? L('Everyone hears you.', '所有人都听得到你。') : L('Everyone at the table hears you.', '桌上所有人都听得到你。')]
    : audience === 'pack' ? [token('wolf'), L('Only the pack hears you.', '只有狼队听得到你。')]
      : [symbol('muted'), !v ? L('Join the table to chat.', '加入牌桌才能聊天。')
        : v.seat < 0 && v.phase !== 'over' ? L('You are watching: you play from the next game.', '你在观战：下一局开始参与。')
          : !v.alive && !['over', 'last'].includes(v.phase) ? L('You are out: the dead don\'t speak.', '你已出局：死者不能说话。')
            : v.phase === 'over' ? L('The game is over: you watched it.', '游戏结束了：你观看了这一局。')
              : v.phase === 'night' ? L('Muted: it is night, and everyone\'s eyes are shut.', '不能发言：现在是夜晚，大家都闭着眼。')
                  : v.phase === 'vote' ? L('Muted while everyone votes.', '投票时不能发言。')
                    : speaker ? L(`Muted: ${speaker} ${speaker === YOU ? 'have' : 'has'} the floor. You speak in turn.`, `不能发言：${speaker}正在发言。请按顺序发言。`) : L('Muted.', '不能发言。')];
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
// pack), sent to the room, which lands it (a person's change answers no
// task: refused, it lands nothing, and the room says why).
function perform(type, target) {
  const { t, v, view } = picture();
  if (!view.actions.includes(type)) return;
  const body = { type, ...(target !== undefined ? { target } : {}), ...(['speak', 'kill', 'chat'].includes(type) ? { text: box.value } : {}) };
  if (type === 'vote' || type === 'abstain') myVote = { day: v.day, target: target ?? null };
  if ('text' in body) box.value = '';
  table.act(t.moment, body);
  draw();
}
// What the world and the rules say when they turn a change away, in Chinese (game-page.js, `translate`).
const ONLY = { kill: '刀人', check: '查验', 'save, poison or pass': '救人、毒人或跳过', speak: '发言', 'vote or abstain': '投票或弃票' };
const KNOWN = [
  ['Stale: the game moved on before your action landed.', '慢了一步：你的操作送达前，游戏已经往下走了。'],
  ['Wait for everyone to say hello.', '等大家打完招呼。'],
  ['There is no game on: chat instead.', '现在没有对局：聊聊天吧。'],
  ['Wait for the narrator to call you.', '等主持人叫到你。'],
  ['Only the host starts a game.', '只有房主能开局。'],
  ['A game is on.', '已经有一局在进行。'],
  [/^A game (?:is|has) ([\d, ]+) seats(?:, dealt their roles)?\.$/, '一局有 $1 个座位。'],
  ['Only a person sits at the table.', '只有真人能入座。'],
  ['You are not at the table.', '你不在桌上。'],
  ['Not now: the game is on.', '现在不行：游戏正在进行。'],
  ['Say something.', '说点什么。'],
  ['Only the host sets the language.', '只有房主能设置语言。'],
  ['Say something: a speech is your turn.', '说点什么：轮到你发言了。'],
  [/^Too long: at most (\d+) characters, you wrote (\d+)\.$/, '太长了：最多 $1 个字符，你写了 $2 个。'],
  ['The game is over.', '游戏已经结束。'],
  ['You have acted already: wait for the others.', '你已经行动过了：等其他人。'],
  ['It is not your turn.', '还没轮到你。'],
  [/^Now you may only (.+)\.$/, (_, words) => `现在你只能${ONLY[words] ?? words}。`],
  ['Pick a living player to kill.', '选一名活着的玩家刀。'],
  ['That player is a wolf: pick someone else.', '那是狼人：换一个人。'],
  ['Pick another living player to check.', '选另一名活着的玩家查验。'],
  ['Your save potion is used.', '你的解药已经用过了。'],
  ['No one was attacked tonight.', '今晚没有人被袭击。'],
  ['You may not save yourself.', '你不能救自己。'],
  ['Your poison is used.', '你的毒药已经用过了。'],
  ['Pick another living player to poison.', '选另一名活着的玩家下毒。'],
  ['Vote for another living player, or abstain.', '投给另一名活着的玩家，或弃票。'],
];
function refused(why) {
  const error = $('.ww-error');
  error.textContent = why ? translate(why, KNOWN) : '';
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
  if (!isPerson(id)) who.append(el('span', '', blurb(id)));
  head.append(faceOf(t, id), who);
  const items = [head];
  if (act) {
    const doIt = item(`${act.verb} ${label(t, id)}`, () => perform(act.type, i));
    doIt.dataset.do = '';
    items.push(doIt);
  }
  if (i !== v.seat && v.phase !== 'over') {
    items.push(...['wolf', 'seer', 'witch', 'villager'].map(guess));
    if (notes.has(i)) items.push(item(L('Clear the note', '清除标记'), () => {
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
  const name = (i) => (i === v.seat ? L('you', '你') : label(t, t.players[i]));
  const Name = (i) => cap(name(i));
  const names = (seats) => list(seats.map(Name));
  const mine = (i) => i === v.seat; // English says "you want", "you were": its verbs agree with you
  const rows = [];
  let last = null; // who said the row before, to run their bubbles together
  const known = (i) => Object.values(identity(v, i)).filter(Boolean).map((m) => m[1]());
  const say = (i, text, note, pack = false) => {
    const id = t.players[i];
    const row = message({ face: id !== me && faceOf(t, id), name: [label(t, id), ...known(i)], text, note: pack ? el('span', 'ww-only', L('only the pack', '仅狼队')) : note, mine: id === me, more: last === i && !pack });
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
      if (v.phase !== 'over') row.append(el('span', 'ww-only', secret === 'wolf' ? L('only the pack', '仅狼队') : L('only you', '仅你可见')));
    }
    rows.push(row);
    last = null;
  };
  // the chat before this game, and (below) after it
  const chatted = (no) => t.lines.filter((l) => l.no === no);
  const chatLine = (l) => {
    const i = t.players.indexOf(l.by);
    if (i >= 0) return say(i, l.text, '');
    rows.push(message({ face: l.by !== me && faceOf(t, l.by), name: label(t, l.by), text: l.text, mine: l.by === me, more: last === l.by }));
    last = l.by;
  };
  chatted(t.no - 1).forEach(chatLine);
  for (const e of v.log) {
    const secret = SECRET[e.type];
    if (e.type === 'night') line(L(`Night ${e.day} falls. Everyone closes their eyes.`, `第 ${e.day} 夜降临。大家闭上眼睛。`));
    else if (e.type === 'pick') {
      line(L(`${Name(e.seat)} ${mine(e.seat) ? 'want' : 'wants'} to kill ${name(e.target)}${e.round === 2 ? ' (second pick)' : ''}.`, `${Name(e.seat)}想杀 ${name(e.target)}${e.round === 2 ? '（第二次选择）' : ''}。`), secret);
      if (e.text) say(e.seat, e.text, '', true);
    } else if (e.type === 'kill') line(e.target === null ? L('The pack kills no one.', '狼队今晚空刀。') : L(`The pack kills ${name(e.target)}.`, `狼队杀了 ${name(e.target)}。`), secret);
    else if (e.type === 'check') line(L(`${Name(e.seat)} checked ${name(e.target)}: `, `${Name(e.seat)}查验了 ${name(e.target)}：`), secret, token(e.wolf ? 'wolf' : 'good'));
    else if (e.type === 'attacked') line(L(`The wolves attacked ${name(e.target)}.`, `狼人袭击了 ${name(e.target)}。`), secret);
    else if (e.type === 'save') line(L(`${Name(e.seat)} saved ${name(e.target)}.`, `${Name(e.seat)}救了 ${name(e.target)}。`), secret);
    else if (e.type === 'poison') line(L(`${Name(e.seat)} poisoned ${name(e.target)}.`, `${Name(e.seat)}毒了 ${name(e.target)}。`), secret);
    else if (e.type === 'dawn') {
      // how, to whoever may know it (deathOf): the pack its kill, the witch her poison, everyone once the game is over
      const told = e.deaths.map((i) => [i, deathOf(v, i)?.how ?? 'night']);
      const known = told.filter(([, how]) => how !== 'night');
      const rest = told.filter(([, how]) => how === 'night').map(([i]) => i);
      const said = [...known.map(([i, how]) => L(`${Name(i)} ${mine(i) ? 'were' : 'was'} ${HOW[how]}`, `${Name(i)}${HOW[how]}`)), ...(rest.length ? [L(`${names(rest)} died in the night`, `${names(rest)}在夜里死了`)] : [])];
      line(said.length ? L(`Day ${e.day}. ${said.join('. ')}.`, `第 ${e.day} 天。${said.join('。')}。`) : L(`Day ${e.day}. No one died in the night.`, `第 ${e.day} 天。昨晚是平安夜。`));
    } else if (e.type === 'speech' || e.type === 'last') {
      if (e.silent) line(e.type === 'last' ? L(`${Name(e.seat)} said nothing as last words.`, `${Name(e.seat)}没有留遗言。`) : L(`${Name(e.seat)} said nothing.`, `${Name(e.seat)}什么也没说。`));
      else say(e.seat, e.text, e.type === 'last' ? L('last words', '遗言') : '');
    } else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, x]) => `${Name(Number(s))} → ${x === null ? L('abstained', '弃票') : name(x)}`);
      const out = e.out === null ? L('A tie: no one is out.', '平票：无人出局。') : L(`${Name(e.out)} ${mine(e.out) ? 'are' : 'is'} out.`, `${Name(e.out)}出局。`);
      line(L(`The vote: ${votes.join(', ')}. ${out}`, `投票：${votes.join('，')}。${out}`));
    } else if (e.type === 'over') line(e.winner === 'village' ? L('Every werewolf is dead: the village wins.', '狼人全部出局：好人胜利。') : L('The werewolves are as many as the rest: they win.', '狼人与其他人一样多：狼人胜利。'));
  }
  chatted(t.no).forEach(chatLine);
  rows.push(...working(t));
  feed.replaceChildren(...rows);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// Under the log: who is typing, and who could not reach the model.
function working(t) {
  return Object.entries(presence()).flatMap(([id, p]) => {
    if (p.typing) return [typingMessage(faceOf(t, id), id)];
    if (!p.failed) return [];
    const row = notice(L(`${id} could not reach the model: ${p.failed}`, `${id} 连不上模型：${p.failed}`));
    row.dataset.failed = '';
    return [row];
  });
}

// Before any game, the log is the chat of everyone at the table.
function drawLobby(t) {
  $('.ww-phase-text').textContent = away || (ROOM ? L('Waiting for the host to start a game', '等房主开始一局') : L('Round the fire', '围坐篝火'));
  $('.ww-over').hidden = Boolean(ROOM); // before any game, the host's way to start one
  $('[data-action="thinking"]').hidden = true;
  $('.ww-hint').hidden = true; // no roles to guess yet
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  let last = null;
  feed.replaceChildren(...t.lines.map((l) => {
    const row = message({ face: l.by !== me && faceOf(t, l.by), name: label(t, l.by), text: l.text, mine: l.by === me, more: last === l.by });
    last = l.by;
    return row;
  }), ...working(t));
  if (stick) feed.scrollTop = feed.scrollHeight;
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
  ai.draw(shown?.ai);
}

// ---- their thinking, after the game ----

// An action in a player's thinking, in words.
const ACTION = { kill: L('kill', '刀'), check: L('check', '查验'), save: L('save', '救'), poison: L('poison', '毒'), pass: L('pass', '跳过'), speak: L('speak', '发言'), vote: L('vote', '投票'), abstain: L('abstain', '弃票') };
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
    if (v.seats[seat].role) meta.append(token(v.seats[seat].role)); // the game is over: every role shows
    meta.append(v.seats[seat].alive ? L(' alive', ' 存活') : L(' dead', ' 死亡'));
    summary.append(icon('chevron'), faceOf(t, id), el('span', 'pj-trace-title', id), meta);
    part.append(summary);
    const thoughts = t.thoughts[id] ?? [];
    if (!thoughts.length) part.append(el('p', 'pj-empty', L('No decisions.', '没有决定。')));
    for (const th of thoughts) {
      const target = Number.isInteger(th.action?.target) ? ` ${label(t, t.players[th.action.target])}` : '';
      const when = th.phase === 'night' ? L(`Night ${th.day}`, `第 ${th.day} 夜`) : L(`Day ${th.day}`, `第 ${th.day} 天`);
      part.append(el('h3', 'pj-setting-group', `${when}${th.action ? ` · ${ACTION[th.action.type] ?? th.action.type}${target}` : ''}`));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', th.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- a new game: how many players, who is at the table, and the roles that makes ----

const starting = $('.ww-start');
function openStart() {
  starting.hidden = false;
  document.body.classList.add('pk-buying-in');
  drawStart();
}
function drawStart() {
  const { people, size } = picture().t;
  for (const b of starting.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === size));
  const roles = cast(size);
  $('.ww-cast', starting).replaceChildren(...[...new Set(roles)].map((role) => {
    const li = el('li', '', `${roles.filter((r) => r === role).length} × `);
    li.append(token(role));
    return li;
  }));
  const seated = Math.min(people.length, size);
  const here = list(people.map((id) => label(picture().t, id)));
  const over = people.length - size;
  const watch = over > 0 ? L(` The last ${over === 1 ? 'one watches' : `${over} watch`}.`, `最后 ${over} 位观战。`) : '';
  const rest = size - seated;
  $('.ww-people').textContent = people.length <= 1 ? '' : L(`At the table: ${here}.${watch} AI players take the ${rest === 1 ? 'other seat' : `other ${rest} seats`}.`, `桌上有：${here}。${watch}其余 ${rest} 个座位由 AI 玩家坐。`);
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

const joining = $('.ww-join');
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
const table = sit('werewolf', HUMAN, {
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

if (ROOM) {
  for (const node of document.querySelectorAll('[data-action="new"], [data-action="key"], [data-action="invite"]')) node.hidden = true;
  joining.elements.name.value = load(NAME) ?? '';
  joining.hidden = false;
  document.body.classList.add('pk-buying-in');
}
draw();
