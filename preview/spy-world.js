// Who's the Spy (site/spy.html) as a world on the runtime's core
// (docs/app/worlds/spy.md; src/core/store.js, ledger.js, controller.js):
// `view` and `apply`, both pure. The table everyone shares: who is at it,
// the game (spy-rules.js), the lines said that are not clues, each AI
// player's thinking. `view` gives a member only what its seat may see, and
// its tasks; `apply` lands a change, or refuses it, saying why. No clock and
// no randomness: the time is each change's `at`, the deal comes in the
// host's `start` (dealt by the table's room, game-tables.js), and the clock
// is a member whose tasks are the deadlines.
//
// The people are the host (HUMAN), whose page opened the table, and any
// friends who joined it by a link; the AI players fill the seats left, and
// sit at the table from when it opens, each saying hello as it sits down.
// The table chats whenever the game does not mute it: in a game, only its
// discussion is open, to the players still in. An AI player at it answers
// what concerns it, and plays by what the table agreed there, as far as the
// rules allow.

import { MAX_CLUE, MAX_LINES, SIZES, act, due, endTalk, fallback as sayNothing, linesLeft, newGame, turn, view as seatView } from './spy-rules.js';
import { DEPTH, MAX_LINE, after as next, latest, line as newLine, named, think as thought, deadline } from './game-kit.js';

export const HUMAN = 'you';
export const CLOCK = 'clock'; // the member whose tasks are the table's deadlines
export const MAX_PEOPLE = 8;
export const TURN = 90_000; // ms a turn may take; then everyone still due is taken as doing nothing
export const TALK = 90_000; // ms a discussion may last; then the vote
const SIZE = 6; // the seats of a new table's game, until the host picks another
const CHAT_SHOWN = 40; // the table's latest lines an AI player is shown

// Each AI player: who they are (`blurb`, shown on the page), how they talk
// and how they clue, and what they do when they think they are the spy.
export const PERSONAS = [
  {
    id: 'Ivy',
    blurb: 'A crossword setter with cryptic clues',
    voice: 'You set crosswords for a living. Your clues are short, clever and a little cryptic, often wordplay or a double meaning, and you enjoy it when no one gets them.',
    play: 'You keep your clues just vague enough that only those who share your word will see it. You vote for whoever gave a clue that fits a different word.',
    spy: 'You give a clue so general it fits both words, and quietly agree with the most common reading.',
  },
  {
    id: 'Max',
    blurb: 'A blunt coach who says too much',
    voice: 'You are a loud, blunt sports coach. Short sentences, no patience, the odd exclamation mark.',
    play: 'Your clues are too specific: you nearly give the word away. You vote fast for whoever sounds odd to you.',
    spy: 'You go on the attack: you name someone as the spy before anyone can look at you.',
  },
  {
    id: 'Juno',
    blurb: 'A drama student who performs everything',
    voice: 'You are a theatrical drama student. You speak in big, dramatic images, as if on stage.',
    play: 'Your clues paint a scene or a feeling, not a fact. You vote with your gut and say so with a flourish.',
    spy: 'You hide behind a mood: a clue all feeling and no fact, which could be either word.',
  },
  {
    id: 'Sam',
    blurb: 'A poker-faced accountant',
    voice: 'You are a dry, precise accountant. As few words as possible, no jokes.',
    play: 'Your clues are one or two flat words. You keep a tally of whose clue fits what, and vote on it.',
    spy: 'You give the flattest, safest clue you can, and vote with the majority.',
  },
  {
    id: 'Lou',
    blurb: 'A chatty chef who sees food in everything',
    voice: 'You are a warm, chatty chef. You relate everything to food, cooking and your kitchen.',
    play: 'Your clues come from the kitchen whenever they can. You trust people too easily and vote late.',
    spy: 'You change the subject to cooking, and agree loudly with whoever sounds sure.',
  },
  {
    id: 'Remy',
    blurb: 'A retired detective who suspects everyone',
    voice: 'You are a retired detective. You speak slowly, as if reading from a notebook ("Interesting. Noted.").',
    play: 'You weigh each clue against the others, then name your suspect with your reasons.',
    spy: 'You build a careful case against a civilian whose clue was a little off.',
  },
  {
    id: 'Pip',
    blurb: 'An excitable kid at heart',
    voice: 'You are bubbly and excitable, like a kid at a party. Lots of energy, simple words.',
    play: 'Your clues are what the thing is like in everyday life. You change your vote when someone convinces you.',
    spy: 'You copy the shape of the others\' clues and hope no one notices.',
  },
];
export const isPerson = (id) => !PERSONAS.some((p) => p.id === id);

