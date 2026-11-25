// The werewolf game (site/werewolf.html) as a world on the runtime's core
// (docs/app/worlds/werewolf.md; src/core/store.js, ledger.js,
// controller.js): `view` and `apply`, both pure. The table everyone
// shares: who is at it, the game (werewolf-rules.js), its chat, each AI
// player's thinking. `view` gives a member only
// what its seat may see, and its tasks; `apply` lands a change, or refuses
// it, saying why. No clock and no randomness: the time is each change's
// `at`, the deal comes in the host's `start` (dealt by the table's room,
// game-tables.js), and the clock is a member whose tasks are the
// deadlines and the narrator's calls.
//
// At night the narrator calls dusk, then each role, alive or not, for a
// fixed time, so how long a call lasts says nothing of who acted in it: a
// role's turn is listed once its call begins and is due by its end, when
// whoever has not acted takes the rules' fallback. After the witch's call,
// dawn. Players are often due at once (the wolves at night, everyone in a
// vote): the rules end a phase once all are in.
//
// The people are the host (HUMAN), whose page opened the table, and any
// friends who joined it by a link; the AI players fill the seats left, and
// sit at the table from when it opens, each saying hello as it sits down.
// The table chats whenever the game does not mute it, which a game on
// does: it has its own speeches. An AI player at it answers what concerns
// it, and plays by what the table agreed there, as far as the rules allow.

import { MAX_SPEECH, SIZES, act, cast, daybreak, due, fallback as sayNothing, newGame, turn, view as seatView } from './werewolf-rules.js';
import { DEPTH, LANGS, MAX_LINE, deadline, latest, line as newLine, named, speak, think as thought } from './game-kit.js';

export const HUMAN = 'you';
export const CLOCK = 'clock'; // the member whose tasks are the deadlines and the narrator's calls
export const MAX_PEOPLE = 8; // at the table, as at the largest game
export const TURN = 90_000; // ms a turn by day may take; then everyone still due is taken as doing nothing
export const CALLS = ['dusk', 'wolves', 'seer', 'witch']; // the narrator's calls each night, in order
export const CALL_MS = { dusk: 3000, wolves: 8000, seer: 8000, witch: 8000 }; // each call's length, long enough for a player's thinking and the model's answer
const SIZE = 7; // the seats of a new table's game, until the host picks another
const CHAT_SHOWN = 40; // the table's latest lines an AI player is shown

