// The poker table (site/poker.html) as a world on the runtime's core
// (docs/app/worlds/poker.md; src/core/store.js, ledger.js,
// controller.js): `view` and `apply`, both pure. The table everyone
// shares: who sits where with how many chips, the hand (poker-dealer.js),
// the chat, the reactions, each AI player's thinking. `view` gives a
// member only what its seat may see, and its tasks; `apply` lands a
// change, or refuses it, saying why. No clock, no deck and no randomness:
// the time is each change's `at`; the dealer is a member whose tasks are
// to deal a hand and each street's cards, which come in its changes; the
// clock is a member whose tasks are the turns' deadlines.
//
// The people are the host (HUMAN), whose page holds the table, and any
// friends who joined it by a link and bought in; AI players come and go
// between hands as the host asks. Anyone may chat and react at any time.

import { act, board, describeLegal, legal, owed, shuffled, startHand, view as handView } from './poker-dealer.js';
import { DEPTH, MAX_LINE, after, deadline, line as newLine, named, think as thought } from './game-kit.js';

export const HUMAN = 'you';
export const DEALER = 'dealer'; // the member who deals: its changes bring the cards
export const CLOCK = 'clock'; // the member whose tasks are the turns' deadlines
const BLINDS = [10, 20];
export const STACK = 1000;
export const [MIN_BUY, MAX_BUY] = [200, 1000]; // what a person may buy in for, and hold on the table
export const MAX_SEATS = 6;
export const TURN = 30_000; // ms a turn may take while it holds up a person; then the dealer checks or folds for the player
const HELLO_MS = 1400; // ms each AI player's hello takes to show, before the first deal
const CHAT_SHOWN = 24; // latest lines an AI player's view has
const DECK = shuffled().sort();

// `talk`: the share of its turns, or of lines other players say to it, on which a player may say something.
export const PERSONAS = [
  {
    id: 'Gary',
    talk: 0.35,
    blurb: 'A tourist who plays any two cards',
    hello: ['Hi folks! Gary, first time at a real table. My wife is at the slots.', 'Quick one: a flush is the all-same-colour thing, right?'],
    bye: 'That\'s my wife texting. Bye, everyone!',
    style: 'You are a tourist on holiday who wandered into the casino for fun. You barely know the strategy: you play almost every hand, call far too much, raise on a whim (a lucky feeling, pretty cards, your birthday), and hate to fold. Cheerful and chatty: you celebrate tiny wins, ask the table naive questions, and say what you hold out loud by mistake now and then. You react to nearly everything, mostly 😮 👏 🔥.',
  },
  {
    id: 'Duke',
    talk: 0.5,
    blurb: 'Rude, aggressive, talks trash',
    hello: ['Name\'s Duke. Sit down, empty your wallet, try not to cry.'],
    bye: 'Fine, I\'m out. None of you were worth my time anyway.',
    style: 'You are rude, cocky and aggressive. You raise and re-raise a lot, bully short stacks and go all in to make people sweat. You talk trash with nearly every action, unprompted: mock a fold, needle whoever is winning, brag about pots you took, taunt the person to call you. Keep it playful-mean table banter: no slurs, no swearing, nothing about anyone\'s real life. You react often, to mock: 😂 at a fold or a small bet, 😤 when someone beats you.',
  },
  {
    id: 'Penny',
    talk: 0.15,
    blurb: 'Careful, counts every chip',
    hello: ['Penny. I count every chip, so don\'t expect gifts.'],
    bye: 'I\'ll take my chips and go. Good game.',
    style: 'You are careful and calculating: every chip counts. You fold weak hands, call only with the right pot odds, bet your strong hands for value and rarely bluff. You talk little, and when you do it is dry and precise: the price of a call, the pot odds, a quick count of outs. You rarely react: a 👍 for a well-played hand.',
  },
  {
    id: 'Mabel',
    talk: 0.3,
    blurb: 'A sweet grandmother who sets traps',
    hello: ['Hello, dears. Mabel. Don\'t mind me, I only play for fun.'],
    bye: 'Time for my programme, dears. Take care now!',
    style: 'You are a sweet, polite grandmother who plays cards every Thursday. You look harmless and play very tight, but with a big hand you set a trap: check and call, then raise on the river. You chat warmly, call people "dear", offer them biscuits, and apologise when you win. You react with 👏 and 👍.',
  },
  {
    id: 'Lex',
    talk: 0.3,
    blurb: 'An online grinder who talks theory',
    hello: ['Lex. I usually play twelve tables online, so this is a holiday.'],
    bye: 'Off to grind some real tables. GG.',
    style: 'You are a young online grinder who plays twelve tables at once at home. You play solid, aggressive, balanced poker and talk in poker jargon: ranges, equity, "3-bet", "standard fold". A little smug, you explain the theory to people who did not ask. You react with 😮 at an odd play and 🔥 at your own.',
  },
  {
    id: 'Hank',
    talk: 0.35,
    blurb: 'A cowboy who loves a big bluff',
    hello: ['Howdy, partners. Hank. Been playin\' cards since before y\'all were born.'],
    bye: 'Saddlin\' up. Y\'all take care, partners.',
    style: 'You are an old-school cowboy from the back-room card games, loose and aggressive, who plays on feel and reads people, not charts. You tell tall tales about legendary pots you won, call everyone "partner", and love a big bluff. You react with 😂 and 🔥.',
  },
];
const FIRST = ['Gary', 'Duke', 'Penny']; // the players at a new table, in seats 1, 3 and 5
// Seat numbers go round the table from the host's, 0: six seats, a player keeps its own.
export const isPerson = (id) => !PERSONAS.some((p) => p.id === id);

