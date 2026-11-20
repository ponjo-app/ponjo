// The poker page's runtime (site/poker.html), the way Ponjo's buddies run
// (docs/agent-runtime.md), small: one table everyone shares, with a change
// log; `plan`, which looks at the table and says which players are due, never
// acting on an event itself; `prompt`, what a player is shown; and `land`,
// the one writer, which lands proposals in order and turns away a stale or
// illegal action. Pure but for `table`, which `land` and `say` change; the
// page (preview/poker.js) runs the model and draws the table.

import { act, describeLegal, startHand, view } from './poker-dealer.js';

export const HUMAN = 'you';
export const BLINDS = [10, 20];
export const STACK = 1000;
const MAX_SAY = 240; // characters of a line at the table
const MAX_TRIES = 3; // proposals turned away on one turn before the dealer folds or checks for the player
const CHAT_SHOWN = 24; // latest lines a prompt has
const DEPTH = 2; // a line this deep in replies wakes no one: nobody replies to a reply forever
export const MAX_SEATS = 6;

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
// Seat numbers go round the table from the person's, 0: six seats, a player keeps its own.

// A new table: the person, who sits down with `buyIn` from their bankroll,
// and `ids`' players with STACK each. Players come and go between hands:
// `joining` take a seat when the next hand is dealt, `leaving` give theirs up.
// People, the person (HUMAN) and any friends, buy chips: `topUp` holds what
// each added since the hand began; one with none sits a hand out. `names`:
// the friends' names; the person has none.
export function newTable(buyIn = STACK, ids = FIRST) {
  const players = [{ id: HUMAN, stack: buyIn }, ...ids.map((id) => ({ id, stack: STACK }))];
  const slots = Object.fromEntries([[HUMAN, 0], ...ids.map((id, k) => [id, ids.length === 3 ? 2 * k + 1 : k + 1])]);
  return { rev: 0, log: [], players, slots, names: {}, hand: null, handNo: 0, button: -1, topUp: {}, joining: [], leaving: [], chat: [], notes: Object.fromEntries(PERSONAS.map(({ id }) => [id, note()])) };
}
export const isPerson = (id) => !PERSONAS.some((p) => p.id === id);

// The seats no one has, or will have at the next hand.
export const freeSeats = (table) => [...Array(MAX_SEATS).keys()].filter((k) => !lineup(table).some((p) => table.slots[p.id] === k)); // a leaving player's seat is its own till the hand ends

// Who is at the table, in seat order, as it is drawn: the hand's seats (or
// the players before the first hand), then those joining: [{ id, joining, leaving }].
export const lineup = (table) => [
  ...(table.hand ? table.hand.seats : table.players).map(({ id }) => ({ id, joining: false, leaving: table.leaving.includes(id) })),
  ...table.joining.map((id) => ({ id, joining: true, leaving: false })),
];
const playing = (table) => lineup(table).filter((p) => p.id !== HUMAN && !p.leaving); // whom the person plays against

// A player takes a seat at the next hand, and says hello. False if there
// is no free seat, or it is already at the table.
export function addPlayer(table, id, seat = freeSeats(table)[0]) {
  const persona = PERSONAS.find((p) => p.id === id);
  if (!persona || lineup(table).some((p) => p.id === id && !p.leaving)) return false;
  if (table.leaving.includes(id)) table.leaving = table.leaving.filter((x) => x !== id); // asked to stay, in its own seat
  else if (freeSeats(table).includes(seat)) {
    table.joining.push(id);
    table.slots[id] = seat;
  } else return false;
  commit(table, { type: 'join', by: id });
  say(table, id, persona.hello[0], { depth: DEPTH });
  return true;
}

// A friend takes `seat` at the next hand, as `name`, with `buyIn` from their
// bankroll. False if the seat is taken, or they are at the table.
export function seatFriend(table, id, name, seat, buyIn) {
  if (!isPerson(id) || lineup(table).some((p) => p.id === id) || !freeSeats(table).includes(seat)) return false;
  table.joining.push(id);
  table.slots[id] = seat;
  table.names[id] = name;
  table.topUp[id] = buyIn;
  commit(table, { type: 'join', by: id });
  return true;
}

