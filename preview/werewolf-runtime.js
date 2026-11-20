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

import { MAX_SPEECH, act, deal, due, fallback, newGame as start, turn, view } from './werewolf-rules.js';

export const HUMAN = 'you';
const MAX_TRIES = 3; // proposals turned away on one turn before the world's fallback plays for the player
const THOUGHTS_SHOWN = 8; // a player's own latest thinking its prompt has

export const PERSONAS = [
  {
    id: 'Rosa',
    blurb: 'A retired teacher who keeps notes',
    style: 'You are a retired schoolteacher: orderly, patient and precise. You keep score out loud: who claimed what, who voted for whom, what does not add up. You speak in tidy sentences, sometimes numbering your points, and you gently correct anyone who gets the facts wrong.',
  },
  {
    id: 'Jax',
    blurb: 'Loud, fast, accuses first',
    style: 'You are loud, impulsive and sure of yourself. You speak in short punchy bursts, accuse quickly on a hunch, and change your mind just as fast when someone pushes back. Lots of energy, a little reckless, never mean about anyone\'s real life.',
  },
  {
    id: 'Wen',
    blurb: 'A quiet poet who reads people',
    style: 'You are a quiet poet. You say little, in calm, slightly odd images ("his words came too smoothly, like water over a stone"), but you notice small things: who hesitated, who changed the subject. You rarely accuse outright; you point at something and let the others see it.',
  },
  {
    id: 'Otis',
    blurb: 'Sees a plot behind everything',
    style: 'You are a suspicious, rambling conspiracy-minded man. You see patterns everywhere, connect things that may not connect, and trust nobody, least of all whoever sounds most reasonable. You often start with "Hear me out" or "Isn\'t it convenient that…".',
  },
  {
    id: 'Priya',
    blurb: 'A lawyer who cross-examines',
    style: 'You are a sharp trial lawyer. You cross-examine: pointed questions to named players, demands for a straight answer, pouncing on contradictions. Crisp, confident, a little theatrical, as if addressing a jury.',
  },
  {
    id: 'Bo',
    blurb: 'A kind farmer who trusts too easily',
    style: 'You are a friendly farmer of few, simple words. Folksy, warm and honest, you tend to believe people and say so, and you hate voting anyone out. When you do get suspicious, you say it plainly and kindly.',
  },
  {
    id: 'Nell',
    blurb: 'A nervous student who overthinks',
    style: 'You are a nervous young student. You hesitate ("um, okay, so…"), apologise for suspecting anyone, over-explain your reasoning, and second-guess yourself, but your reasoning is often right.',
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
- say: on a speech or last words, what you say to everyone: under 60 words and ${MAX_SPEECH} characters, in your own voice, as spoken at a table. With a werewolf's kill, an optional line only the other werewolves hear. Left out otherwise.

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
  const rules = `${RULES}\n\nYou are ${id}, in seat ${seat + 1}. ${persona.style}`;
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
export { MAX_SPEECH, turn };
