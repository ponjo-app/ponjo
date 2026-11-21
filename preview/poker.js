// The poker page (site/poker.html): a person and three AI players at one
// No-Limit Hold'em table, chatting while they play. The dealer
// (poker-dealer.js) owns what must be exact; the players decide the rest
// from the rules and what they can see (poker-world.js). Ponjo's agent
// runtime (src/core/runtime.js) runs them on the table as a world. Here: a
// run, one call of the visitor's model (game-page.js, which this page
// shares with the werewolf page, with its log's messages); and the table
// drawn with the app's classes and faces. The person may invite friends
// (poker-share.js): their pages join by a link, and this page, the host's,
// sends each what its player may see and lands what they do through the
// same writer. A friend's page, opened at `#join=<room>`, only draws.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, location, matchMedia, innerWidth, innerHeight, HTMLDialogElement */

import { $, el, load, message, models, notice, store, typingMessage } from './game-page.js';
import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { handName, legal } from './poker-dealer.js';
import { DECIDE, HUMAN, MAX_SEATS, PERSONAS, STACK, addPlayer, createWorld, force, freeSeats, intros, introduce, isPerson, lineup, react, removePlayer, deal, land, leave, myChips, newTable, say, seatFriend, topUp } from './poker-world.js';
import { createRuntime } from '../src/core/runtime.js';
import { createRuntimePanel } from '../web/runtime-panel.js';
import { host, join } from './poker-share.js';

const WALLET = 'ponjo-poker-bankroll';
const BANKROLL = 1000; // play dollars a new player starts with, and starts again with
const [MIN_BUY, MAX_BUY] = [200, 1000];
const money = (n) => `$${n.toLocaleString('en')}`;
const SLOTS = ['bottom', 'left', 'top-left', 'top', 'top-right', 'right']; // the six seats round the table, from the one this page sits in
const TURN = 30_000; // ms a person has to act while friends are at the table; then the dealer checks or folds
const NAME = 'ponjo-poker-name';
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the table it joins
const me = ROOM ? `f${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}` : HUMAN; // who this page plays as
let table = newTable(0); // the person sits down with a buy-in; a friend's page, the table as the host sends it
const running = new Set(); // players with a run going
const typing = new Set(); // players typing a line, shown in the chat
let failed = new Map(); // players whose run failed → why, until Retry

// ---- what the visitor keeps in this browser: their bankroll ----

// The bankroll, with what was on the table when they last left the page: it comes back to them.
const wallet = (({ bankroll = BANKROLL, onTable = 0, restarts = 0 } = {}) => ({ bankroll: bankroll + onTable, restarts }))(load(WALLET) ?? undefined);
const session = { bought: 0, hands: 0, biggest: 0, cashed: 0 };
const chipsOfMine = () => (turnedAway ? 0 : myChips(table, me));
const saveWallet = () => store({ ...wallet, onTable: chipsOfMine() }, WALLET);
let turnedAway = false; // a friend's page the host asked to leave: its chips are back in its bankroll
// The players' model. Once the visitor picks another, what failed is tried again.
const ai = models(() => {
  runtime?.retry();
  changed();
});

// ---- the controller ----

// Every change: draw it, and tell the world, whose runtime looks again
// and starts the runs that are due; time a person's turn, and send
// friends the table. A friend's page only draws.
function changed() {
  if (!table.hand || table.hand.street === 'done') for (const id of gone) if (gone.delete(id) && seatedNow(id)) leave(table, id);
  draw();
  if (ROOM) return;
  world.changed();
  runtime?.sync(); // who is at the table may have changed
  timeTurn();
  share();
}
const seatedNow = (id) => lineup(table).some((p) => p.id === id && !p.leaving);
const seatOf = (id) => (table.hand ? table.hand.seats : table.players).findIndex((p) => p.id === id);

// While friends are at the table, a person has TURN to act.
let clock = { key: '', ends: 0 };
function timeTurn() {
  const hand = table.hand;
  const id = hand && hand.street !== 'done' && hand.toAct !== null ? hand.seats[hand.toAct].id : null;
  if (gone.has(id)) { // their page went: no one to wait for
    force(table, id);
    return changed();
  }
  const key = id && isPerson(id) && lineup(table).some((p) => p.id !== HUMAN && isPerson(p.id)) ? `${hand.id}:${hand.n}` : '';
  if (key === clock.key) return;
  clearTimeout(clock.timer);
  clock = { key, ends: key ? Date.now() + TURN : 0, timer: key && setTimeout(() => {
    force(table, id);
    changed();
  }, TURN) };
}
setInterval(() => clock.ends && draw(), 1000);

// One run of a player: what it is due for counts as seen, one model call, and its proposal to the writer.
// A model answers in a second or two, faster than a person can follow: a
// player takes at least its own time to think (more facing a bet, less
// to answer in the chat), and its line comes after it is seen typing it.
const PACE = { Gary: [1200, 2600], Duke: [700, 1600], Penny: [1800, 3600], Mabel: [1600, 3200], Lex: [800, 1800], Hank: [1000, 2200] }; // ms a player thinks on its turn, from and to
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
function thinkTime(id, due) {
  const [from, to] = PACE[id] ?? [1000, 2000];
  const ms = from + Math.random() * (to - from);
  if (!due.turn) return ms / 2;
  const s = table.hand.seats[table.players.findIndex((p) => p.id === id)];
  return ms + (table.hand.currentBet > s.bet ? 600 : 0);
}
const typeTime = (text) => Math.min(3000, Math.max(700, text.length * 35));

