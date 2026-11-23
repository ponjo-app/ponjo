// The poker page (site/poker.html): a person and AI players at one
// No-Limit Hold'em table, chatting while they play. The dealer
// (poker-dealer.js) owns what must be exact; the table is a world
// (poker-world.js) on the runtime's core (src/core/): a store in this
// page, kept in the browser's storage on each change (game-kit.js), so a
// refresh goes on with the hand. Each member has a controller: an AI
// player's program is one call of the visitor's model (game-page.js, with
// the log's messages); the person's is this screen, which draws their
// seat's view and lands what they do; the dealer's deals each hand and
// street from a deck the table never holds; the clock's waits for each
// turn's deadline. The person may invite friends (poker-share.js): their
// pages join by a link, and this page, the host's, sends each its seat's
// view and lands what they do. A friend's page, opened at `#join=<room>`,
// only draws. preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, location, matchMedia, innerWidth, innerHeight, HTMLDialogElement */

import { $, el, message, models, notice, typingMessage } from './game-page.js';
import { agent, friends, keep, load, openTable, typer } from './game-kit.js';
import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { clock, control } from '../src/core/controller.js';
import { draw as cards, handName } from './poker-dealer.js';
import { CLOCK, DEALER, DECIDE, HUMAN, MAX_BUY, MAX_SEATS, MIN_BUY, PERSONAS, STACK, decided, freeSeats, isPerson, lineup, myChips, newTable, prompt, world } from './poker-world.js';
import { createRuntimePanel } from '../web/runtime-panel.js';
import { guestId, join } from './poker-share.js';

const WALLET = 'ponjo-poker-bankroll';
const TABLE = 'ponjo-poker-table'; // the table the host's page holds: { rev, state }, as its store last saved it
const BANKROLL = 1000; // play dollars a new player starts with, and starts again with
const money = (n) => `$${n.toLocaleString('en')}`;
const SLOTS = ['bottom', 'left', 'top-left', 'top', 'top-right', 'right']; // the six seats round the table, from the one this page sits in
const NAME = 'ponjo-poker-name';
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

const ROOM = new URLSearchParams(location.hash.slice(1)).get('join'); // a friend's page: the room of the table it joins
const me = ROOM ? guestId(ROOM) : HUMAN; // who this page plays as
let shown = null; // this page's seat's view: the host's, as its controller last read it; a friend's, as the host last sent it
let present = {}; // a friend's page: the presence the host last sent
const EMPTY = { content: { ...newTable(), players: [], hand: null, legal: null, moment: '', ends: 0 }, tasks: [] };
let table = EMPTY.content; // the table as this page's seat sees it

// ---- what the visitor keeps in this browser: their bankroll ----

// The bankroll, with what was on the table when they last left the page: it
// comes back to them, unless the table is still here, chips and all.
const kept = !ROOM && load(TABLE);
const wallet = (({ bankroll = BANKROLL, onTable = 0, restarts = 0 } = {}) => ({ bankroll: bankroll + (kept ? 0 : onTable), restarts }))(load(WALLET) ?? undefined);
const session = { bought: 0, hands: 0, biggest: 0, cashed: 0 };
const chipsOfMine = () => (turnedAway ? 0 : myChips(table, me));
const saveWallet = () => keep({ ...wallet, onTable: chipsOfMine() }, WALLET);
let turnedAway = false; // a friend's page the host asked to leave: its chips are back in its bankroll
// A friend's page, reloaded: the chips it had on the table, put back in the
// bankroll above, go back on the table if the host still has it seated.
let reclaim = ROOM ? load(WALLET)?.onTable ?? 0 : 0;
const ai = models(() => draw()); // the players' model

// ---- the store and its members, on the host's page ----

// The store, kept in this browser on each change. Its members' presence
// (who is at work, whose run failed) is drawn here and sent to friends.
const store = ROOM ? null : openTable(world, TABLE, newTable, () => {
  draw();
  guests.shown();
});
const presence = () => (ROOM ? present : store.client(HUMAN).present());
const seatedNow = (id) => lineup(table).some((p) => p.id === id && !p.leaving);
const seatOf = (id) => (table.hand ? table.hand.seats : table.players).findIndex((p) => p.id === id);
const myTurn = () => (shown?.tasks ?? []).some((t) => t.given.startsWith('turn:'));
setInterval(() => table.ends && draw(), 1000);

