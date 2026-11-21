// The spy table (site/spy.html) as a world for Ponjo's agent runtime
// (src/core/runtime.js, the contract; docs/agent-runtime.md), as the poker
// table is (poker-world.js): one table everyone shares, with a change log;
// who is asked (each AI player the rules say is due: the one whose clue it
// is, or everyone in a vote, at once); `prompt`, what a player is shown,
// built from its seat's `view` alone; and `land`, the one writer, which
// lands proposals in order and turns away a stale or illegal one, asking
// the player again, and after MAX_TRIES playing the rules' fallback. When
// the players run is the runtime's; the page (preview/spy.js) runs the model
// and draws the table.
//
// The people are the host (HUMAN), whose page holds the table, and any
// friends who joined it by a link; the AI players fill the seats left.

import { MAX_CLUE, deal, due, fallback, act, newGame, spiesFor, turn, view } from './spy-rules.js';

export const HUMAN = 'you';
export const MAX_PEOPLE = 8;
const MAX_TRIES = 3; // proposals turned away on one turn before the rules' fallback plays for the player
const THOUGHTS_SHOWN = 8; // a player's own latest thinking its prompt has

// Each AI player: who they are (`blurb`, shown on the page), how they talk
// and how they clue, what they do when they think they are the spy, and the
// line they greet the table with.
export const PERSONAS = [
  {
    id: 'Ivy',
    blurb: 'A crossword setter with cryptic clues',
    voice: 'You set crosswords for a living. Your clues are short, clever and a little cryptic, often wordplay or a double meaning, and you enjoy it when no one gets them.',
    play: 'You keep your clues just vague enough that only those who share your word will see it. You vote for whoever gave a clue that fits a different word.',
    spy: 'You give a clue so general it fits both words, and quietly agree with the most common reading.',
    hello: 'Ivy. Seven letters, "a liar among friends". Any guesses?',
  },
  {
    id: 'Max',
    blurb: 'A blunt coach who says too much',
    voice: 'You are a loud, blunt sports coach. Short sentences, no patience, the odd exclamation mark.',
    play: 'Your clues are too specific: you nearly give the word away. You vote fast for whoever sounds odd to you.',
    spy: 'You go on the attack: you name someone as the spy before anyone can look at you.',
    hello: 'Max. Let\'s get this done, people! Clues short, votes fast!',
  },
  {
    id: 'Juno',
    blurb: 'A drama student who performs everything',
    voice: 'You are a theatrical drama student. You speak in big, dramatic images, as if on stage.',
    play: 'Your clues paint a scene or a feeling, not a fact. You vote with your gut and say so with a flourish.',
    spy: 'You hide behind a mood: a clue all feeling and no fact, which could be either word.',
    hello: 'Juno! Darlings, a game of secrets. I was born for this.',
  },
  {
    id: 'Sam',
    blurb: 'A poker-faced accountant',
    voice: 'You are a dry, precise accountant. As few words as possible, no jokes.',
    play: 'Your clues are one or two flat words. You keep a tally of whose clue fits what, and vote on it.',
    spy: 'You give the flattest, safest clue you can, and vote with the majority.',
    hello: 'Sam. Let\'s keep this efficient.',
  },
  {
    id: 'Lou',
    blurb: 'A chatty chef who sees food in everything',
    voice: 'You are a warm, chatty chef. You relate everything to food, cooking and your kitchen.',
    play: 'Your clues come from the kitchen whenever they can. You trust people too easily and vote late.',
    spy: 'You change the subject to cooking, and agree loudly with whoever sounds sure.',
    hello: 'Lou here! If anyone needs a snack after, my kitchen\'s open.',
  },
  {
    id: 'Remy',
    blurb: 'A retired detective who suspects everyone',
    voice: 'You are a retired detective. You speak slowly, as if reading from a notebook ("Interesting. Noted.").',
    play: 'You weigh each clue against the others, then name your suspect with your reasons.',
    spy: 'You build a careful case against a civilian whose clue was a little off.',
    hello: 'Remy. Thirty years on the force. Somebody here is lying, and I will find them.',
  },
  {
    id: 'Pip',
    blurb: 'An excitable kid at heart',
    voice: 'You are bubbly and excitable, like a kid at a party. Lots of energy, simple words.',
    play: 'Your clues are what the thing is like in everyday life. You change your vote when someone convinces you.',
    spy: 'You copy the shape of the others\' clues and hope no one notices.',
    hello: 'Hi hi! Pip! I love this game! Is it my turn yet?',
  },
];
export const isPerson = (id) => !PERSONAS.some((p) => p.id === id);

