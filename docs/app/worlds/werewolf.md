# Werewolf world

Werewolf for people and AI players on the [Blackboard Agent
Runtime](../../runtime/README.md), in the host's browser page. By night two
wolves who know each other pick a kill, the seer checks, the witch saves or
poisons; by day each living seat speaks in turn, then all vote at once.
Rules `preview/werewolf-rules.js`, world `preview/werewolf-world.js`, page
`preview/werewolf.js`.

## State

```
{ rev,
  table:    { players, names, no }         seat ids, people's names, the game's number
  game:     { seats: [{ role, alive }], day, phase, step, round, picks, victim,
              saved, poisoned, potions, speaker, order, votes, acted, log, winner }
  lines:    [Line]                         the chat (preview/table-talk.js)
  tries:    { agent → { turn, n, why } }   actions turned away on one turn
  thoughts: { agent → [Thought] }          each AI player's own reasoning
  called:   { day, step } }                how far the narrator has called the night
```

A `log` entry's `to` is the seats that may see it; none, all. `turn(game)`
is the moment (`day:phase:step round`, or the speaker): during a vote or
the wolves' pick it stays the same while the actions come in. Open: one
world for the table, games and chat; or one per game, the chat carried on.

## Store

The host's page holds `{ rev, state }` in memory; `commit` runs `apply`,
one change at a time. A friend's page never reads it: the host's page sends
it its seat's `view` over the relay (`preview/poker-share.js`) and commits
what it sends as that friend's change.

The store's condition is `rev`; the game's is the moment. An action carries
`at`, the `turn` it was made on; `apply` takes it only while
`at === turn(game)`, so a vote or kill on a phase the game has left is
stale. Votes in one vote are not stale to each other; the last one tallies
in the same commit. Open: the host plays and its page holds every role; a
store no player reads, or roles hidden from friends only.

## Local

The host's page: the model and key (`ponjo-poker` in `localStorage`); whom
it vouches for (the host, and friends who sat: `people`); the chat's depth
limit (`DEPTH`). No watches, breaker or outside actions.

## World

```
due(state, local, agent)     → [Task]
view(state, local, task)     → { files: { at, kind, about }, prompt: { rules, situation } }
apply(state, change, local)  → { state, actions: [] } | { refused: why }
```

**`due`.** In a game: one task while the agent's seat is in the rules'
`due(game)` and its `tries` this turn are under `MAX_TRIES`; `given`
`['turn:<turn>']`, depth 0. `acted` is the watermark: a seat in it is not
due. After the game: a task per audience for the lines that concern the
agent (named, or a person's line to all); `given` `['chat:<no>:<line>']`.
People are never tasks: a person's seat in the rules' `due` is `view.due`,
and holds the phase until they act or the clock expires it.

**`view`.** The rules' `view(game, seat)`: its role; for a wolf, the pack,
its picks, lines and kill; the seer's checks; the witch's potions and,
while she has the save, whom the wolves attacked; who is alive; who has
voted, not for whom, until the tally. A death shows at dawn as "died in the
night"; how stays with the pack and the witch until the game is over, when
all shows. Added: the agent's last `THOUGHTS_SHOWN` thoughts and why its
last action was turned away. A watcher (seat -1) sees what all see.

**`apply`.**

```
run      { by, for, given, depth, base: { at, kind, about }, made: { thinking, action, say } | { failed } }
person   { by, action, say, at }
world    { by: world, deal: roles | call: step | expire: turn | gone: id }   dealer, narrator, clock, room
```

- A legal action goes through the rules' `act`; `settle` ends a phase once
  no one is due: the barrier is the rules'. A run's illegal or stale action
  lands as a try on its own turn (`base.at`), with why; at `MAX_TRIES`,
  `fallback` plays for the seat. Its thinking always lands. A person's
  illegal action is refused.
- `expire` lands only while its turn is the game's: all still due do
  nothing; `gone`, one person, each turn. After the game a line lands in
  `lines`; of AI answers to a person's line to all, one lands.
- Open: a failed run: a try, the fallback at once, or wait for the clock.

**Audiences.** In the runtime `for` bounds a task's view and rights. Here
both are the seat's: the pack (`to: wolves(game)`) is a group of seats that
may hold the host, a friend and AI players, and `act(game, seat, …)` checks
the seat. A wolf's task for a host who is a villager must still see the
pack. Open: a turn task's `for`: the host, bounding only cost and trust; no
one (the rules ask); or the seat as its own audience.

**Outside programs**, on the host's page: the dealer
(`crypto.getRandomValues`); the narrator, which calls each night role,
alive or not, for at least a set time, so a call's length tells nothing;
the clock, which expires a turn after `TURN` (90 s); the room, when a
friend leaves. Open: whether AI players wait for the narrator's call; the
deadline in the state, for views, or the clock's alone.

## Controllers

One per AI seat, on the host's page, all the host's. A run: a model call,
the player's thinking time, a speech's typing time, then commit; stopped
once its turn leaves `due`. A person has no controller: the page commits
what they do; a friend's page sends it there.

## Today

- Five calls with I/O (`werewolf-world.js:229-290`), the plan in
  `src/core/due.js`; a turn is an ask from the host (`werewolf-world.js:258`).
- The table changes in place (`werewolf-world.js:137-141`, `171`;
  `table-talk.js:32`) and reads the clock (`stamp()`, `table-talk.js:16`,
  at `werewolf-world.js:132`, `183`; `performance.now()`, `:270`).
  `asks` reads the page (`werewolf-world.js:253`, `werewolf.js:181`);
  `propose` waits out the typing (`werewolf-world.js:284`).
- What an agent was given is in memory (`due.js:57`); a failed run commits
  nothing (`src/core/runtime.js:277`, `werewolf.js:51`, `194`). A stale
  action is a try on the new turn (`werewolf-world.js:178-180`); a run stops
  only once its agent is due for nothing (`due.js:136-137`).
- The deal is random in `newGame` (`werewolf-world.js:111`); the clock, the
  narrator, hellos and leaving are the page's (`werewolf.js:69-117`, `233-253`).
- `view.step` is the rules' (`werewolf-rules.js:294`) and friends get who
  runs (`werewolf.js:992`): at night both tell who holds a role. A seat's
  own vote is the page's (`werewolf-rules.js:297`, `werewolf.js:54`, `647`).
- One world and runtime per game (`werewolf.js:172-199`); the chat outlives
  it (`werewolf.js:46`); chat before a game has no writer (`:623-624`).