/**
 * A new table: the host, with no chips until they buy in (`sit`), and
 * `ids`' players with STACK each. Players come and go between hands:
 * `joining` take a seat when the next hand is dealt, `leaving` give theirs
 * up. People, the host and any friends, buy chips: `topUp` holds what each
 * added since the hand began; one with none sits a hand out. `names`: the
 * people's names. `chat`: the lines said; `reactions`: the emoji sent;
 * `thoughts`: each AI player's thinking. `dealing`: the dealer is to deal
 * the next hand, at `dealAt` if set; `deals`, how many it dealt, a hand or
 * none for want of chips. `since`: the `at` of the change that
 * began the turn.
 */
export function newTable(ids = FIRST) {
  const players = [{ id: HUMAN, stack: 0 }, ...ids.map((id) => ({ id, stack: STACK }))];
  const slots = Object.fromEntries([[HUMAN, 0], ...ids.map((id, k) => [id, ids.length === 3 ? 2 * k + 1 : k + 1])]);
  return { players, slots, names: {}, hand: null, handNo: 0, button: -1, topUp: {}, joining: [], leaving: [], chat: [], reactions: [], thoughts: {}, greeted: false, dealing: false, dealAt: 0, deals: 0, since: 0 };
}

// The seats no one has, or will have at the next hand.
export const freeSeats = (table) => [...Array(MAX_SEATS).keys()].filter((k) => !lineup(table).some((p) => table.slots[p.id] === k)); // a leaving player's seat is its own till the hand ends

// Who is at the table, in seat order, as it is drawn: the hand's seats (or
// the players before the first hand), then those joining: [{ id, joining, leaving }].
export const lineup = (table) => [
  ...(table.hand ? table.hand.seats : table.players).map(({ id }) => ({ id, joining: false, leaving: table.leaving.includes(id) })),
  ...table.joining.map((id) => ({ id, joining: true, leaving: false })),
];
const playing = (table) => lineup(table).filter((p) => p.id !== HUMAN && !p.leaving); // whom the host plays against
const seatOf = (table, id) => table.players.findIndex((p) => p.id === id);
const nameOf = (table, id) => (id === DEALER ? 'Dealer' : isPerson(id) ? table.names[id] ?? 'the person' : id);
const names = (table, text) => named([...PERSONAS.map(({ id }) => id), ...Object.keys(table.names)], (id) => nameOf(table, id), text);
const live = (table) => Boolean(table.hand) && table.hand.street !== 'done';
// The turn the table is at, while a hand is live: a move made on another is stale.
const moment = (table) => (live(table) ? `${table.hand.id}:${table.hand.n}` : '');
const actor = (table) => (live(table) && table.hand.toAct !== null ? table.hand.seats[table.hand.toAct].id : null);
// When the turn is due by: TURN after it began, unless it is a person's, alone with AI players.
const ends = (table) => {
  const id = actor(table);
  return id && (!isPerson(id) || lineup(table).some((p) => p.id !== id && isPerson(p.id))) ? table.since + TURN : 0;
};

