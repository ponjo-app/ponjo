# Agent runtime

How agents run against a world. Why it is built this way: [runtime
vision](runtime-vision.md). Ponjo's doc world: [host spec](host-spec.md#buddies).
What an agent program gets and returns: [agent config](agent-config.md).

| Word | Means | In Ponjo |
| --- | --- | --- |
| member | a person or an agent | |
| agent | an AI member: an id and a prompt | a buddy |
| agent program | the tool that does an agent's thinking | an agent |
| world | the state the members share, and its rules | a doc and its comments |
| writer | the only part of a world that changes its state | the doc's door |
| ask | a request from a person that names an agent, open until it answers | a comment that @mentions a buddy |
| watch | a person's standing request: run this agent when its view changes | Watch this doc |
| run | an agent program working once for one agent | |

## Parts

```mermaid
flowchart LR
  subgraph runtime["Runtime"]
    loop["Loop"] -- "state" --> plan["Plan"]
    plan -- "start, stop" --> loop
    loop -- "start" --> run["Run"]
    run -- "ended" --> loop
  end
  loop -- "wait, members, asks" --> world["World and its writer"]
  run -- "view, propose" --> world
  run -- "files, prompt" --> program["Agent program"]
```

| Part | Does | Never |
| --- | --- | --- |
| Loop | waits until the world changes, a run ends or a deadline passes; reads the world; applies the plan | decides who runs |
| Plan | a pure function: state → whom to start and stop, when to look again, and why for each agent | reads a file or a clock |
| Run | one agent, once: its view in, the agent program, a proposal out | changes the world, or starts a run |
| World | answers the five calls below | knows about runs |

## The world's five calls

```
members()                           who is here: id, name, person or agent, may ask
asks()                              open asks: id, agent, when, from whom
view(member, { since, asks })       what this member sees: files, a prompt, the version
wait(version, deadline)             block until something changed after version, or the deadline;
                                    → the new version and the log since: version, author, time
propose(member, version, old, new)  → landed, or refused because …
```

- `wait` is the only place the runtime waits. It takes no callbacks, so no
  event can be lost: it asks what changed after a version, and the log
  answers.
- `view` is all a run is given. The prompt is built from the view alone.
- `propose` is the only way a run changes the world. The writer lands it
  under the world's rules (a doc merges; a game refuses a stale move), in
  order with every other change.

## How the plan decides

An agent is due when it is not running and either:

- **Asked:** an ask names it that is newer than the last one it was given,
  and has not failed. An agent's ask to another agent counts against the
  chain limit and runs for the person who started the chain.
- **Watching:** a person's watch is on, its view changed since its last
  run started, and the change is ready: a person's once they pause 5 s, an
  outside program's at once, another agent's once that agent's run has
  ended. Its own change never counts. A run may name what it waits for
  (in Ponjo, lines of the doc); until its next run, only those wake it.

A person changing an agent's view while a run only a watch started is on
ends that run: it saw an old view. An outside program's change does not.

**Limits** keep the board coming to rest. A change by a person or the world
has depth 0; a run woken by an agent's change has that change's depth plus
1, and past a limit nothing wakes. Past a number of runs in a window, the
runtime pauses the board's watches and tells a person.

## A run

1. Get the agent's view, and note that it looked at this version.
2. Give the files and the prompt to the agent program, in a private folder.
3. Propose what it left behind, based on the version it saw.
4. Note how it ended. The loop looks again.

A run changes nothing itself, so it can be stopped, refused or lost at no
cost. An action on the outside world (a message, a deploy) belongs in the
proposal, for the world to carry out once ([outside
actions](#outside-actions)).

## Refused and failed

- **Refused:** the world turned the proposal away because the board moved
  on. The asks stay open, the agent is told why, and it decides again on the
  new view, up to 3 times. Then the world's fallback applies: a doc waits
  for a person; a game plays a default move.
- **Failed:** the program exited with an error, timed out or could not
  start. Nothing lands. It is shown with Retry and never run again on its
  own: an agent is slow and costs money.
- **A failed read of the world** is tried again, later each time (1 s up to
  30 s).

## Outside actions

An action on the outside world (a message, a call to an API, a deploy) is
part of a proposal, never something a run does itself.

- **Proposed.** A run lists its actions next to its other changes, each
  with the action's name and its input. Only actions the owner installed on
  this machine can be named; the prompt lists them. Nothing in the world
  can install one.
- **Carried out once, after it lands.** An action exists only once its
  proposal lands; a run that is refused, redone, stopped or failed leaves
  none. Each landed action gets an id and a record on this machine:
  proposed, approved, started, then done or failed. The record is never in
  the world's shared state: shared state is data.
- **Never twice on its own.** An action that started and did not end (the
  host stopped) is not started again: it shows as "may have run", with
  Retry for a person. The action is given its id, so a service that takes
  an idempotency key drops a second try.
- **Approved first.** Each action asks the owner first, by default. Only the
  owner approves, as it runs on the owner's machine with the owner's keys;
  others see it waiting. The owner may set an action to run without asking,
  and then only for runs the owner started. Who approved and when is
  recorded with the action.
- **Its result** joins the world as the action's reply, at the depth of the
  run that proposed it plus 1, so agents cannot loop through the outside
  world.
- **Not undone.** Undo takes back the edits the action came with, never the
  action.

Reading stays with the agent program: its folder, the project, the web.
What it reads can end up where others see it, and a fetch can carry data
out in its URL. So the shipped agent programs are set to read, edit, search
and fetch only: no shell and none of the person's own tool servers.
Whatever a person adds to their script or their program's config can act
outside unchecked, and the guarantees above hold only for actions that are
proposed.

In Ponjo: an action is a plugin in `actions/` of the config folder, a
program and a manifest, as an agent is; it gets its input on stdin and its
id as `PONJO_ACTION_ID`. A run lists its actions in `PONJO_ACTIONS`, each
on one of its comments, and the record is in `logs/actions.jsonl`. The
action shows under its comment with what it does, its input, and Approve
and Decline for the owner; its result is a reply in that thread. Settings >
Actions lists them, each with Ask first (on by default).

## State

All in memory on this machine; nothing in a shared file, so no shared file
can make this machine run anything. Per agent: the asks it was given, the
version it last looked at, its view's fingerprint then, what wakes it,
failures, and its watch (also kept in the config folder). Per world: the
runs going and the limits. A restart clears it: open asks run again.

## Agent log

Each look writes what woke it, then each agent's verdict and why (asked in
which ask, whose change, still typing, at the limit, already running); each
run's end writes how it ended and what landed. Names, versions and ids
only, never the world's content. In Ponjo: Settings > Agents > Agent log.

## Security

- Only people start work: an ask from a person who may write, or a watch a
  person turned on. A request found in a file asks no one.
- A run sees only its member's view and changes only through `propose`.
- Outside any view: whoever runs the host can read its files, and an agent
  program must be kept by its own permissions from opening files outside
  its folder.

## Today

What the code does differently from the runtime above:

- One runtime per open doc (`src/host/open-doc.js`); it stops when the doc
  closes.
- Every member sees the whole doc and every thread; in project mode the
  agent program may read the project folder.
- Nothing is refused: the doc world merges.
- An agent program may act outside the doc as its own config allows:
  there are no actions, and the shipped scripts give it a shell (Claude
  Code) and the person's own tool servers.

Code: the loop is `src/host/buddy-runtime.js`, the plan `src/core/due.js`,
the run `src/host/runner.js`; the doc world `src/host/doc-world.js`, its
asks `asksIn` (`src/core/comments.js`) and its prompt `src/core/prompt.js`.