// Each AI player's character: who they are (`blurb`, shown on the page),
// how they talk and how long they go on (`voice`, `words`), how they play,
// how they lie as a werewolf, and what they do with a seer's or witch's secret;
// `zh`, the blurb in Chinese, for a table that plays in it.
export const PERSONAS = [
  {
    id: 'Rosa',
    blurb: 'A retired teacher who keeps the record',
    voice: 'You speak like the schoolteacher you were: orderly and patient, in tidy sentences, often numbering your points ("One: … Two: …"), and you gently correct anyone who gets the facts wrong.',
    words: 50,
    play: 'You keep score of who claimed what and who voted for whom, and suspect whoever\'s words and votes do not match. You vote on evidence and rarely change your mind.',
    wolf: 'You build a careful, reasonable-sounding case against a villager, and keep your own record perfectly straight so no one catches you out.',
    claim: 'As the seer you reveal yourself early, with a numbered list of your checks. As the witch you keep quiet unless telling would save the village.',
    zh: { blurb: '一位记录一切的退休教师' },
  },
  {
    id: 'Jax',
    blurb: 'Loud and fast; accuses first',
    voice: 'You are loud and sure of yourself. You speak in short, punchy bursts, often opening with one word ("Nope." "Called it!"), with exclamation marks.',
    words: 20,
    play: 'You accuse on your first hunch and vote early. If your case falls apart, you jump to the loudest case at the table without any embarrassment.',
    wolf: 'You attack hard to look like the most eager villager, and pick a fight with whoever suspects you.',
    claim: 'You can\'t keep a secret: as the seer you announce your check straight away; as the witch you say so the moment it helps.',
    zh: { blurb: '嗓门大、出手快，总是第一个指认' },
  },
  {
    id: 'Wen',
    blurb: 'A quiet poet who reads people',
    voice: 'You are a quiet poet. One or two calm sentences, often with an image ("his words came too smoothly, like water over a stone"). You never raise your voice.',
    words: 30,
    play: 'You watch for small things: who hesitated, who changed the subject, who was too quick to agree. You rarely accuse outright; you point at something and let others see it, and you often vote last.',
    wolf: 'You say even less than usual and let your images drift toward a villager, never quite accusing anyone.',
    claim: 'You hint at your role instead of saying it ("I have looked into one heart tonight") until hinting is no longer enough.',
    zh: { blurb: '一位会看人的安静诗人' },
  },
  {
    id: 'Otis',
    blurb: 'Sees a plot behind everything',
    voice: 'You ramble. You start with "Hear me out" or "Isn\'t it convenient that…", connect things that may not connect, and trail off into asides.',
    words: 55,
    play: 'You trust nobody, least of all whoever sounds most reasonable or whom everyone agrees with. You often vote against the crowd.',
    wolf: 'You spin an elaborate theory that points at whoever claims a power, and wrap your own partner into it as a fellow victim.',
    claim: 'You claim your role loudly, then suspect anyone else who claims one.',
    zh: { blurb: '觉得什么背后都有阴谋' },
  },
  {
    id: 'Priya',
    blurb: 'A trial lawyer who cross-examines',
    voice: 'You cross-examine. You put pointed questions to named players ("Answer me this, Bo: …"), demand a straight answer, and sum up for the jury. Crisp and a little theatrical.',
    words: 45,
    play: 'You press whoever is quietest or contradicts themselves, and vote for whoever dodged your questions.',
    wolf: 'You cross-examine a villager until they look guilty. If a seer accuses you, you claim seer too and attack their credibility.',
    claim: 'You hold your role back as evidence and reveal it when it will win the vote.',
    zh: { blurb: '擅长盘问的出庭律师' },
  },
  {
    id: 'Bo',
    blurb: 'A kind farmer who trusts too easily',
    voice: 'You are a farmer of few, simple words. Warm and folksy, with a farm saying now and then ("a fox doesn\'t knock before it comes in").',
    words: 25,
    play: 'You tend to believe people and stand up for anyone being piled on. You hate voting someone out and abstain when you are unsure; you vote only on clear evidence.',
    wolf: 'You stay friendly, gently defend your partner, and never accuse first; you just go along with a case someone else made.',
    claim: 'You tell the plain truth about your role as soon as anyone asks.',
    zh: { blurb: '心善、容易信人的农夫' },
  },
  {
    id: 'Nell',
    blurb: 'A nervous student who overthinks',
    voice: 'You are a nervous young student. You hesitate ("um, okay, so…"), apologise for suspecting anyone and over-explain, but your reasoning is sharp.',
    words: 55,
    play: 'You reason it through step by step, and your reads are often right, but you second-guess yourself and sometimes switch your vote at the last moment.',
    wolf: 'You get a little flustered and over-explain why you can\'t be a wolf, then nudge suspicion onto someone quiet.',
    claim: 'You are scared to claim a role and do so only when cornered or when it clearly matters.',
    zh: { blurb: '想太多的紧张学生' },
  },
];
export const isPerson = (id) => !PERSONAS.some((p) => p.id === id);

/**
 * A new table: the host alone, before a game. `people` are the host and
 * the friends at the table, in the order they joined; `names` theirs.
 * `size`: the seats of the next game. `game` is the rules' game once one
 * starts, number `no`, `players` its seats' ids. `call`: the narrator's
 * call tonight, { day, step, at }. `lines`: the chat, each line marked with
 * the `no` of the last game begun when it was said. `thoughts`: each AI
 * player's thinking. `since`: the `at` of the change that began the moment
 * (`moment`). `lang`: what the AI players speak, the host's page's (LANGS).
 */
export function newTable() {
  return { lang: 'en', people: [HUMAN], names: {}, size: SIZE, players: [], no: 0, game: null, call: null, lines: [], thoughts: {}, since: 0 };
}