// A model answers in a second or two, faster than a person can follow: a
// player takes at least its own time to think (more facing a bet, less to
// answer in the chat). Its line lands with its move; each page types it out after.
const PACE = { Gary: [1200, 2600], Duke: [700, 1600], Penny: [1800, 3600], Mabel: [1600, 3200], Lex: [800, 1800], Hank: [1000, 2200] }; // ms a player thinks on its turn, from and to
function thinkTime(id, tasks, view) {
  const [from, to] = PACE[id];
  const ms = from + Math.random() * (to - from);
  if (!tasks.some((t) => t.given.startsWith('turn:'))) return ms / 2;
  return ms + (view.content.legal?.toCall ? 600 : 0);
}
const typeTime = (text) => Math.min(3000, Math.max(700, text.length * 35));

// With ?debug, the host's page shows each AI player's runs (the runtime
// panel): every player's cards and thinking, so only on asking.
const ASKS = { turn: (hand) => `Turn, hand ${hand}`, line: (n) => `Chat line ${n}`, react: (hand) => `After hand ${hand}` };
const panel = !ROOM && new URLSearchParams(location.search).has('debug') ? createRuntimePanel({
  where: 'this table', faceOf,
  askText: (id) => ASKS[id.split(':')[0]]?.(id.split(':')[1]) ?? id,
}) : null;

// AI player `id`'s program: a run is one call of the model on what its
// seat sees, then the player's own time to think; what it decided lands at once.
const think = (id) => agent({ client: store.client(id), id, infer: ai.infer, tool: DECIDE, prompt, panel, decide: decided, pace: (tasks, view) => thinkTime(id, tasks, view) });

// The dealer's program: on its task, the cards it is to deal, from the
// rest of a shuffled deck: the table holds no deck. The first hand waits
// for the players' hellos.
const dealer = ([task], view, signal) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ body: { cards: cards(view.content.out, view.content.need) } }), (task.at ?? 0) - Date.now());
  signal.addEventListener('abort', () => clearTimeout(timer));
});

// What this page's person does: landed here, or on a friend's page sent
// to the host, which lands it. A move is made on the turn this page sees.
// Refused, it lands nothing, and they see why.
function perform(body) {
  if (ROOM) return guest.send({ type: 'act', base: table.moment, body });
  const out = store.commit(HUMAN, { base: table.moment, body });
  if (out.refused) $('.pk-turn').textContent = out.refused;
  return out;
}
const nextHand = () => perform({ type: 'next' });

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
    keep(name, NAME);
    perform(kind === 'sit' ? { type: 'sit', seat: Number(buyin.dataset.slot), name, buyIn: amount } : { type: 'topup', amount });
    saveWallet();
    return closeBuyIn();
  }
  // the host: buying in deals the next hand; the first time, after the players' hellos
  if (perform(kind === 'topup' ? { type: 'topup', amount } : { type: 'sit', buyIn: amount }).refused) wallet.bankroll += amount;
  saveWallet();
  closeBuyIn();
});