// A person's chips now, with what they added since the hand began.
export function myChips(table, id = HUMAN) {
  const seat = seatOf(table, id);
  return (seat < 0 ? 0 : (table.hand ? table.hand.seats : table.players)[seat].stack) + (table.topUp[id] ?? 0);
}

// A big hand, which a player may react to: an all-in, or a pot of 15 big blinds.
const isBig = (hand) => hand?.street === 'done' && (hand.actions.some((a) => a.allIn) || hand.seats.reduce((sum, s) => sum + s.total, 0) >= 15 * hand.bb);
// Who has a word after a big hand: two AI players, the winner first, then those still in at the end.
function reactors(hand) {
  const won = hand.result.won.findIndex(Boolean);
  return [won, ...[...hand.seats.keys()].filter((i) => i !== won && hand.seats[i].inHand && !hand.seats[i].folded)].filter((i) => i > 0).slice(0, 2).map((i) => hand.seats[i].id).filter((id) => !isPerson(id));
}

/**
 * Whether AI player `id` may talk on a task `given`: a number in [0, 1)
 * from the two alone (FNV-1a), under its `talk`. The same each time it is
 * asked, so a run's view and the change it makes agree.
 */
export function rolls(id, given) {
  let h = 0x811c9dc5;
  for (const ch of `${id}|${given}`) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h / 2 ** 32 < PERSONAS.find((p) => p.id === id).talk;
}
// Whether a run of AI player `id` on `tasks` may say something: always to a line or after a big hand; on a turn, as it rolls.
const talks = (id, tasks) => tasks.some((t) => !t.given.startsWith('turn:') || rolls(id, t.given));

// ---- tasks ----

// A line asks AI player `id`: one that names it, a person's always, an AI
// player's as it rolls; a person's to the whole table, the one it is `to`
// (the next AI player after them); none at DEPTH.
const asks = (l, id) => l.by !== id && l.by !== DEALER && l.depth < DEPTH && (l.to.includes(id) ? isPerson(l.by) || rolls(id, `line:${l.id}`) : l.next === id);

// What member `id` is due to do: its turn; an AI player at the table, each
// line that asks it, and a word after a big hand.
function tasksOf(t, id) {
  const tasks = [];
  if (actor(t) === id) tasks.push({ given: `turn:${moment(t)}`, as: id, kind: 'turn', from: [], depth: 0, ...(ends(t) ? { at: ends(t) } : {}), why: 'Your turn' });
  if (isPerson(id) || seatOf(t, id) < 0) return tasks;
  for (const l of t.chat) if (asks(l, id)) tasks.push({ given: `line:${l.id}`, as: id, kind: 'ask', from: l.from, depth: l.depth, why: `${nameOf(t, l.by)} said "${l.text}"` });
  if (isBig(t.hand) && reactors(t.hand).includes(id)) tasks.push({ given: `react:${t.hand.id}`, as: id, kind: 'turn', from: [], depth: 0, why: 'A big hand just ended' });
  return tasks;
}

// The dealer's: the next hand, once asked to deal it; a street's cards, once its betting is over.
function dealerTasks(t) {
  if (live(t)) return owed(t.hand) ? [deadline(`board:${t.hand.id}:${t.hand.street}`, DEALER, undefined, 'The next street')] : [];
  return t.dealing ? [deadline(`deal:${t.deals + 1}`, DEALER, t.dealAt || undefined, 'The next hand')] : [];
}

// The clock's: a turn's end, when the dealer checks or folds for its player.
const clockTasks = (t) => (ends(t) ? [deadline(`timeout:${moment(t)}`, CLOCK, ends(t), 'The turn is up')] : []);

// ---- the world ----

/**
 * What `member` sees: `content`, the table as its seat may see it (its own
 * hole cards, others' at a showdown, and, for a person, the AI players'
 * once the hand is over; its own chips to come; the chat, an AI player
 * its latest; its own thinking this hand, and for a person everyone's
 * once the hand is over; on its turn, what is `legal`); the dealer, the
 * cards out and how many it is to deal; `actions`; `tasks`; `seen` (every
 * presence, to all); `rules`, how the game is played, in words.
 */