const playing = (t) => Boolean(t.game) && t.game.phase !== 'over'; // the game is on
// Who sits at the table for the next game: the people first, then AI players in the seats left.
const seated = (t) => [...t.people.slice(0, t.size), ...PERSONAS.slice(0, Math.max(0, t.size - t.people.length)).map((p) => p.id)];
const here = (t, id) => !isPerson(id) || t.people.includes(id); // a friend who left plays on as doing nothing
const nameOf = (t, id) => (isPerson(id) ? t.names[id] ?? (id === HUMAN ? 'the host' : 'a friend') : id);
// The moment the table is at: a change made on another is stale. It moves
// with each turn of the game (`turn`, werewolf-rules.js).
const moment = (t) => (t.game ? `${t.no}:${turn(t.game)}` : '');
// Who is due now: at night, only once the narrator has called their step.
const dueNow = (t) => (t.game.phase === 'night' && t.call?.step !== t.game.step ? [] : due(t.game));
// When the moment's turns are due by: at night, the end of the call; by day, TURN after it began.
const ends = (t) => (t.game.phase === 'night' ? t.call.at + CALL_MS[t.call.step] : t.since + TURN);
const WHY = { kill: 'Your kill', check: 'Your check', potion: 'Your potions', speak: 'Your speech', last: 'Your last words', vote: 'Your vote' };

// ---- tasks ----

// What player `id`, in `seat`, is due to do: in a game, its turn; out of
// one, an AI player at the table, its hello and each line that asks it.
function tasksOf(t, id, seat) {
  if (!playing(t)) return isPerson(id) || !seated(t).includes(id) ? [] : chatTasks(t, id);
  if (seat < 0 || !here(t, id)) return [];
  const mine = dueNow(t).find((d) => d.seat === seat);
  return mine ? [{ given: `turn:${moment(t)}`, as: id, kind: 'turn', from: [], depth: 0, at: ends(t), why: WHY[mine.kind] }] : [];
}

// An AI player new to the table, which has said no line at it and did not
// play the last game, says hello. A line
// since the last game began asks the AI players it names, under DEPTH; a
// person's line to everyone, the one whose last line is oldest.
function chatTasks(t, id) {
  const hello = t.lines.some((l) => l.by === id) || t.players.includes(id) ? [] : [{ given: `hello:${id}`, as: id, kind: 'ask', from: [], depth: 0, why: 'You just sat down at the table: say hello' }];
  return [...hello, ...t.lines.filter((l) => l.no === t.no && l.by !== id && l.depth < DEPTH && (l.to.includes(id) || (isPerson(l.by) && !l.to.length && answerer(t, l) === id)))
    .map((l) => ({ given: `line:${t.no}:${l.id}`, as: id, kind: 'ask', from: l.from, depth: l.depth, why: `${nameOf(t, l.by)} said "${l.text}"${l.to.length ? '' : ' to everyone'}` }))];
}
// Who answers a person's line `l` to everyone: the AI player at the table whose last line before it is oldest; ties in seat order.
function answerer(t, l) {
  const last = (p) => t.lines.findLast((x) => x.id < l.id && x.by === p)?.id ?? 0;
  return seated(t).filter((p) => !isPerson(p)).reduce((a, p) => (a === null || last(p) < last(a) ? p : a), null);
}

// The clock's: at night, the end of each call; by day, the end of a turn,
// when everyone still due takes the rules' fallback.
function clockTasks(t) {
  if (!playing(t)) return [];
  if (t.game.phase === 'night') return [deadline(`call:${t.no}:${t.call.day}:${t.call.step}`, CLOCK, ends(t), 'The next call')];
  return [deadline(`expire:${moment(t)}`, CLOCK, ends(t), 'The turn is up')];
}

// What `id` may do now: its turn's actions; out of a game, chat.
function actionsOf(t, id, seat) {
  if (playing(t)) {
    const mine = seat < 0 ? null : dueNow(t).find((d) => d.seat === seat);
    if (!mine) return [];
    if (mine.kind !== 'potion') return { kill: ['kill'], check: ['check'], speak: ['speak'], last: ['speak'], vote: ['vote', 'abstain'] }[mine.kind];
    const { due: can } = seatView(t.game, seat);
    return [can.save && 'save', can.poison && 'poison', 'pass'].filter(Boolean);
  }
  return t.people.includes(id) || seated(t).includes(id) ? ['chat'] : [];
}

// ---- the world ----

/**
 * The game as seat `seat` sees it (the rules' `view`): at night, the step
 * the narrator has called, its turn only once called, and whom the wolves
 * attacked only in the witch's call.
 */
function gameView(t, seat) {
  const v = seatView(t.game, seat);
  if (!playing(t) || t.game.phase !== 'night') return v;
  const step = t.call.step;
  return { ...v, step, due: step === t.game.step ? v.due : null, log: v.log.filter((e) => !(e.type === 'attacked' && e.day === t.game.day && step !== 'witch')) };
}

