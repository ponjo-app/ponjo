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
fallback(state, task, at)    → state         a check, else a fold; for other tasks, nothing
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

- The store is the table's room on the relay (`relay/table.js`, a `Table`
  Durable Object at infer.ponjo.app, [rooms](rooms.md)), which runs this
  world (`preview/poker-world.js`, through `preview/game-tables.js`). Each
  page (`preview/poker.js`) is one seat's client (`sit`,
  `preview/game-kit.js`): it draws the view the room sends it and sends
  what its person does; no page holds the state.
- The room sends a page its whole view each time it changes, with the
  presence it may see, instead of a notice to read again; there is no
  `wait` and no `past`.
- The AI seats, the clock and the wallet run in the room: the limits
  (depth 10, N 30), in memory; the table's model calls an hour, on Ponjo's
  key or the opener's own; no queue per provider. The opener's own key is
  held in memory only, not kept in storage ([rooms](rooms.md#today)).
- The bankroll stays in the visitor's browser, apart from the table.
- The dealer is a system member of the room: for `deal` and `board` it
  draws the cards from a fresh shuffle of those not yet out (`draw`,
  `preview/poker-dealer.js`), so no deck is kept anywhere; its view lists
  every card out. `apply` checks its cards are new and enough. Its task is
  `deal:<n>`, `n` counting deals, a hand or none for want of chips; the
  first carries an `at`, once the hellos are said.
- The room commits `leave` for a friend not back within `RECONNECT_MS`, or
  sent away by the host; mid-hand, they are checked or folded for, and out
  at the next deal.
- The roll is a hash of the seat and `given` (`rolls`); a person's line to
  the whole table asks the next AI seat after the speaker (its `next`); a
  person alone with AI seats has no `at`, as before.
- An AI seat's program waits its persona's pace (`game-tables.js`) after
  the model answers, so its change lands that much later; each page types
  a fresh line out after.