function view(t, member) {
  const tasks = member === CLOCK ? clockTasks(t) : member === DEALER ? dealerTasks(t) : tasksOf(t, member);
  const turn = actor(t) === member;
  const base = { actions: turn ? ['fold', 'check', 'call', 'bet', 'raise', 'allin', 'say', 'react'] : ['say', 'react'], tasks, seen: lineup(t).map((p) => p.id), rules: RULES };
  if (member === DEALER) return { ...base, content: { out: t.hand ? [...t.hand.seats.flatMap((s) => s.hole), ...t.hand.board] : [], need: live(t) ? owed(t.hand) : 2 * MAX_SEATS } };
  const person = isPerson(member);
  const seat = t.hand ? t.hand.seats.findIndex((s) => s.id === member) : -1;
  const over = t.hand?.street === 'done';
  let hand = t.hand && handView(t.hand, seat);
  if (hand && person && over) hand = { ...hand, seats: hand.seats.map((s, i) => (isPerson(s.id) ? s : { ...s, hole: [...t.hand.seats[i].hole] })) };
  const mine = (id) => (t.thoughts[id] ?? []).filter((x) => x.hand === t.hand?.id);
  const { players, slots, names, handNo, button, joining, leaving, greeted, dealing } = t;
  return {
    ...base,
    content: {
      players, slots, names, handNo, button, joining, leaving, greeted, dealing, hand,
      topUp: { [member]: t.topUp[member] ?? 0 },
      chat: person ? t.chat : t.chat.slice(-CHAT_SHOWN),
      reactions: t.reactions,
      thoughts: person ? (over ? Object.fromEntries(Object.keys(t.thoughts).map((id) => [id, mine(id)])) : {}) : { [member]: mine(member) },
      legal: turn ? legal(t.hand) : null,
      moment: moment(t),
      ends: ends(t),
    },
  };
}

/**
 * Lands `change` ({ by, at, base, answers, body }), or { refused: why }.
 * A player's `body`: { action, say, react, thinking }, each if any: a move
 * on its turn (fold, check, call, bet, raise or allin, with `amount`, the
 * total for the street), made on `base`, the turn; a line; an emoji; an AI
 * player's thinking. A refused change lands none of them; a move that
 * lands takes its line, its emoji and its thinking with it. A line of an
 * AI player's run lands only if the run may talk (`talks`). Or by `type`:
 *   name { name }                a person goes by `name`
 *   sit { buyIn }             the host buys chips; the first time, the AI
 *                                players say hello; the next hand is dealt
 *   sit { seat, name, buyIn }    a friend takes `seat` at the next hand
 *   topup { amount }             more chips, landing before the next hand
 *   leave                        a person cashes out between hands; a friend
 *                                gone mid-hand gives up the seat, folding
 *   next                         the host: the next hand
 *   add { id, seat }, remove { id }   the host: an AI player sits down at
 *                                the next hand, or gives up its seat after this one
 * The dealer's change answers its task with `cards`, the clock's its own.
 */
function apply(state, change) {
  const t = structuredClone(state);
  const out = step(t, change);
  return out?.refused ? out : { state: settle(t, state, change.at), effects: [] };
}

// A turn no one played (the ledger's): the dealer checks, or folds, for its player.
function fallback(state, task, at) {
  const t = structuredClone(state);
  if (task.given === `turn:${moment(t)}`) force(t, task.as);
  return settle(t, state, at);
}

export const world = { view, apply, fallback, tries: 3 };

function step(t, { by, at, base, answers = [], body }) {
  const b = body ?? {};
  if (by === CLOCK) {
    if (!clockTasks(t).some((x) => x.given === answers[0])) return { refused: 'Not due.' };
    return void force(t, actor(t));
  }
  if (by === DEALER) return dealt(t, answers[0], b.cards);
  if (b.type) return command(t, by, b, at);
  const asked = tasksOf(t, by).filter((x) => answers.includes(x.given));
  if (b.action) {
    if (base !== moment(t) || actor(t) !== by) return { refused: 'Stale: the table moved on before your action landed.' };
    const out = act(t.hand, t.hand.toAct, b.action);
    if (out.error) return { refused: out.error };
    t.hand = out.hand;
  } else if (asked.some((x) => x.given.startsWith('turn:'))) return { refused: 'It is your turn and you gave no action.' };
  const text = typeof b.say === 'string' ? b.say.trim().slice(0, MAX_LINE) : '';
  if (isPerson(by) && !b.action && !text && !REACTIONS.includes(b.react)) return { refused: 'Say something.' };
  if (REACTIONS.includes(b.react)) t.reactions.push({ id: t.reactions.length + 1, by, emoji: b.react, hand: t.hand?.id ?? 0 });
  if (text && (isPerson(by) || talks(by, asked))) say(t, by, text, asked);
  if (!isPerson(by) && b.thinking) t.thoughts = thought(t.thoughts, by, { hand: t.hand?.id ?? 0, street: t.hand?.street ?? '', text: String(b.thinking), action: b.action ? { ...b.action } : null });
}