// A run: one call of the model on what the player sees, then the player's
// own time to think; its proposal goes to the world, which lands the action
// and then, once the player is seen typing it, the line. A run woken only
// to talk, on a turn it stays quiet, calls no model.
async function run({ agent }, { files: basis, prompt: { rules, situation } }) {
  const at = Date.now();
  const started = performance.now();
  if (!basis.turn && !basis.talk) return { at, ms: 0, outcome: 'ok', made: null };
  try {
    const { calls, text, usage } = await ai.infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === 'decide')?.args ?? '{}');
    } catch {}
    await wait(thinkTime(agent.id, basis) - (performance.now() - started));
    return { at, ms: performance.now() - started, outcome: 'ok', usage, made: { thinking: args.thinking ?? text, action: args.action ?? null, react: args.react, say: args.say } };
  } catch (error) {
    return { at, ms: performance.now() - started, outcome: 'failed', body: String(error.message).split('\n')[0] };
  }
}

// With ?debug, the host's page shows what the runtime does (the runtime
// panel): every player's cards and thinking, so only on asking.
const ASKS = { turn: (hand) => `Turn, hand ${hand}`, line: (n) => `Chat line ${n}`, react: (hand) => `After hand ${hand}` };
const panel = !ROOM && new URLSearchParams(location.search).has('debug') && createRuntimePanel({
  where: 'this table', faceOf, retry: (id) => runtime.retry(id),
  askText: (id) => ASKS[id.split(':')[0]]?.(id.split(':')[1]) ?? id,
}) || null; // null without ?debug: `false?.add()` would throw

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

function nextHand() {
  if (!deal(table)) return buyIn('rebuy');
  session.hands++;
  changed();
}

// ---- the session: buying in, topping up, leaving ----

const buyin = $('.pk-buyin');
// The card for buying chips (`sit`, `rebuy`, `topup`) or saying how a session went (`left`).
function buyIn(kind, slot) {
  if (slot !== undefined) buyin.dataset.slot = slot;
  const room = kind === 'topup' ? Math.min(wallet.bankroll, MAX_BUY - chipsOfMine()) : Math.min(wallet.bankroll, MAX_BUY);
  const broke = kind !== 'topup' && wallet.bankroll < MIN_BUY;
  const net = chipsOfMine() + session.cashed - session.bought;
  const title = { sit: 'Sit down', rebuy: 'You are out of chips', topup: 'Top up', left: 'You left the table' }[kind];
  const text = broke ? `Your bankroll is ${money(wallet.bankroll)}, under the ${money(MIN_BUY)} buy-in. It is play money: start again with ${money(BANKROLL)}.`
    : kind === 'left' ? `${net >= 0 ? 'Up' : 'Down'} ${money(Math.abs(net))} over ${session.hands} hand${session.hands === 1 ? '' : 's'}${session.biggest ? `, your biggest pot ${money(session.biggest)}` : ''}. Your bankroll is ${money(wallet.bankroll)}.`
      : kind === 'topup' ? `Add chips from your bankroll (${money(wallet.bankroll)}), up to ${money(MAX_BUY)} on the table. They land before the next hand.`
        : `Blinds ${money(10)}/${money(20)}. Buy in for ${money(MIN_BUY)} to ${money(MAX_BUY)} from your bankroll of ${money(wallet.bankroll)}. Play money only.`;
  $('.pk-setup-title', buyin).textContent = title;
  $('.pk-buyin-text', buyin).textContent = text;
  const slider = buyin.elements.amount;
  const min = kind === 'topup' ? Math.min(20, room) : MIN_BUY;
  Object.assign(slider, { min, max: room, value: kind === 'topup' ? room : room });
  $('.pk-buyin-amount', buyin).hidden = broke || kind === 'left' || room < min;
  buyin.dataset.kind = broke ? 'restart' : kind;
  $('[type=submit]', buyin).textContent = broke ? `Start again with ${money(BANKROLL)}` : kind === 'left' ? 'Sit down again' : kind === 'topup' ? 'Add' : 'Sit down';
  $('[data-action="buyin-cancel"]', buyin).hidden = kind !== 'topup' && !(ROOM && kind === 'sit');
  const name = $('.pk-name-field', buyin);
  name.hidden = !ROOM || kind !== 'sit' || broke;
  name.querySelector('input').value ||= load(NAME) ?? '';
  if (ROOM && kind === 'left') $('[type=submit]', buyin).textContent = 'Keep watching';
  drawBuyValue();
  buyin.hidden = false;
  document.body.classList.add('pk-buying-in');
}
function drawBuyValue() {
  $('.pk-buyin-value', buyin).textContent = money(Number(buyin.elements.amount.value));
  const kind = buyin.dataset.kind;
  if (kind === 'sit' || kind === 'rebuy') $('[type=submit]', buyin).textContent = `Sit down with ${money(Number(buyin.elements.amount.value))}`;
}
function closeBuyIn() {
  buyin.hidden = true;
  document.body.classList.remove('pk-buying-in');
}
buyin.elements.amount.addEventListener('input', drawBuyValue);
buyin.addEventListener('submit', (event) => {
  event.preventDefault();
  const kind = buyin.dataset.kind;
  if (kind === 'restart') {
    wallet.bankroll = BANKROLL;
    wallet.restarts++;
    saveWallet();
    return buyIn('sit');
  }
  if (kind === 'left') return ROOM ? closeBuyIn() : buyIn('sit');
  const amount = Number(buyin.elements.amount.value);
  wallet.bankroll -= amount;
  if (kind === 'sit') Object.assign(session, { bought: 0, hands: 0, biggest: 0, cashed: 0 });
  session.bought += amount;
  if (ROOM) {
    const name = buyin.elements.name.value.trim().slice(0, 20) || 'Friend';
    store(name, NAME);
    guest.send(kind === 'sit' ? { type: 'sit', seat: Number(buyin.dataset.slot), name, buyIn: amount } : { type: 'topup', amount });
    saveWallet();
    return closeBuyIn();
  }
  topUp(table, amount);
  saveWallet();
  closeBuyIn();
  if (kind === 'topup' && table.hand && table.hand.street !== 'done') changed();
  else if (!table.hand) greet();
  else nextHand();
});
// Before the first hand, the players say hello, a line every second or so; then the cards.
function greet() {
  const lines = intros(table);
  lines.forEach((line, k) => setTimeout(() => {
    introduce(table, line);
    changed();
  }, 400 + k * 1400));
  setTimeout(nextHand, 400 + lines.length * 1400 + 600);
}

