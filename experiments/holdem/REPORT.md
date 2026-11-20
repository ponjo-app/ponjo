# Open-card Hold'em on the agent runtime: experiment report

Untracked; no product code changed. Run: `node harness.mjs <name> [--hands N --steps S --refill R --agentMs D --heartbeat H --self T]`.

## Setup

- `harness.mjs` opens `runs/<name>/project/table.md` with `openDoc` (src/host/open-doc.js): the real doc host and agent runtime, headless. It has 3 project buddies (Alice, Bob, Cara), and the owner turns all 3 watches on.
- `agent.mjs` is the picked agent, a deterministic fake that follows the contract. Gate: if `Action on:` is not this buddy, it exits 0 and changes nothing. Otherwise it writes `act=<check|call|fold|raise>` on its own seat line and replies in its own thread.
- `dealer.mjs` is a separate process. It writes the file directly (an outside change) and polls the file every 50 ms. Blinds are 5/10, with one raise per street.
- `analyse.mjs` reads `dealer.jsonl`, `agent.jsonl`, `host.jsonl`, `config/logs/runs.jsonl` and `config/logs/agents.log`. It writes `summary.json` and `turns.tsv`, one row per turn.

## Measurements

| Scenario | Hands | Actions | Runs | Runs per action | No-op runs per action | Steps per action | Stale runs* | s per action | Result |
|---|---|---|---|---|---|---|---|---|---|
| A: default steps (20, +1/min), instant agent | 3 | 48 | 161 | 3.4 (1 to 7) | 2.4 | 0.5 (budget at 0 after 52 s) | 20 | 5.23 | complete, 245 s |
| B: steps 200, +1/10 s | 3 | 48 | 243 | 5.1 | 4.1 | 2.0 | 83 | 5.23 | complete, 252 s |
| C: agent takes 4 s on its turn | 1 | 13 | 63 | 4.8 | 3.8 | 1.6 | 16 | 9.25 | complete, 120 s |
| D: 4 s agent, dealer clock write every 8 s | 1 | 0 | 26 (7 stopped) | n/a | n/a | n/a | 0 | n/a | **livelock**: stalled 60 s, 0 actions |
| E: 4 s agent, clock write every 12 s | 1 | 13 | 64 | 4.9 | 3.9 | 1.7 | 17 | 11.8 | complete, 153 s |
| F: no dealer, buddies pass the turn, default steps | n/a | 25 turns in 19 min | 45 | n/a | n/a | 1.6 | n/a | 0.5 s for turns 1 to 11, then 60 to 120 s | **stalls** on steps |
| G: no dealer, steps 200 | n/a | 40 turns in ~7 s | 108 | 2.7 | 1.7 | 2.6 | n/a | ~0.2 | complete |

\* Stale runs: runs that started on a buddy's change before the dealer's reply landed, so they read the old `Action on`.

Per-hand numbers, A (default): 13 actions / 57 runs / 21 steps / 65 s; 18 / 54 / 1 / 94 s; 17 / 47 / 2 / 86 s. B: 13 / 63 / 26 / 68 s; 18 / 92 / 36 / 94 s; 17 / 85 / 34 / 89 s.

Latency (A and B, 96 actions, medians):

- Dealer write to the door taking it: 107 ms (min 104, max 155).
- Door to the acting run starting: 5.04 s. That is SETTLE_MS = 5 s, src/core/due.js:10.
- Dealer write to the acting run starting: 5.15 s.
- Agent exit to the dealer seeing the action: 83 ms. Run end to dealer: 79 ms.

Correctness, all scenarios: 0 lost actions, 0 duplicates, 0 out-of-turn actions, 0 merge conflicts ("collided"), 0 lost events. Every no-op run logged `ok · Nothing to do, 0 comments` and landed nothing.

## What one action looks like (from agents.log)

