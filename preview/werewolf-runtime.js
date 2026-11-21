// The werewolf page's runtime (site/werewolf.html), the way the poker page's
// runs (preview/poker-runtime.js) and Ponjo's buddies do
// (docs/agent-runtime.md): one game everyone shares, with a change log;
// `plan`, which looks at the game and says which players are due, never
// acting on an event itself; `prompt`, what a player is shown, built from
// its seat's `view` alone; and `land`, the one writer, which lands proposals
// in order and turns away a stale or illegal one. Unlike poker, players are
// often due at once (the wolves at night, everyone in a vote): the writer
// collects their actions, and the rules end the phase once all are in, or
// `expire` once its time is up. A day's speech is a player's action on its
// turn, not side chat. Pure but for `game`, which `land` and `expire`
// change; the page (preview/werewolf.js) runs the model and draws the game.

import { MAX_SPEECH, act, cast, deal, due, fallback, newGame as start, turn, view } from './werewolf-rules.js';

export const HUMAN = 'you';
const MAX_TRIES = 3; // proposals turned away on one turn before the world's fallback plays for the player
const THOUGHTS_SHOWN = 8; // a player's own latest thinking its prompt has

// Each AI player's character: who they are (`blurb`, shown on the page),
// how they talk and how long they go on (`voice`, `words`), how they play,
// how they lie as a werewolf, what they do with a seer's or witch's secret,
// and the line they greet the table with.
export const PERSONAS = [
  {
    id: 'Rosa',
    blurb: 'A retired teacher who keeps the record',
    voice: 'You speak like the schoolteacher you were: orderly and patient, in tidy sentences, often numbering your points ("One: … Two: …"), and you gently correct anyone who gets the facts wrong.',
    words: 50,
    play: 'You keep score of who claimed what and who voted for whom, and suspect whoever\'s words and votes do not match. You vote on evidence and rarely change your mind.',
    wolf: 'You build a careful, reasonable-sounding case against a villager, and keep your own record perfectly straight so no one catches you out.',
    claim: 'As the seer you reveal yourself early, with a numbered list of your checks. As the witch you keep quiet unless telling would save the village.',
    hello: 'Good evening, everyone. Rosa. I\'ll be keeping notes, so do try to be consistent.',
  },
  {
    id: 'Jax',
    blurb: 'Loud and fast; accuses first',
    voice: 'You are loud and sure of yourself. You speak in short, punchy bursts, often opening with one word ("Nope." "Called it!"), with exclamation marks.',
    words: 20,
    play: 'You accuse on your first hunch and vote early. If your case falls apart, you jump to the loudest case at the table without any embarrassment.',
    wolf: 'You attack hard to look like the most eager villager, and pick a fight with whoever suspects you.',
    claim: 'You can\'t keep a secret: as the seer you announce your check straight away; as the witch you say so the moment it helps.',
    hello: 'Jax! Let\'s go. I can smell a wolf already.',
  },
  {
    id: 'Wen',
    blurb: 'A quiet poet who reads people',
    voice: 'You are a quiet poet. One or two calm sentences, often with an image ("his words came too smoothly, like water over a stone"). You never raise your voice.',
    words: 30,
    play: 'You watch for small things: who hesitated, who changed the subject, who was too quick to agree. You rarely accuse outright; you point at something and let others see it, and you often vote last.',
    wolf: 'You say even less than usual and let your images drift toward a villager, never quite accusing anyone.',
    claim: 'You hint at your role instead of saying it ("I have looked into one heart tonight") until hinting is no longer enough.',
    hello: 'Wen. The fire is warm tonight. Some of us are not.',
  },
  {
    id: 'Otis',
    blurb: 'Sees a plot behind everything',
    voice: 'You ramble. You start with "Hear me out" or "Isn\'t it convenient that…", connect things that may not connect, and trail off into asides.',
    words: 55,
    play: 'You trust nobody, least of all whoever sounds most reasonable or whom everyone agrees with. You often vote against the crowd.',
    wolf: 'You spin an elaborate theory that points at whoever claims a power, and wrap your own partner into it as a fellow victim.',
    claim: 'You claim your role loudly, then suspect anyone else who claims one.',
    hello: 'Otis. Hear me out: seven strangers round a fire in the woods? Nobody else finds that suspicious?',
  },
  {
    id: 'Priya',
    blurb: 'A trial lawyer who cross-examines',
    voice: 'You cross-examine. You put pointed questions to named players ("Answer me this, Bo: …"), demand a straight answer, and sum up for the jury. Crisp and a little theatrical.',
    words: 45,
    play: 'You press whoever is quietest or contradicts themselves, and vote for whoever dodged your questions.',
    wolf: 'You cross-examine a villager until they look guilty. If a seer accuses you, you claim seer too and attack their credibility.',
    claim: 'You hold your role back as evidence and reveal it when it will win the vote.',
    hello: 'Priya. Let the record show I am here to find the truth, and I will be asking questions.',
  },
  {
    id: 'Bo',
    blurb: 'A kind farmer who trusts too easily',
    voice: 'You are a farmer of few, simple words. Warm and folksy, with a farm saying now and then ("a fox doesn\'t knock before it comes in").',
    words: 25,
    play: 'You tend to believe people and stand up for anyone being piled on. You hate voting someone out and abstain when you are unsure; you vote only on clear evidence.',
    wolf: 'You stay friendly, gently defend your partner, and never accuse first; you just go along with a case someone else made.',
    claim: 'You tell the plain truth about your role as soon as anyone asks.',
    hello: 'Evening, folks. Bo. Don\'t reckon any of you are wolves, but we\'ll see.',
  },
  {
    id: 'Nell',
    blurb: 'A nervous student who overthinks',
    voice: 'You are a nervous young student. You hesitate ("um, okay, so…"), apologise for suspecting anyone and over-explain, but your reasoning is sharp.',
    words: 55,
    play: 'You reason it through step by step, and your reads are often right, but you second-guess yourself and sometimes switch your vote at the last moment.',
    wolf: 'You get a little flustered and over-explain why you can\'t be a wolf, then nudge suspicion onto someone quiet.',
    claim: 'You are scared to claim a role and do so only when cornered or when it clearly matters.',
    hello: 'Um, hi. I\'m Nell. Sorry, I\'ve never played this with, um, strangers before.',
  },
];

