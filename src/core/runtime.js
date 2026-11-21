// The agent runtime of one world (docs/agent-runtime.md): the loop. It
// keeps this machine's notes on the world's agents, the runs going and
// the breaker, and one timer. Whenever anything may have changed it looks: reads
// the world (members, asks), asks the plan (due.js) what to start and
// stop, and does that. A run is the agent once on its view, and what it
// left behind is proposed to the world. It reaches nothing but the world
// and what its host gives it, so it runs wherever JavaScript does: the
// doc host (src/host/buddy-runtime.js), or a Worker.

import { newId } from './comments.js';
import { WORLD, plan } from './due.js';

// A look that could not read the world (in a doc: a sidecar locked or
// unreadable, an agent's file gone as it was read) is tried again this long
// after, twice as long each time, up to LOOK_AGAIN_MAX_MS: no change may come to try it.
const LOOK_AGAIN_MS = 1000;
const LOOK_AGAIN_MAX_MS = 30_000;

// ---- the contract ----
//
// A world (in Ponjo: src/host/doc-world.js) says what its members are, what
// is asked, what each sees and how a change lands; the runtime knows nothing
// else of it. Its values the runtime only passes on: `files` (what a view
// holds), `made` (what a run left) and what `propose` answers. Its five
// calls answer with a promise; `print` and `wakes` at once.
//
// members()                  → [Member]
// asks()                     → [Ask]; rejects with code 'unreadable' when nothing can be answered
// view(member, { since, asks }) → View: what `member` sees, given its `asks`
//                              and, for a watcher, `since` (the files of its last
//                              watch run's view, or null on its first; undefined: not a watch run)
// wait(version, deadline)    → { rev, log: [Change] }: once something changed after
//                              `version`, or at `deadline` (performance.now());
//                              wait(Infinity, 0) answers at once with the version now
// propose(agent, version, old, made) → what landed, for the host to write; `agent`
//                              is the Member and { for (the members it ran for), depth },
//                              `old` { files, asks } what its run was given. It may land
//                              nothing (a refusal), its answer then having `rejected`, why:
//                              what follows is the world's change, an ask made again
//                              carrying the run's `for` and `depth`
// print(files)               → a view's fingerprint: a watcher whose view's is as it
//                              was when its last run started is not due
// wakes(files, wake)         → whether a view holds what a run said wakes it (`wake`)
// limits                     { depth }: past it, agents' changes and asks wake no one
// settleMs                   how long people's changes pause before a watcher runs on them
//
// Member  { id, name, kind ('person' or 'agent'), mayAsk }: the world says who
//         may ask; work starts only for them
// Ask     { id, agent, from, at, until, for?, depth? }: open until a run is given
//         it; `at` (ISO time) when it last asked, `until` (ISO time) its latest
//         change, which a run given it has seen; an agent's ask has `for`, the
//         members its run was for, and `depth`, its run's
// View    { rev, files, prompt }
// Change  { rev, by: { id, kind ('person', 'agent' or 'world') }, at
//         (performance.now()), asks (it changed only what is asked), stale (runs
//         only a watch started saw the world as it was: they end) }
//
// What the runtime tells its host it did (trace), an Event, by `type`:
// look          { why (what set it off, '' when asked to), verdicts: [{ agent, name,
//               reason (the plan's, in words), run (the id of the run it started, or
//               null) }] }; with no agent to judge, one verdict with agent ''
// look.failed   { error, againMs (when it looks again) }
// run.end       { run, task, view, result, answered (what propose answered) }: the
//               only event with the world's content; what of it is kept or shown
//               is the host's to decide
// watches.paused { runs, within (minutes) }: the breaker tripped

/**
 * The agents of one world (above). What only the host can do:
 * - `run(task, view, signal)`: the agent once on `view`, ended when `signal`
 *   aborts; resolves to { at, ms, outcome ('ok', 'failed', …), body (why it
 *   failed), wake (what wakes it next, or none), made (what to propose) },
 *   and rejects if it could not start.
 * - `breaker()`: { pauseAfter, pauseWithin } as they are now.
 * - `watching`: { read() (who watches, as last noted: id → { by }), note(noted) }.
 * - `trace(event)`: what the runtime did and why, as it happens (Event,
 *   below), for the host to write or show; resolves once it is taken.
 * - `emit(type, payload)`: what the host passes on as it changes: `agents`
 *   (statuses()) and `watches` (watches()).
 */
