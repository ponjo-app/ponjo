# Werewolf world

The werewolf page (`preview/werewolf.js`): the opener, friends who join by a
link, and AI players round one table, on the [runtime](../../runtime/README.md)
in a [room](rooms.md). By night two wolves who know each other pick a kill,
the seer checks, the witch saves or poisons; by day each living seat speaks
in turn, then all vote at once. Rules `preview/werewolf-rules.js`, world
`preview/werewolf-world.js`.

## State

```
Table { rev, people, names, no, lines, game, ledger }
Game  { players, seats: [{ role, alive }], day, phase, step, round, picks, victim,
        saved, poisoned, potions, speaker, order, votes, acted, log, winner,
        since, called: { step, at }, minds: [{ thoughts }] }
Line  { id, by, text, to, depth, about, game, after }
```

- The table is the world; a game is a change, the dealer's `deal`. `game`
  is the last one, kept for the chat about it.
- A `log` entry's `to` is the seats that may see it; none, all. The pack,
  `to: wolves(game)`, is seats, people and agents alike, that `view` reads.
- `turn(game)` is the moment (`day:phase:step round`, or the speaker), the
  same through a vote or the wolves' pick; `since`, the stamp of its first
  change. `called`: the narrator's call, and when it began.
- `minds[seat]`: that seat's thinking. `ledger`: the answers and tries,
  kept by the runtime's wrapper around `apply`, not by this world.

## Store

The room on the relay holds `{ rev, Table }` and gives each client, the
opener's page included, only `read(member)`. `by` is the member whose token
sent a change. `wait(member, rev)` wakes a seat only when its view changed:
a wolf's pick wakes the pack, not the village.

```
Change { by, at, as: seat, base: turn or line, answers, body: { action, say, thinking } }
```

`apply` refuses a change whose `base` is not `turn(game)`: a vote or kill on
a phase the game has left. Votes in one vote do not move the turn, so none
makes another stale; the last tallies in the same commit.

## World

```
view(state, member, past)   → { content, actions, tasks, seen, rules }
apply(state, change, past)  → { state, effects: [] } | { refused: why }
fallback(state, task, at)   → state      the rules' fallback for task.as
tries                       3
```

**`view`** is the seat's. `content` is the rules' `view(game, seat)`: its
role; for a wolf, the pack, its picks, lines and kill; the seer's checks;
the witch's potions and, while she has the save, whom the wolves attacked;
who is alive; who has voted, and its own vote; a death at dawn as "died in
the night", how only to the pack and the witch. The night's step is
`called`, not the rules' step. Then its mind, its last try's why, and the
chat; once over, all. A member with no seat sees what all see. `rules` is
`RULES`; a persona is its agent's prompt. `actions`: what the rules' `due`
lets the seat do now; `say` outside a game; `sit`, `leave` between games;
`start { size }`, for the opener. No effects.

**Tasks.**

```
turn:<turn>:<seat>  { kind: turn, as: seat, from: [], depth: 0, at: since + TURN, or the call's end }
line:<id>           { kind: ask, as: member, from: the line's people, depth: the line's }
```

A turn task while a seat is in the rules' `due(game)`, a person's as an
agent's: a person's is their "your turn", its `at` the ring. `as` gives its
view and rights, so an AI wolf sees the pack whoever owns it. A line task
while a line names the member under `DEPTH`; a person's line to all is
listed for one AI player, the one whose last line is oldest, ties in seat
order. A turn comes first; with no chat during a game, a seat never has a
turn and a line at once.

Open: chat before a game wakes AI players, or, as today, only after one.

**Answers.** The ledger's. Accepted, a change goes through the rules'
`act`: the seat joins `acted`, and `settle` ends a phase once no one is
due, so the barrier is the rules'. Refused (illegal, stale, a turn with no
action), it is a try, its why in the seat's next view; at 3 tries,
`fallback`. A turn that failed, that the wallet will not start, or whose
run made nothing, is its `fallback` at once. Its thinking lands in `minds`
with a change that lands.

## Members and controllers

One per member. People's pages connect with their token and show every
task, with its ring; the AI seats run in the room, with their wallet.

- **Clock**, in the room: its tasks carry `at`. `expire:<turn>` at the
  turn's `at`: all still due take the fallback. `call:<day>:<step>`: the
  narrator calls dusk for 3 s, then each night role, alive or not, for
  exactly `CALL_MS` (8 s), so a call's length tells nothing; a night turn's
  `at` is its call's end. `hello:<seat>`: the hellos before the first
  night, one each `HELLO_MS`.
- **Dealer**, a system member with a script, in the room: after `start`,
  its task `deal:<no>`; it commits `deal { roles }` by
  `crypto.getRandomValues`; `apply` checks it shuffles `cast(size)`.
- **Room**: commits `leave` for a person gone past `RECONNECT_MS`, as
  presence says; their turns take the fallback.

Open: the narrator's call gates AI players (a turn task once its step is
called, as for people today), or only paces what views show.

## Presence

`seen`: by day, all; at night, a seat itself and, a wolf, its pack.

## Agent clients

Tools: `content`, `rules` and the persona as the prompt; the world's
actions as the only tools (today one, `DECIDE`). A run: a model call, the
player's thinking time (at night at most `NIGHT_THINK`), a speech's typing
time, told as presence. The wallet, in the room: Ponjo's key or a visitor's,
the room's budget and rate, the depth limit; the breaker counts no turn.

## Today

- The store is the table's room on the relay (`relay/table.js`, a `Table`
  Durable Object at infer.ponjo.app, [rooms](rooms.md)), which runs this
  world (`preview/werewolf-world.js`, through `preview/game-tables.js`). Each
  page (`preview/werewolf.js`) is one seat's client (`sit`,
  `preview/game-kit.js`): it draws the view the room sends it and sends
  what its person does; no page holds the state.
- The room sends a page its whole view each time it changes, with the
  presence it may see, instead of a notice to read again; there is no
  `wait` and no `past`.
- The AI seats, the clock and the wallet run in the room: the limits
  (depth 10, N 30), in memory; the table's model calls an hour, on Ponjo's
  key or the opener's own; no queue per provider. The opener's own key is
  held in memory only, not kept in storage ([rooms](rooms.md#today)).
- The room deals, in the opener's `start { size }`, adding `roles`;
  `apply` checks they are a shuffle of `cast(size)`. There is no dealer member.
- The narrator's call gates every night turn, an AI seat's as a person's:
  listed once its step is called, due by the call's end. The rules hold
  the night at the witch's step until the clock's last call
  (`daybreak`), so the day never begins before dawn is called. Chat before
  a game wakes no AI player.
- The table keeps `call { day, step, at }`, `since` and `thoughts` beside
  the game, not in it; tasks are `turn:<no>:<turn>`, `line:<no>:<id>`,
  `call:<no>:<day>:<step>`, `hello:<no>:<seat>`, `expire:<no>:<turn>`.
- An AI seat's program waits its persona's thinking time
  (`game-tables.js`) after the model answers, and a speech's typing time,
  told as presence, so its change lands that much later.