function leaveTable() {
  if (ROOM) {
    session.cashed = chipsOfMine();
    guest.send({ type: 'leave' });
  } else session.cashed = leave(table);
  wallet.bankroll += session.cashed;
  saveWallet();
  buyIn('left');
  changed();
}

// ---- the table ----

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const seats = new Map(); // a player's id → its seat
const bets = new Map(); // a player's id → its bet on the felt
// What a player is called here: "You" for this page's own, the host's name, a friend's, an AI player's.
const label = (id) => (id === me ? 'You' : isPerson(id) ? table.names[id] ?? 'Host' : id);
function faceOf(id) {
  const avatar = el('span', `pj-avatar${isPerson(id) ? '' : ' pj-avatar-agent'}`);
  avatar.append(isPerson(id) ? personFace(id === me ? 'You' : label(id), id) : agentFace(id));
  return avatar;
}
function seatNode(id) {
  const node = el('div', 'pk-seat');
  node.dataset.id = id;
  const face = el('span', 'pj-agent-face');
  face.dataset.presence = 'idle';
  face.append(faceOf(id));
  const plate = el('div', 'pk-plate');
  const name = el('span', 'pk-name', label(id));
  name.append(el('span', 'pk-position'));
  plate.append(name, el('span', 'pk-stack'), el('span', 'pk-tag'));
  const think = el('span', 'pk-think');
  think.append(el('i'), el('i'), el('i'));
  node.append(face, plate, el('div', 'pk-hole'), think);
  return node;
}
// An empty seat: a player can be asked to sit there.
const empties = SLOTS.map((pos, k) => {
  const node = el('button', 'pk-empty');
  Object.assign(node, { type: 'button', hidden: true, title: 'Add a player' });
  Object.assign(node.dataset, { pos, slot: k });
  node.append(el('span', 'pk-empty-ring', '+'), el('span', 'pk-empty-label', 'Add player'));
  return node;
});
$('.pk-seats').append(...empties);
// Where a seat is drawn: round the table from this page's own, at the bottom.
const posOf = (slot) => SLOTS[(slot - (table.slots[me] ?? 0) + MAX_SEATS) % MAX_SEATS];
// The seats as the table has them now: one for each player, coming or going, in its own place; the rest empty.
function layout() {
  const here = lineup(table);
  for (const [id, node] of seats) {
    if (here.some((p) => p.id === id)) continue;
    node.remove();
    bets.get(id).remove();
    for (const map of [seats, bets, was, shownBets]) map.delete(id);
  }
  for (const { id } of here) {
    if (!seats.has(id)) {
      seats.set(id, seatNode(id));
      bets.set(id, el('span', 'pk-bet'));
      if (id === me) $('.pk-mine').prepend(seats.get(id));
      else $('.pk-seats').append(seats.get(id));
      $('.pk-table').append(bets.get(id));
    }
    seats.get(id).dataset.pos = bets.get(id).dataset.pos = posOf(table.slots[id]);
    $('.pk-name', seats.get(id)).firstChild.textContent = label(id);
  }
  const free = freeSeats(table);
  for (const [k, node] of empties.entries()) {
    node.hidden = !free.includes(k) || (ROOM && seatedNow(me));
    node.dataset.pos = posOf(k);
    $('.pk-empty-label', node).textContent = ROOM ? 'Sit here' : 'Add player';
  }
}

const cardText = (c) => `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}`;
function card(c) {
  const node = el('span', c ? 'pk-card' : 'pk-card pk-card-back');
  node.dataset.key = c ?? 'back';
  node.setAttribute('aria-label', c ? cardText(c) : 'Face down');
  if (!c) return node;
  const rank = el('span', 'pk-rank', c[0] === 'T' ? '10' : c[0]);
  rank.append(el('small', '', SUIT[c[1]]));
  node.append(rank, el('span', 'pk-pip', SUIT[c[1]]));
  if ('hd'.includes(c[1])) node.dataset.red = '';
  return node;
}
// Cards in `box` as `cards` (null for face down), changing only what changed:
// a new card is dealt in, a card turned face up flips.
function setCards(box, cards) {
  const old = [...box.children].map((n) => n.dataset.key);
  const keys = cards.map((c) => c ?? 'back');
  if (old.join() === keys.join()) return;
  box.replaceChildren(...keys.map((key, j) => {
    const node = card(key === 'back' ? null : key);
    if (old[j] === undefined) {
      node.dataset.in = '';
      node.style.animationDelay = `${(j - old.length) * 0.09}s`;
    } else if (old[j] === 'back' && key !== 'back') node.dataset.flip = '';
    return node;
  }));
}

// One chip for an amount, coloured by value.
function chips(amount, colour) {
  const chip = el('span', 'pk-chip');
  chip.dataset.c = colour ?? (amount < 50 ? 'white' : amount < 200 ? 'red' : amount < 1000 ? 'blue' : 'black');
  return chip;
}
// Chips sliding from one place to another, in full sight: a player's stack to its
// bet, a street's bets into the pot, the pot to its winners' stacks. What they
// land on stays hidden (`hide`) until they land, then bumps.
const FLY_MS = 600;
function fly(from, to, amount, { delay = 0, hide = false } = {}) {
  if (still || !amount) return;
  const [a, b] = [from.getBoundingClientRect(), to.getBoundingClientRect()];
  const flying = el('span', 'pk-flying');
  flying.append(chips(amount));
  $('.pk-page').append(flying); // where the chip sizes are
  const f = flying.getBoundingClientRect();
  Object.assign(flying.style, { left: `${a.left + a.width / 2 - f.width / 2}px`, top: `${a.top + a.height / 2 - f.height / 2}px` });
  const to_ = `translate(${b.left + b.width / 2 - a.left - a.width / 2}px, ${b.top + b.height / 2 - a.top - a.height / 2}px)`;
  if (hide) to.animate([{ opacity: 0 }, { opacity: 0 }], { duration: delay + FLY_MS });
  flying.animate([{ transform: 'scale(0.8)' }, { transform: 'scale(1.15)', offset: 0.4 }, { transform: `${to_} scale(1)` }], { duration: FLY_MS, delay, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'backwards' }).finished.then(() => {
    flying.remove();
    replay(to, 'pk-bump');
  });
}