1. The dealer's write arrives: `look · an edit by outside the app, rev 4, once people pause`. 5 s later all 3 watchers are `due: changed by people` and start. Two gate out (`Nothing to do, 0 comments`), one acts (`Posted, 1 comments`).
2. While the actor lands, the other two read `changed by Alice at rev 2, still landing`.
3. When the actor's run ends, both are `due · a step taken, 19 left`. They start about 80 ms before the dealer reacts, so they see the old doc and gate out.
4. Once the budget is empty, they read `but no step is left, the next in 60 s`.

## Findings

1. **5 s per action, whatever the agent.** The dealer's atomic whole-file write is treated like a person typing, so watchers wait SETTLE_MS (src/host/buddy-runtime.js:409, due.js:77-78). That pause is 96% of an action's time with an instant agent.
2. **Paid runs are stale by construction.** A buddy's change wakes the other watchers as soon as its run ends (due.js:76). The dealer's answer lands about 100 ms later, so these runs spend a step to see a doc where nothing is theirs to do. Then the dealer's write wakes everyone again 5 s later for free.
3. **With a dealer, steps never stall the hand.** The dealer's outside writes wake watchers without a step. Raising the budget (B) only adds wasted runs: 243 runs against 161, with the same hand time.
   - After the budget hit 0, the 1-a-minute refill timer sometimes started a late paid run after the dealer's write had landed. That run then acted 2 to 3 s early (door to act min 2.1 s). Speed therefore depends on the budget's state.
4. **Without a dealer, the default budget stalls (F).** Each turn costs 2 steps (n−1 watchers wake). Ten turns empty the 20 steps. After that it is 1 step a minute, and about a third of those go to the watcher whose turn it is not. Steps 200 (G) fixes it: 40 turns in about 7 s.
5. **Any outside or person edit during a turn kills the actor's run** (buddy-runtime.js:403-408, watch-only runs end). A dealer clock every 8 s with a 4 s agent (D) livelocked: 7 runs stopped, 0 actions.
   - For the same reason, a concurrent dealer edit against an agent's seat-line edit can only merge in the few milliseconds of the landing phase. No merge happened.
6. **No turn order is enforced by the runtime.** The doc's text and the agent's gate carry it all.
7. **Only people's comments ask** (askers, buddy-runtime.js:161; comments.js:245). Neither the dealer nor a buddy can hand the turn to one seat. The only lever is "change the text and wake every watcher".
8. A user-level buddy, Clippy, is written into every fresh config (src/store/buddies.js:36-40) and shows in every look. It was harmless here.
9. Q7 (real agent) was skipped. The `claude` CLI is present, but the only credentials are this hosting session's (ANTHROPIC_BASE_URL and the session token). src/host/runner.js:167-170 strips those from an agent's environment by design. There is no API key or ~/.claude credentials file.

## Extrapolation: 30 s LLM run, 3 agents plus 1 human seat

- An agent action is about 0.1 s + 5 s settle + 30 s + 0.1 s ≈ 35 s.
- A human action costs only their thinking time: they see the dealer's write at once, and their edit reaches the dealer in milliseconds.
- About 20 actions a hand (15 agent, 5 human at about 15 s each) gives roughly 8.8 + 1.3 ≈ **10 min per hand**.
- Cost:
  - Without a cheap shell gate in front of the model, each action starts about 5 model runs: 3 on the dealer's write, and 2 stale paid runs that the dealer's write then kills. Only 1 of the 5 is useful, so about 75 calls a hand for 15 useful ones.
  - With a gate (grep `Action on:` before `exec claude`), it drops to about 15 calls.
- Risk: the human editing anything in the doc during an agent's 30 s turn restarts that turn (finding 5).

## Minimal runtime changes for turn-based play

