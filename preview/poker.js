// The poker page (site/poker.html): a person and three AI players at one
// No-Limit Hold'em table, chatting while they play. The dealer
// (poker-dealer.js) owns what must be exact; the players decide the rest
// from the rules and what they can see (poker-runtime.js). Here: the
// controller, which on every change looks at the table and starts the runs
// `plan` says are due, never acting on an event itself; a run, one call of
// the visitor's model through INFER (agents/ponjo-core.mjs); and the table
// drawn with the app's classes and faces. The players run on Claude Haiku
// through infer.ponjo.app (relay/worker.js), which holds Ponjo's key; or,
// with a visitor's own key, kept in this browser and sent only to their
// model's provider, on the model they pick.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, matchMedia, innerWidth, innerHeight, HTMLDialogElement */

import { INFER } from '../agents/ponjo-core.mjs';
import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { handName, legal } from './poker-dealer.js';
import { DECIDE, HUMAN, PERSONAS, STACK, addPlayer, begin, freeSeats, intros, introduce, lineup, react, removePlayer, deal, fail, land, leave, myChips, newTable, plan, prompt, retry, say, topUp } from './poker-runtime.js';

const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const SAVED = 'ponjo-poker';
const WALLET = 'ponjo-poker-bankroll';
const BANKROLL = 1000; // play dollars a new player starts with, and starts again with
const [MIN_BUY, MAX_BUY] = [200, 1000];
const AUTO_DEAL = 4; // seconds from a hand's result to the next hand
const money = (n) => `$${n.toLocaleString('en')}`;
const HOSTED = 'https://infer.ponjo.app/infer/anthropic'; // Ponjo's key and model, for ponjo.app's pages only
const SLOTS = ['bottom', 'left', 'top-left', 'top', 'top-right', 'right']; // the six seats round the table, the person's first
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

const table = newTable(0); // the person sits down with a buy-in
const running = new Set();
let settings = load(SAVED); // the visitor's own provider, key and model, or null for Ponjo's

// ---- what the visitor keeps in this browser: their model, their bankroll ----

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

// The bankroll, with what was on the table when they last left the page: it comes back to them.
const wallet = (({ bankroll = BANKROLL, onTable = 0, restarts = 0 } = {}) => ({ bankroll: bankroll + onTable, restarts }))(load(WALLET) ?? undefined);
const session = { bought: 0, hands: 0, biggest: 0, cashed: 0 };
const saveWallet = () => store({ ...wallet, onTable: myChips(table) }, WALLET);
const infer = () => (!settings ? INFER.anthropic({ model: 'claude-haiku-5-5', key: 'ponjo' }, HOSTED) // the Worker sets the key, model and effort
  : settings.provider === 'openai' ? INFER.openai({ endpoint: settings.endpoint, model: settings.model, key: settings.key })
    : INFER.anthropic({ model: settings.model, key: settings.key, effort: 'low' }));

// ---- the controller ----

// Every change: draw it, then look again. A look starts what `plan` says is due; that is all it does.
function changed() {
  draw();
  for (const due of plan(table, running)) run(due.id, due);
}

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
const typing = new Set(); // players typing a line, shown in the chat

async function run(id, due) {
  const basis = begin(table, id, due);
  const started = performance.now();
  running.add(id);
  draw();
  const { rules, situation } = prompt(table, id, due);
  try {
    const { calls, text } = await infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === 'decide')?.args ?? '{}');
    } catch {}
    await wait(thinkTime(id, due) - (performance.now() - started));
    land(table, id, basis, { thinking: args.thinking ?? text, action: args.action ?? null, react: args.react });
    if (typeof args.say === 'string' && args.say.trim()) {
      typing.add(id);
      changed();
      await wait(typeTime(args.say));
      typing.delete(id);
      land(table, id, basis, { say: args.say });
    }
  } catch (error) {
    typing.delete(id);
    fail(table, id, basis, String(error.message).split('\n')[0]);
  }
  running.delete(id);
  changed();
}

function nextHand() {
  stopCountdown();
  if (!deal(table)) return buyIn('rebuy');
  session.hands++;
  changed();
}

// ---- the session: buying in, topping up, leaving ----

let paused = false;
let countdown = null;
function stopCountdown() {
  clearInterval(countdown?.timer);
  countdown = null;
}
// After a hand, the next is dealt by itself unless the person paused, or opened something.
function startCountdown() {
  if (countdown || paused || !myChips(table) || !$('.pk-buyin').hidden) return;
  countdown = { left: AUTO_DEAL, timer: setInterval(() => {
    countdown.left--;
    if (countdown.left <= 0) nextHand();
    else drawResult();
  }, 1000) };
}
function pause() {
  paused = true;
  stopCountdown();
  drawResult();
}