/**
 * What `member` sees: `content`, the table as its seat may see it (its
 * role and its night's secrets, never another's, until the game is over;
 * its own thinking, and everyone's once it is over); `actions`; `tasks`;
 * `seen`, whose presence it sees (by day, everyone's; at night, its own
 * and, a wolf's, its pack's); `rules`, how the game is played, in words.
 */
function view(t, member) {
  const seat = t.players.indexOf(member);
  const { people, names, size, players, no, lines, lang = 'en' } = t;
  const game = t.game && gameView(t, seat);
  const night = playing(t) && t.game.phase === 'night';
  return {
    content: {
      lang, people, names, size, seated: seated(t), players, no, lines, game,
      call: night ? { ...t.call, ends: ends(t) } : null,
      thoughts: t.game?.phase === 'over' ? t.thoughts : seat < 0 ? {} : { [member]: latest(t.thoughts, member) },
      moment: moment(t),
    },
    actions: actionsOf(t, member, seat),
    tasks: member === CLOCK ? clockTasks(t) : tasksOf(t, member, seat),
    seen: night ? [...new Set([member, ...(game.pack ?? []).map((i) => t.players[i])])] : [...new Set([...t.people, ...t.players])],
    rules: RULES,
  };
}

/**
 * Lands `change` ({ by, at, base, answers, body }), or { refused: why }.
 * `body`, by `type`:
 *   start { size, roles }        the host: a game of `roles` (a shuffle of
 *                                the rules' `cast(size)`), the people at the
 *                                table first, then AI players in the seats left
 *   size { size }                the host: the next game's seats
 *   join { name }                a person sits at the table, or renames
 *   lang { lang }                the host: what the AI players speak from now on
 *   leave                        a friend leaves: in a game, each of their turns is taken as doing nothing
 *   kill { target, text? }, check { target }, save, poison { target }, pass,
 *   speak { text }, vote { target }, abstain, chat { text }
 *                                made on `base`, the moment; an AI player's with its `thinking`
 * The clock's change answers its task. After each, a friend gone is taken
 * as doing nothing, and a night that has begun is called from dusk.
 */
function apply(t, change) {
  const next = step(t, change);
  return next.refused ? next : { state: settle(next, t, change.at), effects: [] };
}

// A turn no one played (the ledger's): the rules' fallback for its seat.
function fallback(t, task, at) {
  const seat = t.players.indexOf(task.as);
  return settle(playing(t) && seat >= 0 ? { ...t, game: sayNothing(t.game, [seat]) } : t, t, at);
}

export const world = { view, apply, fallback, tries: 3 };

function step(t, { by, at, base, answers = [], body }) {
  if (by === CLOCK) return tick(t, answers[0], at);
  const b = body ?? {};
  if (b.type === 'start') return start(t, by, b);
  if (b.type === 'size') return resize(t, by, b.size);
  if (b.type === 'join') return join(t, by, b.name);
  if (b.type === 'leave') return leave(t, by);
  if (b.type === 'lang') return by === HUMAN && LANGS.includes(b.lang) ? { ...t, lang: b.lang } : { refused: 'Only the host sets the language.' };
  if (base !== moment(t)) return { refused: 'Stale: the game moved on before your action landed.' };
  if (b.type === 'chat') return chat(t, by, b, answers);
  if (!playing(t)) return { refused: 'There is no game on: chat instead.' };
  const seat = t.players.indexOf(by);
  if (!dueNow(t).some((d) => d.seat === seat) && due(t.game).some((d) => d.seat === seat)) return { refused: 'Wait for the narrator to call you.' };
  const game = act(t.game, seat, { type: String(b.type), target: b.target, text: b.text, at: turn(t.game) });
  if (game.error) return { refused: game.error };
  return think({ ...t, game }, t, by, b);
}

// After a change: a night that has begun is called from dusk; a friend
// gone is taken as doing nothing on their turn; a new moment begins at `at`.
function settle(t, before, at) {
  for (;;) {
    if (playing(t) && t.game.phase === 'night' && t.call?.day !== t.game.day) t = { ...t, call: { day: t.game.day, step: 'dusk', at } };
    const gone = playing(t) ? dueNow(t).filter((d) => !here(t, t.players[d.seat])).map((d) => d.seat) : [];
    if (!gone.length) break;
    t = { ...t, game: sayNothing(t.game, gone) };
  }
  return moment(t) === moment(before) ? t : { ...t, since: at };
}