/**
 * A new game at a table of `size`: the person in seat 0, then AI players,
 * `ids` or the first of PERSONAS. `roles` are each seat's; dealt at random
 * if left out. Notes, per AI player: its thinking, and how its last
 * proposal went.
 */
export function newGame(size = 7, { ids = PERSONAS.slice(0, size - 1).map((p) => p.id), roles = deal(size) } = {}) {
  const players = [HUMAN, ...ids];
  return {
    rev: 0, log: [], players, state: start(roles),
    notes: Object.fromEntries(ids.map((id) => [id, { tries: 0, triesAt: '', rejected: '', failed: null, thoughts: [] }])),
  };
}
export const isPerson = (id) => id === HUMAN;
export const seatOf = (game, id) => game.players.indexOf(id);

// Every change lands here: a revision, a line in the log.
function commit(game, change) {
  game.rev++;
  game.log.push({ rev: game.rev, ...change });
}

/**
 * Who is due now, all at once: [{ id, seat, kind }], `kind` as the rules
 * say (kill, check, potion, speak, vote, last). `running`: the ids with a
 * run going, never due. A player whose run failed on this turn waits for Retry.
 */
export function plan(game, running = new Set()) {
  const at = turn(game.state);
  return due(game.state).flatMap(({ seat, kind }) => {
    const id = game.players[seat];
    if (isPerson(id) || running.has(id) || game.notes[id].failed?.at === at) return [];
    return [{ id, seat, kind }];
  });
}

// A run begins on the game as it is now: the moment its action will be for.
export function begin(game, id) {
  game.notes[id].failed = null;
  return { at: turn(game.state) };
}

// A run failed (the model could not be reached): nothing lands; it waits for Retry, or the timer.
export function fail(game, id, basis, why) {
  game.notes[id].failed = { at: basis.at, why };
  commit(game, { type: 'failed', by: id, why });
}
export function retry(game, id) {
  game.notes[id].failed = null;
  commit(game, { type: 'retry', by: id });
}