// A player gives up its seat after this hand (at once if it has not sat
// down yet), and says goodbye. False for the person, or for the last player
// left to play against.
export function removePlayer(table, id) {
  if (isPerson(id) || !playing(table).some((p) => p.id === id) || playing(table).length < 2) return false;
  if (table.joining.includes(id)) {
    table.joining = table.joining.filter((x) => x !== id);
    delete table.slots[id];
  } else table.leaving.push(id);
  commit(table, { type: 'part', by: id });
  say(table, id, PERSONAS.find((p) => p.id === id).bye, { depth: DEPTH });
  return true;
}
const note = () => ({ chatSeen: 0, reactSeen: 0, tries: 0, triesKey: '', rejected: '', failed: null, thoughts: [] });

// Every change lands here: a revision, a line in the log.
function commit(table, change) {
  table.rev++;
  table.log.push({ rev: table.rev, ...change });
}

const seatOf = (table, id) => table.players.findIndex((p) => p.id === id);
const turnKey = (hand) => `${hand.id}:${hand.n}`;
export const nameOf = (table, id) => (isPerson(id) ? table.names[id] ?? 'the person' : id);
const names = (table, text) => [...PERSONAS.map(({ id }) => id), ...Object.keys(table.names)].filter((id) => new RegExp(`\\b${nameOf(table, id).replace(/\W/g, '\\$&')}\\b`, 'i').test(text));

// A person's chips now, with what they added since the hand began.
export function myChips(table, id = HUMAN) {
  const seat = seatOf(table, id);
  return (seat < 0 ? 0 : (table.hand ? table.hand.seats : table.players)[seat].stack) + (table.topUp[id] ?? 0);
}

// More chips for a person, from their bankroll: they land before the next hand, as at a real table.
export function topUp(table, amount, id = HUMAN) {
  table.topUp[id] = (table.topUp[id] ?? 0) + amount;
  commit(table, { type: 'topup', by: id, amount });
}

// A person leaves between hands: their chips go back to their bankroll.
// The person keeps the seat, to buy in again; a friend gives it up. Returns how many.
export function leave(table, id = HUMAN) {
  const amount = myChips(table, id);
  const seat = seatOf(table, id);
  if (seat < 0) { // a friend not yet dealt in
    table.joining = table.joining.filter((x) => x !== id);
    delete table.slots[id];
    delete table.topUp[id];
    commit(table, { type: 'leave', by: id, amount });
    return amount;
  }
  if (table.hand) table.hand.seats[seat].stack = 0;
  table.players[seat].stack = 0;
  delete table.topUp[id];
  if (id !== HUMAN) table.leaving.push(id);
  commit(table, { type: 'leave', by: id, amount });
  return amount;
}

// The next hand. An AI player out of chips buys back in for STACK first;
// people buy in themselves, and one with no chips sits the hand out. With
// no person to play, or no one to play against, there is no hand.
export function deal(table, deck) {
  const before = (table.hand ? table.hand.seats : table.players).map(({ id, stack }) => ({ id, stack }));
  for (const id of table.leaving) delete table.slots[id];
  const players = [...before.filter((p) => !table.leaving.includes(p.id)), ...table.joining.map((id) => ({ id, stack: isPerson(id) ? 0 : STACK }))]
    .sort((a, b) => table.slots[a.id] - table.slots[b.id]);
  // the button stays with its player or, if that player left, with the nearest one before it still here
  const at = table.button;
  table.button = -1;
  for (let k = at; k >= 0 && table.button < 0; k--) table.button = players.findIndex((p) => p.id === before[k]?.id);
  table.joining = [];
  table.leaving = [];
  for (const p of players) p.stack += table.topUp[p.id] ?? 0;
  table.topUp = {};
  if (!players.some((p) => isPerson(p.id) && p.stack)) {
    table.players = players;
    table.hand = null; // the seats are the players' now, for the next hand once someone buys in
    return false;
  }
  for (const p of players) {
    if (p.stack || isPerson(p.id)) continue;
    p.stack = STACK;
    commit(table, { type: 'rebuy', by: p.id, amount: STACK });
  }
  table.handNo++;
  table.hand = startHand({ id: table.handNo, players, button: table.button, blinds: BLINDS, deck });
  table.button = table.hand.button;
  table.players = players;
  commit(table, { type: 'deal', hand: table.handNo });
  return true;
}