// After a change: a person who left mid-hand is checked or folded for on
// their turn; a new turn begins at `at`.
function settle(t, before, at) {
  while (actor(t) && isPerson(actor(t)) && t.leaving.includes(actor(t))) force(t, actor(t));
  if (moment(t) !== moment(before)) t.since = at;
  return t;
}

// The dealer checks, or else folds, for `id` on its turn.
function force(t, id) {
  const seat = t.hand.seats.findIndex((s) => s.id === id);
  t.hand = act(t.hand, seat, { type: 'check' }).hand ?? act(t.hand, seat, { type: 'fold' }).hand;
}

// The dealer's change: the cards for its task `given`, none of them out already.
function dealt(t, given, cards) {
  if (!dealerTasks(t).some((x) => x.given === given)) return { refused: 'Not due.' };
  const out = t.hand ? [...t.hand.seats.flatMap((s) => s.hole), ...t.hand.board] : [];
  const need = live(t) ? owed(t.hand) : 2 * MAX_SEATS;
  if (!Array.isArray(cards) || cards.length < need || new Set(cards).size !== cards.length || cards.some((c) => !DECK.includes(c) || out.includes(c))) return { refused: `Deal ${need} cards from the rest of the deck.` };
  if (live(t)) t.hand = board(t.hand, cards.slice(0, need)).hand;
  else deal(t, cards);
}

// What a person does that is not a move, a line or an emoji, at `at`.
function command(t, by, b, at) {
  const between = !live(t);
  const amount = Math.round(Number(b.amount ?? b.buyIn)) || 0;
  const seated = lineup(t).some((p) => p.id === by && !p.leaving);
  if (b.type === 'name') {
    t.names[by] = String(b.name ?? '').trim().slice(0, 20) || 'Friend';
    return;
  }
  if (b.type === 'sit' && by === HUMAN) {
    if (amount < MIN_BUY || myChips(t) + amount > MAX_BUY) return { refused: `Buy in for ${MIN_BUY} to ${MAX_BUY}.` };
    t.topUp[HUMAN] = (t.topUp[HUMAN] ?? 0) + amount;
    if (!t.greeted) greet(t, at);
    if (between) t.dealing = true;
    return;
  }
  if (b.type === 'sit') {
    const name = String(b.name ?? '').trim().slice(0, 20) || 'Friend';
    if (amount < MIN_BUY || amount > MAX_BUY) return { refused: `Buy in for ${MIN_BUY} to ${MAX_BUY}.` };
    if (isPerson(by) && !lineup(t).some((p) => p.id === by) && freeSeats(t).includes(b.seat)) {
      t.joining.push(by);
      t.slots[by] = b.seat;
      t.names[by] = name;
      t.topUp[by] = amount;
      return;
    }
    return { refused: 'That seat is taken.' };
  }
  if (b.type === 'topup') {
    if (!seated || amount <= 0 || myChips(t, by) + amount > MAX_BUY) return { refused: `You may hold up to ${MAX_BUY} on the table.` };
    t.topUp[by] = (t.topUp[by] ?? 0) + amount;
    return;
  }
  if (b.type === 'leave') {
    if (!seated || !isPerson(by)) return { refused: 'You are not at the table.' };
    if (between || seatOf(t, by) < 0) return void leave(t, by);
    if (by === HUMAN) return { refused: 'Leave once the hand is over.' };
    t.leaving.push(by); // gone mid-hand: checked or folded for, and out at the next deal
    return;
  }
  if (by !== HUMAN) return { refused: 'Only the host does that.' };
  if (b.type === 'next') {
    if (!between) return { refused: 'The hand is not over.' };
    t.dealing = true;
    return;
  }
  if (b.type === 'add') return addPlayer(t, String(b.id), b.seat) ? undefined : { refused: 'There is no seat for them.' };
  if (b.type === 'remove') return removePlayer(t, String(b.id)) ? undefined : { refused: 'A table needs someone to play against.' };
  return { refused: `No action "${b.type}".` };
}

