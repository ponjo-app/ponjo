# Poker table

The poker page (`preview/poker.js`): No-Limit Hold'em for the host person,
AI players (`PERSONAS`), friends who join by a link, a dealer and chat. In
the target design, a world of members on the [runtime](../../runtime/README.md):
the table is a [room](rooms.md) on the relay; each AI seat is an agent client.

## State

```
Table { players, slots, names, hand, handNo, button, topUp, joining, leaving,
        chat, reactions, seats: { id → Seat }, answered }
Seat  { thoughts: [{ hand, street, text, action }], tries: { turn, n, why } }
Line  { id, by, as, text, to (whom it names), depth, about, hand, for?, at }
hand  as in preview/poker-dealer.js, with no deck; answered: the watermarks
```

## Store

The table is a [room](rooms.md) on the relay. It holds `{ rev, state }`;
every client, the host's screen, each AI seat, the dealer, friends' pages,
gets only `read(member)`. `wait(member, rev)` returns once that member's
view changed: a line between two seats wakes no third. `commit` sets `by`
from the member's token and stamps `at`; the world checks `by` may play the
seat in `as`. `past` is unused: the hand and the chat are in the state.

## World

```
view(state, member, past)  → { content, actions, tasks, seen, rules }
apply(state, change)       → { state, actions: [] } | { refused: why }
deadlines(state)           → [{ at, change }]
```

One `view` for every seat; `share` and `prompt` go:

- `content`: the table, this hand's actions and reactions, the last 24
  lines; its own hole cards, others' at a showdown; for people, the AI
  seats' cards and `thoughts` once the hand is over; for an AI seat, its
  own `thoughts` this hand and why its last try was turned away.
- `actions`: on its turn `fold`, `check`, `call`, `bet`, `raise`, `allin`,
  legal amounts; `say`, `react`; people's `sit`, `topup`, `leave`; the
  host's `next`, `add`, `remove`, `invite`, `turnAway`.
- `seen`: all presence, to all. `rules`: `RULES`, and a persona's style.

| `given` | Seat | When | `for` | Depth |
| --- | --- | --- | --- | --- |
| `turn:<hand>:<n>` | the one to act | the hand is live | the host | 0 |
| `line:<id>` | each AI seat it names; all, for a person's line to the table | not its own; `depth` < `DEPTH` (2) | the line's person, or its `for` | the line's |
| `react:<hand>` | the winner and one other still in, if AI | a big hand ended | the host | 0 |
| `deal:<handNo>` | the dealer | the host chose `next` | the host | 0 |
| `board:<hand>:<street>` | the dealer | a street closed, two or more still in | the host | 0 |

A person's turn has `at`, its start plus 30 s, while a friend is at the
table. A seat's turn and lines are one task (one seat, one rights), whoever
asked; `for` is all of them; the turn comes first. `DEPTH` is the table's
rule: a line at it, such as a hello, sets off nothing. `talk`, whether an
AI seat may speak: always to a person's line or after a big hand, else when
a roll falls under the persona's `talk`; a line it will not speak to is
not a task.

Open: the roll a hash of the seat and `given`, or from a seed in `deal`.

Answers: `apply` keys `answered[seat]` by content: turn key, line ids, hand.

- Accepted: the action, then the reaction, then the line, unless `talk` is
  false or another seat answered the same whole-table line.
- Turned away (illegal, or `n` moved since its base): a try and why in
  `tries`, due again; at `MAX_TRIES` (3) the world checks, else folds,
  `as` the seat, `forced`.
- `{ failed }` on a turn: the world checks, else folds, for the seat at
  once; on a line: gone. Nothing: answered.

Only `apply` writes `thoughts`, from that seat's runs. A person's act
carries the `base` their screen showed; stale or illegal, it is `{ refused }`.

- Open: with a turned-away action, its line lands (today) or waits.

Time. `deadlines`: `timeout { base: turn }` at a person's turn `at`, which
plays the fallback if that is still the turn; once the host sits down, each
AI seat's hello, 1.4 s apart, `as` that seat, then `deal`. The store's host
commits each, stamped by the store. No rule reads a clock.

## Members and controllers

One controller per member, on its owner's host: an AI seat in the room or
in its owner's page ([rooms](rooms.md)), each person on their page, the
dealer a script in the room. A
person's program is the screen, showing every task ("your turn", with its
timer); people also act unasked: chat, react, buy in, leave, `next`.

## Presence

`thinking` and `typing` are presence, seen by all, never state. An AI
client shows `thinking` for its persona's `PACE` (longer facing a bet, from
its view), then `typing` for its line, then commits all in one change.

## Outside programs

The dealer keeps the deck in the room: on `deal` it commits the hole
cards and the hand, on `board` the street's cards. `act` (legal moves,
pots, the showdown) stays pure, in `apply`, and deals from no deck.

## Agent clients

Renderer: tools; `content` and `rules` the prompt, `actions` the tools, plus
`thinking`. Local: the visitor's model and key (`models()`,
`preview/game-page.js`); whom the owner pays for; the depth limit; the
breaker. Capacity: one queue for that key, turns before chat.

Open: by default the owner pays for friends' lines (the room), or not.

## Today

`W` is `preview/poker-world.js`, `P` is `preview/poker.js`:

- The table lives only in page memory (`P:39`): a refresh ends the game.
  The way there: keep `{ rev, state }` in the host browser's storage on
  each commit, as the bankroll is (`P:47-50`).
- Five calls with I/O (`W:382`); who is due is `plan` (`src/core/due.js:44`),
  from `seen` in memory (`src/core/runtime.js:260`). One runtime for all
  seats (`P:152`); people have none: the page draws their turn (`P:571`)
  and friends' views (`share`, `P:901`).
- `land`, `say`, `deal`, `force` change the table in place (`W:315`, :296,
  :193, :364); `commit` only logs (`W:147`), a rev per rebuy (`W:214`).
- `stamp()` reads `Date.now()` (`W:143`); a turn turned away is re-asked by
  a new `turnAt` (`W:344`); the turn timer is a page `setTimeout`
  (`P:80-94`); `force` checks `toAct`, not the turn (`W:367`).
- Notes `tries`, `triesKey`, `rejected`, `thoughts` on the table (`W:139`,
  :320, :341-343); `view` rolls `Math.random()` (`W:273`, from :410).
- A run lands in two commits, the line after `typing` (`W:432-437`); its
  pace reads the live table (`P:103-109`). A failed run commits nothing;
  Retry is in memory (`P:162`, :800); a model change retries (`P:56-59`).
- `startHand` shuffles, `act` deals from `hand.deck`
  (`preview/poker-dealer.js:113`, :259-260). A person's move lands on a
  base from the table now (`P:637`); a friend is whoever its hello claims
  (`P:871`); hellos are page timers (`W:110`, `P:244-251`); no breaker
  (`P:154`).