const buyin = $('.pk-buyin');
// The card for buying chips (`sit`, `rebuy`, `topup`) or saying how a session went (`left`).
function buyIn(kind) {
  pause();
  const room = kind === 'topup' ? Math.min(wallet.bankroll, MAX_BUY - myChips(table)) : Math.min(wallet.bankroll, MAX_BUY);
  const broke = kind !== 'topup' && wallet.bankroll < MIN_BUY;
  const net = myChips(table) + session.cashed - session.bought;
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
  $('[data-action="buyin-cancel"]', buyin).hidden = kind !== 'topup';
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
  if (kind === 'left') return buyIn('sit');
  const amount = Number(buyin.elements.amount.value);
  wallet.bankroll -= amount;
  if (kind !== 'topup') Object.assign(session, { bought: 0, hands: 0, biggest: 0, cashed: 0 });
  session.bought += amount;
  topUp(table, amount);
  saveWallet();
  closeBuyIn();
  paused = false;
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
  stopCountdown();
  session.cashed = leave(table);
  wallet.bankroll += session.cashed;
  saveWallet();
  buyIn('left');
  changed();
}

// ---- the table ----

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const seats = new Map(); // a player's id → its seat
const bets = new Map(); // a player's id → its bet on the felt
function seatNode(id) {
  const node = el('div', 'pk-seat');
  node.dataset.id = id;
  const face = el('span', 'pj-agent-face');
  face.dataset.presence = 'idle';
  const avatar = el('span', `pj-avatar${id === HUMAN ? '' : ' pj-avatar-agent'}`);
  avatar.append(id === HUMAN ? personFace('You', HUMAN) : agentFace(id));
  face.append(avatar, el('div', 'pk-hole'));
  const plate = el('div', 'pk-plate');
  const name = el('span', 'pk-name', id === HUMAN ? 'You' : id);
  name.append(el('span', 'pk-position'));
  plate.append(name, el('span', 'pk-stack'), el('span', 'pk-tag'));
  node.append(face, plate);
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
      $('.pk-seats').append(seats.get(id));
      $('.pk-table').append(bets.get(id));
    }
    seats.get(id).dataset.pos = bets.get(id).dataset.pos = SLOTS[table.slots[id]];
  }
  const free = freeSeats(table);
  for (const [k, node] of empties.entries()) node.hidden = !free.includes(k);
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

// A little stack of chips for an amount, coloured by value.
function chips(amount, colour) {
  const stack = el('span', 'pk-stack-chips');
  const c = colour ?? (amount < 50 ? 'white' : amount < 200 ? 'red' : amount < 1000 ? 'blue' : 'black');
  for (let k = 0; k < Math.min(5, Math.max(1, Math.ceil(Math.log2(amount / 10 + 1)))); k++) {
    const chip = el('span', 'pk-chip');
    chip.dataset.c = c;
    stack.append(chip);
  }
  return stack;
}
// Chips sliding from one place to another: a street's bets into the pot, the pot to its winners.
function fly(from, to, amount, delay = 0) {
  if (still || !amount) return;
  const [a, b] = [from.getBoundingClientRect(), to.getBoundingClientRect()];
  const flying = el('span', 'pk-flying');
  flying.append(chips(amount));
  flying.style.left = `${a.left + a.width / 2 - 9}px`;
  flying.style.top = `${a.top + a.height / 2 - 6}px`;
  document.body.append(flying);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  flying.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 }], { duration: 450, delay, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'backwards' }).finished.then(() => flying.remove());
}

