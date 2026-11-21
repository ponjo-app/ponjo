// The spy page's rules (site/spy.html): everything that must be exact in a
// game of Who's the Spy (谁是卧底), and nothing else. Who has which word,
// whose turn it is, what is legal, how a round and a vote end, who wins,
// and what each seat may see. Pure: each call takes a game and returns a new
// one, so it is tested with no page (test/spy.test.js). The players decide;
// this only says what may land.
//
// A seat is a number from 0. Every player gets a word: the civilians one,
// the spies (one, or two at seven or eight) another, close to it. No one is
// told which they are. A round: each living player gives a clue to their
// word, once, in seat order; then everyone alive votes at once, and the
// player with the most votes is out, their side shown. A tie at the top: the
// tied give one more clue each, and everyone votes again, between them only;
// a second tie, and no one is out. The civilians win once every spy is out;
// the spies, once they are as many as the civilians, or one is among the
// last three.

import { cryptoRandom } from './werewolf-rules.js';

export const SIZES = [5, 6, 7, 8];
export const MAX_CLUE = 200; // characters of a clue
export const spiesFor = (size) => (size >= 7 ? 2 : 1);

// The words, civilians' and spies' in either order: close enough to blur, far enough to tell.
export const PAIRS = [
  ['coffee', 'tea'], ['beach', 'pool'], ['guitar', 'violin'], ['pizza', 'burger'], ['lion', 'tiger'],
  ['pen', 'pencil'], ['train', 'bus'], ['rain', 'snow'], ['piano', 'organ'], ['wolf', 'dog'],
  ['butter', 'cheese'], ['honey', 'syrup'], ['ketchup', 'mustard'], ['chess', 'checkers'], ['bicycle', 'scooter'],
  ['library', 'bookstore'], ['dentist', 'doctor'], ['sofa', 'bed'], ['apple', 'pear'], ['socks', 'gloves'],
  ['candle', 'lamp'], ['zoo', 'aquarium'], ['umbrella', 'raincoat'], ['Halloween', 'Christmas'], ['wedding', 'birthday'],
  ['email', 'letter'], ['popcorn', 'chips'], ['moon', 'star'], ['football', 'rugby'], ['airport', 'station'],
];

/**
 * The words and sides for a table of `size`: a pair at random, which word
 * is the spies' at random, and the sides shuffled (Fisher–Yates on
 * `random(n)`, a fair whole number below n). Returns { words: { civilian,
 * spy }, roles }.
 */
export function deal(size, random = cryptoRandom) {
  if (!SIZES.includes(size)) throw new Error(`A game has ${SIZES.join(', ')} seats.`);
  const pair = PAIRS[random(PAIRS.length)];
  const [civilian, spy] = random(2) ? pair : [pair[1], pair[0]];
  const roles = [...Array(spiesFor(size)).fill('spy'), ...Array(size - spiesFor(size)).fill('civilian')];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return { words: { civilian, spy }, roles };
}

/**
 * A new game, at the first round's clues. The log is everything that
 * happened; all of it is public, the votes once a vote ends.
 */
export function newGame({ words, roles }) {
  const game = {
    seats: roles.map((role) => ({ role, word: words[role], alive: true })),
    words: { ...words }, round: 0, phase: 'clue', runoff: null, order: [], speaker: null, votes: {}, acted: [],
    log: [], winner: null,
  };
  startRound(game);
  return game;
}

const clone = (game) => structuredClone(game);
const alive = (game, seat) => Boolean(game.seats[seat]?.alive);
const note = (game, entry) => game.log.push({ round: game.round, ...entry });

/**
 * The moment the game is at, as a string: an action made on one moment is
 * stale once the game has moved to another. During a vote it stays the same
 * while the votes come in.
 */
export const turn = (game) => [game.round, game.phase, game.runoff ? 'runoff' : '', game.speaker ?? ''].join(':');

/** Who is due now, all at once: [{ seat, kind }], `kind` clue (the speaker) or vote (everyone alive who has not). */
export function due(game) {
  if (game.phase === 'clue') return game.acted.includes(game.speaker) ? [] : [{ seat: game.speaker, kind: 'clue' }];
  if (game.phase === 'vote') return game.seats.flatMap((s, i) => (s.alive && !game.acted.includes(i) ? [{ seat: i, kind: 'vote' }] : []));
  return [];
}

// Whom `seat` may vote for: another living player; in a runoff, one of the tied.
export const targets = (game, seat) => (game.runoff ?? game.seats.map((_, i) => i)).filter((i) => i !== seat && alive(game, i));

// Whether `text` says `word`, or its plural, as a word of its own.
export const says = (text, word) => new RegExp(`\\b${word.replace(/\W/g, '\\$&')}(e?s)?\\b`, 'i').test(text);

/**
 * `seat` does `action`, made on the moment `action.at` (`turn`):
 *   clue { text }     a clue to their word, never the word itself
 *   vote { target }   whom they think is a spy
 * Returns the new game, or { error } saying why it is not legal or stale, the game unchanged.
 */
