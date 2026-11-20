// The dealer: a separate program that owns the table by writing the doc file
// directly (an outside change to Ponjo). It deals open cards, polls the file
// for the action of the seat on turn, applies it, and moves the action on.
// Usage: node dealer.mjs <doc> <out dir> <hands> [--heartbeat ms] [--stall ms]
// Logs each write and each action seen to <out>/dealer.jsonl.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [docPath, out, handsArg, ...rest] = process.argv.slice(2);
const opt = (name, d) => { const i = rest.indexOf(`--${name}`); return i < 0 ? d : Number(rest[i + 1]); };
const HANDS = Number(handsArg);
const HEARTBEAT = opt('heartbeat', 0); // write a Clock line this often (ms), 0: never
const STALL = opt('stall', 120_000);
const PLAYERS = ['Alice', 'Bob', 'Cara'];
const SB = 5;
const BB = 10;
const MAX_RAISES = 1;
const log = (e) => appendFileSync(join(out, 'dealer.jsonl'), `${JSON.stringify({ t: Date.now(), ...e })}\n`);

// ---- cards ----
let seed = 12345;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const RANKS = '23456789TJQKA';
const deck = () => { const d = [...RANKS].flatMap((r) => [...'shdc'].map((s) => r + s)); for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; };
// Score of the best 5 of 7 cards: a comparable array.
function score5(cards) {
  const rs = cards.map((c) => RANKS.indexOf(c[0])).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(rs)];
  let straight = uniq.length === 5 && rs[0] - rs[4] === 4 ? rs[0] : null;
  if (uniq.length === 5 && rs.join() === '12,3,2,1,0') straight = 3;
  const counts = Object.entries(rs.reduce((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {})).map(([r, n]) => [n, Number(r)]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const kick = counts.map(([, r]) => r);
  if (straight !== null && flush) return [8, straight];
  if (counts[0][0] === 4) return [7, ...kick];
  if (counts[0][0] === 3 && counts[1][0] === 2) return [6, ...kick];
  if (flush) return [5, ...rs];
  if (straight !== null) return [4, straight];
  if (counts[0][0] === 3) return [3, ...kick];
  if (counts[0][0] === 2 && counts[1][0] === 2) return [2, ...kick];
  if (counts[0][0] === 2) return [1, ...kick];
  return [0, ...rs];
}
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); return 0; };
function best(cards) {
  let top = null;
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) { const s = score5(cards.filter((_, i) => i !== a && i !== b)); if (!top || cmp(s, top) > 0) top = s; }
  return top;
}
const NAMES = ['high card', 'pair', 'two pair', 'trips', 'straight', 'flush', 'full house', 'quads', 'straight flush'];

// ---- the table ----
const stacks = Object.fromEntries(PLAYERS.map((p) => [p, 1000]));
let T; // this hand
let lastResult = '-';
let clock = 0;
const order = (from) => PLAYERS.map((_, i) => PLAYERS[(from + i) % PLAYERS.length]);

function render() {
  const seats = PLAYERS.map((p) => `Seat ${p}: cards=${T.hole[p].join(' ')} stack=${stacks[p]} bet=${T.bet[p]} status=${T.folded.has(p) ? 'folded' : 'in'} act=`);
  return `# Open-card Hold'em

## Table

Hand: ${T.n}
Street: ${T.street}
Board: ${T.board.length ? T.board.join(' ') : '-'}
Pot: ${T.pot}
Current bet: ${T.current}
Raises this street: ${T.raises}
Action on: ${T.on ?? '-'}
Clock: ${clock}

${seats.join('\n')}

Last result: ${lastResult}

## Rules

- Open cards: every seat's cards are public. Blinds ${SB}/${BB}; a raise is ${BB} more than the current bet, at most ${MAX_RAISES} a street.
- On your turn (Action on: you), write one of check, call, fold, raise after act= on your own seat line, and nothing else. The dealer applies it and moves the action on.
- Do not edit anything else in the Table section.
`;
}

let written = '';
function write(kind, extra = {}) {
  written = render();
  writeFileSync(docPath, written);
  log({ type: 'write', kind, hand: T.n, street: T.street, on: T.on, ...extra });
}

function newHand(n) {
  const d = deck();
  const button = (n - 1) % PLAYERS.length;
  T = { n, button, deck: d, hole: Object.fromEntries(PLAYERS.map((p) => [p, [d.pop(), d.pop()]])), board: [], street: 'preflop', bet: Object.fromEntries(PLAYERS.map((p) => [p, 0])), folded: new Set(), pot: 0, current: BB, raises: 0, on: null, need: [] };
  const sb = PLAYERS[(button + 1) % 3];
  const bb = PLAYERS[(button + 2) % 3];
  for (const [p, amt] of [[sb, SB], [bb, BB]]) { stacks[p] -= amt; T.bet[p] = amt; T.pot += amt; }
  T.need = order(button + 3).filter((p) => !T.folded.has(p)); // preflop: button first (3-handed)
  T.on = T.need[0];
}
const active = () => PLAYERS.filter((p) => !T.folded.has(p));
function nextOn(actor) {
  const i = PLAYERS.indexOf(actor);
  return order(i + 1).find((p) => T.need.includes(p)) ?? null;
}

