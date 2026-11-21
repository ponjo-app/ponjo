// The spy table (site/spy.html) as a world for Ponjo's agent runtime
// (src/core/runtime.js, the contract; docs/agent-runtime.md), as the poker
// table is (poker-world.js): one table everyone shares, with a change log;
// who is asked (each AI player the rules say is due: the one whose clue it
// is, or everyone in a vote, at once; in a discussion, everyone once as it
// begins, then whoever a line is to; after a game, whoever a line in the
// chat is to, as table-talk.js says); `prompt`, what a player is shown,
// built from its seat's `view` alone; and `land`, the one writer, which
// lands proposals in order and turns away a stale or illegal one, asking
// the player again, and after MAX_TRIES playing the rules' fallback. When
// the players run is the runtime's; the page (preview/spy.js) runs the model
// and draws the table.
//
// The people are the host (HUMAN), whose page holds the table, and any
// friends who joined it by a link; the AI players fill the seats left.
// Outside a game, before it and once it is over, the people at the table
// chat, and the AI players of the game just played answer.

import { MAX_CLUE, MAX_LINES, act, deal, due, endTalk, fallback, linesLeft, newGame, spiesFor, turn, view } from './spy-rules.js';
import { DEPTH, MAX_LINE, asks, linesOf, named, say, stamp } from './table-talk.js';

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
 * one starts, with `players`, its seats' ids. `lines`, the table's lines
 * that are not clues (table-talk.js), each marked with its `game` and
 * where it was said (`kind`): in a discussion (`talk`), or in the chat
 * before that game or after it (`chat`, `after`). Notes, per AI player: its
 * thinking, and how its last proposal went.
 */
export function newTable() {
  return { rev: 0, log: [], people: [HUMAN], names: {}, players: [], game: null, gameNo: 0, greeting: false, hellos: [], lines: [], notes: {}, turnAt: '', turnKey: '', askedAt: {} };
}

// Every change lands here: a revision, a line in the log. A change of turn is asked from then (`turnAt`).
function commit(table, change) {
  table.rev++;
  table.log.push({ rev: table.rev, ...change });
  const key = table.game ? `${table.gameNo}:${turn(table.game)}` : '';
  if (key !== table.turnKey) Object.assign(table, { turnKey: key, turnAt: stamp() });
}

const nameOf = (table, id) => (isPerson(id) ? table.names[id] ?? (id === HUMAN ? 'the host' : 'a friend') : id);
// The players a line names, by the names they go by at the table.
const namedIn = (table, text) => named([...new Set([...table.players, ...table.people])], (id) => (!isPerson(id) || table.names[id] ? nameOf(table, id) : ''), text);
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
 * `basis` ({ at, about }, the moment its run saw, and the line it answers),
 * or turns it away. `say` is the clue on a clue's turn, or a line in a
 * discussion, where saying nothing is staying quiet; a line answering one a
 * person said to the whole table lands only if no other AI player has
 * answered it yet, so the table settles. The rules turn away an action that
 * is illegal, or made on a moment the game has left; turned away, an AI
 * player is asked again on the game as it is, told why, up to MAX_TRIES,
 * and then the rules' fallback plays for it (in a discussion: it says
 * nothing). Outside a game, `say` is a line in the chat (`chat`).
 * Returns { landed, rejected }.
 */