/**
 * A new table: the host alone, before a game. `people` are the host and
 * the friends at the table, in the order they joined; `names` the friends'
 * names (the host's, once they give one). `game` is the rules' game once
 * one starts, with `players`, its seats' ids. Notes, per AI player: its
 * thinking, and how its last proposal went.
 */
export function newTable() {
  return { rev: 0, log: [], people: [HUMAN], names: {}, players: [], game: null, gameNo: 0, greeting: false, hellos: [], notes: {}, turnAt: '', turnKey: '', askedAt: {} };
}

// A time for an ask, each later than the last (the runtime tells asks apart by them).
let last = 0;
const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();

// Every change lands here: a revision, a line in the log. A change of turn is asked from then (`turnAt`).
function commit(table, change) {
  table.rev++;
  table.log.push({ rev: table.rev, ...change });
  const key = table.game ? `${table.gameNo}:${turn(table.game)}` : '';
  if (key !== table.turnKey) Object.assign(table, { turnKey: key, turnAt: stamp() });
}

const nameOf = (table, id) => (isPerson(id) ? table.names[id] ?? (id === HUMAN ? 'the host' : 'a friend') : id);
const seatOf = (table, id) => table.players.indexOf(id);
export const playing = (table) => Boolean(table.game) && table.game.phase !== 'over' && !table.greeting; // the game is on, past the hellos

// A friend joins the table, as `name`: they play from the next game. False if it is full, or they are here.
export function seatFriend(table, id, name) {
  if (!isPerson(id) || table.people.includes(id) || table.people.length >= MAX_PEOPLE) return false;
  table.people.push(id);
  table.names[id] = name;
  commit(table, { type: 'join', by: id });
  return true;
}

// A friend leaves. In a game, their seat plays on, each of its turns taken
// as doing nothing (`gone`, the page's); out of one, the seat is gone.
export function leave(table, id) {
  if (id === HUMAN || !table.people.includes(id)) return false;
  table.people = table.people.filter((p) => p !== id);
  commit(table, { type: 'leave', by: id });
  return true;
}

/**
 * A game of `size`: the people at the table first, then AI players, `ids`
 * or the first of PERSONAS, to fill the seats. `dealt` are the words and
 * sides, as the rules `deal` them. The players say hello first (`introduce`),
 * and the first clue is asked once the page says the hellos are over (`begin`).
 */
export function start(table, size, { ids, dealt = deal(size) } = {}) {
  const people = table.people.slice(0, size);
  const players = [...people, ...(ids ?? PERSONAS.map((p) => p.id)).slice(0, size - people.length)];
  table.players = players;
  table.game = newGame(dealt);
  table.gameNo++;
  Object.assign(table, { greeting: true, hellos: [], askedAt: {} });
  table.notes = Object.fromEntries(players.filter((id) => !isPerson(id)).map((id) => [id, { tries: 0, triesAt: '', rejected: '', thoughts: [] }]));
  commit(table, { type: 'start', size, spies: spiesFor(size) });
}