// Apply `act` of the seat on turn; returns 'next' | 'street' | 'end'.
function apply(p, act) {
  const toCall = T.current - T.bet[p];
  let anomaly = null;
  if (act === 'raise' && T.raises >= MAX_RAISES) { act = 'call'; anomaly = 'raise over the cap, taken as a call'; }
  if (act === 'check' && toCall > 0) { act = 'call'; anomaly = 'check facing a bet, taken as a call'; }
  if (act === 'fold') { T.folded.add(p); T.need = T.need.filter((x) => x !== p); }
  else if (act === 'call' || act === 'check') { stacks[p] -= toCall; T.bet[p] += toCall; T.pot += toCall; T.need = T.need.filter((x) => x !== p); }
  else if (act === 'raise') { T.current += BB; T.raises++; const put = T.current - T.bet[p]; stacks[p] -= put; T.bet[p] += put; T.pot += put; T.need = active().filter((x) => x !== p); }
  else { anomaly = `unknown action ${act}, taken as a fold`; T.folded.add(p); T.need = T.need.filter((x) => x !== p); }
  if (active().length === 1) return { step: 'end', act, anomaly };
  if (T.need.length) { T.on = nextOn(p); return { step: 'next', act, anomaly }; }
  return { step: T.street === 'river' ? 'end' : 'street', act, anomaly };
}
function nextStreet() {
  T.street = { preflop: 'flop', flop: 'turn', turn: 'river' }[T.street];
  T.deck.pop(); // burn
  T.board.push(...(T.street === 'flop' ? [T.deck.pop(), T.deck.pop(), T.deck.pop()] : [T.deck.pop()]));
  for (const p of PLAYERS) T.bet[p] = 0;
  T.current = 0;
  T.raises = 0;
  T.need = order(T.button + 1).filter((p) => !T.folded.has(p));
  T.on = T.need[0];
}
function endHand() {
  const live = active();
  let winners = live;
  let how = 'the others folded';
  if (live.length > 1) {
    const scored = live.map((p) => [p, best([...T.hole[p], ...T.board])]);
    const top = scored.reduce((a, b) => (cmp(b[1], a[1]) > 0 ? b : a))[1];
    winners = scored.filter(([, s]) => cmp(s, top) === 0).map(([p]) => p);
    how = NAMES[top[0]];
  }
  const share = Math.floor(T.pot / winners.length);
  for (const w of winners) stacks[w] += share;
  lastResult = `hand ${T.n}: ${winners.join(' & ')} won ${T.pot} (${how})`;
  log({ type: 'result', hand: T.n, winners, pot: T.pot, how });
}

// ---- the loop ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seatOf = (text, p) => text.match(new RegExp(`^Seat ${p}: .*$`, 'm'))?.[0] ?? '';
const actOf = (line) => line.match(/\bact=(\S*)/)?.[1] ?? '';

let actions = 0;
newHand(1);
write('deal');
let waitingSince = Date.now();
let lastBeat = Date.now();
let lastSeenText = written;
for (;;) {
  await sleep(50);
  if (HEARTBEAT && Date.now() - lastBeat >= HEARTBEAT) { clock++; lastBeat = Date.now(); write('heartbeat'); }
  let text;
  try { text = readFileSync(docPath, 'utf8'); } catch { continue; }
  if (text === written || text === lastSeenText) {
    if (Date.now() - waitingSince > STALL) { log({ type: 'stall', hand: T.n, street: T.street, on: T.on, waitedMs: Date.now() - waitingSince }); break; }
    continue;
  }
  lastSeenText = text;
  // Something else changed the file: the door's write of a buddy's edit.
  const others = PLAYERS.filter((p) => p !== T.on && actOf(seatOf(text, p)));
  if (others.length) log({ type: 'anomaly', what: 'act out of turn', seats: others, hand: T.n, on: T.on });
  const handInDoc = text.match(/^Hand: (\d+)$/m)?.[1];
  if (Number(handInDoc) !== T.n) log({ type: 'anomaly', what: `doc says hand ${handInDoc}`, hand: T.n });
  const act = actOf(seatOf(text, T.on));
  if (!act) { log({ type: 'change', what: 'a change with no action of the seat on turn', hand: T.n, on: T.on }); if (others.length) write('clear'); continue; }
  const p = T.on;
  const street = T.street;
  const r = apply(p, act);
  actions++;
  log({ type: 'seen', hand: T.n, street, player: p, act: r.act, written: act, anomaly: r.anomaly, n: actions });
  if (r.step === 'street') nextStreet();
  if (r.step === 'end') {
    endHand();
    if (T.n >= HANDS) { T.on = null; write('final'); break; }
    newHand(T.n + 1);
    write('deal');
  } else write(r.step === 'street' ? 'street' : 'action');
  waitingSince = Date.now();
}
log({ type: 'done', actions, stacks });
