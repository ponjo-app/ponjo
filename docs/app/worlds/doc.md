# The doc world

A text doc and its comment threads, which people and buddies co-author:
Ponjo's world on the [Blackboard Agent Runtime](../../runtime/README.md).
What a person sees: [host spec](../host-spec.md#buddies); what a run gets
and returns: [agent config](../agent-config.md).

## State

```
State { text, threads, settled, answered, problem }    at { epoch, rev }
```

`text` is the doc; `threads` the sidecar's ([SPEC](../../../spec/SPEC.md));
`settled` the last rev at which people had paused; `answered` each buddy's
watermarks: per thread, the `until` it was given, per watch, the hash of
the text it was given; `problem` why the sidecar may not be written (another
version): then nothing is due. `text` and `threads` are files; the rest is
the door's memory. `rev` counts text and comment changes since the host
opened the doc, which `epoch` names.

Open: whether `answered` outlives a restart: in the sidecar, in history, or not.

## Store

The doc's door (`src/host/doc-service.js`):

```
read()               → { rev, state }     door.text(), the sidecar, door.rev()
wait(rev, deadline)  → rev                 subscribe(fn), told as each change lands
commit(change)       → { rev, actions } | { refused: why }
```

The door moves a change made on an older state onto the newest, rather
than refuse it. A window's edit, operations on `{ epoch, rev }`, is
transformed by character over what landed since (`transform`); one from
another epoch, or older than the log's 1,000 changes, is refused `stale`.
A whole text (a run's group, an outside change, an undo) is merged by line,
`merge3(base, now, late)`, the doc's lines winning, and never refused. The
transform or the merge is the apply, so no retry is needed. A run's change
is one commit, at one rev; each group is still a version in history.

Every call carries `who`, set by the host from the connection, checked
once (`can`). A run commits as its buddy, at most `write`.

An outside write (`git pull`, another editor) is a commit `by: outside`:
the door watches both files, takes a doc file once still for 50 ms, saves
it to history and merges it by line from the text the file last held. A
sidecar it did not write is taken whole; its new comments ask no one.

## Local

| Holds | Where | Why it is local |
| --- | --- | --- |
| `taken`: each comment this host took from a member, by a hash of its thread, author and body | `history/<doc>/taken.json` | only a comment taken here asks; in the file `by` is what its writer says (SPEC §7) |
| `posted`: each comment a run here posted, with the run's `for` and depth | Open: memory, or `history/<doc>/` | its @mentions ask for those people |
| watches: buddy → `{ by }` | `history/<doc>/watching.json` | a watch spends on every change |
| the room: teammates and levels | memory (`src/host/room.js`) | who may ask |
| settings: the agent, its settings and secrets, `about`, `actions`, `pauseAfter`, `pauseWithin` | `settings.json`, `secrets.bin` | what runs, and what it may do unasked |
| actions: the programs, each one's record | `actions/`, `logs/actions.jsonl` | carried out once, by this machine's leave |
| limits: depth 1,000; the breaker, 300 runs in 10 min | memory | one decision for all the owner's buddies |

The door notes `taken` before it writes a person's comment; `record`
notes `posted` before a run's commit. `changed()` returns on a watch, the
room, the settings, a buddy file (`buddies/`, or a project's
`.ponjo/buddies/`, outside the door), or a run's end.

## World

```
due(state, local, buddy)     → [Task]
view(state, local, task)     → { files, prompt }
apply(state, change, local)  → { state, actions } | { refused: why }
```

An ask is a person's comment that names a buddy, open until the buddy
comments after it in the thread (`askedBy`, `src/core/comments.js`). It
asks whom it @mentions; one that mentions no one asks the thread's
buddies: the one that opened it and each @mentioned there before. Only a
comment in `taken`, by a member who may write, asks. An empty comment
(resolving, reopening) asks no one; resolving drops what the thread asked.
A comment in `posted` asks each other buddy it @mentions, for that run's
`for`, at its depth + 1. An ask's id is its thread's; its version is
`until`, the time of the thread's latest comment.

A watch is due while it is on, whoever set it may ask, and the text is not
the one its watermark hashes. Comments alone wake no watcher. A run may
name lines in `PONJO_WAKE`; until its next run the watch is due only while
the text holds one of them, whole.

Audiences. A task is `for` an ask's author; for a buddy's ask, that run's
`for`; for a watch, its `by`. Every person in the doc sees the whole text
and every thread: the sidecar is one plain shared file, so there are no
private threads, and all views of a buddy are the same. The audience
decides only who must still be allowed to ask, and whose runs count.

Watermarks. `apply` records each run's change as answered: per given
thread, the `until` it was given; for the watch, the hash of `base`'s text.
A run that made nothing, or failed, records the same; Retry is a person's
commit that clears a failed one.
Open: how an empty or failed run is kept: a sidecar line (an empty reply,
or SPEC's `failed`), a note in `history/<doc>/`, or door memory only.
Open: how a change of the agent or its settings voids failed watermarks: a
commit by the host, or a settings hash in each that `due` compares.

Readiness and staleness. A person's change is ready once people pause for
5 s (`SETTLE_MS`): the host clock commits `{ by: clock, settled: rev }` 5 s
after it if none came since. Until then every watch is not ready, so the
controller stops a run only a watch gave. An outside change is ready at
once (a program may write more often than a run lasts: the run lands
merged, and is due again); a buddy's when it lands.

Depth. 0 for a person's ask, and for a watch woken by a person's or an
outside change; for a buddy's ask, or a watch woken only by buddies'
changes, their run's depth + 1.
Open: how `due` tells from a snapshot who made the changes since a
watermark (its own wakes it not; a buddy's sets the depth): a per-member
last change kept in the state, or the door's log in `read`.

Disagreement. Open: how buddies undoing each other for different people
are seen: versions by author in history, or text hashes in the state.

`apply` refuses a run's change if one of `for` may no longer ask. Else it
merges each group (`merge3`; `conflict` where the doc's lines stayed),
moving a thread whose quote the group rewrote; posts each comment, in a
given thread just after the last comment given there; drops a reply in a
thread resolved meanwhile, with its edits; records the watermarks; and
returns the actions of the comments that landed. A run's copies become its
change before `record` (`toChanges`, `src/core/translate.js`).

## Controllers

One for each buddy in each open doc, on the owner's doc host, ending when
the doc closes. The owner pays for every run: a teammate has a page, not a
host. A project's buddy is one agent per owner who opens the project; two
owners on the same files (git, a synced folder) each run a door and see
each other's commits as outside writes. Only `taken` keeps both from
answering one ask.

## Today

- The world is five calls with I/O (`src/host/doc-world.js:55-205`), and
  `due` the controller's `plan` (`src/core/due.js:251`).
- Watermarks and the change log are notes in memory
  (`src/core/runtime.js:88-94`), and `posted` too
  (`src/host/doc-world.js:37`); no watch runs on opening (`runtime.js:92`).
- A run that makes nothing commits nothing (`doc-world.js:185`); a failure
  is noted in memory (`runtime.js:271-277`).
- A run lands as a door call per group and per comment
  (`doc-world.js:172-194`), so a buddy's change counts once its run ended
  (`due.js:291-296`).
- One task per buddy, its askers joined (`due.js:253-270`); one asker no
  longer allowed drops the run (`doc-world.js:164`).
- People's pause is the controller's clock (`due.js:297-298`); staleness a
  flag on the log (`doc-world.js:99`). Comments, settings and actions are
  read from disk at each call (`src/host/doc-service.js:389`,
  `doc-world.js:144-145`), not at a rev.
- The depth limit is the world's (`doc-world.js:19`); the breaker counts
  per doc (`runtime.js:288-294`). One controller per open doc, for all its
  buddies (`src/host/open-doc.js:197`).
