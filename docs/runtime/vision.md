# Blackboard Agent Runtime: vision

**People and a team of agents watch the same board and improve it together.
When the board changes, the world's rules say who is due, the controller
runs them, and the one writer decides what lands.**

*Terms.* A **member** is a person or an **agent** (an AI member: an identity
and a prompt). An **agent program** is the tool that does an agent's
thinking, such as Claude Code. A **world** is the board's rules: a doc, a
poker table, an incident. A **host** is the application that runs it all,
such as Ponjo, an editor. The reference: [Blackboard Agent
Runtime](README.md).

*The name* is the blackboard architecture's (Hearsay-II, in the 1970s):
knowledge sources work on one shared blackboard, and a control part picks
who acts next. Here the knowledge sources are people and agents, and the
world's rules pick; the controller only runs them.

## The problem

Today you delegate to an agent: hand off a task, wait, review the result.
That works for one agent and one task. It fails when the work is shared: a
poker table with you and three agents, or a doc that people and agents
improve at once. There, nobody hands work back; everyone watches one state,
and anyone may act at any moment.

Delegate runtimes start a run per event, so a lost event loses the work:
even OpenHands [drops requests](https://github.com/OpenHands/extensions/blob/cfd1d0f873c0d97e0a1c30093b34c6364a1141c0/skills/github-repo-monitor/scripts/main.py#L1012-L1042)
when a poll fails. Often the next event is an agent's own call: an LLM
decides whether to hand on, and to whom, so it may never be sent. And each
agent acts on its own private context, which goes stale once another
changes the work, so to stay correct agents take turns.

## What an agent is

The design follows from four facts:

1. A call to an agent is slow, costly, not sure to agree with itself, and
   not to be trusted.
2. The board is changed at once by people, programs and other agents.
3. An agent's work counts only once it lands on the board.
4. People need to stay in control: to see who did what, to undo it, and to
   say what may be spent.

## Five principles

**1. Decide from state, never from events.** Who is due is a function of
what the board holds. An event only means "look again", so a lost event or
a restart costs nothing. A thermostat works this way: it reads the room, not
a count of opened doors. So does a Kubernetes controller.

**2. Agents propose; one writer changes the state.** A run reads its view
and hands back a change. It changes nothing itself, so it can be stopped,
refused and redone, or lost, at no cost. A run that made nothing, or
failed, lands too: that it answered is part of the state (fact 3).

**3. Rules in the world, trust on the owner's machine, mechanism in the
controller.** The world says who is due, what each member sees and what
lands. The owner's machine says whom it will spend for, and how much. The
controller only starts and stops runs. Private views follow: a member is handed only
its view, and woken only when it changes.

**4. Rules are pure; I/O is apart.** The world is functions of a snapshot:
no disk, no clock. Where the state is kept is the store's alone, so the
truth can move from a file to a database and no rule changes.

**5. People declare; agents reconcile.** Only people say what they want: a
request, a watch, a standing intent. Agents work the board toward it, and
when it is met, the board comes to rest. Chains between agents are capped,
and agents that keep running are stopped for a person to settle.

## Four components

| Component | What it does | Principle |
|---|---|---|
| Store | keeps the shared state; lands every change, in one order, on a condition | 2, 4 |
| Local | keeps what only the owner's machine writes: who asked for work, the limits, outside actions | 3 |
| World | pure functions: who is due, what a member sees, what a change does | 1, 3, 4 |
| Controller | waits for a change, starts and stops runs, commits what they made | 1, 2 |

Each answers one question: the world whether a run *should* happen, local
whether it *may*, the controller that it *does*, the store what is *true*.

**Why local is not part of the store.** Who can write a thing decides
whether it can be trusted, not who can read it. Anyone who reaches the
shared state can write it: a teammate, `git pull`, a program. So nothing
there can make the owner's machine spend or act.

**How a change moves**, at a poker table:

1. The dealer commits "Action on: Bob". The store lands it as rev 41.
2. The controller, waiting past rev 40, wakes and reads rev 41.
3. The world's `due`: it is Bob's turn, newer than what Bob last answered.
   Local allows it.
4. A run hands Bob's view to the agent program, which decides to call.
5. The run commits the call. The store applies the world's rules: it is
   still Bob's turn, so it lands as rev 42, which records that Bob answered.
6. The controller wakes again. The dealer's next move makes Alice due.

Nobody drew that flow: each step is `due` on a new state.

## What emerges

- **Always-on with no jobs.** Agents act when the world changes, whoever
  changed it; when nothing changes, nothing runs.
- **Parallel work on one board,** with no branches.
- **Coordination with no orchestrator.** Bob acts, the board changes, so
  Alice is due.

## How it differs

1. **Everyone acts on one board at once.** People and agents alike, with
   no turns and no copies: agents propose, one writer lands each change in
   order and refuses one made on a stale board.
2. **Code decides who goes next, from the board.** Not an LLM, and not a
   chain of events: the same answer every time, and nothing to lose.

Against the common way, an orchestrator, as its runtimes' docs describe it
in 2026:

| | Orchestrator: Claude Code subagents, OpenAI Agents SDK, CrewAI | Controller: this runtime |
|---|---|---|
| Working at once | Workers in parallel, each on its own copy; the lead merges | Everyone at once; the writer lands in order and refuses stale moves |
| People | Give the task and review the result | Members, acting while agents act |
| Who goes next | An LLM: the lead starts workers, or an agent hands on | Code, from the board |

## Evidence

Open-card Hold'em on the runtime as Ponjo hosts it, with scripted agents,
lost no actions. Small fixes that follow from these principles took it from 3.4 runs
and 5.2 s per action to 1 run and 0.25 s. The [poker page](https://ponjo.app/poker.html),
three AI players and you at one table, was built from scratch with its own
small runtime and arrived at the same shape: a pure plan, one view that
hides others' cards, a writer that refuses stale moves, and table talk
limited by depth. It now runs on this runtime, as a world
(`preview/poker-world.js`). So do [Werewolf](https://ponjo.app/werewolf.html)
and [Who's the Spy](https://ponjo.app/spy.html), games of hidden roles,
where each seat sees only what it may.

## Not for

Fixed flows that split into independent tasks and need only a final answer.
An orchestrator fits those better.

## Status

- **Built**, in the design before this one, with Ponjo as its host:
  deciding from state through one blocking wait, one writer, asks and
  watches woken by a view's change, stateless agents, the agent log, chains
  limited by depth with a breaker, and outside actions carried out once and
  approved by the owner ([outside actions](README.md#outside-actions));
  for docs, and for three game worlds with per-member views and refusals.
- **Not yet:** the four components as above, and a host that keeps
  running with no window open. What differs:
  [Today](README.md#today).