// The clock's task `given` is due: it lands, at `at`.
function tick(t, given, at) {
  if (!clockTasks(t).some((task) => task.given === given)) return { refused: 'Not due.' };
  const kind = given.split(':')[0];
  if (kind === 'expire') return { ...t, game: sayNothing(t.game) };
  // A call is over: whoever its role still has due does nothing; the next role is called, or, after the witch, dawn.
  const { step: called } = t.call;
  const game = t.game.step === called ? sayNothing(t.game) : t.game;
  const next = CALLS[CALLS.indexOf(called) + 1];
  return next ? { ...t, game, call: { ...t.call, step: next, at } } : { ...t, game: daybreak(game), call: null };
}

function start(t, by, { size, roles }) {
  if (by !== HUMAN) return { refused: 'Only the host starts a game.' };
  if (playing(t)) return { refused: 'A game is on.' };
  if (!SIZES.includes(size) || !Array.isArray(roles) || [...roles].sort().join() !== cast(size).sort().join()) return { refused: `A game is ${SIZES.join(', ')} seats, dealt their roles.` };
  const next = { ...t, size };
  return { ...next, players: seated(next), game: newGame(roles), no: t.no + 1, call: null, thoughts: {} };
}

// The host picks how many seats the next game has: AI players sit down or get up for it.
function resize(t, by, size) {
  if (by !== HUMAN) return { refused: 'Only the host sets the table.' };
  if (playing(t)) return { refused: 'A game is on.' };
  if (!SIZES.includes(size)) return { refused: `A game is ${SIZES.join(', ')} seats.` };
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

// A line in the chat, by someone at the table, while the game does not mute it.
function chat(t, by, b, answers) {
  if (playing(t)) return { refused: 'Not now: the game is on.' };
  if (!actionsOf(t, by, -1).includes('chat')) return { refused: 'You are not at the table.' };
  const text = String(b.text ?? '').trim().slice(0, MAX_LINE);
  if (!text) return { refused: 'Say something.' };
  const asked = tasksOf(t, by, -1).filter((x) => answers.includes(x.given));
  const to = named([...new Set([...seated(t), ...t.people])], (id) => (!isPerson(id) || t.names[id] ? nameOf(t, id) : ''), text);
  return think({ ...t, lines: [...t.lines, newLine(t.lines, { by, text, to, person: isPerson(by), asked, no: t.no })] }, t, by, b);
}

// An AI player's thinking lands with its change, as of the moment it was made on (`before`).
function think(t, before, by, b) {
  if (isPerson(by) || !b.thinking) return t;
  const action = b.type === 'chat' ? null : { type: b.type, ...(Number.isInteger(b.target) ? { target: b.target } : {}) };
  return { ...t, thoughts: thought(t.thoughts, by, { day: before.game?.day ?? 0, phase: before.game?.phase ?? 'over', text: String(b.thinking), action }) };
}

// ---- what an AI player is shown ----

export const ROLE_NAMES = { wolf: 'werewolf', seer: 'seer', witch: 'witch', villager: 'villager' };

const RULES = `You are a player in a game of werewolf (狼人杀) with people and other AI players. Each player has a secret role:
- Werewolves (2): each night they pick one player to kill, together. They know each other. They win once they are as many as everyone else alive.
- Seer (1): each night, checks one player and learns whether they are a werewolf.
- Witch (1): has two potions, each usable once a game: a save, which brings back the wolves' victim of that night (never herself), and a poison, which kills a player she picks. At most one potion a night. She is told whom the wolves attacked only while she still has the save.
- Villagers: no power.
The seer, the witch and the villagers are the village. The village wins once every werewolf is dead.

A night: the werewolves pick their kill (if they disagree, they pick once more, seeing each other's picks; then the most picked); then the seer checks someone; then the witch. Dawn says who died, not how. Then each living player gives one speech, in seat order. Then everyone alive votes at once, for another living player, or abstains. The player with the most votes is out and gives last words; on a tie, or no votes, no one is out. Then night falls again. The dead do not speak, and their roles stay secret until the game ends.

Anyone may lie about their role, and werewolves usually do. A game master runs the game and checks every action: one that is not legal, or comes after the game moved on, is turned away and you are asked again.

You are woken when you have something to do. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences. No one sees it until the game is over; then the people may read it.
- action: what you do now, always. { "type": one of kill, check, save, poison, pass, speak, vote, abstain, "target": a seat number, for kill, check, poison and vote }.
- say: on a speech or last words, what you say to everyone: about as long as your character's speeches, never over ${MAX_SPEECH} characters, in your own voice, as spoken at a table. With a werewolf's kill, an optional line only the other werewolves hear. Left out otherwise.

The table also chats, outside a game: you say hello when you sit down, and answer when someone asks you or speaks to everyone. Whatever the table agreed there holds through the games, as far as these rules allow: the language to speak above all. Speak the language the table speaks.

Play to win for your side, as yourself. Talk only in your own voice: never take up another player's catchphrases. The players marked "a person" are people, not AI players: speak to each by name, or as "you" when you answer them. Be quick.`;

// The tool the model answers with, as INFER (agents/ponjo-core.mjs) takes tools.
export const DECIDE = {
  name: 'decide',
  description: 'Your private thinking, what you do now, and what you say.',
  parameters: {
    type: 'object',
    properties: {
      thinking: { type: 'string', description: 'Private reasoning, one to three short sentences.' },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['kill', 'check', 'save', 'poison', 'pass', 'speak', 'vote', 'abstain'] },
          target: { type: 'integer', description: 'A seat number, for kill, check, poison and vote.' },
        },
        required: ['type'],
      },
      say: { type: 'string', description: 'Your speech or last words; with a kill, an optional line to the other werewolves.' },
    },
    required: ['thinking', 'action'],
  },
};

