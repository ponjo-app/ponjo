# Who's the Spy

Who's the Spy as a world of the [Blackboard Agent
Runtime](../../runtime/README.md). Each seat gets a secret word, the spies
a different one. A round: a clue from each living seat in order, a
discussion, a vote of everyone at once. People chat before and after a
game. It runs in the browser: the page of the person who opened the table
(the *table's host*, `HUMAN`) holds the state and runs the AI seats;
friends join by a link. Rules: `preview/spy-rules.js`; table:
`preview/spy-world.js`; page: `preview/spy.js`.

## State

```
{ rev, people, names, players, gameNo, greeting, hellos, game, lines, answered, thoughts }
game  { seats: [{ role, word, alive }], words, first, round, phase, runoff,
        order, speaker, acted, votes, said, log, winner }
```

- `phase` is `clue`, `talk`, `vote` or `over`. `turn(game)` names the
  moment (round, phase, runoff, speaker); lines and votes do not move it.
- `votes` stay hidden until the vote ends, then go to `log`.
- `lines`: the discussion and the chat, `{ id, by, to, about, depth, game,
  kind }` (`preview/table-talk.js`).
- `answered`: per agent and `given` id, the rev it last answered.
  `thoughts`: each AI seat's private thinking, from its runs' changes.

## Store

The host page's memory; one writer, the page's event loop.

```
read()               → { rev, state }       a copy of the table
wait(rev, deadline)  → rev                  resolves on the next commit
commit(change)       → { rev, actions: [] } | { refused: why }
```

`apply` is synchronous, so commits never interleave. The condition that
matters is the world's: a change carries the `turn` it was made on. A
friend's page holds no state: it sends its player's change to the host
page and gets back its seat's `view` (`preview/poker-share.js`). No action
is ever proposed.

## Local

On the host page: the model and the visitor's key (`preview/game-page.js`,
`localStorage`); who is vouched for (the table's host, each friend whose
page is in the room); the limits (depth `DEPTH`, 2; the breaker); the agent
log (`?debug`), which shows every word.

## World

```
due(state, local, agent)     → [Task]
view(state, local, task)     → { files: { at, about }, prompt: { rules, situation } }
apply(state, change, local)  → { state, actions: [] } | { refused: why }
```

`due` lists, for an AI seat: `clue` when it is the speaker and has not
spoken; `vote` when it is alive and has not voted, all voters at once;
`talk` while it is alive with lines left, once as the discussion begins
(`given` `talk:<gameNo>:<turn>`) and once per line that names it or is a
person's to everyone (`line:<gameNo>:<id>`), below `DEPTH`; after the game,
each chat line that concerns it. A person's seat is never a task; the
rules' `due(game)` lists it, and the page uses that to ask them.

`view` is the rules' `view(game, seat)`: its own word, never its side; who
is alive, and the side of each seat voted out; who has voted, not for whom;
the log. It adds the seat's last 8 thoughts and why its last try was
refused. Once the game is over, everything.

| Change to `apply` | By | Does |
| --- | --- | --- |
| `start { size, dealt }` | the table's host | seats people, then AI seats; deals |
| `hello`, `begin` | the moderator | an AI seat's scripted hello; then clues are due |
| a run's change | an agent | a clue, a line, a vote, or quiet (`say` empty) |
| `act` | a person | the same, from the page |
| `vote-called` | the moderator, the table's host | ends the discussion |
| `expire { turn }` | the moderator | each seat still due on `turn` does nothing |
| `join`, `leave`, `chat` | a person | the table; a gone friend's turns fall back |

- When no one is due, the phase ends. The vote is a barrier: it ends when
  the last seat votes or expires. A tie: one clue each from the tied, a
  vote between them; a second tie, no one is out.
- A change made on a turn the game has left is refused. A line answering a
  person's line to everyone lands only if no AI seat answered it yet.
- Open: an illegal move is `{ refused }` (not counted, due again at once,
  untold) or lands as a turned-away answer (counted, shown, fallback at 3).
- Open: a failed run falls back at once, or waits for `expire`.
- Open: a friend's line that wakes a seat is for the friend, or for the
  table's host, whose model and key every run uses.
- Open: the discussion ends at `TALK` only, or also once every living seat
  answered quiet since the last line.

The moderator is an outside program on the host page. It commits the
hellos at a pace, `begin`, `vote-called` after `TALK`, `expire` after
`TURN`. The world reads no clock. Randomness comes in `start`'s `dealt`:
the word pair, which word is the spies', the sides, the first speaker.

## Controllers

One per AI seat, on the host page. A run is one model call, then the seat's
pace (`PACE`), then the time it takes to type. A person is never launched:
the page shows what their seat's `view` says is due and commits their
`act`; their turn ends by it or by `expire`.

## Today

- The table is mutated in place, with `rev` and `log`
  (`preview/spy-world.js:105-110`); `wait` is resolvers the page fires
  (`preview/spy-world.js:286-289`, `312-325`).
- The world is the five calls (`preview/spy-world.js:285-338`). `propose`
  ignores `version`; staleness is only the rules' `turn` check
  (`preview/spy-rules.js:118`). It awaits the page's typing before it lands
  (`preview/spy-world.js:333`).
- Asks are stamped with the clock (`preview/spy-world.js:109`, `206`;
  `preview/table-talk.js:15-16`). Who answered what is the controller's
  memory (`src/core/runtime.js:260`).
- Quiet, or a second answer to a line, lands nothing
  (`preview/spy-world.js:189-191`). A failed run commits nothing and waits
  for Retry or `TURN` (`src/core/runtime.js:271-278`).
- A refusal commits a `rejected` change and counts tries in `table.notes`,
  with the thoughts (`preview/spy-world.js:149`, `187`, `200-214`).
- The deal draws its own randomness (`preview/spy-world.js:142`).
- Time is the page's: `TURN`, `TALK`, the hellos (`preview/spy.js:24-27`,
  `79-91`, `160-176`). A gone friend's turns fall back in the page
  (`preview/spy.js:66-70`).
- One runtime runs all AI seats, no breaker (`preview/spy.js:142-158`).
- Turn asks are from `HUMAN`; a line's ask is from whoever said it
  (`preview/spy-world.js:268`, `274`; `preview/table-talk.js:39`).