// A big hand, which every player may react to once: an all-in, or a pot of 15 big blinds.
export const isBig = (hand) => hand?.street === 'done' && (hand.actions.some((a) => a.allIn) || hand.seats.reduce((sum, s) => sum + s.total, 0) >= 15 * hand.bb);

/**
 * Who is due now, and why: [{ id, turn, lines, react }]. `turn`: it is its
 * turn; `lines`: the chat lines that concern it since its last look; `react`:
 * a big hand just ended. `running` is the ids with a run going, never due.
 */
export function plan(table, running = new Set()) {
  const hand = table.hand;
  return table.players.flatMap(({ id }) => {
    if (isPerson(id) || running.has(id)) return [];
    const n = table.notes[id];
    const seat = seatOf(table, id);
    const turn = hand?.street !== 'done' && hand?.toAct === seat && n.failed?.key !== turnKey(hand);
    const lines = table.chat.slice(n.chatSeen).filter((line) => concerns(line, id));
    const react = isBig(hand) && n.reactSeen !== hand.id && !n.failed && after(hand).includes(seat);
    return turn || lines.length || react ? [{ id, turn, lines, react }] : [];
  });
}

// Who has a word after a big hand: two AI players, the winner first, then those still in at the end.
const after = (hand) => {
  const won = hand.result.won.findIndex(Boolean);
  return [won, ...[...hand.seats.keys()].filter((i) => i !== won && hand.seats[i].inHand && !hand.seats[i].folded)].filter((i) => i > 0).slice(0, 2);
};

// A line concerns a player when it names the player, or when the person says it to the whole table.
function concerns(line, id) {
  if (line.by === id || line.by === 'dealer' || line.depth >= DEPTH) return false;
  return line.to.includes(id) || (isPerson(line.by) && !line.to.length);
}

// A run begins: what it was given counts as seen, as a buddy's run marks the comments it was given.
// `talk`: whether it may say something this time. Always when the person
// spoke to it or after a big hand; else as often as its character talks (`roll` < talk).
export function begin(table, id, due, roll = Math.random()) {
  const n = table.notes[id];
  n.chatSeen = table.chat.length;
  if (due.react) n.reactSeen = table.hand.id;
  n.failed = null;
  const talk = due.react || due.lines.some((l) => isPerson(l.by)) || roll < PERSONAS.find((p) => p.id === id).talk;
  return { hand: table.hand?.id ?? 0, n: table.hand?.n ?? 0, street: table.hand?.street ?? '', turn: due.turn, about: due.lines.at(-1)?.id ?? null, react: due.react, talk };
}

// A run failed (the model could not be reached): nothing lands; it waits for Retry.
export function fail(table, id, basis, why) {
  table.notes[id].failed = { key: basis.turn ? `${basis.hand}:${basis.n}` : 'chat', why };
  commit(table, { type: 'failed', by: id, why });
}
export function retry(table, id) {
  table.notes[id].failed = null;
  commit(table, { type: 'retry', by: id });
}

// The players at the table say hello when the person first sits down, each
// its first line in seat order, then any more: lines written for them, so they wake no one.
export const intros = (table) => {
  const here = playing(table).filter((p) => !isPerson(p.id)).map(({ id }) => PERSONAS.find((p) => p.id === id));
  return [...here.map((p) => [p.id, p.hello[0]]), ...here.flatMap((p) => p.hello.slice(1).map((text) => [p.id, text]))];
};
export const introduce = (table, [id, text]) => say(table, id, text, { depth: DEPTH });

// The reactions anyone may send: an emoji shown by their face a moment.
export const REACTIONS = ['😂', '😮', '😤', '👍', '👏', '🔥'];
export function react(table, by, emoji) {
  if (!REACTIONS.includes(emoji)) return false;
  commit(table, { type: 'react', by, emoji, hand: table.hand?.id ?? 0 });
  return true;
}

// A line of chat, by the person, a player or the dealer.
export function say(table, by, text, { depth = 0, about = null } = {}) {
  const body = String(text).trim().slice(0, MAX_SAY);
  if (!body) return null;
  const line = { id: table.chat.length + 1, by, text: body, to: by === 'dealer' ? [] : names(table, body).filter((n) => n !== by), depth, about, hand: table.hand?.id ?? 0 };
  table.chat.push(line);
  commit(table, { type: 'chat', by, line: line.id });
  return line;
}

