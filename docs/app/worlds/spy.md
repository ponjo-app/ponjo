# Who's the Spy

Who's the Spy on the [Blackboard Agent Runtime](../../runtime/README.md).
Each seat gets a secret word, the spies a different one. A round: a clue
from each living seat in order, a discussion, a vote of all at once; chat
before and after. Whoever opened the table (the *table's host*,
`HUMAN`) and friends who join by a link play at a [room](rooms.md). Rules
`preview/spy-rules.js`, world `preview/spy-world.js`, page `preview/spy.js`.

## State

```
{ rev, people, names, players, gameNo, hellos, game, lines, seats, since }
game   { seats: [{ role, word, alive }], words, first, round, phase, runoff,
         order, speaker, acted, votes, said, log, winner }
seats  { member → { answered: { given → key }, try: { turn, n, why }, thoughts } }
```

`turn(game)` names the moment (round, phase, runoff, speaker); lines and
votes do not move it. `lines`: the discussion and the chat
(`preview/table-talk.js`). `since`: the store's `at` of the change that
began the turn. `answered` is keyed by content: a turn, or a line's id.

## Store

A [room](rooms.md) on the relay. It alone holds `{ rev, state }`; every
client, people's pages and AI seats, gets `read(member)`. `wait(member,
rev)` wakes a seat only when its view changed. `commit` sets `by` from the
member's token and stamps `at`. No action is ever proposed.

## World

```
view(state, member, past)  → { content, actions, tasks, seen, rules }
apply(state, change)       → { state, actions: [] } | { refused: why }
deadlines(state)           → [{ at, change }]
```

**view.** `content` is the rules' `view(game, seat)`: its own word, never
its side; who is alive, and the side of each seat voted out; who has voted,
not for whom; the log; the lines; its last 8 thoughts and its last try's
why. Once the game is over, everything, all thoughts included. `past` gives
the lines since the seat last answered. `actions`: `clue { text }`, `say {
text }`, `pass`, `vote { target }`, `chat { text }`. `rules`: `RULES`.

**Tasks.** For any seat, a person's too, in priority order:

- `clue`: it is the speaker and has not spoken. `given` `turn:<turn>`.
- `vote`: it is alive and has not voted; every voter at once. The vote is a
  barrier: `apply` tallies once no one is due (`settle`).
- `talk`: it is alive with lines left, and the discussion is newer than
  what it answered. `given` is the channel `talk:<gameNo>:<round>`, keyed
  by its latest line. A line or a pass answers it.
- `chat`: a chat line that names it, below the table's `DEPTH` (2). A
  person's line to everyone gives one AI seat a task, picked here, not by a
  race. Open: which: the next after the speaker, or the least recently due.

`as` is the seat. A turn's `for` is the table's host, who started the game;
a line's, the person who said it, or the `for` of the run that did. A
host's and a friend's line to one seat are one task, `for` both. `at` is
`since` plus `TURN` or `TALK`. The discussion ends when no one is due:
every living seat has answered the latest line, by a line, a pass or its
last line. Open: that alone, also at `TALK`, or not before a minimum (a
quiet table votes at once).

**Answers.** Every run's change lands; `apply` records it:

| A run's change | Records | The task |
| --- | --- | --- |
| a clue, a line, a vote, a pass | answered | gone |
| turned away: says its word, a wrong target, the turn moved | a try, why | due again; at 3, `fallback`: a silent clue, an abstention, a pass |
| `{ failed }` | failed | on a turn, its `fallback` at once; else gone |
| nothing | answered; on a turn, its `fallback` | gone |

Its `thinking` lands too, as the seat's own. A person's illegal or stale
`act` is `{ refused }`.

**Time.** `deadlines` lists, each with the turn as its base: `hello` for
each AI seat, `HELLO_MS` apart, then `begin`; `expire` at `since + TURN`
(each seat still due does nothing); `vote-called` at `since + TALK`. The
store's host commits each at its `at`; it lands only if its turn still is.

## Members and controllers

One per member: each AI seat, the table's host, each friend. A person's
page shows all their tasks ("your clue", "say or pass") and commits.

## Presence

Who is at the table, typing or thinking, told with `presence` and kept
nowhere. Every seat may see it (`seen`): in each phase all may act, or only
the speaker, so it shows no side. A friend whose page is gone stays seated
until the room commits `leave` after `RECONNECT_MS`; from then `apply`
plays the `fallback` for their turns.

## Outside programs

The dealer, in the room, commits `start { size, dealt }`: the word
pair, which word is the spies', the sides, the first speaker, drawn by
`cryptoRandom`. The clock commits `deadlines`; it replaces the page's
moderator. The room commits `join` and `leave` as the friend.

## Agent clients

The renderer is tools: `rules` and `content` as the prompt, `actions` as
the `decide` tool. The persona (`PERSONAS`) is the agent's, not the
world's. A run is one model call, then the seat's pace (`PACE`), shown as
"typing". Local, on its owner's host ([rooms](rooms.md)): whom the table's host pays for
(themselves, friends at the table), the budget, the depth limit, the
breaker, the key (`localStorage`, `preview/game-page.js`). Capacity: one
queue to the provider, taken in task priority.

## Today

- Five calls with I/O (`preview/spy-world.js:285-338`); the runtime plans
  (`src/core/due.js`) and reads the whole table (`spy-world.js:298-311`).
- One runtime for all AI seats, no breaker (`preview/spy.js:142-158`).
  People have no controller: the page draws their turn and sends friends a
  view (`spy.js:365-380`, `679-687`).
- What a seat answered is memory (`src/core/runtime.js:260`); quiet, or a
  second answer to a line to everyone, lands nothing (`spy-world.js:189-191`,
  `table-talk.js:30`); a failed run waits for Retry (`runtime.js:271-278`);
  tries and thoughts are in `notes` (`spy-world.js:149`, `187`, `200-214`).
- The discussion: one ask as it begins, one per line that concerns a seat
  (`spy-world.js:271-275`); it ends only by `TALK` or "vote now"
  (`spy.js:79-91`, `734-737`). Turn asks are from `HUMAN`, a line's from
  its speaker (`spy-world.js:268`, `274`; `table-talk.js:39`).
- The table is page memory, changed in place (`spy.js:35`,
  `spy-world.js:105-110`). Time is page timers (`spy.js:24-27`, `160-176`)
  and `stamp()` (`table-talk.js:15-16`). A gone friend falls back in the
  page (`spy.js:66-70`); `propose` awaits typing (`spy-world.js:333`); the
  deal and the personas are the world's (`spy-world.js:142`, `30-87`).
- The three games each copy `commit`, the world wrapper, tries, thoughts and
  turn stamps (`spy-world.js:105`, `285`; `werewolf-world.js:137`, `229`;
  `poker-world.js:147`, `382`).
