# Werewolf world

The werewolf page (`preview/werewolf.js`): a person, friends who join by a
link, and AI players round one table, on the [runtime](../../runtime/README.md).
By night two wolves who know each other pick a kill, the seer checks, the
witch saves or poisons; by day each living seat speaks in turn, then all
vote at once. Rules `preview/werewolf-rules.js`, world `werewolf-world.js`.

## State

```
Table { rev, people, names, no, lines, answered, game }
Game  { players, seats: [{ role, alive }], day, phase, step, round, picks, victim,
        saved, poisoned, potions, speaker, order, votes, acted, log, winner,
        since, called: { step, at }, minds: [{ thoughts, tries: { turn, n, why } }] }
Line  { id, by, text, to, depth, about, game, after, for? }
```

- The table is the world; a game is a change, the dealer's `deal`. `game`
  is the last one, kept once over for the chat about it. People, chat and
  controllers outlive a game.
- A `log` entry's `to` is the seats that may see it; none, all. The pack,
  `to: wolves(game)`, is seats, people and agents alike: not an audience.
- `turn(game)` is the moment (`day:phase:step round`, or the speaker),
  the same through a vote or the wolves' pick; `since`, the stamp of its
  first change. `called`: how far the narrator has called the night, and
  when. `minds[seat]`: thinking, tries. `answered[member]`: lines answered.

## Store

The table is a [room](rooms.md) on the relay. It holds `{ rev, Table }`,
so a refresh resumes the game and its deadlines, and no player, the opener
included, can read a role. Every client gets only `read(member)`; `by` is
the member whose token sent the change. `wait(member, rev)` wakes a seat
only when its view changed: a wolf's pick wakes the pack, not the village.

An action's input has `at`, the `turn` it was made on; one made on a moment
the game has left is stale. Votes in one vote do not move the turn, so none
makes another stale; the last tallies in the same commit.

## World

```
view(state, member, past)  → { content, actions, tasks, seen, rules }
apply(state, change)       → { state, actions: [] } | { refused: why }
deadlines(state)           → [{ at, change }]
```

**`view`** is the seat's. `content` is the rules' `view(game, seat)`: its
role; for a wolf, the pack, its picks, lines and kill; the seer's checks;
the witch's potions and, while she has the save, whom the wolves attacked;
who is alive; who has voted, and its own vote; a death at dawn as "died in
the night", how only to the pack and the witch. The night's step is
`called`, not the rules' step. Then its mind and the chat; once over, all.
A member with no seat sees what all see. `past` is unused: the log keeps
what happened. `rules` is `RULES`; a persona is its agent's prompt.
`actions`: what the rules' `due` lets the seat do now; `say` outside a
game; `sit`, `leave` between games; `start { size }` for the host.

**Tasks.**

```
turn  { given: ['turn:<turn>'], as: seat, for: [host], depth: 0, at: since + TURN }
line  { given: ['line:<id>', …], as: member, for: the lines' people, depth: the line's }
```

A turn task while a seat is in the rules' `due(game)`, a person's as an
agent's: a person's is their "your turn", its `at` the ring. `for` is the
host, whose key and money; `as` the seat, its view and rights, so a wolf's
task for a host who is a villager still sees the pack. A line task while a
line names the member, or a person says it to all, under `DEPTH`, not in
`answered`; the host's and a friend's lines to one agent are one task, `for`
both. A turn comes first. Open: chat before a game wakes AI players, or, as
today, only after one. Open: a person's line to all asks every AI player
and one answer lands (as today), or the world picks one to ask.

**Answers.** A run's change always lands. Accepted, it goes through the
rules' `act`: the seat joins `acted`, and `settle` ends a phase once no one
is due, so the barrier is the rules'. Turned away (illegal, stale, a turn
with no action), it is a try on the turn it was made on, why in its next
view, due again; at `MAX_TRIES` the rules' `fallback` plays for the seat.
`{ failed }` or nothing: the rules' `fallback` plays for the seat at
once. Its thinking lands in its mind. A person's illegal or stale action
is `{ refused }`. Of AI answers to one line to all, one lands.

**Time.** `deadlines(state)`, each with its base (the turn, the call):
`expire { turn }` at `since + TURN` (90 s), and all still due take the
fallback; `call { step }` at `called.at + CALL_MS`, up to the rules' step,
each night role called alive or not; the hellos, one each `HELLO_MS`.

## Members and controllers

One per member, an AI seat's in the room or in its owner's page
([rooms](rooms.md)). A person's program is
their page (a friend's, over the relay): it shows every task, with a ring.

## Presence

Running, thinking, typing, shown as `seen` allows: by day to all; at night
a seat sees itself and, a wolf, its pack, so who works at night tells no role.

## Outside programs

The dealer, in the room, commits `deal { roles }` on `start`, by
`crypto.getRandomValues`; `apply` checks it is a shuffle of `cast(size)`.
The narrator has no program: its calls and the hellos are deadlines, which
the clock, the store's host, commits at their `at`. The room commits `gone`
for a friend not back within `RECONNECT_MS`; `apply` takes them from
`people` and plays the fallback on their turns. Open: the narrator's call
gates AI players (a task once its step is called), or only paces views.

## Agent clients

Tools: `content`, `rules` and the persona as the prompt, `actions` as tools
(today one, `DECIDE`). A run: a model call, the player's thinking time (at
night at most `NIGHT_THINK`), a speech's typing time, told as presence.
Local: the model and key (`ponjo-poker`, or Ponjo's), for whom (the people
at the table), `DEPTH`, the breaker. Capacity: one queue, turns first.

## Today

- Five calls with I/O (`werewolf-world.js:229-290`); a prompt is built from
  the whole table (`:386-416`); friends get a view plus every seat's runs
  and failures (`werewolf.js:988-993`).
  One runtime per game, for its agents (`werewolf.js:172-199`); people have
  none; the page writes their "your turn" (`werewolf.js:323-334`).
- The table lives in the page's memory (`werewolf.js:40`), changes in place
  (`werewolf-world.js:137-141`, `171`; `table-talk.js:32`) and is stamped by
  `stamp()` (`table-talk.js:16`). Given asks are in memory (`due.js:57`); a
  failed run commits nothing (`src/core/runtime.js:277`); a stale action is
  a try on the new turn (`werewolf-world.js:178-180`).
- The deal is random in `newGame` (`werewolf-world.js:111`); the clock,
  narrator, hellos and leaving are page timers (`werewolf.js:69-117`,
  `233-253`, `955-965`); `asks` reads the page (`werewolf-world.js:253`);
  chat before a game has no writer (`werewolf.js:623-624`).
- `view.step` is the rules' (`werewolf-rules.js:294`); a seat's own vote is
  the page's (`werewolf.js:54`, `647`). A friend's id is what their page
  claims (`werewolf.js:948-950`). There is no breaker (`werewolf.js:186`).