function leaveTable() {
  session.cashed = chipsOfMine();
  perform({ type: 'leave' });
  wallet.bankroll += session.cashed;
  saveWallet();
  buyIn('left');
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
  if (presence()[id]?.failed) return ['Can\'t reach the model', 'failed'];
  if (table.ends && hand?.street !== 'done' && hand?.toAct === i) return [`${Math.max(0, Math.ceil((table.ends - Date.now()) / 1000))}s to act`, 'wait'];
  if (presence()[id]?.working && hand?.toAct === i) return ['Thinking…', 'wait'];
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
    node.toggleAttribute('data-thinking', Boolean(presence()[id]?.working && hand && hand.street !== 'done' && hand.toAct === i));
    node.toggleAttribute('data-won', Boolean(hand?.street === 'done' && hand.result.won[i]));
    $('.pj-agent-face', node).dataset.presence = presence()[id]?.working || (isPerson(id) && hand?.street !== 'done' && hand?.toAct === i) ? 'working' : out || s?.folded ? 'away' : 'idle';
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
    if (hand.seats[seatOf(me)]?.inHand) session.hands++;
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
  if (shown) typed.open();
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
  const mine = myTurn() && !away;
  const stage = hand?.street === 'done' ? (hand.result.showdown ? 'Showdown' : 'Hand complete') : hand?.street;
  $('.pk-phase').textContent = hand ? `Hand ${hand.id} · ${stage[0].toUpperCase() + stage.slice(1)}` : '';
  let status = away;
  if (!status && mine) status = 'Your turn';
  else if (!status && actor) status = `Waiting for ${label(actor)}`;
  else if (!status && !hand && chipsOfMine()) status = 'Waiting for the first deal';
  const turn = $('.pk-turn');
  if (turn.textContent !== status) turn.textContent = status;
  $('.pk-controls').hidden = !mine;
  if (!mine) return;
  const l = table.legal;
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
  const l = table.legal;
  const to = Number($('.pk-slider').value);
  $('.pk-slider').setAttribute('aria-valuetext', money(to));
  const seat = hand.seats[seatOf(me)];
  $('.pk-sizing').textContent = seat.bet ? `Wager · add ${money(to - seat.bet)} to your ${money(seat.bet)}` : 'Wager size';
  $('[data-action="raise"]').textContent = to >= l.raise.max ? `All in ${money(seat.stack)}` : `${hand.currentBet ? 'Raise to' : 'Bet'} ${money(to)}`;
}
// A raise of a size a player names: the least, half the pot, the pot, all in.
function size(name) {
  const hand = table.hand;
  const l = table.legal;
  const pot = hand.pot + l.toCall;
  const to = { min: l.raise.min, half: hand.currentBet + Math.round(pot / 2), pot: hand.currentBet + pot, max: l.raise.max }[name];
  $('.pk-slider').value = Math.min(l.raise.max, Math.max(l.raise.min, to));
  drawRaise();
}

const play = (action) => perform({ action });

// ---- the chat: what people say, as a chat app shows it, and each hand's result ----

// A line an AI player said lands at once; this page types it out first,
// one after another, unless it was there when the page opened.
const typed = typer(() => draw(), typeTime);
let drawn = 0; // lines drawn
let popped = null; // reactions shown, from when the page opened
let posted = 0; // the last hand whose result is in the chat
function drawFeed() {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  for (const node of feed.querySelectorAll('.pk-typing')) node.remove();
  typed.clear();
  for (; drawn < table.chat.length; drawn++) {
    const line = table.chat[drawn];
    if (!isPerson(line.by) && !typed.shows(`l:${line.id}`, line.by, line.text)) break;
    feed.append(line.by === DEALER ? notice(line.text) : chatLine(line, feed.lastElementChild?.dataset.by === line.by));
  }
  if (shown) popped ??= table.reactions.length;
  for (; popped < table.reactions.length; popped++) pop(table.reactions[popped].by, table.reactions[popped].emoji);
  const hand = table.hand;
  if (hand?.street === 'done' && posted !== hand.id) {
    posted = hand.id;
    feed.append(notice(`Hand ${hand.id}: ${resultText()}`));
  }
  for (const id of typed.typing) feed.append(typingMessage(faceOf(id), id));
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
    menu.replaceChildren(el('li', 'pk-menu-head', ''), item([el('span', '', 'Ask to leave the table')], () => sendAway(id)));
    menu.firstChild.append(faceOf(id), el('b', '', label(id)));
  } else if (id) {
    const p = here.find((q) => q.id === id);
    const others = here.filter((q) => q.id !== HUMAN && !q.leaving).length;
    menu.replaceChildren(el('li', 'pk-menu-head', ''), p.leaving
      ? item([el('span', '', 'Stay at the table')], () => perform({ type: 'add', id }))
      : item([el('span', '', p.joining ? 'Don\'t sit down' : table.hand && table.hand.street !== 'done' ? 'Leave after this hand' : 'Leave the table')], () => perform({ type: 'remove', id }), others < 2 ? 'A table needs someone to play against' : ''));
    menu.firstChild.append(...who(id));
  } else {
    const out = PERSONAS.filter((q) => !here.some((h) => h.id === q.id));
    menu.replaceChildren(...out.map((q) => item(who(q.id), () => perform({ type: 'add', id: q.id, seat: slot }))));
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
    const thoughts = table.thoughts[id] ?? [];
    const part = el('details', 'pj-trace-part');
    part.open = true;
    const summary = el('summary');
    const avatar = el('span', 'pj-avatar pj-avatar-agent');
    avatar.append(agentFace(id));
    const held = hand.seats[seat].hole ?? [];
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
  else if (action === 'call') play({ type: table.legal.check ? 'check' : 'call' });
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
  if (emoji) perform({ react: emoji });
});
$('.pk-say').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  if (!input.value.trim()) return;
  perform({ say: input.value });
  input.value = '';
});