export async function createRuntime({ world, run, breaker, watching, trace, emit }) {
  // What this machine notes of each agent (plan): { seen, lookedAt, print
  // (its view's fingerprint as its last watch run started, or null), since
  // (the files of its last watch run's view, or null), wake (what that
  // run named, or null), failed (ask, or 'watch' for its watch, → { at, why
  // }), watch }. The watch is noted by the host too (watching), as only a
  // person changes it; the rest is gone on a restart.
  const notes = new Map();
  const noteOf = (id) => notes.get(id) ?? notes.set(id, { seen: new Map(), lookedAt: null, print: null, since: null, wake: null, failed: new Map(), watch: null }).get(id);
  for (const [id, { by }] of Object.entries(await watching.read())) noteOf(id).watch = { by };
  let version = (await world.wait(Infinity, 0)).rev; // the world's version, as last read from its log
  for (const note of notes.values()) note.lookedAt = version; // no run on opening
  const changedAt = new Map(); // who last changed the world → { rev, at }, people as null
  const depths = new Map(); // agent → the depth of its latest run: its changes' and asks'
  // The breaker: when each run in the window started (performance.now()),
  // and whether it tripped, pausing the watches until someone resumes them.
  let started = [];
  let paused = false;
  // The runs going: agent → { task, from (the version it started at), print
  // (its view's fingerprint, once it has it), stop (ends it), cancelled,
  // landing (its agent is done; it lands whatever happens), done }.
  const runs = new Map();
  let shown = []; // the agents the windows were last told of
  let stopped = false;
  const nameOf = (id) => shown.find((b) => b.id === id)?.name ?? id;

  // ---- looking ----

  let looking = null;
  let again = false;
  let lookAgainMs = LOOK_AGAIN_MS;
  let timer = null;
  let timerAt = Infinity;
  const whys = new Set(); // why the next look comes, for the agent log
  // Look at `at` (performance.now()), or sooner if a look is set sooner;
  // `why` it was set.
  function wake(at, why) {
    if (stopped || at >= timerAt) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      look(why);
    }, Math.max(0, at - performance.now()) + 5);
    timer.unref?.();
  }
  // Look, one at a time, `why` in words: a look asked for meanwhile is one
  // more after it.
  function look(why) {
    if (stopped) return Promise.resolve();
    if (why) whys.add(why);
    if (looking) {
      again = true;
      return looking;
    }
    looking = (async () => {
      do {
        again = false;
        try {
          await lookOnce();
          lookAgainMs = LOOK_AGAIN_MS;
        } catch (error) {
          console.error('Could not look for asks:', error);
          trace({ type: 'look.failed', error: error.message, againMs: lookAgainMs });
          wake(performance.now() + lookAgainMs, 'a look that failed');
          lookAgainMs = Math.min(lookAgainMs * 2, LOOK_AGAIN_MAX_MS);
        }
      } while (again && !stopped);
      looking = null; // at once: a look asked for after the last one began is never lost
    })();
    return looking;
  }
  async function lookOnce() {
    const why = [...whys].join('; ');
    whys.clear();
    const members = await world.members();
    const here = members.filter((m) => m.kind === 'agent');
    let asks = [];
    let problem = null; // why the world cannot say what is asked
    try {
      asks = await world.asks();
    } catch (error) {
      if (error.code !== 'unreadable') throw error;
      problem = error.message;
    }
    const p = problem || here.length === 0 // an agent could not post what it made, or there is none
      ? { start: [], stop: [...runs.keys()], wakeAt: null, asking: new Set() }
      : plan({
        agents: here, asks, askers: members.filter((m) => m.mayAsk).map((m) => m.id), ...(await viewed(here)),
        notes, changedAt, running: new Set(runs.keys()), limit: world.limits.depth, settleMs: world.settleMs, paused, now: performance.now(),
      });
    // A failure is shown while its ask still asks the agent.
    let gone = false;
    for (const [id, note] of notes) for (const key of note.failed.keys()) if (key !== 'watch' && !p.asking.has(`${id} ${key}`)) gone = note.failed.delete(key);
    if (gone) broadcastAgents();
    const names = new Map([...runs].map(([id, r]) => [id, r.task.agent.name]).concat(here.map((b) => [b.id, b.name])));
    const verdicts = new Map([...(p.why ?? [['', problem ? `nothing starts: ${problem}` : 'nothing starts: no agent here']])].map(([id, reason]) => [id, { agent: id, name: names.get(id) ?? '', reason, run: null }]));
    for (const id of p.stop) end(runs.get(id));
    for (const task of p.start) if (!stopped) verdicts.get(task.agent.id).run = startRun(task);
    trace({ type: 'look', why, verdicts: [...verdicts.values()] });
    trip(await breaker());
    if (p.wakeAt !== null) wake(p.wakeAt, 'what a look waited for: people to pause');
  }
  // What the watchers among `here` see now: { prints (each one's view's
  // fingerprint), woken (those whose last run named what wakes them, and
  // whose view holds it) }.
  async function viewed(here) {
    const prints = new Map();
    const woken = new Set();
    for (const [id, note] of notes) {
      const agent = here.find((b) => b.id === id);
      if (!note.watch || !agent) continue;
      const { files } = await world.view(agent, {});
      prints.set(id, world.print(files));
      if (note.wake && world.wakes(files, note.wake)) woken.add(id);
    }
    return { prints, woken };
  }

  // ---- runs ----

  function end(r) {
    if (!r || r.landing) return; // its answer is on its way
    r.cancelled = true;
    r.stop.abort();
  }

  // Start `task`'s run; returns its id.
  function startRun(task) {
    const r = { id: newId('r'), task, from: version, stop: new AbortController(), cancelled: false, landing: false, done: null };
    depths.set(task.agent.id, task.depth);
    started.push(performance.now());
    runs.set(task.agent.id, r);
    r.done = runOnce(r).finally(() => {
      runs.delete(task.agent.id);
      broadcastAgents();
      look(`run ${r.id} of ${task.agent.name} ended`); // what was asked while it ran
    });
    broadcastAgents();
    return r.id;
  }

  // The agent once on its view, then what it left behind is proposed; the host writes how it ended.
  async function runOnce(r) {
    const { task } = r;
    let view = null;
    let result;
    let answered = null;
    try {
      view = await world.view(task.agent, { since: task.watch ? noteOf(task.agent.id).since : undefined, asks: task.asks });
      r.from = view.rev;
      r.print = world.print(view.files);
      result = await run(task, view, r.stop.signal);
    } catch (error) {
      console.error(`Run of ${task.agent.name} failed to start:`, error);
      result = { at: Date.now(), ms: 0, outcome: 'failed', code: null, body: `Ponjo could not run ${task.agent.name}: ${error.message}` };
    }
    if (r.cancelled || stopped) result.outcome = 'stopped'; // ended: no answer
    r.landing = true;
    try {
      if (result.outcome !== 'stopped') answered = await finish(r, view, result);
    } finally {
      await trace({ type: 'run.end', run: r.id, task, view, result, answered });
    }
  }

  // A run ended: the agent's notes say what it was given and how it went,
  // and what it left behind is proposed to the world, as the agent, for
  // whoever asked it: the world lands it as they may. A failed run lands nothing: it is
  // noted as the agent's failure in each ask it was given that still asks
  // it (and for its watch), and asks again only when someone writes there,
  // on Retry, or once the agent program or its settings change. Resolves to
  // what the world says landed ({ landed (in words), … }).
  async function finish(r, view, result) {
    const { task } = r;
    const id = task.agent.id;
    const failed = result.outcome !== 'ok';
    const note = noteOf(id);
    for (const a of task.asks) note.seen.set(a.id, Date.parse(a.until));
    if (note.watch) {
      note.lookedAt = r.from;
      note.print = r.print ?? null;
      if (!failed && task.watch) note.since = view.files;
      note.wake = !failed && result.wake?.length ? result.wake : null; // until its next run: what wakes it
    }
    if (task.watch) {
      if (failed) note.failed.set('watch', { at: new Date().toISOString(), why: result.body });
      else note.failed.delete('watch');
    }
    if (failed) {
      const still = new Set((await world.asks().catch(() => [])).filter((a) => a.agent === id).map((a) => a.id));
      for (const a of task.asks) note.failed.delete(a.id);
      const at = new Date().toISOString();
      for (const a of task.asks) if (still.has(a.id)) note.failed.set(a.id, { at, why: result.body });
      broadcastAgents();
      return { landed: 'Failed' };
    }
    for (const a of task.asks) note.failed.delete(a.id);
    broadcastAgents();
    return world.propose({ ...task.agent, for: task.askers, depth: task.depth }, r.from, { files: view.files, asks: task.asks }, result.made);
  }

  // ---- the breaker ----

  // Past `pauseAfter` runs started within `pauseWithin` minutes, the
  // world's watches pause, and every window is told, until someone resumes them.
  function trip({ pauseAfter, pauseWithin }) {
    started = started.filter((at) => at > performance.now() - pauseWithin * 60_000);
    if (paused || started.length < pauseAfter) return;
    paused = true;
    trace({ type: 'watches.paused', runs: started.length, within: pauseWithin });
    emit('watches', { paused });
  }

  // ---- what people do ----

  // Note who watches, and tell the windows.
  function keepWatching() {
    watching.note(Object.fromEntries([...notes].filter(([, n]) => n.watch).map(([id, n]) => [id, n.watch])));
    broadcastAgents();
  }
  // Agent `id` watches the world (`on`), or no longer, as person `by`
  // says: it looks at once; turned off, a run of it on now ends with no
  // answer unless something else asks it.
  function watch(id, on, by) {
    const note = noteOf(id);
    if (on && !note.watch) Object.assign(note, { watch: { by }, lookedAt: null, print: null, since: null, wake: null });
    if (!on) Object.assign(note, { watch: null, print: null, since: null, wake: null });
    if (!on) note.failed.delete('watch');
    keepWatching();
    look(`${nameOf(id)}'s watch turned ${on ? 'on' : 'off'}`);
  }
  // Run the failed asks of agent `id` (or every agent's) again: someone
  // pressed Retry, or the agent program or its settings changed.
  function retry(id = null) {
    for (const [key, note] of notes) {
      if (id && key !== id) continue;
      for (const ask of note.failed.keys()) {
        if (ask === 'watch') note.lookedAt = null; // it looks again at once
        else note.seen.delete(ask);
      }
    }
    look(id ? `Retry on ${nameOf(id)}` : 'the agent or its settings changed');
  }

  // ---- what the host is told ----

  const broadcastAgents = () => emit('agents', agentStatuses());
  // The agents the world has, each with the asks its run going was given
  // (`asks`, their ids), the asks where its last run failed ([{ ask, at,
  // why }]), whether it watches the world, and whether its last watch run
  // failed ({ at, why } or null).
  function agentStatuses() {
    return shown.map((b) => {
      const r = runs.get(b.id);
      const note = notes.get(b.id);
      const failed = [...(note?.failed ?? [])].filter(([key]) => key !== 'watch').map(([ask, { at, why }]) => ({ ask, at, why }));
      return { ...b, asks: r && !r.cancelled ? r.task.asks.map((a) => a.id) : [], failed, watching: Boolean(note?.watch), watchFailed: note?.failed.get('watch') ?? null };
    });
  }
  // The agents or who may ask changed: show who is here, and look.
  async function sync() {
    try {
      shown = (await world.members()).filter((m) => m.kind === 'agent').map(({ kind, mayAsk, ...b }) => b);
    } catch (error) {
      console.error('Could not read the members:', error);
    }
    broadcastAgents();
    await look('the agents or who may ask changed');
  }

  // A change landed in the world's log (wait, a Change). Only what is
  // asked changed: look. Otherwise one the world says is `stale` ends the
  // runs only a watch started, for they saw the world as it was; the
  // watchers look again at once, or on a person's change once people pause.
  function changed({ rev, by: author, at, asks, stale }) {
    const who = author.kind === 'agent' ? nameOf(author.id) : author.kind === 'person' ? 'a person' : 'the world';
    if (asks) {
      look(`asks changed by ${who}, rev ${rev}`);
      return;
    }
    const by = author.kind === 'agent' ? author.id : author.kind === 'world' ? WORLD : null;
    changedAt.set(by, { rev, at, depth: depths.get(by) ?? 0 });
    if (![...notes.values()].some((n) => n.watch)) return;
    if (stale) {
      for (const r of runs.values()) {
        if (!r.task.watchOnly || r.landing || r.cancelled) continue;
        Object.assign(noteOf(r.task.agent.id), { lookedAt: r.from, print: r.print ?? null });
        end(r);
      }
    }
    if (by !== null) look(`a change by ${who}, rev ${rev}`);
    else wake(at + world.settleMs, `a change by ${who}, rev ${rev}, once people pause`);
  }
  // Wait for the world to change after the version last read, and take
  // each change, until closed: a change that lands meanwhile is in the
  // log the next wait reads.
  (async () => {
    while (!stopped) {
      const { rev, log: since } = await world.wait(version, Infinity);
      if (stopped) return;
      version = rev;
      for (const change of since) changed(change);
    }
  })().catch((error) => console.error('Could not wait for the world to change:', error));

  return {
    /** What is asked may have changed (`why`): look again. */
    look,
    /** The members or who may ask changed: read who is here again, and look. */
    sync,
    /** Agent `id` watches the world (`on`), or no longer, as member `by` says. */
    watch,
    /** Run the failed asks of agent `id` again, or every agent's. */
    retry,
    /** Someone resumes the watches the breaker paused: the runs counted so far count no more. */
    resume() {
      paused = false;
      started = [];
      emit('watches', { paused });
      look('the watches were resumed');
    },
    /** Each agent's status (agentStatuses), as `agents` emits it. */
    statuses: () => agentStatuses(),
    /** The watches: { paused }. */
    watches: () => ({ paused }),
    /** The names of the agents at work. */
    running: () => [...runs.values()].filter((r) => !r.cancelled).map((r) => r.task.agent.name),
    /** End every run without an answer (an open ask runs again next time) and start no more. */
    async close() {
      stopped = true;
      clearTimeout(timer);
      await looking;
      for (const r of runs.values()) end(r);
      await Promise.all([...runs.values()].map((r) => r.done));
    },
  };
}
