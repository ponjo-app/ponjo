# Runtime migration

How Ponjo's code moves from the design before the [runtime
reference](../runtime/README.md) to it. What differs today: its
[Today](../runtime/README.md#today). The worlds' target designs:
[doc](worlds/doc.md), [poker](worlds/poker.md),
[werewolf](worlds/werewolf.md), [spy](worlds/spy.md), [rooms](worlds/rooms.md).

## Order

```
1 doc answers survive a restart      (old runtime)
2 the new core, with spy             (in the page)
3 werewolf and poker on it           (in the page)
4 game rooms on the relay
5 the doc on the new core            (old runtime deleted)
6 the docs say what is
```

Why this order:

- **Step 1 first, on the old runtime.** It fixes the one fault that costs
  people money today (a restart runs every open ask again) with a few
  changes in the doc world and no new parts.
- **The games before the doc.** They use every new part (tasks, the
  ledger, the clock, people's controllers, hidden views) at the lowest
  stakes, so the core is proven before it reaches the editor. Spy first: it
  has no deck and the fewest rules.
- **No adapter.** The old runtime keeps serving the doc while the games
  use the new core; each world moves whole. When the doc moves (step 5),
  the old runtime is deleted.
- **The door last.** It holds the editor's typing and merging. It changes
  only once the core around it has run in three worlds.

Each step is one issue and one or a few pull requests, with its tests, and
lands with the app working. A step that changes what people see or what
is kept on disk waits for its design gate: the person agrees to it first.

## 1. Doc answers survive a restart

On the old runtime, the doc world records every answer where a restart
finds it.

- A run that posts no comment in a thread it was given gets one written
  for it ("Looked; nothing to change."); a failed one gets "Could not
  finish.", the why to the owner alone. An ask is answered by the rule the
  sidecar has: a buddy's comment after it. Retry is a person asking again.
- Which comments this machine's runs posted, with their `for` and depth
  (`posted` in `src/host/doc-world.js`), is kept in `history/<doc>/`.
- A watch's watermark (its text's fingerprint and wake lines) is kept with
  the watch (`watching.json`).
- Goes: the runtime's `seen` and `failed` for the doc's asks; Retry as a
  call (`retry` in `src/core/runtime.js`).

Design gate: the written comments' words, and Retry in the host spec.

Done when: after a restart no answered ask runs again, a failed ask shows
its comment, and a watcher does not run on a doc it already saw; the
golden logs are recorded again, and each changed line is read.

## 2. The new core, with spy

The runtime's Part 1 and 2, with one world.

- `src/core/`: the answer ledger (a pure wrapper around `apply`), the
  controller loop, the wallet's limits (the depth limit, N runs), and the
  clock as a member whose program is a timer.
- Spy's rules as `view` and `apply` (`preview/spy-rules.js`,
  `preview/spy-world.js`): tasks per seat, one answer to a line for the
  whole table, the discussion as a channel; no `stamp()`.
- A store in the page, kept in its storage on each commit, so a refresh
  resumes the game. People's controllers: the page shows their tasks.
- Goes: spy's use of `src/core/runtime.js`, its page timers, its tries.

Done when: `test/spy.test.js` passes on the new core, a refresh resumes a
game mid-vote, a run lands in one commit, and the AI seats' views are
built by the same `view` as people's.

## 3. Werewolf and poker on the core

- Both as `view` and `apply`; one kit in `preview/` for what the three
  share (chat, the clock's tasks, a seat's thoughts).
- Poker's dealer as a system member; `share` goes, people's pages read the
  world's `view`.
- Werewolf's narrator as clock tasks of fixed length; the table is the
  world and a game a change.
- Goes: their use of `src/core/runtime.js`, `stamp()`, page timers, each
  game's own tries and its own view for friends.

Done when: `test/poker.test.js` and `test/werewolf.test.js` pass on the
core, and the three games' shared code is in the kit.

## 4. Game rooms on the relay

The store moves from the opener's page to the room
(`relay/worker.js`, `Room`), as [rooms](worlds/rooms.md) says.

- The room keeps `{ rev, state }` in its storage, runs the game's `apply`,
  and sends each client only its view.
- It gives a token to each member who sits, and sets `by` from it.
- Its alarm drives the clock. The dealer and the AI seats run in it, the
  AI seats with Ponjo's key or a visitor's, kept as rooms.md says; each
  room has a budget and a rate.
- Goes: the opener's page as store, the forwarding in
  `preview/poker-share.js`.

Design gate: the relay keeps state (today it keeps none:
[architecture](architecture.md)); a visitor's key kept by the room, and
what the page tells them of it; the room's budget and rate. To check
first: the Durable Object storage and alarms within the Workers plan the
relay runs on.

Done when: a game goes on with the opener's page closed; a refresh is
back in the same seat; a page receives no view but its own seat's (a test
reads every frame); a page cannot act as another seat; `test/relay.test.js`
covers rooms with state.

## 5. The doc on the new core

- **The store.** The door holds the comments in memory and reads the
  sidecar on disk only as an outside writer; a run lands in one door call,
  at one rev, each group still a version in history; `wait` per member, by
  a view's fingerprint.
- **The world.** The doc's `view` and `apply` as pure functions in
  `src/core/`; tasks from the state (asks, watches, the settle as a clock
  task); the ledger.
- **Controllers.** One per buddy per open doc, with the wallet (limits, the
  owner's policy on who may ask) and capacity: a command-line agent calls
  its provider itself, so capacity here is how many runs go at once per
  agent program and key.
- **The runtime panel** (`web/runtime-panel.js`) shows the new trace.
- Goes: `src/core/runtime.js`'s loop and notes, `src/core/due.js`, the
  five-call contract, the comments read from disk beside the door
  (`src/host/doc-world.js`).

Design gate: any change to what a person sees of runs (the panel, the
agent log, Retry).

Done when: the golden scenarios pass, with each changed line read; the
protocol fuzz and the stress tests pass; a restart in the middle of a run
lands nothing twice and runs each open ask once.

## 6. The docs say what is

The Today sections go from the runtime reference and the world docs; the
host spec, the architecture page (the relay keeps rooms' state) and the
agent config say what the code does.

## Risks

- **The door** (step 5) holds every keystroke. Its typing and merging
  (`transform`, `merge3`) do not change; only where the comments are read
  and how a run lands. The protocol fuzz guards it.
- **The relay** (step 4) becomes a place that keeps state and keys. Its
  limits, its cost and the keys' safety are checked before it ships.
- **Behaviour people notice:** written answers in threads (step 1), games
  that outlive a page (step 4), buddies that no longer run twice after a
  restart (steps 1 and 5). Each goes through its design gate.