/**
 * A new table: the host alone, before a game. `people` are the host and the
 * friends at the table, in the order they joined; `names` their names.
 * `size`: the seats of the next game. `game` is the rules' game once one
 * starts, number `gameNo`, `players` its seats' ids. `lines`: what is said
 * that is not a clue, each { id (its place, from 1), by, text, to (the
 * players it names), depth, from (the people who set it off), game (the
 * last game begun), kind }: in a discussion (`talk`, with its `round`, and,
 * if it names no one, the AI player it asks, `next`), or in the chat out of
 * a game (`chat`). `thoughts`: each AI player's
 * thinking. `heard`: the discussion task each player last answered, with a
 * line or a pass. `since`: the `at` of the change that began the moment (`moment`).
 */
export function newTable() {
  return { people: [HUMAN], names: {}, size: SIZE, players: [], gameNo: 0, game: null, lines: [], thoughts: {}, heard: {}, since: 0 };
}

const playing = (t) => Boolean(t.game) && t.game.phase !== 'over'; // the game is on
// Who sits at the table for the next game: the people first, then AI players in the seats left.
const seated = (t) => [...t.people.slice(0, t.size), ...PERSONAS.slice(0, Math.max(0, t.size - t.people.length)).map((p) => p.id)];
const here = (t, id) => !isPerson(id) || t.people.includes(id); // a friend who left plays on as doing nothing
const nameOf = (t, id) => (isPerson(id) ? t.names[id] ?? (id === HUMAN ? 'the host' : 'a friend') : id);
// The players a line names, by the names they go by at the table.
const namedIn = (t, text) => named([...new Set([...(playing(t) ? t.players : seated(t)), ...t.people])], (id) => (!isPerson(id) || t.names[id] ? nameOf(t, id) : ''), text);
// The moment the table is at: a change made on another is stale. It moves
// with each turn of the game (`turn`, spy-rules.js).
const moment = (t) => (t.game ? `${t.gameNo}:${turn(t.game)}` : '');
const ends = (t) => t.since + (t.game.phase === 'talk' ? TALK : TURN);
// The first AI player after `by` in seat order (from the first seat, if `by` has none) that `ok` takes.
const after = (t, by, ok) => next(t.players, by, (p) => !isPerson(p) && ok(p));
// The discussion's tasks are `talk:<gameNo>:<round>:<line>`, its opening line 0.
const talk = (t) => `talk:${t.gameNo}:${t.game.round}:`;
// The task `given` each line or pass answers: an AI player's, the one its
// run was given; a person's, everything so far, `latest` the newest line.
const hear = (t, by, given, latest) => ({ ...t.heard, [by]: isPerson(by) ? talk(t) + latest : given });

// ---- tasks ----

/**
 * What player `id`, in `seat`, is due to do, in order: its clue or its vote
 * (a turn the rules ask); in a discussion, while it has lines left, the
 * first it has not answered of the discussion's opening and each line that
 * asks it (names it, or names no one and is to it as `next`); out of a
 * game, an AI player at the table, its hello and each line that asks it.
 */
function tasksOf(t, id, seat) {
  if (!playing(t)) return isPerson(id) || !seated(t).includes(id) ? [] : chatTasks(t, id);
  if (seat < 0 || !here(t, id)) return [];
  const mine = due(t.game).find((d) => d.seat === seat);
  if (mine) return [{ given: `turn:${moment(t)}`, as: id, kind: 'turn', from: [], depth: 0, at: ends(t), why: mine.kind === 'clue' ? 'Your clue' : 'Your vote' }];
  if (!linesLeft(t.game, seat)) return [];
  const key = talk(t);
  const heard = t.heard[id]?.startsWith(key) ? Number(t.heard[id].slice(key.length)) : -1;
  const asks = t.lines.filter((l) => l.kind === 'talk' && l.game === t.gameNo && l.round === t.game.round && l.by !== id && (l.to.includes(id) || l.next === id));
  const line = [{ id: 0, from: [], depth: 0 }, ...asks].find((l) => l.id > heard);
  if (!line) return [];
  return [{ given: key + line.id, as: id, kind: 'turn', from: line.from, depth: line.depth, at: ends(t), why: line.id ? `${nameOf(t, line.by)} said "${line.text}"` : 'The discussion begins' }];
}