const TAG = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise to' };
// What a seat shows over its face: what it is doing or just did.
function tag(hand, i, { id, joining, leaving }) {
  if (joining) return ['Sits in next hand', 'wait'];
  if (leaving && (!hand || hand.street === 'done')) return ['Leaving', 'fold'];
  if (clock.ends && hand?.street !== 'done' && hand?.toAct === i) return [`${Math.max(0, Math.ceil((clock.ends - Date.now()) / 1000))}s to act`, 'wait'];
  if (running.has(id) && hand?.toAct === i) return ['Thinking…', 'wait'];
  if (!hand) return ['', ''];
  if (hand.street === 'done') {
    const won = hand.result.won[i];
    if (won) return [`Wins ${money(won)}`, ''];
    const shown = hand.result.showdown && hand.result.hands[i];
    return shown ? [handName(hand.seats[i].hole, hand.board), 'wait'] : hand.seats[i].folded ? ['Fold', 'fold'] : ['', ''];
  }
  const s = hand.seats[i];
  if (s.allIn) return ['All in', ''];
  if (s.folded) return ['Fold', 'fold'];
  const a = hand.actions.findLast((x) => x.seat === i && x.street === hand.street && TAG[x.type]);
  return a ? [`${TAG[a.type]}${a.type === 'bet' || a.type === 'raise' ? ` ${money(a.amount)}` : ''}`, ''] : ['', ''];
}

// Motion for what just changed, unless reduced: `replay` plays a class's animation again.
function replay(node, cls) {
  if (still) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
// A stack's change, "+$120" or "−$40", rising off it.
function delta(node, change) {
  if (still || !change) return;
  const mark = el('span', 'pk-delta', `${change > 0 ? '+' : '−'}${money(Math.abs(change))}`);
  if (change > 0) mark.dataset.up = '';
  node.append(mark);
  setTimeout(() => mark.remove(), 1600);
}
// A street named on the felt as it is dealt.
function banner(text) {
  if (still) return;
  const node = $('.pk-street');
  node.textContent = text;
  node.hidden = false;
  replay(node, 'pk-street');
  clearTimeout(banner.timer);
  banner.timer = setTimeout(() => { node.hidden = true; }, 1400);
}
// Folded cards sliding into the middle, face down.
function muck(box) {
  if (still) return;
  for (const card of box.querySelectorAll('.pk-card')) {
    const a = card.getBoundingClientRect();
    const b = $('.pk-board').getBoundingClientRect();
    const ghost = el('span', 'pk-card pk-card-back pk-flying');
    Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px` });
    ghost.style.setProperty('--w', `${a.width}px`);
    document.body.append(ghost);
    ghost.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${b.left + b.width / 2 - a.left - a.width / 2}px, ${b.top + b.height / 2 - a.top}px) rotate(160deg) scale(0.6)`, opacity: 0 }], { duration: 500, easing: 'ease-in' }).finished.then(() => ghost.remove());
  }
}

