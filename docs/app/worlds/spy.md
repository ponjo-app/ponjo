# Who's the Spy

Who's the Spy on the [Blackboard Agent Runtime](../../runtime/README.md).
Each seat gets a secret word, the spies a different one. A round: a clue
from each living seat in order, a discussion, a vote of all at once; chat
before and after. The table is a [room](rooms.md) on the relay; the
*opener* starts games, friends join by a link. Rules `preview/spy-rules.js`,
world `preview/spy-world.js`, page `preview/spy.js`.

## State

```
{ rev, people, names, players, gameNo, hellos, game, lines, thoughts, since }
game      { seats: [{ role, word, alive }], words, first, round, phase, runoff,
            order, speaker, acted, votes, said, log, winner }
thoughts  { member → [{ round, kind, text }] }
```

`turn(game)` names the moment (round, phase, runoff, speaker); lines and
votes do not move it. `lines`: the discussion and the chat (`game-kit.js`).
`since`: the `at` of the change that began the turn. The answer ledger is
the generic wrapper's.

## Store

The room: it alone holds `{ rev, state }`, in its storage. Every client,
each AI seat in the room included, gets only `read(member)`; no page, the
opener's included, can read another's word. `wait(member, rev)` wakes a
seat only when its view changed. `commit` sets `by` from the member's
token and stamps `at`. A change is `{ by, at, as, base, answers, body }`;
`base` is the `turn` it was made on. No effect is ever proposed.

## World

```
view(state, member, past)    → { content, actions, tasks, seen, rules }
apply(state, change, past)   → { state, effects: [] } | { refused: why }
fallback(state, task, at)    a silent clue, an abstention, a pass; tries: 3
```

**view.** `content` is the rules' `view(game, seat)`: its own word, never
its side; who is alive, and the side of each seat voted out; who has voted,
not for whom; the log; the lines; its last 8 thoughts and the ledger's why
for its last try. Once the game is over, everything, all thoughts included.
`past` gives the lines since the seat last answered. `actions`: `clue {
text }`, `say { text }`, `pass`, `vote { target }`, `chat { text }`.
`rules`: `RULES`.

**Tasks.** For any seat, a person's too, in priority order:

| Task | `kind` | `given` | Due while | `at` |
| --- | --- | --- | --- | --- |
| clue | turn | `turn:<gameNo>:<turn>` | it is the speaker and has not spoken | `since + TURN` |
| vote | turn | `turn:<gameNo>:<turn>` | it is alive and has not voted | `since + TURN` |
| talk | turn | `talk:<gameNo>:<round>:<line>` | it is alive, has lines left, and has not answered the opening (line 0) or a line that asks it | `since + TALK` |
| chat | ask | `chat:<gameNo>:<line>` | a line after the game names it, below `DEPTH` (2) | none |

- `from` is empty for a clue or vote, which the rules set off and the
  owner pays for; else whoever set off the line it answers. `depth` is 0
  for a clue or vote, else as that line set it off.
- The discussion opens with one task for every living seat. After that, a
  line asks only the seats it names; one that names no one asks one seat:
  the next living AI seat after the speaker with lines left. A seat is
  given the first it has not answered, so a line that does not ask it
  leaves its task, and a run on it goes on. A line or a pass answers it; a
  person's line or pass answers all before it. So a discussion costs about
  one run per seat and one per line. It is a `turn`, as the rules ask
  every seat to take part: the runaway count skips it; the line budget and
  depth limit end it.
- Every voter is due at once: a barrier, tallied once no one is due.
- A person's line to everyone, after a game, is one chat task, for the
  first AI seat after the speaker in seat order (the first AI seat, if the
  speaker has none).
- The discussion ends when no one is due: every living seat, people
  included, has answered its opening and each line that asks it, or used
  its lines; else at `TALK`. Open: also not before a minimum, as a table that all pass votes
  at once.

**Answers.** The wrapper keeps the ledger. A clue, a line, a vote or a pass
is answered. A change `apply` refuses (it says its word, a wrong target,
the turn moved) is a try, its why in the next view; at 3, `fallback`. A
failed run, a task the wallet will not start, or nothing on a turn: its
`fallback` at once. `thinking` lands with the change, into `thoughts`. A
person's refused `act` lands nothing; they see why at once.

**Time.** The clock's tasks, each with its base: `hello:<gameNo>:<seat>`
at `start.at` plus `HELLO_MS` each, then `begin`; `expire:<gameNo>:<turn>` at
`since + TURN` (each seat still due takes its `fallback`); `vote-called`
at `since + TALK`. Each lands only if its turn is still the game's.

## Members and controllers

One per member: each AI seat, the opener, each friend, the clock, the
dealer. A person's page shows all their tasks, each `at` as a ring.

## Presence

Who is here, at work or typing; kept nowhere. Every seat may see it
(`seen`): each phase lets all act, or only the speaker, so it shows no
side. A run commits at once; screens type its line out after. The room
commits `leave` for a friend not back within `RECONNECT_MS`; then each of
their turns takes its `fallback`.

## System members

The dealer, a script in the room, has a `deal:<gameNo>` task on the
opener's `start { size }` and commits `dealt`: the word pair, which is the
spies', the sides, the first speaker, by `cryptoRandom`. The clock, the
room's alarm, commits its tasks at their `at`.
The hello lines come in `start`, from each AI seat's persona; the clock
commits each `by` itself, `as` that seat.

## Agent clients

Each AI seat and its wallet run in the room. The renderer: `rules` and
`content` as the prompt, the world's `actions` as its only tools. The
persona (`PERSONAS`) is the agent's. A run answers the seat's allowed
tasks, in the view's order, in one change.

The wallet is the key owner's: Ponjo's, or a visitor's kept in the room
([rooms](rooms.md)). The owner pays; their policy says for which `from`
(the opener, friends at the table), with the room's budget and rate.
Capacity: one queue per provider and key, in task priority.

## Differs

- Its room's ([rooms](rooms.md#differs)).
- There is no dealer member: the room deals in the opener's `start`.
- An AI seat's program waits its persona's pace (`preview/game-tables.js`)
  after the model answers, so its change lands that much later.