// An AI player new to the table, which has said no line at it and did not
// play the last game, says hello. A line
// in the chat since the last game began asks the AI players it names,
// under DEPTH; a person's line to everyone, the first AI player after them.
function chatTasks(t, id) {
  const hello = t.lines.some((l) => l.by === id) || t.players.includes(id) ? [] : [{ given: `hello:${id}`, as: id, kind: 'ask', from: [], depth: 0, why: 'You just sat down at the table: say hello' }];
  const first = (by) => next(seated(t), by, (p) => !isPerson(p));
  return [...hello, ...t.lines.filter((l) => l.kind === 'chat' && l.game === t.gameNo && l.by !== id && l.depth < DEPTH && (l.to.includes(id) || (isPerson(l.by) && !l.to.length && first(l.by) === id)))
    .map((l) => ({ given: `chat:${t.gameNo}:${l.id}`, as: id, kind: 'ask', from: l.from, depth: l.depth, why: `${nameOf(t, l.by)} said "${l.text}"${l.to.length ? '' : ' to everyone'}` }))];
}

// The clock's: the end of a turn, when everyone still due takes the rules'
// fallback; the end of a discussion, when the vote is called.
function clockTasks(t) {
  const task = (...a) => [deadline(...a)];
  if (!playing(t)) return [];
  return t.game.phase === 'talk' ? task(`vote-called:${moment(t)}`, CLOCK, ends(t), 'The vote') : task(`expire:${moment(t)}`, CLOCK, ends(t), 'The turn is up');
}

// What `id` may do now: its clue or its vote; in a discussion, talk or pass; out of a game, chat.
function actionsOf(t, id, seat) {
  if (playing(t)) {
    const mine = seat < 0 ? null : due(t.game).find((d) => d.seat === seat);
    return mine ? [mine.kind] : linesLeft(t.game, seat) ? ['say', 'pass'] : [];
  }
  return t.people.includes(id) || seated(t).includes(id) ? ['chat'] : [];
}

// ---- the world ----

/**
 * What `member` sees: `content`, the table as its seat may see it (its own
 * word, never another's, until the game is over; its own thinking, and
 * everyone's once it is over); `actions`; `tasks`; `seen`, whose presence it
 * sees (everyone's: each phase lets all act, or only the speaker, so it
 * shows no side); `rules`, how the game is played, in words.
 */
function view(t, member) {
  const seat = t.players.indexOf(member);
  const { people, names, size, players, gameNo } = t;
  return {
    content: {
      people, names, size, seated: seated(t), players, gameNo,
      game: t.game && seatView(t.game, seat < 0 ? null : seat),
      lines: t.lines.filter((l) => l.kind === 'chat'), // a discussion's are in the game's log
      thoughts: t.game?.phase === 'over' ? t.thoughts : seat < 0 ? {} : { [member]: latest(t.thoughts, member) },
      moment: moment(t),
      ends: playing(t) ? ends(t) : 0,
    },
    actions: actionsOf(t, member, seat),
    tasks: member === CLOCK ? clockTasks(t) : tasksOf(t, member, seat),
    seen: [...new Set([...t.people, ...t.players])],
    rules: RULES,
  };
}

/**
 * Lands `change` ({ by, at, base, answers, body }), or { refused: why }.
 * `body`, by `type`:
 *   start { size, dealt }       the host: a game, dealt as the rules `deal`,
 *                               the people at the table first, then AI
 *                               players in the seats left
 *   size { size }               the host: the next game's seats
 *   join { name }               a person sits at the table, or renames
 *   leave                       a friend leaves: in a game, each of their turns is taken as doing nothing
 *   clue { text }, say { text }, pass, vote { target }, chat { text }
 *                               made on `base`, the moment; an AI player's with its `thinking`
 * The clock's change answers its task. After each, a friend gone is taken
 * as doing nothing, and a discussion where no one is due ends.
 */