export function land(table, id, basis, { thinking = '', action = null, say: line = '', for: those }) {
  if (!table.game || table.game.phase === 'over') return chat(table, id, basis, { thinking, say: line, for: those });
  if (!playing(table)) return { landed: false, rejected: 'Wait for everyone to say hello.' };
  const seat = seatOf(table, id);
  const n = table.notes[id];
  const talk = table.game.phase === 'talk';
  const mine = talk ? { kind: 'talk' } : due(table.game).find((d) => d.seat === seat);
  const text = typeof line === 'string' ? line.trim() : '';
  const proposed = { ...(action ?? (mine?.kind === 'clue' ? { type: 'clue' } : talk ? { type: 'say' } : {})), at: basis.at };
  if (proposed.type === 'clue' || proposed.type === 'say') proposed.text = text;
  if (n && thinking) n.thoughts.push({ round: table.game.round, kind: mine?.kind ?? null, text: String(thinking), action: action && { ...action } });
  const about = basis.about ? table.lines[basis.about - 1] : null;
  if (proposed.type === 'say' && !text) return { landed: false, rejected: null }; // staying quiet
  const answered = proposed.type === 'say' && about && isPerson(about.by) && !about.to.length && !isPerson(id) && table.lines.some((l) => l.about === about.id && !isPerson(l.by));
  if (answered) return { landed: false, rejected: null }; // another AI player answered it already
  const out = act(table.game, seat, proposed);
  if (!out.error) {
    table.game = out;
    if (n) n.rejected = '';
    if (proposed.type === 'say') say(table.lines, { by: id, text, to: namedIn(table, text), about, for: those, isPerson, game: table.gameNo, kind: 'talk' });
    commit(table, { type: 'action', by: id, kind: mine.kind });
    return { landed: true, rejected: null };
  }
  if (n) {
    const at = turn(table.game);
    const still = talk ? linesLeft(table.game, seat) > 0 && table.game.phase === 'talk' : due(table.game).some((d) => d.seat === seat);
    n.tries = n.triesAt === at ? n.tries + 1 : 1;
    n.triesAt = at;
    n.rejected = still ? `Your last action was turned away: ${out.error}` : '';
    if (still) table.askedAt[id] = stamp(); // asked again
  }
  commit(table, { type: 'rejected', by: id, why: out.error });
  if (n?.rejected && n.tries >= MAX_TRIES) {
    n.rejected = '';
    if (talk) delete table.askedAt[id]; // it says nothing more unless a line wakes it
    else table.game = fallback(table.game, [seat]);
    commit(table, { type: 'action', by: id, kind: mine.kind, forced: true });
  }
  return { landed: false, rejected: out.error };
}

// A line in the chat outside a game, by someone at the table, or an AI
// player of the game just played: before a game, it goes with the next.
function chat(table, id, basis, { thinking = '', say: line = '', for: those }) {
  const text = typeof line === 'string' ? line.trim().slice(0, MAX_LINE) : '';
  const n = table.notes[id];
  if (n && thinking) n.thoughts.push({ round: table.game?.round ?? 0, kind: 'chat', text: String(thinking), action: null });
  if (!table.people.includes(id) && !(table.game && table.players.includes(id))) return { landed: false, rejected: 'You are not at the table.' };
  if (!text) return { landed: false, rejected: isPerson(id) ? 'Say something.' : null }; // an AI player staying quiet
  const after = Boolean(table.game);
  const about = basis.about ? table.lines[basis.about - 1] : null;
  const line_ = say(table.lines, { by: id, text, to: namedIn(table, text), about, for: those, isPerson, game: after ? table.gameNo : table.gameNo + 1, kind: 'chat', after });
  if (!line_) return { landed: false, rejected: null }; // another AI player answered it already
  commit(table, { type: 'chat', by: id });
  return { landed: true, rejected: null };
}