const shownBets = new Map(); // a player's bet as drawn on the felt, to slide into the pot
const was = new Map(); // each player as last drawn, to show what changed
let celebrated = 0; // the hand whose winners were last cheered
function draw() {
  const hand = table.hand;
  const potNode = $('.pk-pot');
  const sameHand = hand && hand.id === draw.hand;
  layout();
  for (const [id, shown] of shownBets) if (sameHand && shown && !hand.seats.find((s) => s.id === id)?.bet) fly(bets.get(id), potNode, shown);
  if (sameHand && hand.street !== draw.street) banner(hand.street === 'done' ? (hand.result.showdown ? 'Showdown' : '') : hand.street[0].toUpperCase() + hand.street.slice(1));
  if (!hand?.result?.showdown && hand?.street === 'done') $('.pk-street').hidden = true;
  draw.hand = hand?.id;
  draw.street = hand?.street;
  const sb = hand?.actions.find((a) => a.type === 'small blind')?.seat;
  const bb = hand?.actions.find((a) => a.type === 'big blind')?.seat;
  for (const p of lineup(table)) {
    const { id } = p;
    const node = seats.get(id);
    const i = (hand ? hand.seats : table.players).findIndex((q) => q.id === id); // -1 while joining
    const s = hand && i >= 0 ? hand.seats[i] : null;
    const out = s && !s.inHand;
    if (!was.has(id)) was.set(id, { acts: 0, stack: null, folded: false });
    const before = was.get(id);
    node.toggleAttribute('data-folded', Boolean(out || s?.folded || p.joining || (p.leaving && (!hand || hand.street === 'done'))));
    node.toggleAttribute('data-turn', Boolean(hand && hand.street !== 'done' && hand.toAct === i));
    node.toggleAttribute('data-thinking', Boolean(running.has(id) && hand && hand.street !== 'done' && hand.toAct === i));
    node.toggleAttribute('data-won', Boolean(hand?.street === 'done' && hand.result.won[i]));
    $('.pj-agent-face', node).dataset.presence = running.has(id) || (isPerson(id) && hand?.street !== 'done' && hand?.toAct === i) ? 'working' : out || s?.folded ? 'away' : 'idle';
    const stack = isPerson(id) ? myChips(table, id) : s ? s.stack : i >= 0 ? table.players[i].stack : STACK;
    const stackNode = $('.pk-stack', node);
    stackNode.textContent = out ? 'Out' : money(stack);
    if (before.stack !== null && stack !== before.stack) delta(stackNode, stack - before.stack);
    before.stack = stack;
    const acts = s ? hand.actions.filter((a) => a.seat === i && TAG[a.type]).length : 0;
    if (sameHand && acts > before.acts) replay($('.pk-plate', node), 'pk-pulse');
    before.acts = acts;
    if (sameHand && s?.folded && !before.folded) muck(id === me ? $('.pk-hole-mine') : $('.pk-hole', node));
    before.folded = Boolean(s?.folded);
    $('.pk-position', node).textContent = s && hand.street !== 'done' ? (i === bb ? 'BB' : i === sb && sb !== hand.button ? 'SB' : '') : '';
    const [text, kind] = tag(hand, i, p);
    const tagNode = $('.pk-tag', node);
    if (tagNode.textContent !== text) {
      Object.assign(tagNode, { textContent: text }).dataset.kind = kind;
      replay(tagNode, 'pk-pulse');
    }
    const shown = Boolean(s && hand.result?.showdown && hand.result.hands[i]);
    node.toggleAttribute('data-shown', shown);
    if (id !== me) setCards($('.pk-hole', node), s?.inHand && !s.folded ? (shown ? s.hole : [null, null]) : []);
    const bet = s?.bet ?? 0;
    const was_ = shownBets.get(id) ?? 0;
    if (bet !== was_) bets.get(id).replaceChildren(...(bet ? [chips(bet), money(bet)] : []));
    if (sameHand && bet > was_) fly($('.pk-stack', node), bets.get(id), bet - was_, { hide: true });
    shownBets.set(id, bet);
  }
  const puck = $('.pk-puck');
  puck.hidden = !hand;
  if (hand) puck.dataset.pos = posOf(table.slots[hand.seats[hand.button].id] ?? 0);
  setCards($('.pk-board'), hand?.board ?? []);
  const pot = hand ? hand.seats.reduce((sum, s) => sum + s.total, 0) : 0;
  potNode.hidden = !pot || hand.street === 'done';
  if (pot) $('.pk-pot-amount', potNode).textContent = `Pot ${money(pot)}`;
  if (pot && potNode.dataset.amount !== `${pot}`) {
    $('.pk-chip', potNode).replaceWith(chips(pot, 'gold'));
    if (sameHand) replay(potNode, 'pk-bump');
  }
  potNode.dataset.amount = pot;
  drawResult();
  const best = new Set(hand?.result?.showdown ? hand.result.hands[hand.result.pots[0].winners[0]].cards : []);
  for (const node of document.querySelectorAll('.pk-board .pk-card, .pk-seat .pk-card, .pk-hole-mine .pk-card')) node.toggleAttribute('data-best', best.has(node.dataset.key));
  if (hand?.street === 'done' && celebrated !== hand.id) {
    celebrated = hand.id;
    const mine = hand.result.won[seatOf(me)] ?? 0;
    if (mine > session.biggest) session.biggest = mine;
    saveWallet();
    if (seatedNow(me) && !chipsOfMine()) setTimeout(() => buyIn('rebuy'), 1500);
    for (const [i, won] of hand.result.won.entries()) {
      if (!won) continue;
      const node = seats.get(hand.seats[i].id);
      fly($('.pk-center'), $('.pk-stack', node), won, { delay: FLY_MS });
    }
  }
  drawMe();
  drawFeed();
}

// Between hands: the result, then the host deals the next hand; and what the session stands at.
function drawResult() {
  const hand = table.hand;
  const over = !hand || hand.street === 'done';
  $('.pk-result').hidden = !over || !hand;
  const result = $('.pk-result-text');
  const summary = resultText();
  if (result.textContent !== summary) result.textContent = summary;
  $('.pk-wait-host').hidden = !ROOM;
  $('[data-action="next"]').hidden = !chipsOfMine() || Boolean(ROOM);
  $('[data-action="invite"]').hidden = Boolean(ROOM);
  $('[data-action="thinking"]').hidden = !hand || hand.street !== 'done';
  const net = chipsOfMine() + session.cashed - session.bought;
  $('.pk-bank').innerHTML = '';
  if (away) $('.pk-bank').append(el('span', 'pk-away', away));
  else if (ROOM && !seatedNow(me)) $('.pk-bank').append(el('span', 'pk-away', 'Watching. Pick an empty seat to sit down.'));
  for (const [name, value] of [['Bankroll', money(wallet.bankroll)], ['On the table', money(chipsOfMine())], ['This session', `${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`]]) {
    const item = el('span', '', `${name} `);
    item.append(el('b', '', value));
    $('.pk-bank').append(item);
  }
  $('[data-action="topup"]').disabled = !seatedNow(me) || !chipsOfMine() || Math.min(wallet.bankroll, MAX_BUY - chipsOfMine()) < 20;
  $('[data-action="leave"]').disabled = !over || !seatedNow(me) || !chipsOfMine();
}

// The hand's result, as the table says it: who won what, with which hand.
function resultText() {
  const hand = table.hand;
  if (!hand) return 'Play money only.';
  if (hand.street !== 'done') return '';
  const { result } = hand;
  const lines = result.pots.map((p, k) => {
    const names = p.winners.map((i) => label(hand.seats[i].id));
    const with_ = result.showdown ? ` · ${handName(hand.seats[p.winners[0]].hole, hand.board)}` : '';
    return `${k ? 'Side pot: ' : ''}${names.join(' and ')} ${names.length > 1 || names[0] === 'You' ? 'win' : 'wins'} ${money(p.amount)}${with_}`;
  });
  if (seatedNow(me) && !chipsOfMine()) lines.push('You are out of chips.');
  return lines.join('. ');
}

// ---- you: your cards, what you hold, and what you may do ----

