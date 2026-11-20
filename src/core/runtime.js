// The agent runtime of one world (docs/agent-runtime.md): the loop. It
// keeps this machine's notes on the world's agents, the runs going and
// the breaker, and one timer. Whenever anything may have changed it looks: reads
// the world (members, asks), asks the plan (due.js) what to start and
// stop, and does that. A run is the agent once on its view, and what it
// left behind is proposed to the world. It reaches nothing but the world
// and what its host gives it, so it runs wherever JavaScript does: the
// doc host (src/host/buddy-runtime.js), or a Worker.

import { newId } from './comments.js';
import { OUTSIDE, SETTLE_MS, plan } from './due.js';

// A look that could not read the world (in a doc: a sidecar locked or
// unreadable, a buddy file gone as it was read) is tried again this long
// after, twice as long each time, up to LOOK_AGAIN_MAX_MS: no change may come to try it.
const LOOK_AGAIN_MS = 1000;
const LOOK_AGAIN_MAX_MS = 30_000;

/**
 * The agents of one world. `world` answers the five calls and has
 * `limits` (its depth limit). What only the host can do:
 * - `run(task, view, signal)`: the agent once on `view` ({ rev, files,
 *   prompt }), ended when `signal` aborts; resolves to { at, ms, outcome
 *   ('ok', 'failed', …), body (why it failed), wake (what wakes it next,
 *   or none), made (what to propose) }, and rejects if it could not start.
 * - `print(files)`: a view's fingerprint; `wakes(files, wake)`: whether a
 *   view holds what a run said wakes it.
 * - `breaker()`: { pauseAfter, pauseWithin } as they are now.
 * - `watching`: { read() (who watches, as last noted: id → { by }), note(noted) }.
 * - `log(...lines)`: the agent log; `ended({ id, task, view, result,
 *   answered })`: a run ended, what it was given and what landed, for the
 *   host to write.
 * - `emit(type, payload)`: tells every window (`agents`, `watches`).
 */
export async function createRuntime({ world, run, print, wakes, breaker, watching, log, ended, emit }) {
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
          log(`look failed: ${error.message}; again in ${lookAgainMs / 1000} s`);
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
        notes, changedAt, running: new Set(runs.keys()), limit: world.limits.depth, paused, now: performance.now(),
      });
    // A failure is shown while its ask still asks the agent.
    let gone = false;
    for (const [id, note] of notes) for (const key of note.failed.keys()) if (key !== 'watch' && !p.asking.has(`${id} ${key}`)) gone = note.failed.delete(key);
    if (gone) broadcastAgents();
    const verdicts = new Map(p.why ?? [['', problem ? `nothing starts: ${problem}` : 'nothing starts: no buddy here']]);
    const names = new Map([...runs].map(([id, r]) => [id, r.task.agent.name]).concat(here.map((b) => [b.id, b.name])));
    for (const id of p.stop) end(runs.get(id));
    for (const task of p.start) if (!stopped) verdicts.set(task.agent.id, `${verdicts.get(task.agent.id)} · started ${startRun(task)}`);
    const rows = [...verdicts].map(([id, reason]) => [names.get(id) ?? '', reason]);
    const width = Math.max(...rows.map(([name]) => name.length));
    log(`look · ${why || 'asked to'}`, ...rows.map(([name, reason]) => `${name.padEnd(width)}  ${reason}`));
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
      prints.set(id, print(files));
      if (note.wake && wakes(files, note.wake)) woken.add(id);
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
      r.print = print(view.files);
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
      await ended({ id: r.id, task, view, result, answered });
    }
  }

  // A run ended: the agent's notes say what it was given and how it went,
  // and what it left behind is proposed to the world, as the agent, for
  // whoever asked it, at most at their level: a run one of whose askers
  // may no longer ask lands nothing. A failed run lands nothing: it is
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
    const members = await world.members();
    for (const asker of task.askers) if (!members.some((m) => m.id === asker && m.mayAsk)) return { comments: [], landed: 'Dropped: whoever asked can no longer edit' };
    if (failed) {
      const still = new Set((await world.asks().catch(() => [])).filter((a) => a.agent === id).map((a) => a.id));
      for (const a of task.asks) note.failed.delete(a.id);
      const at = new Date().toISOString();
      for (const a of task.asks) if (still.has(a.id)) note.failed.set(a.id, { at, why: result.body });
      broadcastAgents();
      return { comments: [], landed: 'Failed' };
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
    log(`watches paused: ${started.length} runs in ${pauseWithin} min`);
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

  // ---- what the windows see ----

  const broadcastAgents = () => emit('agents', agentStatuses());
  // The agents the world has, which are at work, the asks where each
  // one's last run failed ([{ thread, at, why }]), whether it watches the
  // world, and whether its last watch run failed ({ at, why } or null).
  function agentStatuses() {
    return shown.map((b) => {
      const r = runs.get(b.id);
      const threadIds = r && !r.cancelled ? r.task.asks.map((a) => a.id) : [];
      const note = notes.get(b.id);
      const failed = [...(note?.failed ?? [])].filter(([key]) => key !== 'watch').map(([thread, { at, why }]) => ({ thread, at, why }));
      return { ...b, state: threadIds.length ? 'running' : 'ready', threadIds, failed, watching: Boolean(note?.watch), watchFailed: note?.failed.get('watch') ?? null };
    });
  }
  // The agents or who may ask changed: show who is here, and look.
  async function sync() {
    try {
      shown = (await world.members()).filter((m) => m.kind === 'agent').map(({ kind, mayAsk, ...b }) => b);
    } catch (error) {
      console.error('Could not read the buddies:', error);
    }
    broadcastAgents();
    await look('the buddies or who may ask changed');
  }

  // A change landed in the world's log (wait): { rev, by: { id, kind }, at,
  // comments }. Comments changed: look. Otherwise a person's change ends
  // the runs only a watch started, for they saw the world as it was, and
  // the watchers look again once people pause; one from outside the app
  // ends none (a program may write more often than a run lasts: the run
  // lands merged, and runs again on it) and, being whole, has them look at
  // once, as an agent's does.
  function changed({ rev, by: author, at, comments }) {
    const who = author.kind === 'buddy' ? nameOf(author.id) : author.kind === 'person' ? 'a person' : 'outside the app';
    if (comments) {
      look(`a comment by ${who}, rev ${rev}`);
      return;
    }
    const by = author.kind === 'buddy' ? author.id : author.kind === 'outside' ? OUTSIDE : null;
    changedAt.set(by, { rev, at, depth: depths.get(by) ?? 0 });
    if (![...notes.values()].some((n) => n.watch)) return;
    if (by !== null) {
      look(`an edit by ${who}, rev ${rev}`);
      return;
    }
    for (const r of runs.values()) {
      if (!r.task.watchOnly || r.landing || r.cancelled) continue;
      Object.assign(noteOf(r.task.agent.id), { lookedAt: r.from, print: r.print ?? null });
      end(r);
    }
    wake(at + SETTLE_MS, `an edit by ${who}, rev ${rev}, once people pause`);
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
    sync,
    watch,
    retry,
    /** Someone resumes the watches the breaker paused: the runs counted so far count no more. */
    resume() {
      paused = false;
      started = [];
      emit('watches', { paused });
      look('the watches were resumed');
    },
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
