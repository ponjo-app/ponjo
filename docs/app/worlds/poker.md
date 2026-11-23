# Poker table

The poker page (`preview/poker.js`) is a No-Limit Hold'em table: one
person, AI players (`PERSONAS`), friends who join by a link, a dealer and
table chat. In the target design it runs in the browser on the
[runtime](../../runtime/README.md): the table is the state,
`preview/poker-world.js` the world, and each AI seat has a controller.

## State

```
Table { rev, players, slots, names, hand, handNo, button, topUp,
        joining, leaving, chat, log, seats: { id → Seat }, answered }
Seat  { thoughts: [{ hand, street, text, action }], turnedAway: { turn, tries, why } }
Line  { id, by, text, to (whom it names), depth, about, hand, for? }
```

`hand` is the dealer's (`preview/poker-dealer.js`): seats, hole cards,
`deck`, board, `n` (actions so far), `toAct`, `result`. `seats` is what an
AI seat keeps between runs: only its own view shows it, and the person
reads `thoughts` once the hand is over. `rev` grows by one per change.

## Store

```
read()               → { rev, state }       state frozen
wait(rev, deadline)  → rev                  on the next commit, or at deadline
commit(change)       → { rev, actions: [] } | { refused: why }
```

- An object in the host's page, on one thread: `commit` reads, applies and
  lands with no `await` between, so its condition always holds.
- A stale move is the world's to see: an action carries `base { hand, n }`,
  the turn it was made on, and `apply` compares it with the state.
- Friends' pages never reach the store. They send moves to the host's page,
  which commits them as theirs, and get a person's view back.

## Local

The host's page also holds what only the owner's machine says: the
bankroll (`localStorage`; chips on the table are state); the model and key
(`models()`, `preview/game-page.js`); whom it vouches for (the person, and
friends admitted by `joined`, not sent away or gone); the depth limit; no
breaker, as nothing is standing. Store and local share a page but stay two
objects: a friend's message reaches the store, never local.

Open: a friend's line sets off a run on the owner's key, or only the
owner's do.

## World

```
due(state, local, agent)     → [Task]
view(state, local, task)     → { files: base, prompt: { rules, situation } }
apply(state, change, local)  → { state, actions: [] } | { refused: why }
base  { hand, n, street, turn, about, react, talk }
```

| `due` gives | When | Audience | Depth |
| --- | --- | --- | --- |
| `turn:<hand>:<n>` | the hand is live, its seat is `toAct`, not answered or last turned away | the owner | 0 |
| `line:<id>` | a line names it, or a person says it to the whole table; not its own or the dealer's; `depth` < `DEPTH` (2) | the line's person, or an agent's line's `for` | the line's |
| `react:<hand>` | a big hand ended (all in, or 15 big blinds); the winner and one other still in | the owner | 0 |

The turn and the owner's lines are one task; a friend's line is another.
Lines said at `DEPTH` (hellos, byes) wake no one. `talk`, whether a run may
speak: always to a person's line or after a big hand, else when a roll falls
under the persona's `talk`.

`view` is the seat's: the dealer's `view(hand, seat)` (its own hole cards,
others' at a showdown), the last 24 lines, this hand's reactions, its own
`thoughts` this hand, why its last action was turned away, and `talk`.

| `apply` takes | By | Lands |
| --- | --- | --- |
| `{ by, for, given, depth, base, made }` | agent | `made.thinking` into `thoughts`. `made.action` against `base`: a moved turn or an illegal action is turned away, `tries` + 1, why kept for its prompt; at `MAX_TRIES` (3) the dealer checks, else folds, for it (`forced`). Then `react`; then `say`, unless `talk` is false or another agent answered the same whole-table line. `given` is answered. |
| `act { base, action }` | person | stale or illegal: refused |
| `say`, `react` | member | a line, a reaction |
| `sit`, `topup`, `leave`, `join`, `part` | person | between hands, or at the next |
| `deal { deck }` | dealer | rebuys for AI players out of chips; the hand |
| `timeout { turn }` | clock | the dealer checks or folds, if `turn` is still the turn |

Watermarks, `answered[agent]`: `turn` (the key, whether turned away),
`lines` (per audience, the highest id), `react` (the hand). Every run's
change sets them, also `made: null` and `{ failed }`.

*Dealer.* Its rules (`act`: legal moves, the next street from `hand.deck`,
pots) are pure and run inside `apply`. Outside is what commits `deal`: the
person's Next, and the page after the hellos. *Randomness.* The deck is
shuffled outside and comes in `deal`. *Time.* Order is `rev` and ids; no
rule reads a clock. While friends are at the table a person has 30 s to
act; the host's clock commits `timeout`.

- Open: the `talk` roll a hash of the agent and `given`, or a seed in `deal`.
- Open: a failed run on a turn counts as a try, or waits for Retry.
- Open: the deck in the state, seen by any reader of the store; or in the
  dealer's local, each street committed as its cards.

## Controllers

One per AI seat, made when a player joins, ended when it leaves. A run is
one model call with the `decide` tool; the player's pace (`thinkTime`) is
the run's. The person and friends are members, not agents: no controller;
their page shows their turn, and they commit their own moves.

Open: a line after its player is seen typing, as a second commit; or in
one commit with the action, drawn late.

## Today

In `preview/poker-world.js` unless named:

- Five calls with I/O (`createWorld`, :382); who is due is `plan`
  (`src/core/due.js:44`), from `seen` in memory (`src/core/runtime.js:260`).
  One runtime for all seats (`poker.js:152`); asks merge across audiences;
  every person `mayAsk` (:399).
- Calls change the table in place: `land` (:315), `say` (:296), `deal`
  (:193), `force` (:364); `commit` (:147) only logs and bumps `rev`.
- `stamp()` reads `Date.now()` (:143) for `turnAt` (:150) and a line's `at`
  (:299), which tell asks apart; a turned-away turn is asked again by a new
  `turnAt` (:344). Seat notes `tries`, `triesKey`, `rejected`, `thoughts`
  (:139) are written by `land` (:320, :341-343). `view` rolls
  `Math.random()` for `talk` (`begin`, :273, from :410).
- One run lands in two commits: the action, then the line after `typing`
  (:432-437). One that makes nothing or fails commits nothing; a failure
  is kept in memory, with Retry (`poker.js:162`, `poker.js:800`). `deal`
  shuffles (`poker-dealer.js:113`) and lands a rev per rebuy and one for
  the hand (:214, :220).
- A person's move lands on a `base` from the table now, never stale
  (`poker.js:637`). The turn timer is a `setTimeout` that calls `force`
  (`poker.js:80-94`), which checks `toAct`, not the turn (:367).
- The page writes hellos and byes as the player's lines (:110, :136;
  `poker.js:244`) and builds each friend's view (`share`, `poker.js:901`).
