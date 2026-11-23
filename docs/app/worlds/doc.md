# The doc world

A text doc and its comment threads, which people and buddies co-author:
Ponjo's world on the [Blackboard Agent Runtime](../../runtime/README.md).
What a person sees: [host spec](../host-spec.md#buddies); what a run gets
and returns: [agent config](../agent-config.md).

## State

```
State   { text, threads, record, watches, settled, log }    at rev
Watch   { by, seen (a text's hash), since (least depth of changes since), wake }
```

`text` and `threads` are the doc and its [sidecar](../../../spec/SPEC.md).
The rest is the door's own, kept with `rev` in `history/<doc>/`, so a
restart finds the same tasks. `record` says who wrote each comment, as the
door authenticated them, with its depth and, for a buddy's, its run's
`for`; a comment not in it is by `outside`. `settled` is the rev at which
people last paused; `log` the last 1,000 operations, for `apply` to move a
window's edit over. With a sidecar of another version, nothing is due.

A watch is the door's own, on this machine, never in the sidecar: it
spends the owner's money, and in a file it would vouch for no one
elsewhere.

## Store

The doc's door (`src/host/doc-service.js`), holding text and sidecar in
memory.

```
read(member)        → { rev, view }
wait(member, rev)   → rev        once that member's view changed
commit(change)      → { rev, actions } | { refused: why }
```

`commit` sets `by` from the connection (an owner's window, a teammate's
page through the relay, a buddy's controller) and `at`, comments' too,
from the door's clock. A window's operations are transformed by character
over `log`; a whole text (a run's group, an outside change, an undo) is
merged by line, `merge3`, the doc's lines winning. A run's change is one
commit at one rev; each group is still a version in history, to undo
alone. A person's edit older than `log` is refused `stale`.

The past is history's versions, named by SHA-256 (`history/<doc>/`). All
see the whole doc, so any text or comment change wakes every member;
`settled` wakes only those whose tasks it changes.

## World

`view(state, member, past)`:

| Field | A person | A buddy |
| --- | --- | --- |
| `content` | the text, the threads, the members | the same |
| `actions` | type, comment, resolve, reopen, watch, undo, restore; the owner more | comment `{ thread \| anchor, body, edits }` |
| `tasks` | Open, below | its task, below |
| `seen` | everyone in the doc | everyone in the doc |
| `rules` | the help | what any member can do and the etiquette (`buildPrompt`) |

Tasks. A buddy has at most one task: every ask needs the same seat (the
buddy) and rights (`write`), whoever asked. `given` holds each thread that
asks it, by id, and `watch` while its watch is due; `as` is the buddy;
`for` is each asker and the watch's `by`; `depth` the least of theirs.

- A comment `record` has by a member who may write asks whom it
  @mentions, or with none the thread's buddies; a buddy's, each other buddy
  it @mentions, for its run's `for`, at its depth + 1. An empty one asks no
  one; resolving drops what the thread asked.
- A thread asks until the buddy has an answer at its latest comment.
- A watch is due when `since` is set, the text's hash is not `seen`, the
  text holds a `wake` line if it has any, and people have settled.

Open: whether a comment that @mentions a person is a task for them.

Answers. Every run's change lands. `apply` answers each given thread at
the latest comment the run's view held, so one written meanwhile still
asks, and posts its replies just after it; a reply in a thread resolved
meanwhile is dropped, with its edits. It sets the watch's `seen` to the
hash of the text it lands, or of the text given if another member's change
landed meanwhile, clears `since`, and keeps the run's `wake` lines. Each
text change lowers the other watches' `since`. Nothing made is an answer;
so is a failure: each gets a comment written for it, below; Retry is a
person asking again.
It is turned away only when the sidecar became unwritable; due again once
it is not. `{ refused }` is for people and outside programs alone.

Every answer to an ask is a comment. A run that posted none in a thread
it was given gets one written for it ("Looked; nothing to change."); a
failed one gets "Could not finish.", its why to the owner alone. So an ask
is answered by the rule the sidecar already has, a buddy's comment after
it, and needs no record of its own.

Time. `deadlines(state)` holds `{ settled: rev }` 5 s (`SETTLE_MS`) after
a person's latest text change; typing meanwhile keeps it from landing.
Until it lands no watch is listed, so a run only a watch gave is stopped.
An outside change is ready at once: the door took it whole.

Disagreement. Open: how buddies undoing each other for different people
are seen: text hashes `apply` keeps per group, by author, or another way.

## Members and controllers

The owner, the room's teammates and the buddies (`buddies/`, a project's
`.ponjo/buddies/`), each with a controller. A person's is their window or
page (`web/client.js`): it shows every task, and the person also acts of
their own accord, which is most of what a doc sees. A buddy's runs on the
owner's doc host, one per open doc, acts only on its task, and goes on
while any of its `given` is listed. A buddy file changed by `git pull` may
rename it, changing whom an old `@name` names, but vouches for no ask.

## Presence

Cursors, who has a window on the project (`here`), who is typing, which
buddy is at work: told to the door, shown to all in the doc, kept nowhere.

## Outside programs

Another editor, `git pull`, a synced folder, the clock: each commits as
itself, a file as `by: outside`. A doc file is taken once still for 50 ms,
saved to history and merged by line from the text the file last held. A
sidecar's new comments are in no `record` and ask no one. Another owner's
Ponjo on the same files is one too: each door is a store, and sees the
other's commits as outside writes, so no ask runs on both.

## Agent clients

Renderers. Files, for a command-line agent: copies of the doc and sidecar
in a private folder, the persona, `rules` and the task on stdin; Translate
(`toChanges`) turns the copies and `PONJO_GROUPS`, `PONJO_WAKE`,
`PONJO_ACTIONS` into one change, ids included. Tools: the Ponjo agent's
`comment`, with its edits ([Ponjo agent](../ponjo-agent.md)).

Local, the config folder: whom the owner pays for (the owner, teammates
who can write); budgets (none yet); depth 1,000; the breaker, N runs since
a person last acted in the doc; the agent, its settings and secrets; the
outside actions, each a task for the owner. A change of the agent asks
nothing again.

Capacity. One queue per provider and key, for the Ponjo agent's calls. A
command-line agent calls its provider from its own process: the host sees
neither its waiting nor its 429s.

## Today

- The world is five calls with I/O (`src/host/doc-world.js:55-205`), the
  plan the controller's (`src/core/due.js:44`); one controller per open doc,
  for all its buddies (`src/host/open-doc.js:42`), none for people.
- Answers, watches' `seen`, `since` and wake lines are notes in memory
  (`src/core/runtime.js:88-94`); a buddy's comments' `for` and depth too
  (`doc-world.js:37`); `taken` is local's (`src/store/history.js:148-160`).
- A run that makes nothing commits nothing (`doc-world.js:185`); a failure
  waits for Retry in memory (`runtime.js:271-277`), and runs again when the
  agent changes (`open-doc.js:52`).
- `rev` starts again at each opening (`doc-service.js:94-96`); comments are
  read from disk at each call (`doc-service.js:389-392`); a run lands in a
  commit per group and comment (`doc-world.js:172-194`), so a watcher
  counts a buddy's change once its run ended (`due.js:84-89`).
- People's pause is the controller's clock (`due.js:90-91`); `at` is
  `Date.now()` (`doc-service.js:442`); outside is `world` (`doc-world.js:23`).
- A watcher's last view is in memory (`runtime.js:264`); the breaker counts
  300 runs in 10 min (`runtime.js:288-294`); runs share no queue.