// The AI players' hellos, in seat order: lines written for them, so they wake no one.
export const intros = (table) => table.players.filter((id) => !isPerson(id)).map((id) => [id, PERSONAS.find((p) => p.id === id).hello]);
export function introduce(table, [id, text]) {
  table.hellos.push({ id, text });
  commit(table, { type: 'hello', by: id });
}
export function begin(table) {
  table.greeting = false;
  commit(table, { type: 'begin' });
}

/**
 * The writer: lands `id`'s proposal { thinking, action, say }, made on
 * `basis` ({ at }, the moment its run saw), or turns it away. `say` is the
 * clue on a clue's turn. The rules turn away an action that is illegal, or
 * made on a moment the game has left; turned away, an AI player is asked
 * again on the game as it is, told why, up to MAX_TRIES, and then the rules'
 * fallback plays for it. Returns { landed, rejected }.
 */
export function land(table, id, basis, { thinking = '', action = null, say = '' }) {
  if (!playing(table)) return { landed: false, rejected: 'No game is on.' };
  const seat = seatOf(table, id);
  const n = table.notes[id];
  const mine = due(table.game).find((d) => d.seat === seat);
  const proposed = { ...(action ?? (mine?.kind === 'clue' ? { type: 'clue' } : {})), at: basis.at };
  if (proposed.type === 'clue' && typeof say === 'string' && say.trim()) proposed.text = say;
  if (n && thinking) n.thoughts.push({ round: table.game.round, kind: mine?.kind ?? null, text: String(thinking), action: action && { ...action } });
  const out = act(table.game, seat, proposed);
  if (!out.error) {
    table.game = out;
    if (n) n.rejected = '';
    commit(table, { type: 'action', by: id, kind: mine.kind });
    return { landed: true, rejected: null };
  }
  if (n) {
    const at = turn(table.game);
    const still = due(table.game).some((d) => d.seat === seat);
    n.tries = n.triesAt === at ? n.tries + 1 : 1;
    n.triesAt = at;
    n.rejected = still ? `Your last action was turned away: ${out.error}` : '';
    if (still) table.askedAt[id] = stamp(); // asked again
  }
  commit(table, { type: 'rejected', by: id, why: out.error });
  if (n?.rejected && n.tries >= MAX_TRIES) {
    table.game = fallback(table.game, [seat]);
    n.rejected = '';
    commit(table, { type: 'action', by: id, kind: mine.kind, forced: true });
  }
  return { landed: false, rejected: out.error };
}

// Players' turns taken as doing nothing (the rules' `fallback`): `ids`, or
// everyone still due once the turn's time is up.
export function expire(table, ids = due(table.game).map((d) => table.players[d.seat])) {
  const seats = ids.map((id) => seatOf(table, id)).filter((seat) => due(table.game).some((d) => d.seat === seat));
  if (!seats.length) return;
  table.game = fallback(table.game, seats);
  commit(table, { type: 'expired', late: seats.map((s) => table.players[s]) });
}

// ---- the table as a world ----

// What the table asks of each AI player now (an Ask, runtime.js), each from
// the host: its turn, once the turn began or its last proposal was turned away.
function asksOf(table) {
  if (!playing(table)) return [];
  const key = `${table.gameNo}:${turn(table.game)}`;
  return due(table.game).flatMap(({ seat }) => {
    const id = table.players[seat];
    if (isPerson(id)) return [];
    const at = [table.turnAt, table.askedAt[id] ?? ''].sort().at(-1);
    return [{ id: `turn:${key}`, agent: id, from: HUMAN, at, until: at }];
  });
}

/**
 * The table as Ponjo's runtime reaches it: the five calls and what they
 * need (runtime.js, the contract). `table()` is the table as it is now;
 * `typing(id, text)` resolves once the page has shown AI player `id`
 * typing its clue for as long as that takes. The page calls `changed()`
 * after each change it makes itself; the waits then read the table's log.
 */
