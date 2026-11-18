// The agent runtime of one open doc (docs/agent-runtime.md): the controller.
// It keeps this machine's notes on the doc's buddies, the steps and the
// runs going, and one timer. Whenever anything may have changed it looks:
// reads the doc, asks the rules (plan, src/core/due.js) what to start and
// stop, and does that. A run is the agent once on copies (execute,
// runner.js); what it made (toChanges, src/core/translate.js) lands through
// the doc's door, as the buddy. Nothing of it is written to a shared file.

import { basename } from 'node:path';
import { filled, nextStepAt, refilled } from '../core/bucket.js';
import { movedAnchor, newId, threadsOf } from '../core/comments.js';
import { diffOps } from '../core/ot.js';
import { merge3 } from '../core/diff.js';
import { SETTLE_MS, plan } from '../core/due.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';
import { toChanges } from '../core/translate.js';
import { pickedAgent } from '../store/agents.js';
import { noteWatching, readTaken, readWatching } from '../store/history.js';
import { logRun } from '../store/runs.js';
import { readSettings, settingsWithId } from '../store/settings.js';
import { readSidecarText } from '../store/files.js';
import { DocError, can } from './door.js';
import { execute, killTree, testAgent } from './runner.js';

// A look that could not read the doc (a sidecar locked or unreadable, a
// buddy file gone as it was read) is tried again this long after, twice as
// long each time, up to LOOK_AGAIN_MAX_MS: no event may come to try it.
const LOOK_AGAIN_MS = 1000;
const LOOK_AGAIN_MAX_MS = 30_000;

/**
 * The buddies' statuses as someone at `level` sees them: why a run failed
 * is the owner's machine's, so only the owner hears it.
 */
export function agentsFor(level, agents) {
  if (level === 'owner') return agents;
  return agents.map((a) => ({ ...a, failed: a.failed.map(({ thread, at }) => ({ thread, at })), watchFailed: a.watchFailed && { at: a.watchFailed.at } }));
}

/**
 * The buddies of one open doc. `door` is how it reads the doc and lands a
 * run: { text(), rev(), epoch(), missing(), closed(), readComments() (the
 * sidecar's lines and problem), submit(arg, who), comment(arg, who) }.
 * `place()` is { docPath, folder, room } as they are now, `pathInProject()`
 * the doc's path in its project (`/`-separated); `buddies()` the buddies the
 * doc reaches, `me()` the owner, `levelOf(id)` a person's level now. `emit`
 * tells every window (`agents`, `steps`). `timeoutMs` ends a run that hangs.
 */