/**
 * The writer: lands `id`'s proposal { action, say, thinking }, made on
 * `basis` (what `begin` gave its run), or turns it away. An action lands
 * only if the player is still to act on the very state its run saw, and the
 * dealer says it is legal; turned away, the player is asked again on the
 * table as it is, told why, up to MAX_TRIES, and then the dealer checks or
 * folds for it. A line lands unless it answers a line of the person's to the
 * whole table that another player has answered already, so the table settles.
 * Returns { landed, rejected }.
 */
export function land(table, id, basis, proposal) {
  const hand = table.hand;
  const seat = seatOf(table, id);
  const n = table.notes[id];
  const { action = null, thinking = '' } = proposal;
  if (thinking && !isPerson(id)) n.thoughts.push({ hand: basis.hand, street: basis.street, text: String(thinking), action: action && { ...action } });
  let rejected = null;
  let landed = false;
  const live = hand && hand.id === basis.hand && hand.street !== 'done';
  if (action || (basis.turn && live && hand.toAct === seat)) {
    if (!live || hand.n !== basis.n || hand.toAct !== seat) rejected = 'stale: the table moved on before your action landed.';
    else if (!action) rejected = 'it is your turn and you gave no action.';
    else {
      const out = act(hand, seat, action);
      if (out.error) rejected = out.error;
      else {
        table.hand = out.hand;
        landed = true;
        commit(table, { type: 'action', by: id, hand: hand.id, action: out.hand.actions[hand.actions.length] }); // after it, the dealer may add an uncalled bet returned
      }
    }
  }
  if (rejected && !isPerson(id)) {
    commit(table, { type: 'rejected', by: id, why: rejected });
    const still = table.hand?.street !== 'done' && table.hand?.toAct === seat;
    const key = still ? turnKey(table.hand) : '';
    n.tries = n.triesKey === key ? n.tries + 1 : 1;
    n.triesKey = key;
    n.rejected = still ? `Your last action was turned away: ${rejected}` : '';
    if (still && n.tries >= MAX_TRIES) {
      force(table, id);
      n.rejected = '';
    }
  } else if (landed && n) {
    n.rejected = '';
  }
  if (proposal.react) react(table, id, proposal.react);
  const text = proposal.say;
  if (typeof text === 'string' && text.trim() && basis.talk !== false) {
    const about = basis.about ? table.chat[basis.about - 1] : null;
    const answered = about && isPerson(about.by) && !about.to.includes(id) && table.chat.some((l) => l.about === about.id && !isPerson(l.by));
    if (!answered) say(table, id, text, { depth: about ? about.depth + 1 : 1, about: about?.id ?? null });
  }
  return { landed, rejected };
}

// The dealer checks, or else folds, for `id` on its turn: an AI player turned
// away too often, or a person whose time ran out.
export function force(table, id) {
  const before = table.hand;
  const seat = seatOf(table, id);
  if (before?.street === 'done' || before?.toAct !== seat) return;
  table.hand = act(before, seat, { type: 'check' }).hand ?? act(before, seat, { type: 'fold' }).hand;
  commit(table, { type: 'action', by: id, hand: before.id, action: table.hand.actions[before.actions.length], forced: true });
}

// ---- what a player is shown ----