export function createWorld(table, { typing = async () => {} } = {}) {
  const waiting = new Set();
  const changed = () => {
    for (const done of waiting) done();
  };
  const kindOf = (by) => (!by ? 'world' : isPerson(by) ? 'person' : 'agent');
  return {
    changed,
    limits: { depth: 0 }, // players never ask each other: the rules ask
    settleMs: 0,
    print: () => '',
    wakes: () => false,

    async members() {
      const t = table();
      return [...t.people.map((id) => ({ id, name: nameOf(t, id), kind: 'person', mayAsk: true })), ...t.players.filter((id) => !isPerson(id)).map((id) => ({ id, name: id, kind: 'agent', mayAsk: false }))];
    },
    async asks() {
      return asksOf(table());
    },
    // What `agent` sees: `files` the moment its run is made on, `prompt` { rules, situation }.
    async view(agent) {
      const t = table();
      return { rev: t.rev, files: { at: turn(t.game) }, prompt: prompt(t, agent.id) };
    },
    async wait(version, deadline) {
      for (;;) {
        const t = table();
        const since = t.log.filter((c) => c.rev > version);
        if (since.length || performance.now() >= deadline) return { rev: t.rev, log: since.map((c) => ({ rev: c.rev, by: { id: c.by ?? null, kind: kindOf(c.by) }, at: performance.now(), asks: true, stale: false })) };
        await new Promise((resolve) => {
          const done = () => {
            waiting.delete(done);
            resolve();
          };
          waiting.add(done);
        });
      }
    },
    // A run's proposal ({ thinking, action, say }), landed against the
    // moment it was made on: a clue once the player is seen typing it.
    // Resolves to { landed, rejected }.
    async propose(agent, version, old, made) {
      if (!made) return { landed: false, rejected: null };
      const t = table();
      const clue = due(t.game).some((d) => d.kind === 'clue' && t.players[d.seat] === agent.id);
      if (clue && typeof made.say === 'string' && made.say.trim() && old.files.at === turn(t.game)) await typing(agent.id, made.say);
      const out = land(table(), agent.id, old.files, made);
      changed();
      return out;
    },
  };
}

// ---- what a player is shown ----

const RULES = `You are a player in a game of Who's the Spy (谁是卧底) with people and other AI players.

Every player was given a secret word. Most players, the civilians, share one word; the spies (one at a table of five or six, two at seven or eight) were given a different word, close to it (say "coffee" and "tea"). No one is told which side they are on: you know only your own word, and must work out from the others' clues whether yours is the civilians' word or the spies'.

A round: each living player gives one clue to their word, in turn: a short description, true of their word, that never says the word itself. Then everyone alive votes at once for the player they think is a spy. The player with the most votes is out, and their side is shown. On a tie at the top, the tied players give one more clue each, and everyone votes again, between them only; a second tie, and no one is out. Then the next round. The civilians win once every spy is out. The spies win once they are as many as the civilians, or a spy is among the last three players.

So: a clue that is too plain helps the spies guess the civilians' word; one that is too vague looks like a spy's. If the others' clues fit a different word than yours, you are likely a spy: blend in, give clues that fit their word too, and vote with them. A game master checks every action: one that is not legal, or comes after the game moved on, is turned away and you are asked again.

You are woken when you have something to do. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences: which word the others seem to have, which side you think you are on, and whom you suspect. No one sees it until the game is over.
- action: what you do now, always. { "type": "clue" } with your clue in say, or { "type": "vote", "target": a seat number }.
- say: on your clue, the clue itself, in your own voice: one sentence, under 15 words, never your word or its plural. Left out when you vote.

Play to win for your side, as yourself. Talk only in your own voice. Be quick.`;