export async function createBuddyRuntime({ door, place, pathInProject, buddies, me, levelOf, settingsDir, secrets, emit, timeoutMs }) {
  // What this machine notes of each buddy (plan): { seen, lookedAt, base,
  // failed (thread, or 'watch' for its watch, → { at, why }), watch }. The
  // watch is noted with the doc's history too (noteWatching), as only a
  // person changes it; the rest is gone on a restart.
  const notes = new Map();
  const noteOf = (id) => notes.get(id) ?? notes.set(id, { seen: new Map(), lookedAt: null, base: null, failed: new Map(), watch: null }).get(id);
  for (const [id, { by }] of Object.entries(await readWatching(place().docPath, settingsDir))) noteOf(id).watch = { by };
  for (const note of notes.values()) note.lookedAt = door.rev(); // no run on opening
  const changedAt = new Map(); // who last changed the text → { rev, at }, people as null
  let steps = { left: null, cap: DEFAULT_SETTINGS.steps, every: DEFAULT_SETTINGS.refillEvery * 1000, at: performance.now() };
  // The runs going: buddy → { task, from (the rev it started at), child,
  // cancelled, landing (its agent is done; it lands whatever happens), done }.
  const runs = new Map();
  let shown = []; // the buddies the windows were last told of
  let stopped = false;

  // ---- looking ----

  let looking = null;
  let again = false;
  let lookAgainMs = LOOK_AGAIN_MS;
  let timer = null;
  let timerAt = Infinity;
  // Look at `at` (performance.now()), or sooner if a look is set sooner.
  function wake(at) {
    if (stopped || at >= timerAt) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      look();
    }, Math.max(0, at - performance.now()) + 5);
    timer.unref?.();
  }
  // Look, one at a time: a look asked for meanwhile is one more after it.
  function look() {
    if (stopped) return Promise.resolve();
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
          wake(performance.now() + lookAgainMs);
          lookAgainMs = Math.min(lookAgainMs * 2, LOOK_AGAIN_MAX_MS);
        }
      } while (again && !stopped);
      looking = null; // at once: a look asked for after the last one began is never lost
    })();
    return looking;
  }
  async function lookOnce() {
    if (door.closed()) return;
    const here = await buddies();
    const { lines, problem } = await door.readComments();
    const text = door.text();
    const editors = (place().room?.list()?.teammates ?? []).filter((p) => p.level === 'write').map((p) => p.id);
    const { settings } = await readSettings(settingsDir);
    const before = JSON.stringify(stepsView());
    steps = refilled(steps, { cap: settings.steps, every: settings.refillEvery * 1000 }, performance.now());
    const p = problem || here.length === 0 // a buddy could not post its comments, or there is none
      ? { start: [], stop: [...runs.keys()], steps, wakeAt: null, asking: new Set() }
      : plan({
        buddies: here,
        threads: threadsOf(lines.map((l) => l.comment).filter(Boolean), here.map(({ id, name }) => ({ id, name })), text),
        askers: [(await me()).id, ...editors],
        taken: await readTaken(place().docPath, settingsDir),
        notes, changedAt, running: new Set(runs.keys()), steps, text, now: performance.now(),
      });
    steps = p.steps;
    if (JSON.stringify(stepsView()) !== before) emit('steps', stepsView());
    // A failure is shown while its thread still asks the buddy.
    let gone = false;
    for (const [id, note] of notes) for (const key of note.failed.keys()) if (key !== 'watch' && !p.asking.has(`${id} ${key}`)) gone = note.failed.delete(key);
    if (gone) broadcastAgents();
    for (const id of p.stop) end(runs.get(id));
    for (const task of p.start) if (!stopped) startRun(task);
    if (p.wakeAt !== null) wake(p.wakeAt);
  }

  // ---- runs ----

  function end(run) {
    if (!run || run.landing) return; // its answer is on its way
    run.cancelled = true;
    killTree(run.child);
  }

  function startRun(task) {
    const run = { task, from: door.rev(), child: null, cancelled: false, landing: false, done: null };
    runs.set(task.buddy.id, run);
    run.done = runOnce(run).finally(() => {
      runs.delete(task.buddy.id);
      broadcastAgents();
      look(); // what was asked while it ran
    });
    broadcastAgents();
  }

  // The agent once, then what it made lands; logged with its trace.
  async function runOnce(run) {
    const { task } = run;
    const { docPath, folder } = place();
    const copies = { path: folder ? await pathInProject() : basename(docPath), text: door.text(), comments: await readSidecarText(docPath) };
    const runId = newId('r');
    let result;
    let answered = null;
    try {
      const { settings } = await readSettings(settingsDir);
      result = await execute({
        task, copies, timeoutMs,
        agent: await pickedAgent(settings, secrets()[settings.agent], settingsDir),
        folder, human: { name: (await me()).name, about: (await settingsWithId(settingsDir)).about.trim() },
        onChild: (child) => {
          run.child = child;
          if (run.cancelled) killTree(child);
        },
      });
    } catch (error) {
      console.error(`Run of ${task.buddy.name} failed to start:`, error);
      result = { at: Date.now(), ms: 0, outcome: 'failed', code: null, body: `Ponjo could not run ${task.buddy.name}: ${error.message}` };
    }
    if (run.cancelled || stopped) result.outcome = 'stopped'; // ended: no answer
    run.landing = true;
    try {
      if (result.outcome !== 'stopped') answered = await finish(run, copies, result);
    } finally {
      const trace = { script: result.script, prompt: result.prompt, steps: result.steps ?? [], stdout: result.stdout ?? '', stderr: result.stderr ?? '', base: copies.text, edited: result.edited ?? null, comments: result.comments ?? null, landed: answered?.landed ?? 'Ended without an answer' };
      await logRun(settingsDir, { doc: place().docPath, run: runId, buddy: task.buddy.name, threads: task.threads.map((t) => t.id), ...(task.watch ? { watched: true } : {}), comments: answered?.comments ?? [], at: new Date(result.at).toISOString(), ms: result.ms, outcome: result.outcome, code: result.code, ...(result.usage ? { usage: result.usage } : {}) }, trace);
    }
  }

  // A run ended: the buddy's notes say what it was given and how it went,
  // and what it made lands through the door, as the buddy, with the level of
  // whoever asked it, at most write: a run one of whose askers was removed
  // or set to Read meanwhile lands nothing. A failed run lands nothing: it
  // is noted as the buddy's failure in each thread that asked it (and for
  // its watch), and asks again only when someone writes there, on Retry,
  // or once the agent or its settings change. Each comment's edits (its
  // group) land as a version of their own, merged with what landed since
  // (merge3), then its comments; in a thread that asked it, just after the
  // last comment it was given. Resolves to the ids of the comments it posted
  // and what landed, in words, for its trace.
  async function finish(run, copies, result) {
    const { task } = run;
    const id = task.buddy.id;
    const failed = result.outcome !== 'ok';
    const note = noteOf(id);
    for (const t of task.threads) note.seen.set(t.id, Date.parse(t.comments.at(-1).at));
    if (note.watch) {
      note.lookedAt = run.from;
      if (!failed) note.base = copies.text;
    }
    if (task.watch) {
      if (failed) note.failed.set('watch', { at: new Date().toISOString(), why: result.body });
      else note.failed.delete('watch');
    }
    for (const asker of task.askers) if (!can({ level: await levelOf(asker) }, 'write')) return { comments: [], landed: 'Dropped: whoever asked can no longer edit' };
    const by = { id, name: task.buddy.name, kind: 'ai' };
    const threads = threadsOf((await door.readComments()).lines.map((l) => l.comment).filter(Boolean), [], door.text());
    const open = new Map(threads.filter((t) => !t.resolved).map((t) => [t.id, t]));
    for (const t of task.threads) note.failed.delete(t.id);
    if (failed) {
      const at = new Date().toISOString();
      for (const t of task.threads) if (open.has(t.id)) note.failed.set(t.id, { at, why: result.body });
      broadcastAgents();
      return { comments: [], landed: 'Failed' };
    }
    broadcastAgents();
    const { posts, carried, dropped } = toChanges({ by, base: copies.text, edited: result.edited, comments: result.comments, groups: result.groups, threads, asking: task.threads.map((t) => t.id) });
    if (dropped) return { comments: [], landed: `Dropped: ${dropped}` };
    const who = { ...by, level: 'write' };
    let prev = copies.text;
    let conflict = false;
    for (const { comment, doc, lands } of carried) {
      if (!door.missing() && lands && doc !== prev) { // a doc gone has nothing to land on
        const now = { text: door.text(), rev: door.rev() };
        const merged = merge3(prev, now.text, doc);
        conflict ||= merged.conflicts > 0;
        await door.submit({ ops: diffOps(now.text, merged.text), rev: now.rev, epoch: door.epoch(), id: newId('e'), reply: comment.id, thread: comment.thread ?? comment.id, conflict: merged.conflicts > 0 }, who)
          .catch((error) => { if (error.code !== 'not_saved') throw error; }); // landed: windows hear it is not saved
        // A reply whose edits rewrote its thread's text moves the thread (SPEC §3).
        const anchor = comment.thread !== undefined && movedAnchor(open.get(comment.thread).anchor, prev, doc, door.text());
        if (anchor) comment.anchor = anchor;
      }
      prev = doc;
    }
    if (!posts.length) return { comments: [], landed: 'Nothing to do' };
    // A reply comes just after the last comment the run was given in its
    // thread, each after the one before it.
    const after = new Map(task.threads.map((t) => [t.id, t.comments.at(-1).at]));
    try {
      for (const c of posts) {
        const { at } = await door.comment({ id: c.id, thread: c.thread, anchor: c.anchor ?? null, body: c.body, after: c.thread !== undefined ? after.get(c.thread) : undefined }, who);
        if (c.thread !== undefined && after.has(c.thread)) after.set(c.thread, at);
      }
    } catch (error) {
      console.error(`Could not post ${task.buddy.name}'s comments:`, error);
      return { comments: [], landed: 'Its comments were not posted' };
    }
    return { comments: posts.map((c) => c.id), landed: conflict ? 'Posted; where it collided with people, their lines stayed' : 'Posted' };
  }

  // ---- the steps ----

  // The steps as the windows show them: { left, cap, next (when the next
  // comes, by the wall clock, or null) }.
  function stepsView() {
    const next = nextStepAt(steps);
    return { left: steps.left ?? steps.cap, cap: steps.cap, next: next === null ? null : Math.round((Date.now() + Math.max(0, next - performance.now())) / 1000) * 1000 };
  }

  // ---- what people do ----

  // Note who watches, and tell the windows.
  function keepWatching() {
    const noted = Object.fromEntries([...notes].filter(([, n]) => n.watch).map(([id, n]) => [id, n.watch]));
    noteWatching(place().docPath, settingsDir, noted).catch((error) => console.error('Could not note the buddies watching:', error));
    broadcastAgents();
  }
  // Buddy `buddy` watches the doc (`on`), or no longer, as `who` says: it
  // looks at once; turned off, a run of it on now ends with no answer
  // unless something else asks it.
  async function watch({ buddy, on } = {}, who) {
    if (typeof buddy !== 'string' || typeof on !== 'boolean') throw new DocError('bad_input', 'expected { buddy, on }');
    if (!(await buddies()).some((b) => b.id === buddy)) throw new DocError('not_found', 'no such buddy here');
    const note = noteOf(buddy);
    if (on && !note.watch) Object.assign(note, { watch: { by: who.id }, lookedAt: null, base: null });
    if (!on) Object.assign(note, { watch: null, base: null });
    if (!on) note.failed.delete('watch');
    keepWatching();
    look();
    return {};
  }
  // Run the failed asks of `buddy` (or every buddy's) again: the agent or
  // its settings changed, or someone pressed Retry.
  function retryFailed(buddy = null) {
    for (const [id, note] of notes) {
      if (buddy !== null && id !== buddy) continue;
      for (const key of note.failed.keys()) {
        if (key === 'watch') note.lookedAt = null; // it looks again at once
        else note.seen.delete(key);
      }
    }
    look();
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
      const threadIds = run && !run.cancelled ? run.task.threads.map((t) => t.id) : [];
      const note = notes.get(b.id);
      const failed = [...(note?.failed ?? [])].filter(([key]) => key !== 'watch').map(([thread, { at, why }]) => ({ thread, at, why }));
      return { ...b, state: threadIds.length ? 'running' : 'ready', threadIds, failed, watching: Boolean(note?.watch), watchFailed: note?.failed.get('watch') ?? null };
    });
  }
  // The buddies or who may ask changed: show who is here, and look.
  async function sync() {
    if (door.closed()) return;
    try {
      shown = await buddies();
    } catch (error) {
      console.error('Could not read the buddies:', error);
    }
    broadcastAgents();
    await look();
  }

  return {
    /**
     * A change to the text landed, at the doc's rev now: `by` a buddy's id,
     * or null for people (or outside). A person's ends the runs only a watch
     * started, for they saw the doc as it was, and the watchers look again
     * once people pause; a buddy's has them look at once.
     */
    changed(by) {
      changedAt.set(by, { rev: door.rev(), at: performance.now() });
      if (![...notes.values()].some((n) => n.watch)) return;
      if (by !== null) {
        look();
        return;
      }
      for (const run of runs.values()) {
        if (!run.task.watchOnly || run.landing || run.cancelled) continue;
        noteOf(run.task.buddy.id).lookedAt = run.from;
        end(run);
      }
      wake(performance.now() + SETTLE_MS);
    },
    /** What is asked may have changed: look again. */
    look,
    sync,
    /** The agent, its settings or its secrets changed: the failed asks run again. */
    agentChanged: () => retryFailed(),
    statuses: () => agentStatuses(),
    steps: () => stepsView(),
    /** The names of the buddies at work. */
    running: () => [...runs.values()].filter((r) => !r.cancelled).map((r) => r.task.buddy.name),
    testAgent: async () => {
      const { settings } = await readSettings(settingsDir);
      return testAgent(await pickedAgent(settings, secrets()[settings.agent], settingsDir));
    },
    calls: {
      watch: (body, who) => watch(body, who),
      // Someone refills the steps: all of them, and the buddies waiting go on.
      refillSteps: () => {
        steps = filled(steps, performance.now());
        emit('steps', stepsView());
        look();
        return {};
      },
      retry: (body) => {
        if (typeof body?.buddy !== 'string') throw new DocError('bad_input', 'expected { buddy }');
        retryFailed(body.buddy);
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
    },
  };
}
