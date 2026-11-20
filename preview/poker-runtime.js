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

export const PERSONAS = [
  {
    id: 'Gary',
    style: 'You are a tourist on holiday who wandered into the casino for fun. You barely know the strategy: you play almost every hand, call far too much, raise on a whim (a lucky feeling, pretty cards, your birthday), and hate to fold. Cheerful and chatty: you celebrate tiny wins, ask the table naive questions, and say what you hold out loud by mistake now and then.',
  },
  {
    id: 'Duke',
    style: 'You are rude, cocky and aggressive. You raise and re-raise a lot, bully short stacks and go all in to make people sweat. You talk trash with nearly every action, unprompted: mock a fold, needle whoever is winning, brag about pots you took, taunt the person to call you. Keep it playful-mean table banter: no slurs, no swearing, nothing about anyone\'s real life.',
  },
  {
    id: 'Penny',
    style: 'You are careful and calculating: every chip counts. You fold weak hands, call only with the right pot odds, bet your strong hands for value and rarely bluff. You talk little, and when you do it is dry and precise: the price of a call, the pot odds, a quick count of outs.',
  },
];

// A new table: the person, who sits down with `buyIn` from their bankroll,
// and the three players with STACK each.
export function newTable(buyIn = STACK) {
  const players = [{ id: HUMAN, stack: buyIn }, ...PERSONAS.map(({ id }) => ({ id, stack: STACK }))];
  return { rev: 0, log: [], players, hand: null, handNo: 0, button: -1, topUp: 0, chat: [], notes: Object.fromEntries(PERSONAS.map(({ id }) => [id, note()])) };
}
const note = () => ({ chatSeen: 0, reactSeen: 0, tries: 0, triesKey: '', rejected: '', failed: null, thoughts: [] });

// Every change lands here: a revision, a line in the log.
function commit(table, change) {
  table.rev++;
  table.log.push({ rev: table.rev, ...change });
}

const seatOf = (table, id) => table.players.findIndex((p) => p.id === id);
const turnKey = (hand) => `${hand.id}:${hand.n}`;
const nameOf = (id) => (id === HUMAN ? 'the person' : id);
const names = (text) => PERSONAS.filter(({ id }) => new RegExp(`\\b${id}\\b`, 'i').test(text)).map(({ id }) => id);

// The person's chips now, with what they added since the hand began.
export const myChips = (table) => (table.hand ? table.hand.seats[0].stack : table.players[0].stack) + table.topUp;

// More chips for the person, from their bankroll: they land before the next hand, as at a real table.
export function topUp(table, amount) {
  table.topUp += amount;
  commit(table, { type: 'topup', amount });
}

// The person leaves between hands: their chips go back to their bankroll. Returns how many.
export function leave(table) {
  const amount = myChips(table);
  if (table.hand) table.hand.seats[0].stack = 0;
  table.players[0].stack = 0;
  table.topUp = 0;
  commit(table, { type: 'leave', amount });
  return amount;
}