const TAG = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise to' };
// What a seat shows over its face: what it is doing or just did.
function tag(hand, i, { id, joining, leaving }) {
  if (joining) return ['Sits in next hand', 'wait'];
  if (leaving && (!hand || hand.street === 'done')) return ['Leaving', 'fold'];
  if (table.notes[id]?.failed) return ['Can\'t reach the model', 'failed'];
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
    $('.pj-agent-face', node).dataset.presence = running.has(id) || (i === 0 && hand?.street !== 'done' && hand?.toAct === 0) ? 'working' : out || s?.folded ? 'away' : 'idle';
    const stack = id === HUMAN ? myChips(table) : s ? s.stack : i >= 0 ? table.players[i].stack : STACK;
    const stackNode = $('.pk-stack', node);
    stackNode.textContent = out ? 'Out' : money(stack);
    if (before.stack !== null && stack !== before.stack) delta(stackNode, stack - before.stack);
    before.stack = stack;
    const acts = s ? hand.actions.filter((a) => a.seat === i && TAG[a.type]).length : 0;
    if (sameHand && acts > before.acts) replay($('.pk-plate', node), 'pk-pulse');
    before.acts = acts;
    if (sameHand && s?.folded && !before.folded) muck(id === HUMAN ? $('.pk-hole-mine') : $('.pk-hole', node));
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
    if (id !== HUMAN) setCards($('.pk-hole', node), s?.inHand && !s.folded ? (shown ? s.hole : [null, null]) : []);
    const bet = s?.bet ?? 0;
    const was_ = shownBets.get(id) ?? 0;
    if (sameHand && bet > was_) {
      fly($('.pj-agent-face', node), bets.get(id), bet - was_);
      replay(bets.get(id), 'pk-bump');
    }
    if (bet !== was_) bets.get(id).replaceChildren(...(bet ? [chips(bet), money(bet)] : []));
    shownBets.set(id, bet);
  }
  const puck = $('.pk-puck');
  puck.hidden = !hand;
  if (hand) puck.dataset.pos = SLOTS[table.slots[hand.seats[hand.button].id] ?? 0];
  setCards($('.pk-board'), hand?.board ?? []);
  const pot = hand ? hand.seats.reduce((sum, s) => sum + s.total, 0) : 0;
  potNode.hidden = !pot || hand.street === 'done';
  if (pot) $('.pk-pot-amount', potNode).textContent = `Pot ${money(pot)}`;
  if (pot && potNode.dataset.amount !== `${pot}`) {
    $('.pk-stack-chips', potNode).replaceWith(chips(pot, 'gold'));
    if (sameHand) replay(potNode, 'pk-bump');
  }
  potNode.dataset.amount = pot;
  drawResult();
  const best = new Set(hand?.result?.showdown ? hand.result.hands[hand.result.pots[0].winners[0]].cards : []);
  for (const node of document.querySelectorAll('.pk-board .pk-card, .pk-seat .pk-card, .pk-hole-mine .pk-card')) node.toggleAttribute('data-best', best.has(node.dataset.key));
  if (hand?.street === 'done' && celebrated !== hand.id) {
    celebrated = hand.id;
    if (hand.result.won[0] > session.biggest) session.biggest = hand.result.won[0];
    saveWallet();
    if (myChips(table)) startCountdown();
    else setTimeout(() => buyIn('rebuy'), 1500);
    for (const [i, won] of hand.result.won.entries()) {
      if (!won) continue;
      const node = seats.get(hand.seats[i].id);
      fly(potNode.hidden ? $('.pk-board') : potNode, $('.pj-agent-face', node), won, 450);
      node.toggleAttribute('data-won', true);
      setTimeout(() => node.removeAttribute('data-won'), 1600);
    }
  }
  drawMe();
  drawFeed();
}

// Between hands: the result, the next hand coming or paused, and what the session stands at.
function drawResult() {
  const hand = table.hand;
  const over = !hand || hand.street === 'done';
  $('.pk-result').hidden = !over || !hand;
  $('.pk-result-text').textContent = resultText();
  $('.pk-countdown').textContent = countdown ? `Next hand in ${countdown.left}…` : '';
  $('[data-action="next"]').hidden = Boolean(countdown) || !myChips(table);
  $('[data-action="pause"]').hidden = !countdown;
  $('[data-action="thinking"]').hidden = !hand || hand.street !== 'done';
  const net = myChips(table) + session.cashed - session.bought;
  $('.pk-bank').innerHTML = '';
  for (const [label, value] of [['Bankroll', money(wallet.bankroll)], ['On the table', money(myChips(table))], ['This session', `${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`]]) {
    const item = el('span', '', `${label} `);
    item.append(el('b', '', value));
    $('.pk-bank').append(item);
  }
  $('[data-action="topup"]').disabled = !myChips(table) || Math.min(wallet.bankroll, MAX_BUY - myChips(table)) < 20;
  $('[data-action="leave"]').disabled = !over || !myChips(table);
}

// The hand's result, as the table says it: who won what, with which hand.
function resultText() {
  const hand = table.hand;
  if (!hand) return 'Play money only.';
  if (hand.street !== 'done') return '';
  const { result } = hand;
  const lines = result.pots.map((p, k) => {
    const names = p.winners.map((i) => (i === 0 ? 'You' : hand.seats[i].id));
    const with_ = result.showdown ? ` · ${handName(hand.seats[p.winners[0]].hole, hand.board)}` : '';
    return `${k ? 'Side pot: ' : ''}${names.join(' and ')} ${names.length > 1 || names[0] === 'You' ? 'win' : 'wins'} ${money(p.amount)}${with_}`;
  });
  if (!myChips(table)) lines.push('You are out of chips.');
  return lines.join('. ');
}

// ---- you: your cards, what you hold, and what you may do ----