function apply(t, change) {
  const next = step(t, change);
  return next.refused ? next : { state: settle(next, t, change.at), effects: [] };
}

// A turn no one played (the ledger's): a clue unsaid, a vote not cast, a pass in a discussion.
function fallback(t, task, at) {
  const next = task.given.startsWith('talk:') ? { ...t, heard: { ...t.heard, [task.as]: task.given } } : { ...t, game: sayNothing(t.game, [t.players.indexOf(task.as)]) };
  return settle(next, t, at);
}

export const world = { view, apply, fallback, tries: 3 };

function step(t, { by, base, answers = [], body }) {
  if (by === CLOCK) return tick(t, answers[0]);
  const b = body ?? {};
  if (b.type === 'start') return start(t, by, b);
  if (b.type === 'size') return resize(t, by, b.size);
  if (b.type === 'join') return join(t, by, b.name);
  if (b.type === 'leave') return leave(t, by);
  if (base !== moment(t)) return { refused: 'Stale: the game moved on before your action landed.' };
  if (b.type === 'chat') return chat(t, by, b, answers);
  if (!playing(t)) return { refused: 'There is no game on: chat instead.' };
  const seat = t.players.indexOf(by);
  if (b.type === 'pass') {
    const task = tasksOf(t, by, seat)[0];
    if (!task?.given.startsWith('talk:')) return { refused: 'There is nothing to pass on now.' };
    const latest = t.lines.findLast((l) => l.kind === 'talk' && l.game === t.gameNo && l.round === t.game.round);
    return think({ ...t, heard: hear(t, by, task.given, latest?.id ?? 0) }, t, by, b);
  }
  const game = act(t.game, seat, { type: String(b.type), text: b.text, target: b.target });
  if (game.error) return { refused: game.error };
  if (b.type !== 'say') return think({ ...t, game }, t, by, b);
  // A line that names no one asks the next AI player who has lines left.
  const said = line(t, by, game.log.at(-1).text, answers, { kind: 'talk', round: t.game.round });
  if (!said.to.length) said.next = after(t, by, (p) => linesLeft(game, t.players.indexOf(p)) > 0);
  return think({ ...t, game, lines: [...t.lines, said], heard: hear(t, by, answers.find((a) => a.startsWith(talk(t))) ?? talk(t) + said.id, said.id) }, t, by, b);
}

// After a change: a friend gone is taken as doing nothing on their turn; a
// discussion where no one is due ends; a new moment begins at `at`.
function settle(t, before, at) {
  while (playing(t)) {
    const gone = due(t.game).filter((d) => !here(t, t.players[d.seat])).map((d) => d.seat);
    if (gone.length) t = { ...t, game: sayNothing(t.game, gone) };
    else if (t.game.phase === 'talk' && !t.players.some((id, seat) => tasksOf(t, id, seat).length)) t = { ...t, game: endTalk(t.game) };
    else break;
  }
  return moment(t) === moment(before) ? t : { ...t, since: at };
}

// The clock's task `given` is due: it lands.
function tick(t, given) {
  if (!clockTasks(t).some((task) => task.given === given)) return { refused: 'Not due.' };
  const kind = given.split(':')[0];
  if (kind === 'vote-called') return { ...t, game: endTalk(t.game) };
  return { ...t, game: sayNothing(t.game) };
}

function start(t, by, { dealt, size }) {
  if (by !== HUMAN) return { refused: 'Only the host starts a game.' };
  if (playing(t)) return { refused: 'A game is on.' };
  if (!SIZES.includes(size)) return { refused: `A game has ${SIZES.join(', ')} seats.` };
  const next = { ...t, size };
  return { ...next, players: seated(next), game: newGame(dealt), gameNo: t.gameNo + 1, thoughts: {}, heard: {} };
}

