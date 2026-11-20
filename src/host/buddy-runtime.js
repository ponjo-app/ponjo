// The agent runtime of one open doc (docs/agent-runtime.md): the loop. It
// keeps this machine's notes on the world's agents, the runs going and
// the breaker, and one timer. Whenever anything may have changed it looks: reads
// the world (members, asks), asks the plan (src/core/due.js) what to start
// and stop, and does that. A run is the agent once on its view (execute,
// runner.js), and what it left behind is proposed to the world (the doc's:
// doc-world.js). Nothing of it is written to a shared file; what it does
// and why is written to this machine's agent log (logLoop).

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { newId } from '../core/comments.js';
import { OUTSIDE, SETTLE_MS, plan } from '../core/due.js';
import { pickedAgent } from '../store/agents.js';
import { noteWatching, readWatching } from '../store/history.js';
import { logLoop, logRun } from '../store/runs.js';
import { readSettings } from '../store/settings.js';
import { DocError } from './door.js';
import { execute, killTree, testAgent } from './runner.js';

// A look that could not read the doc (a sidecar locked or unreadable, a
// buddy file gone as it was read) is tried again this long after, twice as
// long each time, up to LOOK_AGAIN_MAX_MS: no change may come to try it.
const LOOK_AGAIN_MS = 1000;
const LOOK_AGAIN_MAX_MS = 30_000;

// A view's fingerprint: its doc's text's (its comments wake no watcher).
const printOf = (files) => createHash('sha256').update(files.text).digest('base64url');

// A time as the agent log writes it, on this machine's clock: 2026-11-18 21:40:12.203.
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;

/**
 * The buddies' statuses as someone at `level` sees them: why a run failed
 * is the owner's machine's, so only the owner hears it.
 */
export function agentsFor(level, agents) {
  if (level === 'owner') return agents;
  return agents.map((a) => ({ ...a, failed: a.failed.map(({ thread, at }) => ({ thread, at })), watchFailed: a.watchFailed && { at: a.watchFailed.at } }));
}

/**
 * The buddies of one open doc. `world` is the doc's (doc-world.js), the
 * five calls it reaches the doc by; `docPath()` names the doc in the logs
 * and notes. `emit` tells every window (`agents`, `watches`). `timeoutMs`
 * ends a run that hangs.
 */
