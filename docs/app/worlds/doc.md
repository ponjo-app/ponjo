# The doc world

A text doc and its comment threads, which people and buddies co-author:
Ponjo's world on the [Blackboard Agent Runtime](../../runtime/README.md).
What a person sees: [host spec](../host-spec.md#buddies); what a run gets
and returns: [agent config](../agent-config.md).

## State

```
State   { text, threads, record, watches, typed, settled, ledger }    at rev
Watch   { by, seen (a text's hash), since (least depth of changes since), wake }
```

`text` and `threads` are the doc and its [sidecar](../../../spec/SPEC.md).
The rest is the door's own, kept with `rev` in `history/<doc>/`, so a
restart finds the same tasks. `record` says who wrote each comment, as the
door authenticated them, with its depth and, for a buddy's, the `from` of
the tasks its run answered; a comment not in it is by `outside`. `typed` is
when people last changed the text, `settled` the `typed` the clock last
settled. `ledger` is the runtime's, kept by its wrapper around `apply`. A
watch is never in the sidecar: in a file it would vouch for no one. With a
sidecar of another version, nothing is due.

## Store

The doc's door (`src/host/doc-service.js`), holding both files in memory.

```
read(member)        → { rev, view }
wait(member, rev)   → rev        once that member's view changed
commit(change)      → { rev, effects } | { refused: why }
Change  { by, at, as, base, answers, body }
```

`commit` sets `by` from the connection (a window, a teammate's page
through the relay, a buddy's or the clock's controller) and `at`, comments'
too. A window's `base` is a rev, a run's the hash of the text it was given.
The past is history's versions by SHA-256: `apply` moves a window's
operations by character over the edits since its base, and refuses one
whose base is no longer kept (`stale`). A whole text (a run's group, an
outside change, an undo) merges by line, `merge3`, the doc's lines winning.
A run's change is one commit; each group is still a version, to undo
alone. Any text or comment change wakes every member; a settle, only those
whose tasks it moves.

## World

`view(state, member, past)`:

| Field | A person | A buddy |
| --- | --- | --- |
| `content` | the text, the threads, the members | the same |
| `actions` | type, comment, resolve, reopen, watch, undo, restore; the owner more | comment `{ thread \| anchor, body, edits }` |
| `tasks` | Open, below | its asks and its watch |
| `seen` | everyone in the doc | everyone in the doc |
| `rules` | the help | what any member can do and the etiquette (`buildPrompt`) |

Tasks. One per `given`, `as` the buddy:

- `ask`: `given` is a comment that asks it, until the buddy comments
  after it. A comment `record` has by a member who may write asks whom it
  @mentions, or with none the thread's buddies, `from` its author, `depth`
  0; a buddy's, each other buddy it @mentions, `from` its record's, `depth`
  its own + 1. An empty one asks no one; resolving drops the thread's asks.
- `watch`: `given` is the watch and its `seen`; `from` its `by`; `depth`
  its `since`. Listed when `since` is set, the text's hash is not `seen`,
  the text holds a `wake` line if it has any, and `settled` is `typed`.

A run takes every task the wallet lets start; a comment written meanwhile
is a new task, for the next. No member waits on a buddy's task, so none
has an `at`; a run that hangs fails at its timeout. Open: whether a
comment that @mentions a person is a task for them.

Answers. A buddy's change lands its groups, then its comments, a reply
just after the latest comment given in its thread; one in a thread
resolved meanwhile is dropped, with its edits. Every answer to an ask is a
comment, by the rule the sidecar has: a run that posted none in a given
thread gets "Looked; nothing to change."; a failed one, or one the wallet
did not start, "Could not finish.", its why to the owner alone. Retry is a
person asking again.

The door moves a watch on every change that answers it, failed too:
`seen` becomes the hash of the text it lands, or of the one given if
another's change landed meanwhile; `since` clears; its `wake` lines are
kept. Each text change lowers other watches' `since`.

`apply` refuses an illegal change from anyone: a reply on no thread, a
sidecar that may not be written, a stale base. `fallback` gives nothing:
an ask or a watch past its tries is gone. Open: the doc's limit of tries.

Time. The clock is a member on the doc host. While `typed` is past
`settled` it has one `turn`, `given` that `typed`, `at` 5 s after
(`SETTLE_MS`); its change sets `settled`, unless typing made it stale.
Until then no watch is listed, so a run only a watch gave is stopped. An
outside change is ready at once: the door took it whole.

Disagreement. Open, as in the runtime: how buddies undoing each other for
different people are seen.

## Members and controllers

The owner, the room's teammates, the buddies (`buddies/`, a project's
`.ponjo/buddies/`) and the clock, each with a controller. A person's is
their window or page (`web/client.js`): it shows every task, and the
person also acts of their own accord, which is most of what a doc sees. A
buddy's runs on the owner's doc host, one per open doc, and acts only on
its tasks. A buddy file changed by `git pull` may rename it, changing whom
an old `@name` names, but vouches for no ask.

## Presence

Cursors, `here`, typing, a buddy at work: shown to all, kept nowhere.

## Outside programs

Another editor, `git pull`, a synced folder: members with no tasks, each
`by: outside`. A doc file is taken once still for 50 ms, saved to history
and merged by line from the text the file last held. A sidecar's new
comments are in no `record` and ask no one. Another owner's Ponjo on the
same files is one too: each door is a store, and sees the other's commits
as outside writes, so no ask runs on both.

## Agent clients

Renderers. Files, for a command-line agent: copies of the doc and sidecar
in a private folder, the persona, `rules` and the tasks on stdin;
Translate (`toChanges`) turns the copies and `PONJO_GROUPS`, `PONJO_WAKE`,
`PONJO_ACTIONS` into one change, ids included. Tools: the Ponjo agent's
`comment`, with its edits ([Ponjo agent](../ponjo-agent.md)).

Wallet, the config folder. The owner pays, for tasks whose `from` is
themselves or teammates who can write; quotas per person (none yet); the
depth limit and the breaker (Ponjo's numbers Open in the runtime); the
agent, its settings and secrets; effects in `actions/`, records in
`logs/actions.jsonl`. A change of the agent asks nothing again.

Capacity. One queue per provider and key, for the Ponjo agent's calls. A
command-line agent calls its provider itself and waits on its own.

## Today

- The world is six calls with I/O (`src/host/doc-world.js:80-236`), the
  plan the controller's (`src/core/due.js:44`); one controller per open doc,
  for all its buddies (`src/host/open-doc.js:42`), none for people.
- Answers are comments, but notes in memory hold them too (`seen`,
  `src/core/runtime.js:92-93`); `taken`, a buddy's comments' askers and
  depth (`posted`, `doc-world.js:38`) and a watch with its print and wake
  are the config folder's (`src/store/history.js:149-213`).
- A watch run that makes nothing commits nothing (`doc-world.js:194`); a
  failed watch waits for Retry in memory (`runtime.js:278`), and runs again
  when the agent changes (`open-doc.js:52`).
- `rev` starts again at each opening (`doc-service.js:94-96`); comments are
  read from disk at each call (`doc-service.js:389-392`); a run lands in a
  commit per group and comment (`doc-world.js:181-206`), so a watcher
  counts a buddy's change once its run ended (`due.js:84-89`).
- People's pause is the controller's timer (`due.js:90-91`); `at` is
  `Date.now()` (`doc-service.js:442`); a window's edit moves over a log of
  1,000 (`doc-service.js:774`); the depth limit is 1,000
  (`doc-world.js:19`); the breaker counts 300 runs in 10 min
  (`runtime.js:298-304`); runs share no queue.
