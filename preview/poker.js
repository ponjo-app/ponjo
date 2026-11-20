// The poker page (site/poker.html): a person and three AI players at one
// No-Limit Hold'em table, chatting while they play. The dealer
// (poker-dealer.js) owns what must be exact; the players decide the rest
// from the rules and what they can see (poker-runtime.js). Here: the
// controller, which on every change looks at the table and starts the runs
// `plan` says are due, never acting on an event itself; a run, one call of
// the visitor's model through INFER (agents/ponjo-core.mjs); and the table
// drawn with the app's classes and faces. The key is the visitor's own,
// kept in this browser and sent only to their model's provider.
// preview/build.js bundles it into dist/preview, as the site serves it.

/* global document, HTMLDialogElement */

import { INFER } from '../agents/ponjo-core.mjs';
import { agentFace, personFace, setBuddies, setOwner } from '../web/faces.js';
import { icon } from '../web/icons.js';
import { legal } from './poker-dealer.js';
import { DECIDE, HUMAN, PERSONAS, STACK, begin, deal, fail, land, newTable, plan, prompt, retry, say } from './poker-runtime.js';

const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const SAVED = 'ponjo-poker';
const POS = ['bottom', 'left', 'top', 'right'];
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const STREET = { flop: 'Flop', turn: 'Turn', river: 'River' };
const A = { 'High card': 'high card', Pair: 'a pair', 'Two pair': 'two pair', 'Three of a kind': 'three of a kind', Straight: 'a straight', Flush: 'a flush', 'Full house': 'a full house', 'Four of a kind': 'four of a kind', 'Straight flush': 'a straight flush' };

setBuddies(PERSONAS.map(({ id }) => ({ id, name: id })));
setOwner(HUMAN);

let table = newTable();
const running = new Set();
let settings = load();

// ---- the visitor's model ----

function load() {
  try {
    return JSON.parse(localStorage.getItem(SAVED)) ?? null;
  } catch {
    return null;
  }
}
function store(value) {
  try {
    if (value) localStorage.setItem(SAVED, JSON.stringify(value));
    else localStorage.removeItem(SAVED);
  } catch {}
}
const infer = () => (settings.provider === 'openai'
  ? INFER.openai({ endpoint: settings.endpoint, model: settings.model, key: settings.key })
  : INFER.anthropic({ model: settings.model, key: settings.key, effort: 'low' }));

// ---- the controller ----

// Every change: draw it, then look again. A look starts what `plan` says is due; that is all it does.
function changed() {
  draw();
  if (settings) for (const due of plan(table, running)) run(due.id, due);
}

// One run of a player: what it is due for counts as seen, one model call, and its proposal to the writer.
async function run(id, due) {
  const basis = begin(table, id, due);
  running.add(id);
  draw();
  const { rules, situation } = prompt(table, id, due);
  const sent = table;
  try {
    const { calls, text } = await infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [DECIDE]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === 'decide')?.args ?? '{}');
    } catch {}
    running.delete(id);
    if (sent !== table) return changed(); // a new game began meanwhile
    land(table, id, basis, { thinking: args.thinking ?? text, action: args.action ?? null, say: args.say });
  } catch (error) {
    running.delete(id);
    if (sent === table) fail(table, id, basis, String(error.message).split('\n')[0]);
  }
  changed();
}

function nextHand() {
  if (!deal(table)) {
    const fresh = newTable();
    Object.assign(table, { players: fresh.players, hand: null, button: -1 });
    deal(table);
  }
  changed();
}

// ---- the table ----

const seats = [];
function seatNode(id, i) {
  const node = el('div', 'pk-seat');
  node.dataset.pos = POS[i];
  const face = el('span', 'pj-agent-face');
  face.dataset.presence = 'idle';
  const avatar = el('span', `pj-avatar${id === HUMAN ? '' : ' pj-avatar-agent'}`);
  avatar.append(id === HUMAN ? personFace('You', HUMAN) : agentFace(id));
  face.append(avatar);
  const text = el('div', 'pk-seat-text');
  const name = el('span', 'pk-name', id === HUMAN ? 'You' : id);
  const button = el('span', 'pk-dealer-button', 'D');
  button.title = 'Dealer button';
  name.append(button);
  text.append(name, el('span', 'pk-stack'), el('span', 'pk-status'));
  node.append(face, text, el('div', 'pk-hole'), el('span', 'pk-bet'));
  return node;
}
$('.pk-seats').append(...table.players.map(({ id }, i) => (seats[i] = seatNode(id, i))));

function card(c) {
  const node = el('span', 'pk-card', c ? (c[0] === 'T' ? '10' : c[0]) : '');
  if (!c) node.classList.add('pk-card-back');
  else {
    node.append(el('span', 'pk-suit', SUIT[c[1]]));
    node.setAttribute('aria-label', c);
  }
  return node;
}