function drawMe() {
  const hand = table.hand;
  const s = hand?.seats[seatOf(me)];
  setCards($('.pk-hole-mine'), s?.inHand ? s.hole : []);
  $('.pk-hole-mine').style.opacity = s?.folded ? 0.5 : '';
  $('.pk-strength').textContent = !s?.inHand ? '' : s.folded ? 'Folded' : handName(s.hole, hand.board);
  const actor = hand?.street !== 'done' && hand?.seats[hand.toAct]?.id;
  const mine = actor === me && !away;
  const failure = !away && failed.has(actor) && { why: failed.get(actor) };
  const recovery = $('.pk-recovery');
  recovery.hidden = !failure;
  $('[data-action="retry"]', recovery).hidden = Boolean(ROOM);
  if (!failure || recovery.dataset.actor !== actor) $('details', recovery).open = false;
  recovery.dataset.actor = failure ? actor : '';
  $('details p', recovery).textContent = failure?.why ?? '';
  const stage = hand?.street === 'done' ? (hand.result.showdown ? 'Showdown' : 'Hand complete') : hand?.street;
  $('.pk-phase').textContent = hand ? `Hand ${hand.id} · ${stage[0].toUpperCase() + stage.slice(1)}` : '';
  let status = away;
  if (!status && mine) status = 'Your turn';
  else if (!status && actor) status = failure ? `${label(actor)} lost connection.${ROOM ? ' Waiting for the host to retry.' : ''}` : `Waiting for ${label(actor)}`;
  else if (!status && !hand && chipsOfMine()) status = 'Waiting for the first deal';
  const turn = $('.pk-turn');
  if (turn.textContent !== status) turn.textContent = status;
  $('.pk-controls').hidden = !mine;
  if (!mine) return;
  const l = legal(hand, seatOf(me));
  $('[data-action="call"]').textContent = l.check ? 'Check' : `Call ${money(l.call)}${l.call === s.stack ? ' · all in' : ''}`;
  $('[data-action="raise"]').hidden = !l.raise;
  $('.pk-sizes').hidden = !l.raise || l.raise.min === l.raise.max;
  if (!l.raise) return;
  const slider = $('.pk-slider');
  const key = `${hand.id}:${hand.n}`;
  if (slider.dataset.for !== key) Object.assign(slider, { min: l.raise.min, max: l.raise.max, step: 1, value: l.raise.min }).dataset.for = key;
  drawRaise();
}
function drawRaise() {
  const hand = table.hand;
  const l = legal(hand, seatOf(me));
  const to = Number($('.pk-slider').value);
  $('.pk-slider').setAttribute('aria-valuetext', money(to));
  const seat = hand.seats[seatOf(me)];
  $('.pk-sizing').textContent = seat.bet ? `Wager · add ${money(to - seat.bet)} to your ${money(seat.bet)}` : 'Wager size';
  $('[data-action="raise"]').textContent = to >= l.raise.max ? `All in ${money(seat.stack)}` : `${hand.currentBet ? 'Raise to' : 'Bet'} ${money(to)}`;
}
// A raise of a size a player names: the least, half the pot, the pot, all in.
function size(name) {
  const hand = table.hand;
  const l = legal(hand, seatOf(me));
  const pot = hand.seats.reduce((sum, s) => sum + s.total, 0) + l.toCall;
  const to = { min: l.raise.min, half: hand.currentBet + Math.round(pot / 2), pot: hand.currentBet + pot, max: l.raise.max }[name];
  $('.pk-slider').value = Math.min(l.raise.max, Math.max(l.raise.min, to));
  drawRaise();
}

// What this page's player does: landed here, or on a friend's page sent to the host, which lands it.
function perform(message) {
  if (ROOM) guest.send(message);
  else apply(HUMAN, message);
}
const play = (action) => perform({ type: 'act', action });

// What a person does, from this page or a friend's: through the writer, as an AI player's proposal.
function apply(id, message) {
  const hand = table.hand;
  const between = !hand || hand.street === 'done';
  const amount = Math.round(Number(message.amount ?? message.buyIn)) || 0;
  if (message.type === 'act' && hand && message.action && typeof message.action === 'object') land(table, id, { hand: hand.id, n: hand.n, turn: true }, { action: message.action });
  else if (message.type === 'say') say(table, id, message.text);
  else if (message.type === 'react') react(table, id, message.emoji);
  else if (message.type === 'sit' && id !== HUMAN && amount >= MIN_BUY && amount <= MAX_BUY) {
    if (!seatFriend(table, id, String(message.name).trim().slice(0, 20) || 'Friend', message.seat, amount)) room.send(peerOf(id), { type: 'refused', amount });
  } else if (message.type === 'topup' && seatedNow(id) && amount > 0 && myChips(table, id) + amount <= MAX_BUY) topUp(table, amount, id);
  else if (message.type === 'leave' && seatedNow(id) && between) leave(table, id);
  else return;
  changed();
}

// ---- the chat: what people say, as a chat app shows it, and each hand's result ----

let drawn = 0; // log entries drawn
let posted = 0; // the last hand whose result is in the chat
function drawFeed() {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  for (const node of feed.querySelectorAll('.pk-typing')) node.remove();
  for (; drawn < table.log.length; drawn++) {
    const change = table.log[drawn];
    if (change.type === 'chat') {
      const line = table.chat[change.line - 1];
      feed.append(chatLine(line, feed.lastElementChild?.dataset.by === line.by));
    } else if (change.type === 'react') {
      pop(change.by, change.emoji);
    } else if (change.type === 'rebuy') {
      feed.append(notice(`${change.by} buys back in for ${money(change.amount)}.`));
    }
  }
  const hand = table.hand;
  if (hand?.street === 'done' && posted !== hand.id) {
    posted = hand.id;
    feed.append(notice(`Hand ${hand.id}: ${resultText()}`));
  }
  for (const id of typing) feed.append(typingMessage(faceOf(id), id));
  if (stick) feed.scrollTop = feed.scrollHeight;
}
// A reaction: the emoji pops up in a bubble by its sender's face and floats away.
function pop(id, emoji) {
  const seat = seats.get(id);
  if (!seat) return;
  $('.pk-react', seat)?.remove();
  const node = el('span', 'pk-react', emoji);
  $('.pj-agent-face', seat).append(node);
  setTimeout(() => node.remove(), 2400);
}