// The host picks how many seats the next game has: AI players sit down or get up for it.
function resize(t, by, size) {
  if (by !== HUMAN) return { refused: 'Only the host sets the table.' };
  if (playing(t)) return { refused: 'A game is on.' };
  if (!SIZES.includes(size)) return { refused: `A game has ${SIZES.join(', ')} seats.` };
  return { ...t, size };
}

// A person sits at the table as `name`, and plays from the next game; one there already takes the name.
function join(t, by, name) {
  const as = String(name ?? '').trim().slice(0, 20) || 'Friend';
  if (!isPerson(by)) return { refused: 'Only a person sits at the table.' };
  if (!t.people.includes(by) && t.people.length >= MAX_PEOPLE) return { refused: 'The table is full.' };
  return { ...t, people: t.people.includes(by) ? t.people : [...t.people, by], names: { ...t.names, [by]: as } };
}

function leave(t, by) {
  if (by === HUMAN || !t.people.includes(by)) return { refused: 'You are not at the table.' };
  return { ...t, people: t.people.filter((p) => p !== by) };
}

// A line in the chat out of a game, by someone at the table.
function chat(t, by, b, answers) {
  if (playing(t)) return { refused: 'Not now: the game is on.' };
  if (!actionsOf(t, by, -1).includes('chat')) return { refused: 'You are not at the table.' };
  const text = String(b.text ?? '').trim().slice(0, MAX_LINE);
  if (!text) return { refused: 'Say something.' };
  return think({ ...t, lines: [...t.lines, line(t, by, text, answers, { kind: 'chat' })] }, t, by, b);
}

// A line `by` says, answering the tasks `answers`: a person's sets off
// depth 0, from them; an AI player's one deeper than what it answers, for
// whoever set that off.
function line(t, by, text, answers, marks) {
  const asked = tasksOf(t, by, t.players.indexOf(by)).filter((x) => answers.includes(x.given));
  return newLine(t.lines, { by, text, to: namedIn(t, text), person: isPerson(by), asked, game: t.gameNo, ...marks });
}

// An AI player's thinking lands with its change, as of the moment it was made on (`before`).
function think(t, before, by, b) {
  if (isPerson(by) || !b.thinking) return t;
  return { ...t, thoughts: thought(t.thoughts, by, { round: before.game?.round ?? 0, kind: ['say', 'pass'].includes(b.type) ? 'talk' : b.type, text: String(b.thinking), action: b.type === 'vote' ? { type: 'vote', target: b.target } : null }) };
}

// ---- what an AI player is shown ----

