// The werewolf page's rules (site/werewolf.html): everything that must be
// exact in a game of werewolf, and nothing else. Who has which role, whose
// turn it is, what is legal, how a night, a day and a vote end, who wins,
// and what each seat may see. Pure: each call takes a game and returns a new
// one, so it is tested with no page (test/werewolf.test.js). The players
// decide; this only says what may land.
//
// A seat is a number from 0. The roles: werewolves, who kill one player a
// night; the seer, who learns one player's side a night; the witch, with one
// potion that saves the night's victim and one that kills, each once a game;
// villagers. A night, as a narrator calls it: the wolves pick a kill
// together, then the seer checks someone, then the witch. Dawn says who died. Then each living player
// speaks once, in seat order; then everyone alive votes at once; the player
// with the most votes is out, and says their last words. The village wins
// when every wolf is dead; the wolves, once they are as many as everyone else.

export const SIZES = [6, 7, 8];
const WOLVES = 2; // at any size; one seer, one witch, the rest villagers
export const MAX_SPEECH = 400; // characters of a speech, last words or a line to the pack

// A fair whole number below n from crypto.getRandomValues, with no modulo bias.
export function cryptoRandom(n) {
  const limit = Math.floor(2 ** 32 / n) * n;
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return word[0] % n;
}

// The roles for a table of `size`, shuffled: Fisher–Yates on `random(n)`, a fair whole number below n.
export function deal(size, random = cryptoRandom) {
  if (!SIZES.includes(size)) throw new Error(`A game has ${SIZES.join(', ')} seats.`);
  const roles = [...Array(WOLVES).fill('wolf'), 'seer', 'witch', ...Array(size - WOLVES - 2).fill('villager')];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

/**
 * A new game, at the first night. `roles` are each seat's, as `deal` gives them.
 * The log is everything that happened, each entry with `to`, the seats that
 * may see it, or none for everyone.
 */
export function newGame(roles) {
  const game = {
    seats: roles.map((role) => ({ role, alive: true })),
    day: 0, phase: 'night', step: 'wolves', round: 1, picks: {}, victim: null, saved: false, poisoned: null,
    potions: { save: true, poison: true }, speaker: null, order: [], votes: {}, acted: [],
    log: [], winner: null,
  };
  startNight(game);
  return game;
}

const clone = (game) => structuredClone(game);
const seatsWith = (game, ok) => game.seats.flatMap((s, i) => (ok(s, i) ? [i] : []));
const wolves = (game) => seatsWith(game, (s) => s.role === 'wolf');
const roleSeat = (game, role) => game.seats.findIndex((s) => s.role === role);
const alive = (game, seat) => Boolean(game.seats[seat]?.alive);
const note = (game, entry, to) => game.log.push(to ? { day: game.day, ...entry, to } : { day: game.day, ...entry });

/**
 * The moment the game is at, as a string: an action made on one moment is
 * stale once the game has moved to another. During a vote or the wolves'
 * pick it stays the same while the others' actions come in.
 */
export const turn = (game) => [game.day, game.phase, game.phase === 'night' ? `${game.step}${game.round}` : game.speaker ?? ''].join(':');

/**
 * Who is due now, all at once: [{ seat, kind }]. `kind`: kill (a wolf picks
 * the night's victim), check (the seer), potion (the witch), speak (the day's
 * speaker), vote, last (the voted-out player's last words).
 */
export function due(game) {
  const not = (i) => alive(game, i) && !game.acted.includes(i);
  if (game.phase === 'night' && game.step === 'wolves') return wolves(game).filter(not).map((seat) => ({ seat, kind: 'kill' }));
  if (game.phase === 'night' && game.step === 'seer') {
    const seer = roleSeat(game, 'seer');
    return not(seer) ? [{ seat: seer, kind: 'check' }] : [];
  }
  if (game.phase === 'night') {
    const witch = roleSeat(game, 'witch');
    const can = potions(game);
    return not(witch) && (can.save || can.poison) ? [{ seat: witch, kind: 'potion' }] : []; // with nothing she could use, she sleeps
  }
  if (game.phase === 'day' || game.phase === 'last') return game.acted.includes(game.speaker) ? [] : [{ seat: game.speaker, kind: game.phase === 'day' ? 'speak' : 'last' }];
  if (game.phase === 'vote') return seatsWith(game, (s, i) => not(i)).map((seat) => ({ seat, kind: 'vote' }));
  return [];
}

// What the witch may do tonight: save the wolves' victim, poison someone, or neither.
function potions(game) {
  const witch = roleSeat(game, 'witch');
  return {
    save: game.potions.save && game.victim !== null && game.victim !== witch, // she may not save herself
    poison: game.potions.poison,
  };
}

// A speech, last words or a line to the pack: its text, or an error.
function text(action, required) {
  const t = typeof action.text === 'string' ? action.text.trim() : '';
  if (!t && required) return { error: 'Say something: a speech is your turn.' };
  if (t.length > MAX_SPEECH) return { error: `Too long: at most ${MAX_SPEECH} characters, you wrote ${t.length}.` };
  return { text: t };
}

/**
 * `seat` does `action`, made on the moment `action.at` (`turn`):
 *   kill { target, text? }   a wolf picks the night's victim, with a line to the pack
 *   check { target }         the seer learns whether the target is a wolf
 *   save | poison { target } | pass   the witch
 *   speak { text }           the day's speech, or last words
 *   vote { target } | abstain
 * Returns the new game, or { error } saying why it is not legal or stale, the game unchanged.
 */
export function act(game, seat, action) {
  if (game.phase === 'over') return { error: 'The game is over.' };
  if (action?.at !== turn(game)) return { error: 'Stale: the game moved on before your action landed.' };
  const mine = due(game).find((d) => d.seat === seat);
  if (!mine) return { error: game.acted.includes(seat) ? 'You have acted already: wait for the others.' : 'It is not your turn.' };
  const type = String(action.type ?? '');
  const target = action.target;
  const isTarget = Number.isInteger(target) && alive(game, target);
  const g = clone(game);
  const words = { kill: 'kill', check: 'check', potion: 'save, poison or pass', speak: 'speak', last: 'speak', vote: 'vote or abstain' }[mine.kind];
  const allowed = { kill: ['kill'], check: ['check'], potion: ['save', 'poison', 'pass'], speak: ['speak'], last: ['speak'], vote: ['vote', 'abstain'] }[mine.kind];
  if (!allowed.includes(type)) return { error: `Now you may only ${words}.` };
  if (type === 'kill') {
    if (!isTarget) return { error: 'Pick a living player to kill.' };
    if (g.seats[target].role === 'wolf') return { error: 'That player is a wolf: pick someone else.' };
    const line = text(action, false);
    if (line.error) return line;
    g.picks[seat] = target;
    note(g, { type: 'pick', seat, target, round: g.round, text: line.text || undefined }, wolves(g));
  } else if (type === 'check') {
    if (!isTarget || target === seat) return { error: 'Pick another living player to check.' };
    note(g, { type: 'check', seat, target, wolf: g.seats[target].role === 'wolf' }, [seat]);
  } else if (type === 'save') {
    if (!potions(g).save) return { error: !g.potions.save ? 'Your save potion is used.' : g.victim === null ? 'No one was attacked tonight.' : 'You may not save yourself.' };
    g.potions.save = false;
    g.saved = true;
    note(g, { type: 'save', seat, target: g.victim }, [seat]);
  } else if (type === 'poison') {
    if (!g.potions.poison) return { error: 'Your poison is used.' };
    if (!isTarget || target === seat) return { error: 'Pick another living player to poison.' };
    g.potions.poison = false;
    g.poisoned = target;
    note(g, { type: 'poison', seat, target }, [seat]);
  } else if (type === 'speak') {
    const line = text(action, true);
    if (line.error) return line;
    note(g, { type: mine.kind === 'last' ? 'last' : 'speech', seat, text: line.text });
  } else if (type === 'vote') {
    if (!isTarget || target === seat) return { error: 'Vote for another living player, or abstain.' };
    g.votes[seat] = target;
  } else if (type === 'abstain') {
    g.votes[seat] = null;
  }
  g.acted.push(seat);
  return settle(g);
}

/**
 * The world's fallback: `seats` (by default everyone due) are taken as
 * doing nothing, the way a timer that ran out or a player turned away too
 * often leaves them. A wolf picks no one, the seer checks no one, the witch
 * passes, a speaker says nothing, a voter abstains. Returns the new game.
 */
export function fallback(game, seats = due(game).map((d) => d.seat)) {
  const g = clone(game);
  for (const { seat, kind } of due(g).filter((d) => seats.includes(d.seat))) {
    if (kind === 'vote') g.votes[seat] = null;
    if (kind === 'speak' || kind === 'last') note(g, { type: kind === 'last' ? 'last' : 'speech', seat, text: '', silent: true });
    g.acted.push(seat);
  }
  if (g.phase === 'night' && g.step === 'wolves' && !due(g).length) g.round = 2; // out of time: the picks stand, with no second round
  return settle(g);
}

// After an action: while no one is due, the phase ends and the next begins.
function settle(g) {
  while (g.phase !== 'over' && !due(g).length) end(g);
  return g;
}

function end(g) {
  g.acted = [];
  if (g.phase === 'night' && g.step === 'wolves') return endPick(g);
  if (g.phase === 'night' && g.step === 'seer') return wakeWitch(g);
  if (g.phase === 'night') return dawn(g);
  if (g.phase === 'day') {
    const at = g.order.indexOf(g.speaker);
    const next = g.order.slice(at + 1).find((i) => alive(g, i));
    if (next !== undefined) g.speaker = next;
    else Object.assign(g, { phase: 'vote', speaker: null, votes: {} });
    return;
  }
  if (g.phase === 'vote') return tally(g);
  if (g.phase === 'last') return win(g) || startNight(g);
}

function startNight(g) {
  g.day++;
  Object.assign(g, { phase: 'night', step: 'wolves', round: 1, picks: {}, victim: null, saved: false, poisoned: null, speaker: null });
  note(g, { type: 'night' });
}

// The wolves' pick: if they disagree, once more, seeing each other's picks;
// then the most picked, a tie to the pick of the first wolf in seat order
// who picked one of those tied. No pick, no victim.
function endPick(g) {
  const picks = Object.entries(g.picks).map(([seat, target]) => [Number(seat), target]).sort((a, b) => a[0] - b[0]);
  if (g.round === 1 && new Set(picks.map(([, t]) => t)).size > 1) {
    Object.assign(g, { round: 2, picks: {} });
    return;
  }
  const count = new Map();
  for (const [, t] of picks) count.set(t, (count.get(t) ?? 0) + 1);
  const most = Math.max(0, ...count.values());
  g.victim = picks.find(([, t]) => count.get(t) === most)?.[1] ?? null;
  note(g, { type: 'kill', target: g.victim }, wolves(g));
  g.step = 'seer';
}

function wakeWitch(g) {
  g.step = 'witch';
  const witch = roleSeat(g, 'witch');
  if (alive(g, witch) && g.potions.save && g.victim !== null) note(g, { type: 'attacked', target: g.victim }, [witch]); // she is told only while she can save
}

function dawn(g) {
  const deaths = [...new Set([g.victim, g.poisoned].filter((i) => i !== null && i !== undefined))]
    .filter((i) => !(i === g.victim && g.saved))
    .sort((a, b) => a - b);
  for (const i of deaths) g.seats[i].alive = false;
  Object.assign(g, { phase: 'day', step: null, round: 1, picks: {}, victim: null, saved: false, poisoned: null });
  note(g, { type: 'dawn', deaths });
  if (win(g)) return;
  // speeches go round from the seat after the first who died, or from the first seat
  const n = g.seats.length;
  const from = deaths.length ? deaths[0] + 1 : 0;
  g.order = [...Array(n).keys()].map((k) => (from + k) % n).filter((i) => alive(g, i));
  g.speaker = g.order[0];
}

// The vote: the one with the most votes is out and says last words; a tie, or no votes, and no one is.
function tally(g) {
  const count = new Map();
  for (const t of Object.values(g.votes)) if (t !== null) count.set(t, (count.get(t) ?? 0) + 1);
  const most = Math.max(0, ...count.values());
  const top = [...count].filter(([, c]) => c === most).map(([t]) => t);
  const out = most && top.length === 1 ? top[0] : null;
  note(g, { type: 'vote', votes: { ...g.votes }, out });
  g.votes = {};
  if (out === null) return startNight(g);
  g.seats[out].alive = false;
  Object.assign(g, { phase: 'last', speaker: out });
}

// The game ends when every wolf is dead, or the wolves are as many as everyone else.
function win(g) {
  const live = g.seats.filter((s) => s.alive);
  const w = live.filter((s) => s.role === 'wolf').length;
  const winner = w === 0 ? 'village' : w >= live.length - w ? 'wolves' : null;
  if (!winner) return false;
  Object.assign(g, { phase: 'over', step: null, speaker: null, winner });
  note(g, { type: 'over', winner, roles: g.seats.map((s) => s.role) });
  return true;
}

/**
 * Everything seat `seat` may see: its own role; the other wolves, the
 * pack's picks and lines, and its kill, for a wolf; its checks, for the
 * seer; whom the wolves attacked and its potions, for the witch; who is
 * alive, which role the night is at (a narrator calls each, alive or not),
 * whose turn it is in the day, who has voted (not for whom, till the vote
 * ends), and the public log. Once the game is over, everything.
 * The only way a player's prompt, or a page, sees the game.
 */
export function view(game, seat) {
  const over = game.phase === 'over';
  const me = game.seats[seat];
  const pack = me.role === 'wolf' ? wolves(game) : [];
  const mine = due(game).find((d) => d.seat === seat);
  return {
    seat, role: me.role, alive: me.alive, day: game.day, phase: game.phase, step: game.phase === 'night' ? game.step : null, winner: game.winner,
    due: mine ? { kind: mine.kind, at: turn(game), ...(mine.kind === 'potion' ? potions(game) : {}), ...(mine.kind === 'kill' ? { round: game.round } : {}) } : null,
    speaker: game.phase === 'day' || game.phase === 'last' ? game.speaker : null,
    voted: game.phase === 'vote' ? [...game.acted] : [],
    pack: pack.length ? pack : null,
    potions: me.role === 'witch' || over ? { ...game.potions } : null,
    seats: game.seats.map((s, i) => ({ alive: s.alive, role: over || i === seat || pack.includes(i) ? s.role : null })),
    log: game.log.filter((e) => over || !e.to || e.to.includes(seat)).map(({ to, ...e }) => structuredClone(e)),
  };
}