// A line of chat by `by` (a person, an AI player answering the tasks
// `asked`, or the dealer), at `depth` if given.
function say(t, by, text, asked = [], depth) {
  const l = newLine(t.chat, { by, text, to: by === DEALER ? [] : names(t, text), person: isPerson(by), asked, hand: t.hand?.id ?? 0 });
  if (depth !== undefined) l.depth = depth;
  else if (isPerson(by) && by !== DEALER && !l.to.length) l.next = after(t.players.map((p) => p.id), by, (p) => !isPerson(p)); // to the whole table: one AI player answers
  t.chat.push(l);
}

// The players at the table say hello when the host first sits down, each
// its first line in seat order, then any more: lines written for them, so
// they ask no one. The first hand is dealt once they are said, from `at`.
function greet(t, at) {
  const here = playing(t).filter((p) => !isPerson(p.id)).map(({ id }) => PERSONAS.find((p) => p.id === id));
  const lines = [...here.map((p) => [p.id, p.hello[0]]), ...here.flatMap((p) => p.hello.slice(1).map((text) => [p.id, text]))];
  for (const [id, text] of lines) say(t, id, text, [], DEPTH);
  t.greeted = true;
  t.dealAt = at + lines.length * HELLO_MS;
}

// An AI player takes a seat at the next hand, and says hello. False if
// there is no free seat, or it is already at the table.
function addPlayer(t, id, seat = freeSeats(t)[0]) {
  const persona = PERSONAS.find((p) => p.id === id);
  if (!persona || lineup(t).some((p) => p.id === id && !p.leaving)) return false;
  if (t.leaving.includes(id)) t.leaving = t.leaving.filter((x) => x !== id); // asked to stay, in its own seat
  else if (freeSeats(t).includes(seat)) {
    t.joining.push(id);
    t.slots[id] = seat;
  } else return false;
  say(t, id, persona.hello[0], [], DEPTH);
  return true;
}

// An AI player gives up its seat after this hand (at once if it has not sat
// down yet), and says goodbye. False for a person, or for the last player
// left to play against.
function removePlayer(t, id) {
  if (isPerson(id) || !playing(t).some((p) => p.id === id) || playing(t).length < 2) return false;
  if (t.joining.includes(id)) {
    t.joining = t.joining.filter((x) => x !== id);
    delete t.slots[id];
  } else t.leaving.push(id);
  say(t, id, PERSONAS.find((p) => p.id === id).bye, [], DEPTH);
  return true;
}

// A person leaves between hands: their chips go back to their bankroll.
// The host keeps the seat, to buy in again; a friend gives it up.
function leave(t, id) {
  if (seatOf(t, id) < 0) { // a friend not yet dealt in
    t.joining = t.joining.filter((x) => x !== id);
    delete t.slots[id];
    delete t.topUp[id];
    return;
  }
  if (t.hand) t.hand.seats[seatOf(t, id)].stack = 0;
  t.players[seatOf(t, id)].stack = 0;
  delete t.topUp[id];
  if (id !== HUMAN) t.leaving.push(id);
}

// The next hand, its hole cards from `cards`. An AI player out of chips
// buys back in for STACK first; people buy in themselves, and one with no
// chips sits the hand out. With no person to play, there is no hand.
function deal(t, cards) {
  t.dealing = false;
  t.dealAt = 0;
  t.deals++;
  const before = (t.hand ? t.hand.seats : t.players).map(({ id, stack }) => ({ id, stack }));
  for (const id of t.leaving) delete t.slots[id];
  const players = [...before.filter((p) => !t.leaving.includes(p.id)), ...t.joining.map((id) => ({ id, stack: isPerson(id) ? 0 : STACK }))]
    .sort((a, b) => t.slots[a.id] - t.slots[b.id]);
  // the button stays with its player or, if that player left, with the nearest one before it still here
  const at = t.button;
  t.button = -1;
  for (let k = at; k >= 0 && t.button < 0; k--) t.button = players.findIndex((p) => p.id === before[k]?.id);
  t.joining = [];
  t.leaving = [];
  for (const p of players) p.stack += t.topUp[p.id] ?? 0;
  t.topUp = {};
  t.players = players;
  if (!players.some((p) => isPerson(p.id) && p.stack)) {
    t.hand = null; // the seats are the players' now, for the next hand once someone buys in
    return;
  }
  for (const p of players) {
    if (p.stack || isPerson(p.id)) continue;
    p.stack = STACK;
    say(t, DEALER, `${p.id} buys back in for $${STACK.toLocaleString('en')}.`, [], DEPTH);
  }
  t.handNo++;
  t.hand = startHand({ id: t.handNo, players, button: t.button, blinds: BLINDS, deck: cards });
  t.button = t.hand.button;
}