// A line of chat: yours on the right, others' with their face and name.
function chatLine(line, more) {
  const mine = line.by === me;
  const item = message({ face: !mine && faceOf(line.by), name: label(line.by), text: line.text, mine, more });
  item.dataset.by = line.by;
  return item;
}

// ---- who is at the table: an empty seat offers a player; a player can be asked to leave ----

const menu = el('ul', 'pj-block-menu pk-menu');
menu.setAttribute('role', 'menu');
menu.hidden = true;
document.body.append(menu);
function item(content, run, disabled = '') {
  const li = el('li');
  li.setAttribute('role', 'menuitem');
  li.append(...content);
  if (disabled) Object.assign(li, { title: disabled }).setAttribute('aria-disabled', 'true');
  else li.addEventListener('click', () => {
    closeMenu();
    run();
    changed();
  });
  return li;
}
function who(id) {
  const persona = PERSONAS.find((p) => p.id === id);
  const avatar = el('span', 'pj-avatar pj-avatar-agent');
  avatar.append(agentFace(id));
  const text = el('span', 'pk-menu-text');
  text.append(el('b', '', id), el('span', '', persona.blurb));
  return [avatar, text];
}
// The menu by `anchor`: for an empty seat, the players who could sit there; for a player, to leave or stay.
function openMenu(anchor, { slot, id }) {
  const here = lineup(table);
  if (id && isPerson(id)) {
    menu.replaceChildren(el('li', 'pk-menu-head', ''), item([el('span', '', 'Ask to leave the table')], () => turnAway(id)));
    menu.firstChild.append(faceOf(id), el('b', '', label(id)));
  } else if (id) {
    const p = here.find((q) => q.id === id);
    const others = here.filter((q) => q.id !== HUMAN && !q.leaving).length;
    menu.replaceChildren(el('li', 'pk-menu-head', ''), p.leaving
      ? item([el('span', '', 'Stay at the table')], () => addPlayer(table, id))
      : item([el('span', '', p.joining ? 'Don\'t sit down' : table.hand && table.hand.street !== 'done' ? 'Leave after this hand' : 'Leave the table')], () => removePlayer(table, id), others < 2 ? 'A table needs someone to play against' : ''));
    menu.firstChild.append(...who(id));
  } else {
    const out = PERSONAS.filter((q) => !here.some((h) => h.id === q.id));
    menu.replaceChildren(...out.map((q) => item(who(q.id), () => addPlayer(table, q.id, slot))));
  }
  const at = anchor.getBoundingClientRect();
  menu.hidden = false;
  const left = Math.min(Math.max(8, at.left + at.width / 2 - menu.offsetWidth / 2), innerWidth - menu.offsetWidth - 8);
  const top = at.bottom + 4 + menu.offsetHeight < innerHeight ? at.bottom + 4 : Math.max(8, at.top - menu.offsetHeight - 4);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
}
function closeMenu() {
  menu.hidden = true;
}
$('.pk-seats').addEventListener('click', (event) => {
  const empty = event.target.closest('.pk-empty');
  const seat = event.target.closest('.pk-seat');
  if (empty && ROOM) return buyIn('sit', Number(empty.dataset.slot));
  if (empty) return openMenu(empty, { slot: Number(empty.dataset.slot) });
  if (seat && !ROOM && seat.dataset.id !== HUMAN && event.target.closest('.pj-agent-face, .pk-plate')) openMenu(seat, { id: seat.dataset.id });
});
document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !event.target.closest('.pk-menu, .pk-empty, .pk-seat')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});

// ---- their thinking, after a hand ----

function showThinking() {
  const hand = table.hand;
  const dialog = $('.pk-thinking');
  $('h2', dialog).textContent = `Their thinking, hand ${hand.id}`;
  const body = $('.pk-thinking-body', dialog);
  body.replaceChildren(...hand.seats.filter((s) => !isPerson(s.id)).map(({ id }) => {
    const seat = hand.seats.findIndex((s) => s.id === id);
    const thoughts = table.notes[id]?.thoughts.filter((t) => t.hand === hand.id) ?? [];
    const part = el('details', 'pj-trace-part');
    part.open = true;
    const summary = el('summary');
    const avatar = el('span', 'pj-avatar pj-avatar-agent');
    avatar.append(agentFace(id));
    const held = hand.seats[seat].hole;
    summary.append(icon('chevron'), avatar, el('span', 'pj-trace-title', id), el('span', 'pj-trace-meta', held.length ? `held ${held.map(cardText).join(' ')}` : 'sat out'));
    part.append(summary);
    if (!thoughts.length) part.append(el('p', 'pj-empty', 'No decisions this hand.'));
    for (const t of thoughts) {
      part.append(el('h3', 'pj-setting-group', [t.street === 'done' ? 'After the hand' : t.street[0].toUpperCase() + t.street.slice(1), t.action && t.action.type].filter(Boolean).join(' · ')));
      part.append(el('pre', 'pj-trace-text pj-trace-thinking', t.text));
    }
    return part;
  }));
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

// ---- the players' model: Ponjo's, or the visitor's own key (game-page.js) ----

function drawModel() {
  $('[data-action="key"]').hidden = Boolean(ROOM);
  if (ROOM) $('.pk-model').textContent = 'You joined a friend\'s table: the AI players run on their page.';
  else ai.draw();
}

// ---- wiring ----

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'next') nextHand();
  else if (action === 'retry' && !ROOM) {
    const actor = $('.pk-recovery').dataset.actor;
    if (failed.has(actor)) runtime.retry(actor);
  }
  else if (action === 'topup') buyIn('topup');
  else if (action === 'leave') leaveTable();
  else if (action === 'buyin-cancel') {
    closeBuyIn();
    drawResult();
  }
  else if (action === 'thinking') showThinking();
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') ai.open();
  else if (action === 'invite') invite();
  else if (action === 'invite-done') closeInvite();
  else if (action === 'copy') copyLink();
  else if (action === 'fold') play({ type: 'fold' });
  else if (action === 'call') play({ type: legal(table.hand, seatOf(me)).check ? 'check' : 'call' });
  else if (action === 'raise') play({ type: table.hand.currentBet ? 'raise' : 'bet', amount: Number($('.pk-slider').value) });
  else if (action === 'chat') {
    const chat = $('.pk-chat');
    chat.hidden = !chat.hidden;
    $('.pk-chat-open').hidden = !chat.hidden;
  } else if (event.target.closest('[data-size]')) size(event.target.closest('[data-size]').dataset.size);
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});
$('.pk-reacts').addEventListener('click', (event) => {
  const emoji = event.target.closest('[data-react]')?.dataset.react;
  if (emoji) perform({ type: 'react', emoji });
});
$('.pk-say').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  if (!input.value.trim()) return;
  perform({ type: 'say', text: input.value });
  input.value = '';
});