/**
 * The writer: lands `id`'s proposal { thinking, action, say }, made on
 * `basis` (what `begin` gave its run), or turns it away. `say` is the
 * speech on a speaking turn, and a line to the pack with a wolf's kill. The
 * rules turn away an action that is illegal, or made on a moment the game
 * has left; turned away, an AI player is asked again on the game as it is,
 * told why, up to MAX_TRIES, and then the rules' fallback plays for it.
 * Returns { landed, rejected }.
 */
export function land(game, id, basis, { thinking = '', action = null, say = '' }) {
  const seat = seatOf(game, id);
  const n = game.notes[id];
  const mine = due(game.state).find((d) => d.seat === seat);
  const speaking = mine && (mine.kind === 'speak' || mine.kind === 'last');
  const proposed = { ...(action ?? (speaking ? { type: 'speak' } : {})), at: basis.at };
  if (typeof say === 'string' && (proposed.type === 'speak' || proposed.type === 'kill')) proposed.text = say;
  if (n && thinking) n.thoughts.push({ day: game.state.day, phase: game.state.phase, kind: mine?.kind ?? null, text: String(thinking), action: action && { ...action } });
  const out = act(game.state, seat, proposed);
  if (!out.error) {
    game.state = out;
    commit(game, { type: 'action', by: id, kind: mine.kind });
    if (n) n.rejected = '';
    return { landed: true, rejected: null };
  }
  commit(game, { type: 'rejected', by: id, why: out.error });
  if (n) {
    const at = turn(game.state);
    const still = due(game.state).some((d) => d.seat === seat);
    n.tries = n.triesAt === at ? n.tries + 1 : 1;
    n.triesAt = at;
    n.rejected = still ? `Your last action was turned away: ${out.error}` : '';
    if (still && n.tries >= MAX_TRIES) {
      game.state = fallback(game.state, [seat]);
      commit(game, { type: 'action', by: id, kind: mine.kind, forced: true });
      n.rejected = '';
    }
  }
  return { landed: false, rejected: out.error };
}

// The turn's time is up: everyone still due is taken as doing nothing (the rules' `fallback`).
export function expire(game) {
  const late = due(game.state).map((d) => game.players[d.seat]);
  if (!late.length) return;
  game.state = fallback(game.state);
  commit(game, { type: 'expired', late });
}

// ---- what a player is shown ----

export const ROLE_NAMES = { wolf: 'werewolf', seer: 'seer', witch: 'witch', villager: 'villager' };

export const RULES = `You are a player in a game of werewolf (狼人杀) with a person and other AI players. Each player has a secret role:
- Werewolves (2): each night they pick one player to kill, together. They know each other. They win once they are as many as everyone else alive.
- Seer (1): each night, checks one player and learns whether they are a werewolf.
- Witch (1): has two potions, each usable once a game: a save, which brings back the wolves' victim of that night (never herself), and a poison, which kills a player she picks. At most one potion a night. She is told whom the wolves attacked only while she still has the save.
- Villagers: no power.
The seer, the witch and the villagers are the village. The village wins once every werewolf is dead.

A night: the werewolves pick their kill (if they disagree, they pick once more, seeing each other's picks; then the most picked); then the seer checks someone; then the witch. Dawn says who died, not how. Then each living player gives one speech, in seat order. Then everyone alive votes at once, for another living player, or abstains. The player with the most votes is out and gives last words; on a tie, or no votes, no one is out. Then night falls again. The dead do not speak, and their roles stay secret until the game ends.

Anyone may lie about their role, and werewolves usually do. A game master runs the game and checks every action: one that is not legal, or comes after the game moved on, is turned away and you are asked again.

You are woken when you have something to do. Each time, answer with one call to the decide tool:
- thinking: your private reasoning in one to three short sentences. No one sees it until the game is over; then the person may read it.
- action: what you do now, always. { "type": one of kill, check, save, poison, pass, speak, vote, abstain, "target": a seat number, for kill, check, poison and vote }.
- say: on a speech or last words, what you say to everyone: about as long as your character's speeches, never over ${MAX_SPEECH} characters, in your own voice, as spoken at a table. With a werewolf's kill, an optional line only the other werewolves hear. Left out otherwise.

Play to win for your side, as yourself. Talk only in your own voice: never take up another player's catchphrases. The person is "the person" (seat 1): speak to them as "you". Be quick.`;

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