const lastAction = (hand, seat) => hand.actions.findLast((a) => a.seat === seat && a.street === hand.street && !a.type.endsWith('blind'));
const verb = (a) => ({ fold: 'Folded', check: 'Checked', call: `Called ${a.amount}`, bet: `Bet ${a.amount}`, raise: `Raised to ${a.amount}` })[a.type] ?? '';

function draw() {
  const hand = table.hand;
  for (const [i, node] of seats.entries()) {
    const { id } = table.players[i];
    const s = hand?.seats[i];
    const stack = s ? s.stack : table.players[i].stack;
    const out = !s?.inHand && hand;
    const thinking = running.has(id);
    $('.pj-agent-face', node).dataset.presence = thinking || (id === HUMAN && hand?.toAct === 0) ? 'working' : out || s?.folded ? 'away' : 'idle';
    $('.pk-stack', node).textContent = out ? 'Out' : `${stack}`;
    const a = hand && lastAction(hand, i);
    const failed = table.notes[id]?.failed;
    $('.pk-status', node).textContent = failed ? 'Could not reach the model' : thinking ? 'Thinking…'
      : hand?.toAct === i ? (id === HUMAN ? 'Your turn' : 'To act') : s?.allIn ? 'All in' : s?.folded ? 'Folded' : a ? verb(a) : '';
    $('.pk-status', node).toggleAttribute('data-failed', Boolean(failed));
    $('.pk-dealer-button', node).hidden = hand?.button !== i;
    const shown = hand?.result?.showdown && hand.result.hands[i];
    $('.pk-hole', node).replaceChildren(...(s?.inHand && !s.folded ? s.hole.map((c) => card(id === HUMAN || shown ? c : null)) : []));
    $('.pk-bet', node).textContent = s?.bet ? `${s.bet}` : '';
  }
  $('.pk-board').replaceChildren(...(hand?.board ?? []).map(card));
  const pot = hand ? hand.seats.reduce((sum, s) => sum + s.total, 0) : 0;
  $('.pk-pot').textContent = hand ? `Pot ${pot}` : '';
  $('.pk-news').textContent = news();
  const over = !hand || hand.street === 'done';
  $('.pk-between').hidden = !over || !settings;
  const ended = hand && (hand.seats[0].stack === 0 || hand.seats.filter((s) => s.stack > 0).length < 2);
  $('[data-action="next"]').textContent = !hand ? 'Deal' : ended ? 'New game' : 'Next hand';
  $('[data-action="thinking"]').hidden = !hand || hand.street !== 'done';
  drawControls();
  drawFeed();
}

function news() {
  const hand = table.hand;
  if (!hand) return 'Play chips only. Everyone starts with 1,000.';
  if (hand.street !== 'done') return '';
  const result = hand.result;
  const lines = result.pots.map((p, k) => {
    const names = p.winners.map((i) => (i === 0 ? 'You' : hand.seats[i].id));
    const hands = result.showdown ? ` with ${A[result.hands[p.winners[0]].name]}` : '';
    return `${k ? 'Side pot' : names.length > 1 ? 'Split pot' : ''}${k || names.length > 1 ? ': ' : ''}${names.join(' and ')} ${names.length > 1 || names[0] === 'You' ? 'win' : 'wins'} ${p.amount}${hands}`;
  });
  if (hand.seats[0].stack === 0) lines.push('You are out of chips.');
  else if (hand.seats.filter((s) => s.stack > 0).length === 1) lines.push('You took every chip at the table.');
  return lines.join('. ') + '.';
}

function drawControls() {
  const hand = table.hand;
  const mine = hand && hand.street !== 'done' && hand.toAct === 0;
  $('.pk-controls').hidden = !mine;
  if (!mine) return;
  const l = legal(hand, 0);
  const call = $('[data-action="call"]');
  call.textContent = l.check ? 'Check' : `Call ${l.call}${l.call < l.toCall || l.call === hand.seats[0].stack ? ' (all in)' : ''}`;
  $('.pk-raise').hidden = !l.raise;
  if (l.raise) {
    const amount = $('.pk-amount');
    Object.assign(amount, { min: l.raise.min, max: l.raise.max, step: 1 });
    if (amount.dataset.for !== `${hand.id}:${hand.n}`) {
      amount.value = l.raise.min;
      amount.dataset.for = `${hand.id}:${hand.n}`;
    }
    $('[data-action="raise"]').textContent = l.raise.min === l.raise.max ? 'All in' : hand.currentBet ? 'Raise to' : 'Bet';
    amount.hidden = l.raise.min === l.raise.max;
  }
}

function play(action) {
  const hand = table.hand;
  land(table, HUMAN, { hand: hand.id, n: hand.n, turn: true }, { action });
  changed();
}

// ---- the chat, with the dealer's lines ----