export function act(game, seat, action) {
  if (game.phase === 'over') return { error: 'The game is over.' };
  if (action?.at !== turn(game)) return { error: 'Stale: the game moved on before your action landed.' };
  const mine = due(game).find((d) => d.seat === seat);
  if (!mine) return { error: game.acted.includes(seat) ? 'You have voted already: wait for the others.' : 'It is not your turn.' };
  const type = String(action.type ?? '');
  if (type !== mine.kind) return { error: mine.kind === 'clue' ? 'It is your turn to give a clue.' : 'Now you may only vote.' };
  const g = clone(game);
  if (type === 'clue') {
    const text = typeof action.text === 'string' ? action.text.trim() : '';
    if (!text) return { error: 'Say something: a clue is your turn.' };
    if (text.length > MAX_CLUE) return { error: `Too long: at most ${MAX_CLUE} characters, you wrote ${text.length}.` };
    if (says(text, g.seats[seat].word)) return { error: 'Your clue says your word: describe it without saying it.' };
    note(g, { type: 'clue', seat, text });
  } else {
    if (!targets(g, seat).includes(action.target)) return { error: g.runoff ? 'Vote for one of the tied players, not yourself.' : 'Vote for another living player.' };
    g.votes[seat] = action.target;
  }
  g.acted.push(seat);
  return settle(g);
}

/**
 * The world's fallback: `seats` (by default everyone due) are taken as
 * doing nothing, the way a timer that ran out or a player turned away too
 * often leaves them: a speaker says nothing, a voter abstains. Returns the new game.
 */
export function fallback(game, seats = due(game).map((d) => d.seat)) {
  const g = clone(game);
  for (const { seat, kind } of due(g).filter((d) => seats.includes(d.seat))) {
    if (kind === 'clue') note(g, { type: 'clue', seat, text: '', silent: true });
    else g.votes[seat] = null;
    g.acted.push(seat);
  }
  return settle(g);
}

// After an action: while no one is due, the phase ends and the next begins.
function settle(g) {
  while (g.phase !== 'over' && !due(g).length) end(g);
  return g;
}

function end(g) {
  g.acted = [];
  if (g.phase === 'vote') return tally(g);
  const next = g.order.slice(g.order.indexOf(g.speaker) + 1).find((i) => alive(g, i));
  if (next !== undefined) g.speaker = next;
  else Object.assign(g, { phase: 'vote', speaker: null, votes: {} });
}

// A round's clues go round from the seat after the last round's first, or the first seat.
function startRound(g) {
  g.round++;
  const n = g.seats.length;
  const from = (g.round - 1) % n;
  g.order = [...Array(n).keys()].map((k) => (from + k) % n).filter((i) => alive(g, i));
  Object.assign(g, { phase: 'clue', runoff: null, speaker: g.order[0], votes: {} });
  note(g, { type: 'round' });
}

// The vote: the one with the most votes is out. A tie: a runoff between the
// tied; a tie in a runoff, or no votes, and no one is out.
function tally(g) {
  const count = new Map();
  for (const t of Object.values(g.votes)) if (t !== null) count.set(t, (count.get(t) ?? 0) + 1);
  const most = Math.max(0, ...count.values());
  const top = [...count].filter(([, c]) => c === most).map(([t]) => t).sort((a, b) => a - b);
  const out = most && top.length === 1 ? top[0] : null;
  const runoff = out === null && most > 0 && !g.runoff ? top : null;
  note(g, { type: 'vote', votes: { ...g.votes }, out, runoff, role: out === null ? null : g.seats[out].role, ...(g.runoff ? { second: true } : {}) });
  g.votes = {};
  if (runoff) return Object.assign(g, { phase: 'clue', runoff, order: runoff, speaker: runoff[0] });
  if (out !== null) g.seats[out].alive = false;
  if (!win(g)) startRound(g);
}

// The game ends when every spy is out, or the spies are as many as the civilians, or one is among the last three.
function win(g) {
  const live = g.seats.filter((s) => s.alive);
  const spies = live.filter((s) => s.role === 'spy').length;
  const winner = spies === 0 ? 'civilians' : spies >= live.length - spies || live.length <= 3 ? 'spies' : null;
  if (!winner) return false;
  Object.assign(g, { phase: 'over', speaker: null, runoff: null, winner });
  note(g, { type: 'over', winner, roles: g.seats.map((s) => s.role), words: { ...g.words } });
  return true;
}

/**
 * Everything seat `seat` may see: its own word, never its side; who is
 * alive, and the side of each player voted out; whose clue it is, or who
 * has voted (not for whom, till the vote ends); and the log. Once the game
 * is over, everything. A seat of null watches: it sees what anyone does,
 * and no word. The only way a player's prompt, or a page, sees the game.
 */
export function view(game, seat) {
  const over = game.phase === 'over';
  const me = seat === null ? null : game.seats[seat];
  const mine = seat === null ? null : due(game).find((d) => d.seat === seat);
  return {
    seat, word: me?.word ?? null, alive: me?.alive ?? false, round: game.round, phase: game.phase, winner: game.winner,
    due: mine ? { kind: mine.kind, at: turn(game), ...(mine.kind === 'vote' ? { targets: targets(game, seat) } : {}) } : null,
    speaker: game.speaker, runoff: game.runoff && [...game.runoff],
    voted: game.phase === 'vote' ? [...game.acted] : [],
    seats: game.seats.map((s) => ({ alive: s.alive, role: over || !s.alive ? s.role : null, word: over ? s.word : null })),
    words: over ? { ...game.words } : null,
    log: structuredClone(game.log),
  };
}