// ---- what a player is shown ----

// The reactions anyone may send: an emoji shown by their face a moment.
export const REACTIONS = ['😂', '😮', '😤', '👍', '👏', '🔥'];

const RULES = `You are a player at a No-Limit Texas Hold'em table, playing for play money only (amounts are play dollars, no real money). Two to six seats: people, and AI players, who may come and go between hands. Blinds are $${BLINDS[0]}/$${BLINDS[1]}; you sit with $${STACK}, and buy back in for $${STACK} when you lose it all.

The rules, in short: each player gets two private cards. Betting goes round on four streets: preflop, then the flop (three shared cards on the board), the turn (one more), the river (one more). On your turn you may fold; check if there is nothing to call; call; or bet / raise, which in this game is always to a total for this street ("raise to 120"), at least the last raise more than the current bet, or all in. When one player is left, they win the pot; otherwise the best five-card hand from each player's two cards and the board wins at the showdown, and side pots go to those who could match the bets. A dealer runs the game and checks every action: one that is not legal, or comes after the table moved on, is turned away and you are asked again.

You see what anyone at the table sees, plus your own two cards. Nobody's cards are shown until a showdown. You also see the table's chat.

You are woken when it is your turn, when someone talks to you (or the person talks to the whole table), or once after a big hand. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences. No one sees it during the hand; afterwards the person may read it.
- action: only when it is your turn, and then always. { "type": "fold" | "check" | "call" | "bet" | "raise" | "allin", "amount": the total for the street, only for bet and raise }.
- say: optional, one short line to the table in your own voice, under 20 words. Leave it out when told to stay quiet, or when you would have nothing to say. At most one of you usually answers the person, and a reply needs no reply. Talk only in your own voice: never take up another player's pet names or catchphrases. A person with no name is "the person": speak to them as "you". You may bluff in what you say, but never claim to see others' cards.
- react: optional, one emoji shown by your face for a moment, as players react at a real table: ${REACTIONS.join(' ')}. Use it freely, with or without a line, when a moment calls for one: a big raise, a bluff, a bad beat, someone winning a pot, a good line in the chat. How often is your character's.

Play to win chips, as yourself. Be quick.`;

// The tool the model answers with, as INFER (agents/ponjo-core.mjs) takes tools.
export const DECIDE = {
  name: 'decide',
  description: 'Your private thinking, your action when it is your turn, and optionally a line to the table and a reaction.',
  parameters: {
    type: 'object',
    properties: {
      thinking: { type: 'string', description: 'Private reasoning, one to three short sentences.' },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise', 'allin'] },
          amount: { type: 'integer', description: 'For bet and raise: the total for this street.' },
        },
        required: ['type'],
      },
      say: { type: 'string', description: 'One short line to the table, or left out.' },
      react: { type: 'string', enum: REACTIONS, description: 'One emoji shown by your face a moment, or left out.' },
    },
    required: ['thinking'],
  },
};

// The model's answer as a change's body: { action, say, react, thinking }, each if any.
export function decided(args) {
  const a = args?.action && typeof args.action === 'object' ? args.action : null;
  return {
    thinking: String(args?.thinking ?? ''),
    ...(a ? { action: { type: String(a.type), ...(Number.isInteger(a.amount) ? { amount: a.amount } : {}) } } : {}),
    ...(typeof args?.say === 'string' && args.say.trim() ? { say: args.say } : {}),
    ...(REACTIONS.includes(args?.react) ? { react: args.react } : {}),
  };
}

const cardsText = (cards) => (cards?.length ? cards.join(' ') : '—');

function actionText(c, a, me) {
  const by = a.seat === me ? 'you' : nameOf(c, c.hand.seats[a.seat].id);
  if (a.type === 'uncalled') return `${a.amount} uncalled returned to ${by}`;
  if (a.type.endsWith('blind')) return `${by} post${by === 'you' ? '' : 's'} the ${a.type} ${a.amount}`;
  return `${by} ${a.type}${a.type === 'bet' || a.type === 'raise' ? (a.type === 'raise' ? ' to ' : ' ') + a.amount : a.type === 'call' ? ` ${a.amount}` : ''}${a.allIn ? ' (all in)' : ''}`;
}