// The discussion is over, its time up or the host starting the vote: everyone votes.
export function callVote(table) {
  if (table.game?.phase !== 'talk') return;
  table.game = endTalk(table.game);
  commit(table, { type: 'vote-called' });
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

// What the table asks of each AI player now (an Ask, runtime.js): its turn,
// once the turn began or its last proposal was turned away, from the host;
// in a discussion, while it has lines left, a word as it begins, from the
// host, and each line that concerns it, from whoever said it; once the game
// is over, each line in the chat after it that concerns it.
function asksOf(table) {
  if (table.game?.phase === 'over') {
    const after = table.lines.filter((l) => l.kind === 'chat' && l.after && l.game === table.gameNo);
    return table.players.filter((id) => !isPerson(id)).flatMap((id) => asks(after, id, isPerson, `chat:${table.gameNo}`));
  }
  if (!playing(table)) return [];
  const key = `${table.gameNo}:${turn(table.game)}`;
  const latest = (id) => [table.turnAt, table.askedAt[id] ?? ''].sort().at(-1);
  if (table.game.phase !== 'talk') {
    return due(table.game).flatMap(({ seat }) => {
      const id = table.players[seat];
      return isPerson(id) ? [] : [{ id: `turn:${key}`, agent: id, from: HUMAN, at: latest(id), until: latest(id) }];
    });
  }
  const talk = table.lines.filter((l) => l.kind === 'talk' && l.game === table.gameNo && l.at > table.turnAt);
  return table.players.flatMap((id, seat) => {
    if (isPerson(id) || !linesLeft(table.game, seat)) return [];
    return [{ id: `talk:${key}`, agent: id, from: HUMAN, at: latest(id), until: latest(id) }, ...asks(talk, id, isPerson, `line:${table.gameNo}`)];
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
    limits: { depth: DEPTH }, // how deep players answer each other: the table's rule (table-talk.js) holds first
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
    // What `agent` sees for its asks: `files` the moment its run is made on
    // and the latest line it answers, `prompt` { rules, situation }.
    async view(agent, { asks: asked = [] } = {}) {
      const t = table();
      const lines = [...linesOf(t.lines, asked, `line:${t.gameNo}`), ...linesOf(t.lines, asked, `chat:${t.gameNo}`)];
      return { rev: t.rev, files: { at: turn(t.game), about: lines.at(-1)?.id ?? null }, prompt: prompt(t, agent.id, lines) };
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
    // moment it was made on: a clue or a line once the player is seen
    // typing it. Resolves to { landed, rejected }.
    async propose(agent, version, old, made) {
      if (!made) return { landed: false, rejected: null };
      const t = table();
      const speaks = ['talk', 'over'].includes(t.game.phase) || due(t.game).some((d) => d.kind === 'clue' && t.players[d.seat] === agent.id);
      if (speaks && typeof made.say === 'string' && made.say.trim() && old.files.at === turn(t.game)) await typing(agent.id, made.say);
      const out = land(table(), agent.id, old.files, { ...made, for: agent.for });
      changed();
      return out;
    },
  };
}

// ---- what a player is shown ----

const RULES = `You are a player in a game of Who's the Spy (谁是卧底) with people and other AI players.

Every player was given a secret word. Most players, the civilians, share one word; the spies (one at a table of five or six, two at seven or eight) were given a different word, close to it (say "coffee" and "tea"). No one is told which side they are on: you know only your own word, and must work out from the others' clues whether yours is the civilians' word or the spies'.

A round: each living player gives one clue to their word, in turn: a short description, true of their word, that never says the word itself. Then a short discussion: anyone alive may talk, at most ${MAX_LINES} lines each, never saying their word: accuse, defend yourself, question someone, or stay quiet. Then everyone alive votes at once for the player they think is a spy. The player with the most votes is out, and their side is shown. On a tie at the top, the tied players give one more clue each, and everyone votes again, between them only; a second tie, and no one is out. Then the next round. The civilians win once every spy is out. The spies win once they are as many as the civilians, or a spy is among the last three players.

So: a clue that is too plain helps the spies guess the civilians' word; one that is too vague looks like a spy's. If the others' clues fit a different word than yours, you are likely a spy: blend in, give clues that fit their word too, and vote with them. A game master checks every action: one that is not legal, or comes after the game moved on, is turned away and you are asked again.

You are woken when you have something to do. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences: which word the others seem to have, which side you think you are on, and whom you suspect. No one sees it until the game is over.
- action: what you do now, always. { "type": "clue" } with your clue in say, { "type": "say" } with a line in the discussion, or { "type": "vote", "target": a seat number }.
- say: your clue or your line, in your own voice: one sentence, under 20 words, never your word or its plural. In the discussion, leave it empty to stay quiet: speak only when you have something worth saying, and at most one of you usually answers a line said to the whole table. A reply needs no reply. Left out when you vote.

Play to win for your side, as yourself. Talk only in your own voice. Be quick.`;

// The tool the model answers with, as INFER (agents/ponjo-core.mjs) takes tools.
export const DECIDE = {
  name: 'decide',
  description: 'Your private thinking, what you do now, and your clue or line.',
  parameters: {
    type: 'object',
    properties: {
      thinking: { type: 'string', description: 'Private reasoning, one to three short sentences.' },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['clue', 'say', 'vote'] },
          target: { type: 'integer', description: 'For vote: a seat number.' },
        },
        required: ['type'],
      },
      say: { type: 'string', description: 'Your clue on your turn, or your line in the discussion (empty to stay quiet).' },
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
 * word or side can reach it only once the rules show it. `lines`: the lines
 * in a discussion that woke it, to answer if it will.
 * Returns { rules, situation }; the rules stay the same run to run, so they cache.
 */
export function prompt(table, id, lines = []) {
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
    else if (e.type === 'talk') rounds.push('The discussion:');
    else if (e.type === 'line') rounds.push(`  - ${who(e.seat)} says: "${e.text}"`);
    else if (e.type === 'vote') {
      const votes = Object.entries(e.votes).map(([s, t]) => `${who(Number(s))} → ${t === null ? 'no vote' : who(t)}`);
      rounds.push(`- The vote${e.second ? ' between the tied' : ''}: ${votes.join('; ')}. ${e.out !== null ? `${who(e.out)} is out: ${SIDE[e.role]}.` : e.runoff ? `A tie between ${e.runoff.map(who).join('; ')}: one more clue each, then a vote between them.` : 'No one is out.'}`);
    }
  }
  parts.push(['What has happened:', ...rounds].join('\n'));
  if (v.phase === 'over') {
    const after = table.lines.filter((l) => l.kind === 'chat' && l.after && l.game === table.gameNo);
    parts.push(`The game is over: everyone's word and side are shown above. ${after.length ? ['The chat since:', ...after.map((l) => `- ${l.by === id ? 'you' : nameOf(table, l.by)}: "${l.text}"`)].join('\n') : ''}`);
    const woke = lines.map((l) => `${nameOf(table, l.by)} said "${l.text}"${l.to.length ? '' : ' to everyone'}`).join(', and ');
    parts.push(`Now: ${woke}. Answer if you will, as yourself, about the game just played: action say, with one short line in say, or an empty say to stay quiet.`);
  }
  const mine = table.notes[id].thoughts.slice(-THOUGHTS_SHOWN);
  if (mine.length) parts.push(['Your own earlier thinking:', ...mine.map((t) => `- Round ${t.round}: ${t.text}`)].join('\n'));
  if (v.due) {
    const woke = lines.map((l) => `${l.by === id ? 'you' : nameOf(table, l.by)} said "${l.text}"${l.to.length ? '' : ' to everyone'}`).join(', and ');
    const ask = v.due.kind === 'clue'
      ? `It is your turn to give a clue${v.runoff ? ' (you are in a tie: this clue may decide the vote)' : ''}: action clue, with it in say.`
      : v.due.kind === 'talk'
        ? `It is the discussion before the vote; you have ${v.due.left} line${v.due.left === 1 ? '' : 's'} left. ${woke ? `${woke}: answer if you will. ` : ''}Action say, with your line in say, or an empty say to stay quiet.`
        : `Vote for the player you think is a spy: action vote, with the target's seat number, one of ${v.due.targets.map((i) => i + 1).join(', ')}.`;
    parts.push(`Now: ${ask}${table.notes[id].rejected ? `\n${table.notes[id].rejected}` : ''}`);
  }
  return { rules, situation: parts.join('\n\n') };
}

// What a page draws: `id`'s view of the game (a watcher's, if it has no seat).
export const show = (table, id) => table.game && view(table.game, table.players.includes(id) ? seatOf(table, id) : null);
export { MAX_CLUE, MAX_LINES, due };