export const RULES = `You are a player at a No-Limit Texas Hold'em table, playing for play money only (amounts are play dollars, no real money). Two to six seats: people, and AI players, who may come and go between hands. Blinds are $${BLINDS[0]}/$${BLINDS[1]}; you sit with $${STACK}, and buy back in for $${STACK} when you lose it all.

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

const cardsText = (cards) => (cards?.length ? cards.join(' ') : '—');
const who = (table, seat, me) => (seat === me ? 'you' : nameOf(table, table.hand.seats[seat].id));

function actionText(table, a, me) {
  const by = who(table, a.seat, me);
  if (a.type === 'uncalled') return `${a.amount} uncalled returned to ${by}`;
  if (a.type.endsWith('blind')) return `${by} post${by === 'you' ? '' : 's'} the ${a.type} ${a.amount}`;
  return `${by} ${a.type}${a.type === 'bet' || a.type === 'raise' ? (a.type === 'raise' ? ' to ' : ' ') + a.amount : a.type === 'call' ? ` ${a.amount}` : ''}${a.allIn ? ' (all in)' : ''}`;
}

/**
 * What player `id` is shown for a run woken by `due`: the rules and its own
 * style, then the situation, built only from the dealer's `view` for its
 * seat, so another player's cards can reach it only once shown. Returns
 * { rules, situation }; the rules stay the same run to run, so they cache.
 */
export function prompt(table, id, due, talk = true) {
  const me = seatOf(table, id);
  const persona = PERSONAS.find((p) => p.id === id);
  const rules = `${RULES}\n\nYou are ${id}. ${persona.style}`;
  const parts = [];
  const hand = table.hand;
  if (hand) {
    const v = view(hand, me);
    const order = v.seats.map((_, k) => (v.button + 1 + k) % v.seats.length);
    parts.push(`Hand ${v.id}. Street: ${v.street === 'done' ? 'the hand is over' : v.street}. Board: ${cardsText(v.board)}. Pot: ${v.pot}.`);
    parts.push(['Seats, from the small blind round to the button:', ...order.map((i) => {
      const s = v.seats[i];
      const tags = [i === v.button && 'button', !s.inHand && 'sitting out, no chips', s.folded && 'folded', s.allIn && 'all in'].filter(Boolean);
      return `- ${i === me ? `${id} (you)` : nameOf(table, s.id)}: stack ${s.stack}, bet this street ${s.bet}${tags.length ? `, ${tags.join(', ')}` : ''}${s.hole ? `, cards ${cardsText(s.hole)}` : ''}`;
    })].join('\n'));
    const streets = ['preflop', 'flop', 'turn', 'river', 'done'];
    parts.push(['Actions this hand:', ...streets.map((st) => {
      const done = v.actions.filter((a) => a.street === st).map((a) => actionText(table, a, me));
      return done.length ? `- ${st === 'done' ? 'end' : st}: ${done.join('; ')}` : null;
    }).filter(Boolean)].join('\n'));
    if (v.result) {
      parts.push(['Result:', ...v.result.pots.map((p, k) => `- ${k ? `side pot ${k}` : 'pot'} ${p.amount} to ${p.winners.map((i) => who(table, i, me)).join(' and ')}`),
        ...Object.entries(v.result.hands).map(([i, h]) => `- ${who(table, Number(i), me)} showed ${cardsText(v.seats[i].hole)}: ${h.name}`)].join('\n'));
    }
    const mine = table.notes[id].thoughts.filter((t) => t.hand === v.id);
    if (mine.length) parts.push(['Your own earlier thinking this hand:', ...mine.map((t) => `- ${t.street}: ${t.text}`)].join('\n'));
    if (due.turn) {
      const l = describeLegal(hand, me);
      parts.push(`It is your turn. To call: ${hand.currentBet - hand.seats[me].bet}. You may: ${l}.${table.notes[id].rejected ? `\n${table.notes[id].rejected}` : ''}`);
    }
  }
  const reactions = table.log.filter((c) => c.type === 'react' && c.hand === (hand?.id ?? 0)).slice(-8);
  if (reactions.length) parts.push(`Reactions this hand, latest last: ${reactions.map((c) => `${c.by === id ? `${id} (you)` : nameOf(table, c.by)} ${c.emoji}`).join(', ')}.`);
  const chat = table.chat.slice(-CHAT_SHOWN);
  if (chat.length) parts.push(['The chat, latest last:', ...chat.map((l) => `- ${l.by === id ? `${id} (you)` : l.by === 'dealer' ? 'Dealer' : nameOf(table, l.by)}: ${l.text}`)].join('\n'));
  const why = [
    due.turn && 'it is your turn: decide your action',
    due.lines.length && `${due.lines.map((l) => `${nameOf(table, l.by)} said "${l.text}"`).join(', and ')}${due.turn ? '' : ' (it is not your turn: no action, only say, if anything)'}`,
    due.react && !due.turn && 'a big hand just ended: say something only if it is worth it, no action',
  ].filter(Boolean);
  parts.push(`Why you are woken: ${why.join('; ')}.${talk ? '' : ' Stay quiet this time: no say (a reaction is fine).'}`);
  return { rules, situation: parts.join('\n\n') };
}