export async function createBuddyRuntime({ world, docPath, settingsDir, secrets, emit, timeoutMs }) {
  // What this machine notes of each buddy (plan): { seen, lookedAt, print
  // (its view's fingerprint as its last watch run started, or null), since
  // (the files of its last watch run's view, or null), wake (the lines that
  // run named, or null), failed (ask, or 'watch' for its watch, → { at, why
  // }), watch }. The watch is noted with the doc's history too
  // (noteWatching), as only a person changes it; the rest is gone on a restart.
  const notes = new Map();
  const noteOf = (id) => notes.get(id) ?? notes.set(id, { seen: new Map(), lookedAt: null, print: null, since: null, wake: null, failed: new Map(), watch: null }).get(id);
  for (const [id, { by }] of Object.entries(await readWatching(docPath(), settingsDir))) noteOf(id).watch = { by };
  let version = (await world.wait(Infinity, 0)).rev; // the world's version, as last read from its log
  for (const note of notes.values()) note.lookedAt = version; // no run on opening
  const changedAt = new Map(); // who last changed the text → { rev, at }, people as null
  const depths = new Map(); // agent → the depth of its latest run: its changes' and asks'
  // The breaker: when each run in the window started (performance.now()),
  // and whether it tripped, pausing the watches until someone resumes them.
  let started = [];
  let paused = false;
  // The runs going: buddy → { task, from (the version it started at), print
  // (its view's fingerprint, once it has it), child,
  // cancelled, landing (its agent is done; it lands whatever happens), done }.
  const runs = new Map();
  let shown = []; // the buddies the windows were last told of
  let stopped = false;
  const nameOf = (id) => shown.find((b) => b.id === id)?.name ?? id;

  // ---- the agent log ----

  // Lines for the agent log, one write after another, each the time and the
  // doc, then what happened: names, revs and thread ids, never the doc's text.
  let logged = Promise.resolve();
  function tell(...lines) {
    const head = `${stamp(new Date())}  ${basename(docPath())}  `;
    const text = lines.map((line, i) => (i ? `  ${line}` : head + line)).join('\n');
    logged = logged.then(() => logLoop(settingsDir, `${text}\n`));
  }

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
          tell(`look failed: ${error.message}; again in ${lookAgainMs / 1000} s`);
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
    const { settings } = await readSettings(settingsDir);
    const p = problem || here.length === 0 // a buddy could not post its comments, or there is none
      ? { start: [], stop: [...runs.keys()], wakeAt: null, asking: new Set() }
      : plan({
        agents: here, asks, askers: members.filter((m) => m.mayAsk).map((m) => m.id), ...(await viewed(here)),
        notes, changedAt, running: new Set(runs.keys()), limit: world.limits.depth, paused, now: performance.now(),
      });
    // A failure is shown while its ask still asks the buddy.
    let gone = false;
    for (const [id, note] of notes) for (const key of note.failed.keys()) if (key !== 'watch' && !p.asking.has(`${id} ${key}`)) gone = note.failed.delete(key);
    if (gone) broadcastAgents();
    const verdicts = new Map(p.why ?? [['', problem ? `nothing starts: ${problem}` : 'nothing starts: no buddy here']]);
    const names = new Map([...runs].map(([id, r]) => [id, r.task.agent.name]).concat(here.map((b) => [b.id, b.name])));
    for (const id of p.stop) end(runs.get(id));
    for (const task of p.start) if (!stopped) verdicts.set(task.agent.id, `${verdicts.get(task.agent.id)} · started ${startRun(task)}`);
    const rows = [...verdicts].map(([id, reason]) => [names.get(id) ?? '', reason]);
    const width = Math.max(...rows.map(([name]) => name.length));
    tell(`look · ${why || 'asked to'}`, ...rows.map(([name, reason]) => `${name.padEnd(width)}  ${reason}`));
    trip(settings);
    if (p.wakeAt !== null) wake(p.wakeAt, 'what a look waited for: people to pause');
  }
  // What the watchers among `here` see now: { prints (each one's view's
  // fingerprint), woken (those whose last run named lines that wake them,
  // and whose view holds one, whole) }.
  async function viewed(here) {
    const prints = new Map();
    const woken = new Set();
    for (const [id, note] of notes) {
      const agent = here.find((b) => b.id === id);
      if (!note.watch || !agent) continue;
      const { files } = await world.view(agent, {});
      prints.set(id, printOf(files));
      if (note.wake?.some((l) => files.text.split(/\r?\n/).includes(l))) woken.add(id);
    }
    return { prints, woken };
  }

  // ---- runs ----

  function end(run) {
    if (!run || run.landing) return; // its answer is on its way
    run.cancelled = true;
    killTree(run.child);
  }

  // Start `task`'s run; returns its id.
  function startRun(task) {
    const run = { id: newId('r'), task, from: version, child: null, cancelled: false, landing: false, done: null };
    depths.set(task.agent.id, task.depth);
    started.push(performance.now());
    runs.set(task.agent.id, run);
    run.done = runOnce(run).finally(() => {
      runs.delete(task.agent.id);
      broadcastAgents();
      look(`run ${run.id} of ${task.agent.name} ended`); // what was asked while it ran
    });
    broadcastAgents();
    return run.id;
  }

  // The agent once on its view, then what it left behind is proposed;
  // logged with its trace.
  async function runOnce(run) {
    const { task } = run;
    const runId = run.id;
    let view = null;
    let result;
    let answered = null;
    try {
      view = await world.view(task.agent, { since: task.watch ? noteOf(task.agent.id).since : undefined, asks: task.asks });
      run.from = view.rev;
      run.print = printOf(view.files);
      const { settings } = await readSettings(settingsDir);
      result = await execute({
        buddy: task.agent, files: view.files, prompt: view.prompt, timeoutMs,
        agent: await pickedAgent(settings, secrets()[settings.agent], settingsDir),
        onChild: (child) => {
          run.child = child;
          if (run.cancelled) killTree(child);
        },
      });
    } catch (error) {
      console.error(`Run of ${task.agent.name} failed to start:`, error);
      result = { at: Date.now(), ms: 0, outcome: 'failed', code: null, body: `Ponjo could not run ${task.agent.name}: ${error.message}` };
    }
    if (run.cancelled || stopped) result.outcome = 'stopped'; // ended: no answer
    run.landing = true;
    try {
      if (result.outcome !== 'stopped') answered = await finish(run, view, result);
    } finally {
      const trace = { script: result.script, prompt: result.prompt, steps: result.steps ?? [], stdout: result.stdout ?? '', stderr: result.stderr ?? '', base: view?.files.text ?? null, edited: result.edited ?? null, comments: result.comments ?? null, landed: answered?.landed ?? 'Ended without an answer' };
      const why = result.outcome === 'ok' || result.outcome === 'stopped' ? '' : `: ${String(result.body ?? '').split('\n')[0].slice(0, 200)}`;
      tell(`run ${runId} of ${task.agent.name} ended: ${result.outcome}${why} in ${(result.ms / 1000).toFixed(1)} s · ${trace.landed}, ${answered?.comments.length ?? 0} comments`);
      await logRun(settingsDir, { doc: docPath(), run: runId, buddy: task.agent.name, threads: task.asks.map((a) => a.id), ...(task.watch ? { watched: true } : {}), comments: answered?.comments ?? [], at: new Date(result.at).toISOString(), ms: result.ms, outcome: result.outcome, code: result.code, ...(result.usage ? { usage: result.usage } : {}) }, trace);
    }
  }

  // A run ended: the buddy's notes say what it was given and how it went,
  // and what it left behind is proposed to the world, as the buddy, for
  // whoever asked it, at most at their level: a run one of whose askers was
  // removed or set to Read meanwhile lands nothing. A failed run lands
  // nothing: it is noted as the buddy's failure in each ask it was given
  // that still asks it (and for its watch), and asks again only when
  // someone writes there, on Retry, or once the agent or its settings
  // change. Resolves to the ids of the comments it posted and what landed,
  // in words, for its trace.
  async function finish(run, view, result) {
    const { task } = run;
    const id = task.agent.id;
    const failed = result.outcome !== 'ok';
    const note = noteOf(id);
    for (const a of task.asks) note.seen.set(a.id, Date.parse(a.until));
    if (note.watch) {
      note.lookedAt = run.from;
      note.print = run.print ?? null;
      if (!failed) note.since = { text: view.files.text, comments: task.watch ? view.files.comments ?? '' : null };
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
    return world.propose({ ...task.agent, for: task.askers, depth: task.depth }, run.from, { files: view.files, asks: task.asks }, { text: result.edited, comments: result.comments, groups: result.groups, actions: result.actions, output: result.stdout });
  }

  // ---- the breaker ----

  // Past `pauseAfter` runs started within `pauseWithin` minutes, the doc's
  // watches pause, and every window is told, until someone resumes them.
  function trip({ pauseAfter, pauseWithin }) {
    started = started.filter((at) => at > performance.now() - pauseWithin * 60_000);
    if (paused || started.length < pauseAfter) return;
    paused = true;
    tell(`watches paused: ${started.length} runs in ${pauseWithin} min`);
    emit('watches', { paused });
  }

  // ---- what people do ----

  // Note who watches, and tell the windows.
  function keepWatching() {
    const noted = Object.fromEntries([...notes].filter(([, n]) => n.watch).map(([id, n]) => [id, n.watch]));
    noteWatching(docPath(), settingsDir, noted).catch((error) => console.error('Could not note the buddies watching:', error));
    broadcastAgents();
  }
  // Buddy `buddy` watches the doc (`on`), or no longer, as `who` says: it
  // looks at once; turned off, a run of it on now ends with no answer
  // unless something else asks it.
  async function watch({ buddy, on } = {}, who) {
    if (typeof buddy !== 'string' || typeof on !== 'boolean') throw new DocError('bad_input', 'expected { buddy, on }');
    if (!(await world.members()).some((b) => b.kind === 'agent' && b.id === buddy)) throw new DocError('not_found', 'no such buddy here');
    const note = noteOf(buddy);
    if (on && !note.watch) Object.assign(note, { watch: { by: who.id }, lookedAt: null, print: null, since: null, wake: null });
    if (!on) Object.assign(note, { watch: null, print: null, since: null, wake: null });
    if (!on) note.failed.delete('watch');
    keepWatching();
    look(`${nameOf(buddy)}'s watch turned ${on ? 'on' : 'off'}`);
    return {};
  }
  // Run the failed asks of `buddy` (or every buddy's) again: the agent or
  // its settings changed, or someone pressed Retry.
  function retryFailed(buddy, why) {
    for (const [id, note] of notes) {
      if (buddy && id !== buddy) continue;
      for (const key of note.failed.keys()) {
        if (key === 'watch') note.lookedAt = null; // it looks again at once
        else note.seen.delete(key);
      }
    }
    look(why);
  }

  // ---- what the windows see ----

  const broadcastAgents = () => emit('agents', agentStatuses());
  // The buddies the doc reaches, which are at work, the threads where each
  // one's last run failed ([{ thread, at, why }]), whether it watches the
  // doc, and whether its last watch run failed ({ at, why } or null); `why`
  // for the owner alone (agentsFor).
  function agentStatuses() {
    return shown.map((b) => {
      const run = runs.get(b.id);
      const threadIds = run && !run.cancelled ? run.task.asks.map((a) => a.id) : [];
      const note = notes.get(b.id);
      const failed = [...(note?.failed ?? [])].filter(([key]) => key !== 'watch').map(([thread, { at, why }]) => ({ thread, at, why }));
      return { ...b, state: threadIds.length ? 'running' : 'ready', threadIds, failed, watching: Boolean(note?.watch), watchFailed: note?.failed.get('watch') ?? null };
    });
  }
  // The buddies or who may ask changed: show who is here, and look.
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
  // comments }. Comments changed: look. The text: a person's ends the runs
  // only a watch started, for they saw the doc as it was, and the watchers
  // look again once people pause; one found on disk ends none (a program
  // may write more often than a run lasts: the run lands merged by line,
  // and runs again on it) and, being whole, has them look at once, as a
  // buddy's does.
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
    for (const run of runs.values()) {
      if (!run.task.watchOnly || run.landing || run.cancelled) continue;
      Object.assign(noteOf(run.task.agent.id), { lookedAt: run.from, print: run.print ?? null });
      end(run);
    }
    wake(at + SETTLE_MS, `an edit by ${who}, rev ${rev}, once people pause`);
  }
  // Wait for the world to change after the version last read, and take
  // each change, until closed: a change that lands meanwhile is in the
  // log the next wait reads.
  (async () => {
    while (!stopped) {
      const { rev, log } = await world.wait(version, Infinity);
      if (stopped) return;
      version = rev;
      for (const change of log) changed(change);
    }
  })().catch((error) => console.error('Could not wait for the doc to change:', error));

  return {
    /** What is asked may have changed (`why`): look again. */
    look,
    sync,
    /** The agent, its settings or its secrets changed: the failed asks run again. */
    agentChanged: () => retryFailed(null, 'the agent or its settings changed'),
    statuses: () => agentStatuses(),
    /** The watches: { paused }. */
    watches: () => ({ paused }),
    /** The names of the buddies at work. */
    running: () => [...runs.values()].filter((r) => !r.cancelled).map((r) => r.task.agent.name),
    testAgent: async () => {
      const { settings } = await readSettings(settingsDir);
      return testAgent(await pickedAgent(settings, secrets()[settings.agent], settingsDir));
    },
    calls: {
      watch: (body, who) => watch(body, who),
      // Someone resumes the watches the breaker paused: the runs counted so far count no more.
      resume: () => {
        paused = false;
        started = [];
        emit('watches', { paused });
        look('the watches were resumed');
        return {};
      },
      retry: (body) => {
        if (typeof body?.buddy !== 'string') throw new DocError('bad_input', 'expected { buddy }');
        retryFailed(body.buddy, `Retry on ${nameOf(body.buddy)}`);
        return {};
      },
    },
    /** End every run without an answer (an open ask runs again next time) and start no more. */
    async close() {
      stopped = true;
      clearTimeout(timer);
      await looking;
      for (const run of runs.values()) end(run);
      await Promise.all([...runs.values()].map((r) => r.done));
      await logged;
    },
  };
}