// The tool the model answers with, as INFER (agents/ponjo-core.mjs) takes tools.
export const DECIDE = {
  name: 'decide',
  description: 'Your private thinking, what you do now, and your clue.',
  parameters: {
    type: 'object',
    properties: {
      thinking: { type: 'string', description: 'Private reasoning, one to three short sentences.' },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['clue', 'vote'] },
          target: { type: 'integer', description: 'For vote: a seat number.' },
        },
        required: ['type'],
      },
      say: { type: 'string', description: 'Your clue, on your turn to give one.' },
    },
    required: ['thinking', 'action'],
  },
};

// The model's answer as the writer takes it: seats are numbered from 1 in what a player is shown, from 0 here.
export function decided(args) {
  const a = args?.action && typeof args.action === 'object' ? args.action : null;
  const target = Number.isInteger(a?.target) ? a.target - 1 : undefined;
  return { thinking: String(args?.thinking ?? ''), action: a && { type: String(a.type), ...(target !== undefined ? { target } : {}) }, say: typeof args?.say === 'string' ? args.say.slice(0, MAX_CLUE) : '' };
}

const SIDE = { civilian: 'a civilian', spy: 'a spy' };

/**
 * What player `id` is shown now: the rules and its own style, then the
 * game as its seat's `view` has it, and nothing else, so another player's
 * word or side can reach it only once the rules show it.
 * Returns { rules, situation }; the rules stay the same run to run, so they cache.
 */
export function prompt(table, id) {
  const seat = seatOf(table, id);
  const v = view(table.game, seat);
  const persona = PERSONAS.find((p) => p.id === id);
  const rules = [
    `${RULES}\n\nYou are ${id}, in seat ${seat + 1}: ${persona.blurb.toLowerCase()}.`,
    `How you talk: ${persona.voice}`,
    `How you play: ${persona.play}`,
    `When you think you are the spy: ${persona.spy}`,
  ].join('\n');
  const who = (i) => `seat ${i + 1}, ${i === seat ? 'you' : nameOf(table, table.players[i])}`;
  const parts = [`Your word: "${v.word}".`];
  parts.push(['The players, in seat order:', ...v.seats.map((s, i) => `- ${who(i)}: ${s.alive ? 'in' : `out, was ${SIDE[s.role]}`}`)].join('\n'));
  const rounds = [];
  for (const e of v.log) {
    if (e.type === 'round') rounds.push(`Round ${e.round}:`);
    else if (e.type === 'clue') rounds.push(`- ${who(e.seat)}${e.silent ? ' gave no clue.' : `: "${e.text}"`}`);
    else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, t]) => `${who(Number(s))} → ${t === null ? 'no vote' : who(t)}`);
      rounds.push(`- The vote${e.second ? ' between the tied' : ''}: ${votes.join('; ')}. ${e.out !== null ? `${who(e.out)} is out: ${SIDE[e.role]}.` : e.runoff ? `A tie between ${e.runoff.map(who).join('; ')}: one more clue each, then a vote between them.` : 'No one is out.'}`);
    }
  }
  parts.push(['What has happened:', ...rounds].join('\n'));
  const mine = table.notes[id].thoughts.slice(-THOUGHTS_SHOWN);
  if (mine.length) parts.push(['Your own earlier thinking:', ...mine.map((t) => `- Round ${t.round}: ${t.text}`)].join('\n'));
  if (v.due) {
    const ask = v.due.kind === 'clue'
      ? `It is your turn to give a clue${v.runoff ? ' (you are in a tie: this clue may decide the vote)' : ''}: action clue, with it in say.`
      : `Vote for the player you think is a spy: action vote, with the target's seat number, one of ${v.due.targets.map((i) => i + 1).join(', ')}.`;
    parts.push(`Now: ${ask}${table.notes[id].rejected ? `\n${table.notes[id].rejected}` : ''}`);
  }
  return { rules, situation: parts.join('\n\n') };
}

// What a page draws: `id`'s view of the game (a watcher's, if it has no seat).
export const show = (table, id) => table.game && view(table.game, table.players.includes(id) ? seatOf(table, id) : null);
export { MAX_CLUE, due };