/**
 * What AI player `id` is shown, from its `view` alone, so another player's
 * cards can reach it only once shown: the rules and its own style, then
 * the table as its seat sees it, and what its tasks ask. Returns { rules,
 * situation }; the rules stay the same run to run, so they cache.
 */
export function prompt({ content: c, tasks, rules: how }, id) {
  const persona = PERSONAS.find((p) => p.id === id);
  const rules = `${how}\n\nYou are ${id}. ${persona.style}`;
  const parts = [];
  const v = c.hand;
  const turn = tasks.some((t) => t.given.startsWith('turn:'));
  if (v) {
    const me = v.seats.findIndex((s) => s.id === id);
    const who = (i) => (i === me ? 'you' : nameOf(c, v.seats[i].id));
    const order = v.seats.map((_, k) => (v.button + 1 + k) % v.seats.length);
    parts.push(`Hand ${v.id}. Street: ${v.street === 'done' ? 'the hand is over' : v.street}. Board: ${cardsText(v.board)}. Pot: ${v.pot}.`);
    parts.push(['Seats, from the small blind round to the button:', ...order.map((i) => {
      const s = v.seats[i];
      const tags = [i === v.button && 'button', !s.inHand && 'sitting out, no chips', s.folded && 'folded', s.allIn && 'all in'].filter(Boolean);
      return `- ${i === me ? `${id} (you)` : nameOf(c, s.id)}: stack ${s.stack}, bet this street ${s.bet}${tags.length ? `, ${tags.join(', ')}` : ''}${s.hole ? `, cards ${cardsText(s.hole)}` : ''}`;
    })].join('\n'));
    const streets = ['preflop', 'flop', 'turn', 'river', 'done'];
    parts.push(['Actions this hand:', ...streets.map((st) => {
      const done = v.actions.filter((a) => a.street === st).map((a) => actionText(c, a, me));
      return done.length ? `- ${st === 'done' ? 'end' : st}: ${done.join('; ')}` : null;
    }).filter(Boolean)].join('\n'));
    if (v.result) {
      parts.push(['Result:', ...v.result.pots.map((p, k) => `- ${k ? `side pot ${k}` : 'pot'} ${p.amount} to ${p.winners.map(who).join(' and ')}`),
        ...Object.entries(v.result.hands).map(([i, h]) => `- ${who(Number(i))} showed ${cardsText(v.seats[i].hole)}: ${h.name}`)].join('\n'));
    }
    const mine = c.thoughts[id] ?? [];
    if (mine.length) parts.push(['Your own earlier thinking this hand:', ...mine.map((t) => `- ${t.street}: ${t.text}`)].join('\n'));
    if (turn && c.legal) {
      const refused = tasks.find((t) => t.refused)?.refused;
      parts.push(`It is your turn. To call: ${c.legal.toCall}. You may: ${describeLegal(c.legal, v.currentBet)}.${refused ? `\nYour last action was turned away: ${refused}` : ''}`);
    }
  }
  const reactions = c.reactions.filter((r) => r.hand === (v?.id ?? 0)).slice(-8);
  if (reactions.length) parts.push(`Reactions this hand, latest last: ${reactions.map((r) => `${r.by === id ? `${id} (you)` : nameOf(c, r.by)} ${r.emoji}`).join(', ')}.`);
  if (c.chat.length) parts.push(['The chat, latest last:', ...c.chat.map((l) => `- ${l.by === id ? `${id} (you)` : nameOf(c, l.by)}: ${l.text}`)].join('\n'));
  const lines = tasks.filter((t) => t.given.startsWith('line:'));
  const why = [
    turn && 'it is your turn: decide your action',
    lines.length && `${lines.map((t) => t.why).join(', and ')}${turn ? '' : ' (it is not your turn: no action, only say, if anything)'}`,
    tasks.some((t) => t.given.startsWith('react:')) && !turn && 'a big hand just ended: say something only if it is worth it, no action',
  ].filter(Boolean);
  parts.push(`Why you are woken: ${why.join('; ')}.${talks(id, tasks) ? '' : ' Stay quiet this time: no say (a reaction is fine).'}`);
  return { rules, situation: parts.join('\n\n') };
}