/**
 * The model's answer as a change's body, for a view whose `actions` are
 * these: seats are numbered from 1 in what a player is shown, from 0 here;
 * a speech with no action is a speech; in the chat, an empty line is nothing (null).
 */
export function decided(args, actions) {
  const a = args?.action && typeof args.action === 'object' ? args.action : null;
  const thinking = String(args?.thinking ?? '');
  const text = typeof args?.say === 'string' ? args.say : '';
  if (actions.includes('chat')) return text.trim() ? { type: 'chat', text: text.slice(0, MAX_LINE), thinking } : null;
  const target = Number.isInteger(a?.target) ? a.target - 1 : undefined;
  return { type: a ? String(a.type) : actions.includes('speak') ? 'speak' : '', thinking, ...(text ? { text } : {}), ...(target !== undefined ? { target } : {}) };
}

// One entry of the log, in words, for the player whose view `v` it is in; `who(i)` names seat i.
function entryText(v, e, who) {
  const names = (list) => (list.length ? list.map(who).join(' and ') : 'no one');
  switch (e.type) {
    case 'night': return `Night ${e.day} falls.`;
    case 'pick': return `${who(e.seat)} wants to kill ${who(e.target)}${e.round === 2 ? ' (second pick)' : ''}${e.text ? `, and says to the pack: "${e.text}"` : '.'}`;
    case 'kill': return e.target === null ? 'The pack killed no one tonight.' : `The pack chose to kill ${who(e.target)}.`;
    case 'check': return `${e.seat === v.seat ? 'You' : who(e.seat)} checked ${who(e.target)}: ${e.wolf ? 'a WEREWOLF' : 'not a werewolf'}.`;
    case 'attacked': return `The werewolves attacked ${who(e.target)} tonight.`;
    case 'save': return `${e.seat === v.seat ? 'You' : who(e.seat)} used the save on ${who(e.target)}.`;
    case 'poison': return `${e.seat === v.seat ? 'You' : who(e.seat)} poisoned ${who(e.target)}.`;
    case 'dawn': return `Day ${e.day}. ${e.deaths.length ? `${names(e.deaths)} died in the night.` : 'No one died in the night.'}`;
    case 'speech': return `${who(e.seat)}${e.silent ? ' said nothing.' : `: "${e.text}"`}`;
    case 'vote': {
      const votes = Object.entries(e.votes).map(([s, t]) => `${who(Number(s))} → ${t === null ? 'abstained' : who(t)}`);
      return `The vote: ${votes.join('; ')}. ${e.out === null ? 'A tie or no votes: no one is out.' : `${who(e.out)} is out.`}`;
    }
    case 'last': return `${who(e.seat)}, last words${e.silent ? ': nothing.' : `: "${e.text}"`}`;
    case 'over': return `The game is over: ${e.winner === 'village' ? 'the village' : 'the werewolves'} won.`;
    default: return '';
  }
}

