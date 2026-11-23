# Runtime migration

How Ponjo's code moved from the design before the [runtime
reference](../runtime/README.md) to it. Done; what still differs:
[Differs](../runtime/README.md#differs). The worlds:
[doc](worlds/doc.md), [poker](worlds/poker.md),
[werewolf](worlds/werewolf.md), [spy](worlds/spy.md), [rooms](worlds/rooms.md).

## Steps

Each one issue and its pull request, with its tests, landing with the app
working; a step that changed what people see or what is kept on disk
waited for the person to agree to its design first.

1. Doc answers survive a restart, on the old runtime: every ask answered by a comment (#500).
2. The new core (`src/core/store.js`, `ledger.js`, `controller.js`), with spy as its first world (#501).
3. Werewolf and poker on it, with one kit for the three games (#502).
4. Game tables become rooms on the relay, each holding its store, AI seats and clock (#503).
5. The doc on the new core; the old runtime deleted (#504).
6. The docs say what the code does (issue #499).

## Why this order

- **Step 1 first, on the old runtime.** It fixed the one fault that cost
  people money (a restart ran every open ask again) with a few changes in
  the doc world and no new parts.
- **The games before the doc.** They use every new part (tasks, the
  ledger, the clock, people's controllers, hidden views) at the lowest
  stakes, so the core was proven before it reached the editor. Spy first:
  it has no deck and the fewest rules.
- **No adapter.** The old runtime kept serving the doc while the games
  used the new core; each world moved whole. When the doc moved (step 5),
  the old runtime was deleted.
- **The door last.** It holds the editor's typing and merging. It changed
  only once the core around it had run in three worlds.
