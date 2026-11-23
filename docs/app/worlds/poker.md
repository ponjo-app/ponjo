# Poker table

The poker page (`preview/poker.js`): No-Limit Hold'em with the opener, AI
players (`PERSONAS`), friends who join by a link, a dealer and chat; in the
target design, a world of members on the [runtime](../../runtime/README.md),
stored in a [room](rooms.md) where the AI seats, dealer and clock run.

## State

```
Table { players, slots, names, hand, handNo, button, topUp, joining, leaving,
        chat, reactions, seats: { id → { thoughts: [{ hand, street, text, action }] } } }
Line  { id, by, as, text, to (whom it names), depth, about, hand, at }
hand  as in preview/poker-dealer.js, with no deck
```

`thoughts` is the seat's state, written by `apply` from its own runs. The
answer ledger (answered, tries, why) is the runtime wrapper's, in the state.

## Store

The room holds `{ rev, state }` and gives each member only `read(member)`:
people's pages, AI seats, the dealer, the clock. `wait(member, rev)`
returns once that member's view changed. `commit` sets `by` from the
member's token and stamps `at`. A change is `{ by, at, as, base, answers,
body }`; `base` of a move is `{ hand, n }`, the turn it was made on. No
page, the opener's included, can read another seat's cards. `past` is
unused: the hand and the chat are in the state. There are no effects.

## World

```
view(state, member, past)    → { content, actions, tasks, seen, rules }
apply(state, change, past)   → { state, effects: [] } | { refused: why }
fallback(state, task)        → change        a check, else a fold; for other tasks, nothing
tries                        3
```

One `view` for every seat; `share` and `prompt` go:

- `content`: the table, this hand's actions and reactions, the last 24
  lines; its own hole cards, others' at a showdown; for people, the AI
  seats' cards and `thoughts` once the hand is over; for an AI seat, its
  own `thoughts` this hand, and why its last try was refused.
- `actions`: on its turn `fold`, `check`, `call`, `bet`, `raise`, `allin`,
  with legal amounts; `say`, `react`; people's `sit`, `topup`, `leave`;
  the opener's `next`, `add`, `remove`, `invite`, `turnAway`.
- `seen`: all presence, to all. `rules`: `RULES`, and a persona's style.

| `given` | `as` | `kind` | When | `from` | `at` |
| --- | --- | --- | --- | --- | --- |
| `turn:<hand>:<n>` | the one to act | turn | the hand is live | — | 30 s after the turn began |
| `line:<id>` | an AI seat the line names | ask | `depth` < `DEPTH` (2) | its people | — |
| `line:<id>` | one AI seat, for a person's line to the whole table | ask | as above | the person | — |
| `react:<hand>` | the winner and one other still in, if AI | turn | a big hand ended | — | — |
| `deal:<handNo>` | the dealer | turn, or ask after `next` | the opener sat, or chose `next` | the opener | — |
| `board:<hand>:<street>` | the dealer | turn | a street closed, two or more still in | — | — |
| `timeout:<hand>:<n>` | the clock | turn | a turn is live | — | the turn's `at` |

`depth` is 0 for a person's line or the rules', else one more than the
agent line's. An agent's line carries on the `from` of the tasks its run
answered. `DEPTH` is the table's rule; a hello is said at it, so it sets
off nothing. A seat's turn and its lines are separate tasks; its
controller batches them into one run and one change. `talk`: a line task is
listed always for a person's line, else when a roll falls under the
persona's `talk`.

- Open: the roll: a hash of the seat and `given`, or a seed in `deal`.
- Open: who gets a person's whole-table line: the next AI seat after the
  speaker, or one picked by the roll.
- Open: a person alone with AI seats: 30 s too, or a longer `at`.

Answers. `apply` lands a move only if `base` is still the turn and the
dealer says it is legal; a stale or illegal change is refused, whoever
sent it. A person sees why at once. For an AI seat the ledger counts a try
and the turn is due again; at 3 tries, or when the run failed or the
wallet would not start it, the `fallback` plays. A refused change lands
nothing: not its line, not its reaction, not its thinking. A move that lands
takes its reaction and its line with it.

Time. The clock's `timeout`, with its base still the turn, plays the
seat's `fallback`; stale, it is refused. No rule reads a clock: `stamp()`
and `turnAt` give way to the store's `at` and the ledger.

## Members and controllers

One controller per member: the opener and each friend on their pages; each
AI seat, the dealer and the clock in the room. A person's screen shows every
task ("your turn", with its `at`); people also act unasked: chat, react, buy
in, leave, `next`. The opener's `sit` lands the AI seats' hellos as lines.

## Presence

`thinking` is presence while a run goes, seen by all, never state. A run
commits as soon as it ends; `PACE` and the `typing` wait go. A screen may
type a fresh line out.

## System members

The dealer is a script in the room that holds the deck: on `deal` it
shuffles and commits the hole cards and the hand, on `board` the street's
cards. `act` (legal moves, pots, the showdown) stays pure in `apply` and
deals from no deck. The clock wakes on the room's alarm at its next task's
`at` and commits `timeout` with that turn as base.

## Agent clients

AI seats run in the room, beside the store, with their wallets. The
renderer gives the world's actions as the only tools, and `thinking` as
text. A seat uses Ponjo's key, or that of the visitor who brought it, kept
in the room's storage apart from the state. The owner always pays; the
wallet's policy on `from` says whose lines start a run. A turn it will not
start is answered as not started and falls back; the breaker counts no
turns. Capacity: one queue per key in the room, turns before lines.

## Today

`W` is `preview/poker-world.js`, `P` is `preview/poker.js`:

- The table lives only in the opener's page memory (`P:39`): a refresh ends
  the game, and that page can read every card. The way there: a room.
- Five calls with I/O (`W:382`); who is due is `plan` (`src/core/due.js:44`),
  from `seen` in memory (`src/core/runtime.js:260`). One runtime for all
  seats, on the opener's key (`P:152`); people have none: the page draws
  their turn (`P:571`) and friends' views (`share`, `P:901`).
- `land`, `say`, `deal`, `force` change the table in place (`W:315`, :296,
  :193, :364); `commit` only logs (`W:147`), a rev per rebuy (`W:214`).
- `stamp()` reads `Date.now()` (`W:143`); a refused turn is re-asked by a
  new `turnAt` (`W:344`); turn timers are page `setTimeout`s, for people
  only (`P:80-94`); `force` checks `toAct`, not the turn (`W:367`).
- The world keeps its own tries and fallback (`W:139`, :341-348) and a
  refused run's thinking (`W:320`); `view` rolls `Math.random()` (`W:273`).
- A run lands in two commits, the line after `typing` (`W:432-437`); its
  pace reads the live table (`P:103-109`). A failed run commits nothing;
  Retry is in memory (`P:162`, :800).
- Every AI seat hears a person's whole-table line; the first answer wins
  (`W:264-267`, :356). Hellos are page timers (`W:110`, `P:244-251`).
- `startHand` shuffles, `act` deals from `hand.deck`
  (`preview/poker-dealer.js:113`, :259-260). A person's move lands on a base
  from the table now (`P:637`); a friend is whoever its hello claims (`P:871`).