const ASK = {
  kill: 'Pick the player the werewolves kill tonight: action kill, with a target that is not a werewolf. You may add a say: a line only the pack hears.',
  check: 'Pick a player to check: action check, with a target.',
  potion: 'Use a potion or not: action save, poison with a target, or pass.',
  speak: 'It is your turn to speak: action speak, with your speech in say.',
  last: 'You were voted out. Give your last words: action speak, with them in say.',
  vote: 'Vote: action vote with a target, or abstain.',
};

/**
 * What AI player `id` is shown, from its `view` alone, so another
 * player's role or a night's secrets can reach it only if its seat may
 * know them: the rules and its own style, then the table's chat, the
 * game as its seat sees it, and what its tasks ask. Returns { rules, situation }; the rules stay
 * the same run to run, so they cache.
 */
export function prompt({ content: c, tasks, rules: how }, id) {
  const v = c.game;
  const seat = v ? v.seat : -1;
  const persona = PERSONAS.find((p) => p.id === id);
  const rules = [
    `${how}${speak(c.lang)}\n\nYou are ${id}${seat >= 0 ? `, in seat ${seat + 1}` : ''}: ${persona.blurb.toLowerCase()}.`,
    `How you talk: ${persona.voice} Your speeches run to about ${persona.words} words.`,
    `How you play: ${persona.play}`,
    `As a werewolf: ${persona.wolf}`,
    `As the seer or the witch: ${persona.claim}`,
    'Your character colours how you talk and play; still, you play to win for your side.',
  ].join('\n');
  const name = (p) => (p === id ? 'you' : isPerson(p) ? `${nameOf(c, p)}, a person` : p);
  const parts = [];
  const chat = c.lines.slice(-CHAT_SHOWN);
  if (chat.length) parts.push(['The table\'s chat, latest last:', ...chat.map((l) => `- ${name(l.by)}: "${l.text}"`)].join('\n'));
  if (v && seat >= 0) {
    const who = (i) => `seat ${i + 1}, ${name(c.players[i])}${v.seats[i].role ? ` (${ROLE_NAMES[v.seats[i].role]})` : ''}`;
    parts.push(`Your role: ${ROLE_NAMES[v.role]}.${v.pack ? ` The werewolves: ${v.pack.map(who).join(' and ')}.` : ''}${v.potions ? ` Your potions: save ${v.potions.save ? 'unused' : 'used'}, poison ${v.potions.poison ? 'unused' : 'used'}.` : ''}`);
    parts.push(['The players, in seat order:', ...v.seats.map((s, i) => `- ${who(i)}: ${s.alive ? 'alive' : 'dead'}`)].join('\n'));
    parts.push(['What has happened, as you saw it:', ...v.log.map((e) => `- ${entryText(v, e, who)}`)].join('\n'));
    const mine = c.thoughts[id] ?? [];
    if (mine.length) parts.push(['Your own earlier thinking:', ...mine.map((t) => `- ${t.phase === 'night' ? 'Night' : 'Day'} ${t.day}: ${t.text}`)].join('\n'));
    if (v.phase === 'over') parts.push('The game is over: every role is shown above.');
  }
  if (!v || v.phase === 'over') {
    parts.push(`At the table now: ${c.seated.map(name).join(', ')}.${c.people.length > c.seated.filter(isPerson).length ? ` Watching: ${c.people.filter((p) => !c.seated.includes(p)).map(name).join(', ')}.` : ''}`);
    parts.push(`Now: ${tasks.map((t) => t.why).join(', and ')}. Answer if you will, as yourself: action speak, with one short line in say, or an empty say to stay quiet.`);
  }
  if (v?.due) {
    const extra = v.due.kind === 'potion' ? ` You may: ${[v.due.save && 'save', v.due.poison && 'poison', 'pass'].filter(Boolean).join(', ')}.` : v.due.kind === 'kill' && v.due.round === 2 ? ' The pack disagreed: pick once more.' : '';
    const refused = tasks.find((t) => t.refused)?.refused;
    parts.push(`Now: ${ASK[v.due.kind]}${extra}${refused ? `\nYour last action was turned away: ${refused}` : ''}`);
  }
  return { rules, situation: parts.join('\n\n') };
}

export { MAX_SPEECH, cast };