// ---- friends: the host's page invites them; a friend's page joins ----

const peers = new Map(); // a friend's page in the room → { id, log, chat }: its player, and how much of the log and chat it was sent
const gone = new Set(); // friends whose page went: they leave the table once the hand is over
let room = null; // the room, once the person invites friends
let away = ''; // a friend's page: why the line to the host is down
const peerOf = (id) => [...peers].find(([, p]) => p.id === id)?.[0];

const inviting = $('.pk-invite');
async function invite() {
  inviting.hidden = false;
  document.body.classList.add('pk-buying-in');
  inviting.elements.name.value = table.names[HUMAN] ?? load(NAME) ?? '';
  room ??= await host({ joined, heard: (peer, message) => peers.has(peer) && apply(peers.get(peer).id, message), left });
  inviting.elements.link.value = room.link;
}
function closeInvite() {
  const name = inviting.elements.name.value.trim().slice(0, 20);
  if (name) {
    table.names[HUMAN] = name;
    store(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-buying-in');
  changed();
}
function copyLink() {
  inviting.elements.link.select();
  navigator.clipboard?.writeText(inviting.elements.link.value).catch(() => {});
}
function joined(peer, hello) {
  if (!/^f[0-9a-f]{8}$/.test(String(hello?.id))) return room.turnAway(peer, 'Not a player');
  peers.set(peer, { id: hello.id, log: 0, chat: 0 });
  gone.delete(hello.id);
  changed();
}
function left(peer) {
  const id = peers.get(peer)?.id;
  peers.delete(peer);
  if (id && lineup(table).some((p) => p.id === id)) gone.add(id);
  changed();
}
function turnAway(id) {
  const peer = peerOf(id);
  if (peer !== undefined) room.turnAway(peer, 'The host asked you to leave the table.');
  left(peer);
}

// Each friend's page gets the table as its player may see it: its own
// cards, others' once shown, the AI players' once the hand is over; the
// log and chat since it was last sent them.
function share() {
  for (const [peer, p] of peers) {
    const seat = seatOf(p.id);
    const hand = table.hand && {
      ...table.hand,
      deck: [],
      seats: table.hand.seats.map((s, i) => ({ ...s, hole: i === seat || (table.hand.result?.showdown && table.hand.result.hands[i]) || (table.hand.street === 'done' && !isPerson(s.id)) ? s.hole : s.hole.map(() => null) })),
    };
    const done = table.hand?.street === 'done';
    const notes = Object.fromEntries(PERSONAS.map(({ id }) => [id, { thoughts: done ? table.notes[id].thoughts.filter((t) => t.hand === table.hand.id) : [] }]));
    const { rev, players, slots, names, joining, leaving, handNo } = table;
    room.send(peer, { type: 'state', table: { rev, players, slots, names, joining, leaving, handNo, hand, notes, topUp: { [p.id]: table.topUp[p.id] ?? 0 }, log: table.log.slice(p.log), logFrom: p.log, chat: table.chat.slice(p.chat), chatFrom: p.chat }, running: [...running], typing: [...typing], failed: [...failed], clock: clock.ends ? clock.ends - Date.now() : 0 });
    Object.assign(p, { log: table.log.length, chat: table.chat.length });
  }
}

// A friend's page: the table as the host sends it.
const guest = ROOM && join(ROOM, { id: me }, {
  heard(message) {
    away = '';
    if (message.type === 'refused') {
      wallet.bankroll += message.amount;
      saveWallet();
    }
    if (message.type !== 'state') return draw();
    const t = message.table;
    table = { ...t, log: [...table.log.slice(0, t.logFrom), ...t.log], chat: [...table.chat.slice(0, t.chatFrom), ...t.chat] };
    for (const [set, ids] of [[running, message.running], [typing, message.typing]]) set.clear() || ids.forEach((id) => set.add(id));
    failed = new Map(message.failed);
    clock = { ends: message.clock && Date.now() + message.clock };
    saveWallet();
    draw();
  },
  away(reason) {
    away = reason === 'host' ? 'The host is away. Waiting for them…' : reason === 'line' ? 'Reconnecting…' : reason;
    if (!['host', 'line'].includes(reason) && !turnedAway) {
      const back = chipsOfMine();
      wallet.bankroll += back;
      session.cashed += back;
      turnedAway = true;
      saveWallet();
    }
    draw();
  },
});

$('.pk-slider').addEventListener('input', drawRaise);
drawModel();
draw();
if (!ROOM) buyIn('sit');