function drawMe() {
  const hand = table.hand;
  const s = hand?.seats[0];
  setCards($('.pk-hole-mine'), s?.inHand ? s.hole : []);
  $('.pk-hole-mine').style.opacity = s?.folded ? 0.5 : '';
  $('.pk-strength').textContent = !s?.inHand ? '' : s.folded ? 'Folded' : handName(s.hole, hand.board);
  const mine = hand && hand.street !== 'done' && hand.toAct === 0;
  $('.pk-controls').hidden = !mine;
  if (!mine) return;
  const l = legal(hand, 0);
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
  const l = legal(hand, 0);
  const to = Number($('.pk-slider').value);
  $('[data-action="raise"]').textContent = to >= l.raise.max ? `All in ${money(l.raise.max)}` : `${hand.currentBet ? 'Raise to' : 'Bet'} ${money(to)}`;
}
// A raise of a size a player names: the least, half the pot, the pot, all in.
function size(name) {
  const hand = table.hand;
  const l = legal(hand, 0);
  const pot = hand.seats.reduce((sum, s) => sum + s.total, 0) + l.toCall;
  const to = { min: l.raise.min, half: hand.currentBet + Math.round(pot / 2), pot: hand.currentBet + pot, max: l.raise.max }[name];
  $('.pk-slider').value = Math.min(l.raise.max, Math.max(l.raise.min, to));
  drawRaise();
}

function play(action) {
  const hand = table.hand;
  land(table, HUMAN, { hand: hand.id, n: hand.n, turn: true }, { action });
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
      feed.append(message(line, feed.lastElementChild?.dataset.by === line.by));
    } else if (change.type === 'react') {
      pop(change.by, change.emoji);
    } else if (change.type === 'rebuy') {
      feed.append(dealer(`${change.by} buys back in for ${money(change.amount)}.`));
    } else if (change.type === 'failed') {
      const line = dealer(`${change.by} could not reach the model: ${change.why}`);
      line.dataset.failed = '';
      const again = el('button', 'pj-link-button', 'Retry');
      again.type = 'button';
      again.addEventListener('click', () => {
        again.remove();
        retry(table, change.by);
        changed();
      });
      line.append(' ', again);
      feed.append(line);
    }
  }
  const hand = table.hand;
  if (hand?.street === 'done' && posted !== hand.id) {
    posted = hand.id;
    feed.append(dealer(`Hand ${hand.id}: ${resultText()}`));
  }
  for (const id of typing) {
    const row = message({ by: id, text: '' }, false);
    row.classList.add('pk-typing');
    row.dataset.by = '';
    $('.pk-msg-text', row).append(el('i'), el('i'), el('i'));
    $('.pk-msg-text', row).setAttribute('aria-label', `${id} is typing`);
    feed.append(row);
  }
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

function dealer(text) {
  return el('li', 'pk-dealer', text);
}
// A message: yours on the right; others' on the left with their face and,
// first in a run of theirs, their name.
function message(line, more) {
  const item = el('li', 'pk-msg');
  item.dataset.by = line.by;
  if (more) item.dataset.more = '';
  const col = el('div', 'pk-msg-col');
  if (line.by === HUMAN) item.dataset.mine = '';
  else {
    const avatar = el('span', 'pj-avatar pj-avatar-agent');
    avatar.append(agentFace(line.by));
    item.append(avatar);
    if (!more) col.append(el('span', 'pk-msg-name', line.by));
  }
  col.append(el('div', 'pk-msg-text', line.text));
  item.append(col);
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
  if (id) {
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
  if (empty) return openMenu(empty, { slot: Number(empty.dataset.slot) });
  if (seat && seat.dataset.id !== HUMAN && event.target.closest('.pj-agent-face, .pk-plate')) openMenu(seat, { id: seat.dataset.id });
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
  body.replaceChildren(...hand.seats.filter((s) => s.id !== HUMAN).map(({ id }) => {
    const seat = hand.seats.findIndex((s) => s.id === id);
    const thoughts = table.notes[id].thoughts.filter((t) => t.hand === hand.id);
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

// ---- setup: the visitor's provider, key and model ----

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
  for (const { id } of PERSONAS) if (table.notes[id].failed) retry(table, id);
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
  if (action === 'next') {
    paused = false;
    nextHand();
  } else if (action === 'pause') pause();
  else if (action === 'topup') buyIn('topup');
  else if (action === 'leave') leaveTable();
  else if (action === 'buyin-cancel') {
    closeBuyIn();
    drawResult();
  }
  else if (action === 'thinking') {
    pause();
    showThinking();
  }
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') {
    pause();
    openSetup();
  }
  else if (action === 'cancel') {
    setup.hidden = true;
    document.body.classList.remove('pk-setting-up');
  }
  else if (action === 'fold') play({ type: 'fold' });
  else if (action === 'call') play({ type: legal(table.hand, 0).check ? 'check' : 'call' });
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
  if (emoji && react(table, HUMAN, emoji)) changed();
});
$('.pk-say').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  if (!say(table, HUMAN, input.value)) return;
  input.value = '';
  changed();
});

$('.pk-slider').addEventListener('input', drawRaise);
setup.querySelector('.pk-error').after(forget);
drawModel();
draw();
buyIn('sit');