let drawn = 0; // log entries drawn
let board = 0; // board cards announced
function drawFeed() {
  const feed = $('.pk-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  for (; drawn < table.log.length; drawn++) {
    const change = table.log[drawn];
    if (change.type === 'deal') {
      board = 0;
      const hand = table.hand;
      feed.append(dealer(`Hand ${change.hand}. ${hand.button === 0 ? 'You have' : `${hand.seats[hand.button].id} has`} the button.`));
    } else if (change.type === 'action') {
      const a = change.action;
      const who = change.by === HUMAN ? 'You' : change.by;
      const what = { fold: 'fold', check: 'check', call: `call ${a.amount}`, bet: `bet ${a.amount}`, raise: `raise to ${a.amount}` }[a.type];
      feed.append(dealer(`${who} ${change.by === HUMAN ? what : what.replace(/^\w+/, (w) => `${w}s`)}${a.allIn ? ', all in' : ''}${change.forced ? ' (by the dealer, after three moves that were not legal)' : ''}.`));
    } else if (change.type === 'chat') {
      feed.append(message(table.chat[change.line - 1]));
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
    const hand = table.hand;
    if (hand && change.type === 'action' && change.hand === hand.id && drawn === table.log.findLastIndex((c) => c.type === 'action')) {
      if (hand.board.length > board) {
        const street = hand.street === 'done' ? (hand.board.length === 5 ? 'River' : hand.board.length === 4 ? 'Turn' : 'Flop') : STREET[hand.street];
        feed.append(dealer(`${board === 0 || hand.board.length - board > 1 ? 'Board' : street}: ${hand.board.slice(board === 0 || hand.board.length - board > 1 ? 0 : board).map(cardText).join(' ')}.`));
        board = hand.board.length;
      }
      if (hand.street === 'done') {
        for (const [i, h] of Object.entries(hand.result.hands)) feed.append(dealer(`${Number(i) === 0 ? 'You show' : `${hand.seats[i].id} shows`} ${hand.seats[i].hole.map(cardText).join(' ')}: ${A[h.name]}.`));
        feed.append(dealer(news()));
      }
    }
  }
  if (stick) feed.scrollTop = feed.scrollHeight;
}
const cardText = (c) => `${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}`;

function dealer(text) {
  return el('li', 'pk-dealer', text);
}
function message(line) {
  const item = el('li', 'pk-message');
  const head = el('div', 'pj-msg-head');
  const avatar = el('span', `pj-avatar${line.by === HUMAN ? '' : ' pj-avatar-agent'}`);
  avatar.append(line.by === HUMAN ? personFace('You', HUMAN) : agentFace(line.by));
  const who = el('span', 'pj-who');
  who.append(el('span', 'pj-name', line.by === HUMAN ? 'You' : line.by));
  head.append(avatar, who);
  item.append(head, el('div', 'pj-body', line.text));
  return item;
}

// ---- their thinking, after a hand ----

function showThinking() {
  const hand = table.hand;
  const dialog = $('.pk-thinking');
  $('h2', dialog).textContent = `Their thinking, hand ${hand.id}`;
  const body = $('.pk-thinking-body', dialog);
  body.replaceChildren(...PERSONAS.map(({ id }) => {
    const seat = table.players.findIndex((p) => p.id === id);
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
  settings = next;
  store(settings);
  for (const { id } of PERSONAS) if (table.notes[id].failed) retry(table, id);
  setup.hidden = true;
  document.body.classList.remove('pk-setting-up');
  if (!table.hand) nextHand();
  else changed();
});
const forget = el('button', 'pj-link-button pk-forget', 'Forget my key');
forget.type = 'button';
forget.addEventListener('click', () => {
  settings = null;
  store(null);
  openSetup();
});

// ---- wiring ----

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'next') nextHand();
  else if (action === 'thinking') showThinking();
  else if (action === 'close') $('.pk-thinking').close();
  else if (action === 'key') openSetup();
  else if (action === 'fold') play({ type: 'fold' });
  else if (action === 'call') play({ type: legal(table.hand, 0).check ? 'check' : 'call' });
  else if (action === 'raise') {
    const l = legal(table.hand, 0);
    const typed = Math.round(Number($('.pk-amount').value) || l.raise.min);
    play({ type: table.hand.currentBet ? 'raise' : 'bet', amount: Math.min(l.raise.max, Math.max(l.raise.min, typed)) });
  }
});
$('.pk-thinking').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close(); // a click on the backdrop
});
$('.pk-say').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  if (!say(table, HUMAN, input.value)) return;
  input.value = '';
  changed();
});

$('.pk-news').textContent = `Play chips only. Everyone starts with ${STACK.toLocaleString('en')}.`;
setup.querySelector('.pk-error').after(forget);
if (settings) nextHand();
else openSetup();
draw();