// ---- friends: the host's page invites them; a friend's page joins ----

let away = ''; // a friend's page: why the line to the host is down
const sentAway = new Set(); // friends the host asked to leave: their pages may not come back

// Each friend's page gets its seat's view, with the presence it may see
// (game-kit.js); what it sends lands as its player's.
const guests = friends(store, {
  heard: act,
  joined: (id) => (sentAway.has(id) ? 'The host asked you to leave the table.' : ''),
});
const inviting = $('.pk-invite');
async function invite() {
  inviting.hidden = false;
  document.body.classList.add('pk-buying-in');
  inviting.elements.name.value = table.names[HUMAN] ?? load(NAME) ?? '';
  inviting.elements.link.value = await guests.link();
}
function closeInvite() {
  const name = inviting.elements.name.value.trim().slice(0, 20);
  if (name) {
    store.commit(HUMAN, { body: { type: 'name', name } });
    keep(name, NAME);
  }
  inviting.hidden = true;
  document.body.classList.remove('pk-buying-in');
}
function copyLink() {
  inviting.elements.link.select();
  navigator.clipboard?.writeText(inviting.elements.link.value).catch(() => {});
}
// The host asks a friend to leave: their page goes, and may not come back; they leave the table.
function sendAway(id) {
  sentAway.add(id);
  guests.turnAway(id, 'The host asked you to leave the table.');
  store.client(id).commit({ body: { type: 'leave' } });
}
// What a friend's page sends: what its player does, made on `base`. A buy-in
// that does not land goes back to their bankroll.
function act(id, message) {
  const b = message.body ?? {};
  const action = b.action && typeof b.action === 'object' ? { type: String(b.action.type), ...(Number.isInteger(b.action.amount) ? { amount: b.action.amount } : {}) } : null;
  const body = ['sit', 'topup', 'leave'].includes(b.type) ? { type: b.type, seat: b.seat, name: b.name, buyIn: b.buyIn, amount: b.amount }
    : { ...(action ? { action } : {}), ...(typeof b.say === 'string' ? { say: b.say } : {}), ...(typeof b.react === 'string' ? { react: b.react } : {}) };
  const { refused: why } = store.commit(id, { base: String(message.base ?? ''), body });
  if (why && b.type === 'sit') guests.send(id, { type: 'refused', amount: Number(b.buyIn) || 0 });
  else if (why) guests.send(id, { type: 'rejected', why });
}

// A friend's page: the table as the host sends it.
const guest = ROOM && join(ROOM, { id: me }, {
  heard(message) {
    away = '';
    if (message.type === 'refused') {
      wallet.bankroll += message.amount;
      saveWallet();
    }
    if (message.type === 'rejected') $('.pk-turn').textContent = message.why;
    if (message.type !== 'state') return draw();
    shown = message.view;
    table = shown.content;
    present = message.presence;
    if (reclaim && seatedNow(me)) wallet.bankroll -= reclaim;
    reclaim = 0;
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
if (!ROOM) {
  // The members' controllers: each AI player's, the dealer's, the clock's, and this screen's, the host's seat.
  for (const { id } of PERSONAS) control(store.client(id), { program: think(id), wallet: store.wallet });
  control(store.client(DEALER), { program: dealer });
  control(store.client(CLOCK), clock());
  control(store.client(HUMAN), {
    show(view) {
      shown = view;
      table = view.content;
      draw();
    },
  });
  // Friends at a table this page held before it reloaded: the room is new, so they are gone.
  for (const { id } of lineup(table)) if (isPerson(id) && id !== HUMAN) guests.gone(id);
  if (!chipsOfMine()) buyIn(table.greeted ? 'rebuy' : 'sit');
}
draw();