const RULES = `You are a player in a game of Who's the Spy (谁是卧底) with people and other AI players.

Every player was given a secret word. Most players, the civilians, share one word; the spies (one at a table of five or six, two at seven or eight) were given a different word, close to it (say "coffee" and "tea"). No one is told which side they are on: you know only your own word, and must work out from the others' clues whether yours is the civilians' word or the spies'.

A round: each living player gives one clue to their word, in turn: a short description, true of their word, that never says the word itself. Then a short discussion: anyone alive may talk, at most ${MAX_LINES} lines each, never saying their word: accuse, defend yourself, question someone, or stay quiet. Then everyone alive votes at once for the player they think is a spy. The player with the most votes is out, and their side is shown. On a tie at the top, the tied players give one more clue each, and everyone votes again, between them only; a second tie, and no one is out. Then the next round. The civilians win once every spy is out. The spies win once they are as many as the civilians, or a spy is among the last three players.

So: a clue that is too plain helps the spies guess the civilians' word; one that is too vague looks like a spy's. If the others' clues fit a different word than yours, you are likely a spy: blend in, give clues that fit their word too, and vote with them. A game master checks every action: one that is not legal, or comes after the game moved on, is turned away and you are asked again.

You are woken when you have something to do. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences: which word the others seem to have, which side you think you are on, and whom you suspect. No one sees it until the game is over.
- action: what you do now, always. { "type": "clue" } with your clue in say, { "type": "say" } with a line in the discussion, or { "type": "vote", "target": a seat number }.
- say: your clue or your line, in your own voice: one sentence, under 20 words, never your word or its plural. In the discussion, leave it empty to stay quiet: speak only when you have something worth saying, and at most one of you usually answers a line said to the whole table. A reply needs no reply. Left out when you vote.

The table also chats, outside a game: you say hello when you sit down, and answer when someone asks you or speaks to everyone. Whatever the table agreed there holds through the games, as far as these rules allow: the language to speak above all. Speak the language the table speaks.

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
/**
 * The model's answer as a change's body, for a view whose `actions` are
 * these: seats are numbered from 1 in what a player is shown, from 0 here;
 * an empty line in a discussion is a pass, and in the chat, nothing (null).
 */
export function decided(args, actions) {
  const a = args?.action && typeof args.action === 'object' ? args.action : null;
  const thinking = String(args?.thinking ?? '');
  const text = typeof args?.say === 'string' ? args.say.slice(0, MAX_CLUE) : '';
  const type = actions.includes('chat') ? 'chat' : a ? String(a.type) : actions[0];
  if (type === 'vote') return { type, thinking, ...(Number.isInteger(a?.target) ? { target: a.target - 1 } : {}) };
  if (['say', 'chat'].includes(type) && !text.trim()) return type === 'say' ? { type: 'pass', thinking } : null;
  return { type, text, thinking };
}

const SIDE = { civilian: 'a civilian', spy: 'a spy' };

/**
 * What AI player `id` is shown, from its `view` alone, so another player's
 * word or side can reach it only once the rules show it: the rules and its
 * own style, then the table's chat, the game as its seat sees it, and
 * what its tasks ask.
 * Returns { rules, situation }; the rules stay the same run to run, so they cache.
 */
export function prompt({ content: c, tasks, rules: how }, id) {
  const v = c.game;
  const seat = v ? v.seat : -1;
  const persona = PERSONAS.find((p) => p.id === id);
  const rules = [
    `${how}\n\nYou are ${id}${seat >= 0 ? `, in seat ${seat + 1}` : ''}: ${persona.blurb.toLowerCase()}.`,
    `How you talk: ${persona.voice}`,
    `How you play: ${persona.play}`,
    `When you think you are the spy: ${persona.spy}`,
  ].join('\n');
  const name = (p) => (p === id ? 'you' : isPerson(p) ? `${nameOf(c, p)}, a person` : p);
  const parts = [];
  const chat = c.lines.slice(-CHAT_SHOWN);
  if (chat.length) parts.push(['The table\'s chat, latest last:', ...chat.map((l) => `- ${name(l.by)}: "${l.text}"`)].join('\n'));
  if (v && seat >= 0) {
    const who = (i) => `seat ${i + 1}, ${i === seat ? 'you' : nameOf(c, c.players[i])}`;
    parts.push(`Your word: "${v.word}".`);
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
    const mine = c.thoughts[id] ?? [];
    if (mine.length) parts.push(['Your own earlier thinking:', ...mine.map((t) => `- Round ${t.round}: ${t.text}`)].join('\n'));
    if (v.phase === 'over') parts.push('The game is over: everyone\'s word and side are shown above.');
  }
  if (!v || v.phase === 'over') {
    parts.push(`At the table now: ${c.seated.map(name).join(', ')}.`);
    parts.push(`Now: ${tasks.map((t) => t.why).join(', and ')}. Answer if you will, as yourself: action say, with one short line in say, or an empty say to stay quiet.`);
  }
  if (v?.due) {
    const ask = v.due.kind === 'clue'
      ? `It is your turn to give a clue${v.runoff ? ' (you are in a tie: this clue may decide the vote)' : ''}: action clue, with it in say.`
      : v.due.kind === 'talk'
        ? `It is the discussion before the vote; you have ${v.due.left} line${v.due.left === 1 ? '' : 's'} left. ${tasks[0]?.why ?? 'The discussion goes on'}: action say, with your line in say, or an empty say to stay quiet.`
        : `Vote for the player you think is a spy: action vote, with the target's seat number, one of ${v.due.targets.map((i) => i + 1).join(', ')}.`;
    const refused = tasks.find((t) => t.refused)?.refused;
    parts.push(`Now: ${ask}${refused ? `\nYour last action was turned away: ${refused}` : ''}`);
  }
  return { rules, situation: parts.join('\n\n') };
}

export { MAX_CLUE, MAX_LINES };