// The model's answer as the writer takes it: seats are numbered from 1 in what a player is shown, from 0 here.
export function decided(args) {
  const a = args?.action && typeof args.action === 'object' ? args.action : null;
  const target = Number.isInteger(a?.target) ? a.target - 1 : undefined;
  return { thinking: String(args?.thinking ?? ''), action: a && { type: String(a.type), ...(target !== undefined ? { target } : {}) }, say: typeof args?.say === 'string' ? args.say : '' };
}

// A seat as a player is shown it: "seat 3, Wen", with its role when that player may know it.
const seatName = (game, v, i) => `seat ${i + 1}, ${i === v.seat ? 'you' : isPerson(game.players[i]) ? 'the person' : game.players[i]}${v.seats[i].role ? ` (${ROLE_NAMES[v.seats[i].role]})` : ''}`;

// One entry of the log, in words, for the player whose view `v` it is in.
function entryText(game, v, e) {
  const who = (i) => seatName(game, v, i);
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
 * What player `id` is shown now: the rules and its own style, then the
 * game as its seat's `view` has it, and nothing else, so another player's
 * role or a night's secrets can reach it only if that seat may know them.
 * Returns { rules, situation }; the rules stay the same run to run, so they cache.
 */
export function prompt(game, id) {
  const seat = seatOf(game, id);
  const v = view(game.state, seat);
  const persona = PERSONAS.find((p) => p.id === id);
  const rules = [
    `${RULES}\n\nYou are ${id}, in seat ${seat + 1}: ${persona.blurb.toLowerCase()}.`,
    `How you talk: ${persona.voice} Your speeches run to about ${persona.words} words.`,
    `How you play: ${persona.play}`,
    `As a werewolf: ${persona.wolf}`,
    `As the seer or the witch: ${persona.claim}`,
    'Your character colours how you talk and play; still, you play to win for your side.',
  ].join('\n');
  const parts = [];
  parts.push(`Your role: ${ROLE_NAMES[v.role]}.${v.pack ? ` The werewolves: ${v.pack.map((i) => seatName(game, v, i)).join(' and ')}.` : ''}${v.potions ? ` Your potions: save ${v.potions.save ? 'unused' : 'used'}, poison ${v.potions.poison ? 'unused' : 'used'}.` : ''}`);
  parts.push(['The players, in seat order:', ...v.seats.map((s, i) => `- ${seatName(game, v, i)}: ${s.alive ? 'alive' : 'dead'}`)].join('\n'));
  parts.push(['What has happened, as you saw it:', ...v.log.map((e) => `- ${entryText(game, v, e)}`)].join('\n'));
  const mine = game.notes[id].thoughts.slice(-THOUGHTS_SHOWN);
  if (mine.length) parts.push(['Your own earlier thinking:', ...mine.map((t) => `- ${t.phase === 'night' ? 'Night' : 'Day'} ${t.day}: ${t.text}`)].join('\n'));
  if (v.due) {
    const extra = v.due.kind === 'potion' ? ` You may: ${[v.due.save && 'save', v.due.poison && 'poison', 'pass'].filter(Boolean).join(', ')}.` : v.due.kind === 'kill' && v.due.round === 2 ? ' The pack disagreed: pick once more.' : '';
    parts.push(`Now: ${ASK[v.due.kind]}${extra}${game.notes[id].rejected ? `\n${game.notes[id].rejected}` : ''}`);
  }
  return { rules, situation: parts.join('\n\n') };
}

// What the page draws: the person's own view, and each seat's name.
export const show = (game) => view(game.state, seatOf(game, HUMAN));
export { MAX_SPEECH, cast, turn };