// The next hand. A player out of chips buys back in for STACK first; the
// person must buy in themselves, so with no chips there is no hand.
export function deal(table, deck) {
  const players = (table.hand ? table.hand.seats : table.players).map(({ id, stack }) => ({ id, stack }));
  players[0].stack += table.topUp;
  table.topUp = 0;
  if (!players[0].stack) {
    table.players = players;
    return false;
  }
  for (const p of players.slice(1)) {
    if (p.stack) continue;
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
  return PERSONAS.flatMap(({ id }) => {
    if (running.has(id)) return [];
    const n = table.notes[id];
    const seat = seatOf(table, id);
    const turn = hand?.street !== 'done' && hand?.toAct === seat && n.failed?.key !== turnKey(hand);
    const lines = table.chat.slice(n.chatSeen).filter((line) => concerns(line, id));
    const react = isBig(hand) && n.reactSeen !== hand.id && !n.failed;
    return turn || lines.length || react ? [{ id, turn, lines, react }] : [];
  });
}

// A line concerns a player when it names the player, or when the person says it to the whole table.
function concerns(line, id) {
  if (line.by === id || line.by === 'dealer' || line.depth >= DEPTH) return false;
  return line.to.includes(id) || (line.by === HUMAN && !line.to.length);
}

// A run begins: what it was given counts as seen, as a buddy's run marks the comments it was given.
export function begin(table, id, due) {
  const n = table.notes[id];
  n.chatSeen = table.chat.length;
  if (due.react) n.reactSeen = table.hand.id;
  n.failed = null;
  return { hand: table.hand?.id ?? 0, n: table.hand?.n ?? 0, street: table.hand?.street ?? '', turn: due.turn, about: due.lines.at(-1)?.id ?? null, react: due.react };
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

// The players say hello when the person first sits down, in this order:
// lines written for them, so they wake no one.
export const INTROS = [
  ['Gary', 'Hi folks! Gary, first time at a real table. My wife is at the slots.'],
  ['Duke', 'Name\'s Duke. Sit down, empty your wallet, try not to cry.'],
  ['Penny', 'Penny. I count every chip, so don\'t expect gifts.'],
  ['Gary', 'Quick one: a flush is the all-same-colour thing, right?'],
];
export const introduce = (table, [id, text]) => say(table, id, text, { depth: DEPTH });

// A line of chat, by the person, a player or the dealer.
export function say(table, by, text, { depth = 0, about = null } = {}) {
  const body = String(text).trim().slice(0, MAX_SAY);
  if (!body) return null;
  const line = { id: table.chat.length + 1, by, text: body, to: by === 'dealer' ? [] : names(body).filter((n) => n !== by), depth, about, hand: table.hand?.id ?? 0 };
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
  if (thinking && id !== HUMAN) n.thoughts.push({ hand: basis.hand, street: basis.street, text: String(thinking), action: action && { ...action } });
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
  if (rejected && id !== HUMAN) {
    commit(table, { type: 'rejected', by: id, why: rejected });
    const still = table.hand?.street !== 'done' && table.hand?.toAct === seat;
    const key = still ? turnKey(table.hand) : '';
    n.tries = n.triesKey === key ? n.tries + 1 : 1;
    n.triesKey = key;
    n.rejected = still ? `Your last action was turned away: ${rejected}` : '';
    if (still && n.tries >= MAX_TRIES) {
      const before = table.hand;
      const fallback = act(before, seat, { type: 'check' }).hand ?? act(before, seat, { type: 'fold' }).hand;
      table.hand = fallback;
      n.rejected = '';
      commit(table, { type: 'action', by: id, hand: fallback.id, action: fallback.actions[before.actions.length], forced: true });
    }
  } else if (landed && n) {
    n.rejected = '';
  }
  const text = proposal.say;
  if (typeof text === 'string' && text.trim()) {
    const about = basis.about ? table.chat[basis.about - 1] : null;
    const answered = about && about.by === HUMAN && !about.to.includes(id) && table.chat.some((l) => l.about === about.id && l.by !== HUMAN);
    if (!answered) say(table, id, text, { depth: about ? about.depth + 1 : 1, about: about?.id ?? null });
  }
  return { landed, rejected };
}

// ---- what a player is shown ----

export const RULES = `You are a player at a No-Limit Texas Hold'em table, playing for play money only (amounts are play dollars, no real money). Four seats: a person, and three AI players: Gary, Duke and Penny. Blinds are $${BLINDS[0]}/$${BLINDS[1]}; you sit with $${STACK}, and buy back in for $${STACK} when you lose it all.

The rules, in short: each player gets two private cards. Betting goes round on four streets: preflop, then the flop (three shared cards on the board), the turn (one more), the river (one more). On your turn you may fold; check if there is nothing to call; call; or bet / raise, which in this game is always to a total for this street ("raise to 120"), at least the last raise more than the current bet, or all in. When one player is left, they win the pot; otherwise the best five-card hand from each player's two cards and the board wins at the showdown, and side pots go to those who could match the bets. A dealer runs the game and checks every action: one that is not legal, or comes after the table moved on, is turned away and you are asked again.

You see what anyone at the table sees, plus your own two cards. Nobody's cards are shown until a showdown. You also see the table's chat.

You are woken when it is your turn, when someone talks to you (or the person talks to the whole table), or once after a big hand. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences. No one sees it during the hand; afterwards the person may read it.
- action: only when it is your turn, and then always. { "type": "fold" | "check" | "call" | "bet" | "raise" | "allin", "amount": the total for the street, only for bet and raise }.
- say: optional, one short line to the table in your own voice, under 20 words. How often you talk is your character's; leave it out when you would have nothing to say. At most one of you usually answers the person, and a reply needs no reply. You may bluff in what you say, but never claim to see others' cards.

Play to win chips, as yourself. Be quick.`;

// The tool the model answers with, as INFER (agents/ponjo-core.mjs) takes tools.
export const DECIDE = {
  name: 'decide',
  description: 'Your private thinking, your action when it is your turn, and optionally a line to the table.',
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
    },
    required: ['thinking'],
  },
};

const cardsText = (cards) => (cards?.length ? cards.join(' ') : '—');
const who = (table, seat, me) => (seat === me ? 'you' : nameOf(table.hand.seats[seat].id));

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
export function prompt(table, id, due) {
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
      return `- ${i === me ? `${id} (you)` : nameOf(s.id)}: stack ${s.stack}, bet this street ${s.bet}${tags.length ? `, ${tags.join(', ')}` : ''}${s.hole ? `, cards ${cardsText(s.hole)}` : ''}`;
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
  const chat = table.chat.slice(-CHAT_SHOWN);
  if (chat.length) parts.push(['The chat, latest last:', ...chat.map((l) => `- ${l.by === id ? `${id} (you)` : l.by === 'dealer' ? 'Dealer' : nameOf(l.by)}: ${l.text}`)].join('\n'));
  const why = [
    due.turn && 'it is your turn: decide your action',
    due.lines.length && `${due.lines.map((l) => `${nameOf(l.by)} said "${l.text}"`).join(', and ')}${due.turn ? '' : ' (it is not your turn: no action, only say, if anything)'}`,
    due.react && !due.turn && 'a big hand just ended: say something only if it is worth it, no action',
  ].filter(Boolean);
  parts.push(`Why you are woken: ${why.join('; ')}.`);
  return { rules, situation: parts.join('\n\n') };
}