1. **A buddy's @mention asks the mentioned buddy, for one step.** The dealer then becomes a buddy (or a buddy hands off), and exactly one run starts per action, with no gate runs, no 5 s pause and 1 step per turn instead of n−1. The change is to add buddies to the askers when a buddy comment @mentions another buddy, spending a step (comments.js askedBy, due.js plan).
2. **A watch scoped to a region** (a heading's section or a line pattern). The watcher is due only when lineChanges touch that region. This removes the gate runs and the stale paid runs.
3. **A shorter settle for outside writes.** The door already waits for a 50 ms stillness (doc-service.js:776). The 5 s SETTLE_MS is for typing and could apply to people only.
4. Optionally, **don't end a watch run on an outside change outside its region.** This follows from change 2 and fixes the livelock in finding 5.

With change 1 alone, the extrapolated hand drops from about 10 min to about 8 min (no 5 s pauses), and model calls from about 75 to 15.

## Rerun on the changed runtime (PRs #423–#426 merged locally, branch holdem-combined)

The agent can now write `{"line":"Action on: <me>"}` to `PONJO_WAKE` (`--wake`). A new mode, `--self N --mention`, has each buddy hand the turn to the next by @mention, with no watch at all.

| Scenario | Before | After |
|---|---|---|
| Dealer, default steps, wake lines (v2-A-wake) | 3.4 runs, 2.4 no-ops, 0.5 steps and 5.2 s per action; 245 s for 3 hands | **1 run, 0 no-ops, 0 steps, 0.25 s per action**; 3 hands in 12 s; 48 of 48 runs acted |
| Dealer, default steps, no wake lines (v2-A-nowake) | as above | 3.5 runs and 2.5 no-ops per action, 0.25 s per action (the 5 s pause is gone; the no-op runs remain) |
| Clock write every 8 s, 4 s agent, wake (v2-D) | livelock: 0 actions in 60 s, 7 runs stopped | the hand completes: 13 actions, 19 runs, 0 stopped (6 "already acted" reruns on clock ticks) |
| No dealer, watches + wake (v2-F) | 2.6 steps per turn, 10 turns fast | 1 step and about 1 run per turn: 23 turns in 1.3 s, then 1 a minute (budget) |
| No dealer, @mention hand-off (v2-M) | (not possible) | 1 run and 1 step per turn: 21 turns in 1.2 s, then 1 a minute (budget) |

Latency with wake lines: dealer write to door 106 ms; door to acting run 32 ms; agent exit to dealer 106 ms.

Correctness: no lost, duplicate or out-of-turn actions and no conflicts in any scenario.

Remaining limits:
- Without a dealer, the default 20 steps still pace buddies at 1 turn a minute after 20 turns. That is the budget working as designed; Settings > Agents raises it.
- Without wake lines, two no-op runs per action remain.

Extrapolated with a 30 s model, wake lines and a gate: an agent action takes about 30 s, so a 20-action hand takes about 8.8 min with 15 model calls.

## Run it yourself

On branch `holdem-experiment` (the four PRs merged, plus this folder):

```sh
npm ci
cd experiments/holdem
node harness.mjs try --hands 1 --wake   # dealer, wake lines
node harness.mjs try2 --hands 1         # dealer, no wake lines
node harness.mjs try3 --hands 1 --agentMs 4000 --heartbeat 8000 --stall 60000 --wake
node harness.mjs try4 --self 30 --wake  # no dealer, watches
node harness.mjs try5 --self 30 --mention  # no dealer, @mention hand-off
```

Each run writes `runs/<name>/summary.json`, `turns.tsv` and `config/logs/agents.log`.
`--self` runs stop after 30 turns, or after 4 min with no new turn.

## Play it in the app

macOS or Linux only (the agent script is a shell script).

```sh
node experiments/holdem/app/setup.mjs ~/holdem-table --you <your seat name>
```

It creates the table, the buddies Alice, Bob and Cara with a playing style each, and the agent script "holdem" in the app's agents folder. It then prints the steps:

1. Open the folder in `npm run desktop`.
2. Pick "Hold'em seat" in Settings > Agents: Fake, or Claude Code.
3. Turn on Watch this doc on each buddy's card.
4. Run the dealer it prints.
5. On your turn the doc shows a "Your move" list: tick one box. The dealer is started with `--humans <you>`, and the table is in a code block so it reads line by line.
