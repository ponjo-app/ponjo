// A doc's buddies at work (docs/agent-runtime.md): which are asked or
// watching, their runs (runner.js), what each run lands, and what this
// machine notes for them meanwhile. It reads the doc and lands each run
// through `door`, as the buddy; nothing of it is written to a shared file.

import { basename } from 'node:path';
import { filled, nextStepAt, refilled, take } from '../core/bucket.js';
import { movedAnchor, newId, threadsOf } from '../core/comments.js';
import { diffOps } from '../core/ot.js';
import { merge3 } from '../core/diff.js';
import { SETTLE_MS, whoIsDue } from '../core/due.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';
import { toChanges } from '../core/translate.js';
import { pickedAgent } from '../store/agents.js';
import { noteWatching, readTaken, readWatching } from '../store/history.js';
import { logRun } from '../store/runs.js';
import { readSettings, settingsWithId } from '../store/settings.js';
import { readSidecarText } from '../store/files.js';
import { DocError, can } from './door.js';
import { Runner, testAgent } from './runner.js';

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
 * the doc's path in its project (`/`-separated); `buddies()` the
 * buddies the doc reaches, `me()` the owner, `levelOf(id)` a person's level
 * now. `emit` tells every window (`agents`, `steps`).
 */
export async function createBuddyRuntime({ door, place, pathInProject, buddies, me, levelOf, settingsDir, secrets, emit }) {
  const broadcastAgents = () => emit('agents', agentStatuses());
  const pickAgent = async () => {
    const { settings } = await readSettings(settingsDir);
    return pickedAgent(settings, secrets()[settings.agent], settingsDir);
  };
  const runner = new Runner({
    asks: () => asks(),
    doc: async () => ({ path: place().folder ? await pathInProject() : basename(place().docPath), text: door.text(), comments: await readSidecarText(place().docPath) }),
    agent: pickAgent,
    folder: async () => place().folder,
    human: async () => ({ name: (await me()).name, about: (await settingsWithId(settingsDir)).about.trim() }),
    finish: (result) => finishRun(result),
    onChange: () => broadcastAgents(),
    log: (entry, trace) => logRun(settingsDir, { doc: place().docPath, ...entry }, trace),
  });

  // The buddies asked or watching now, each with its inbox (whoIsDue, in
  // src/core/due.js; Runner's asks). Only the comments of those who may
  // write ask: the owner and the players who can edit, and only those this
  // host took (comment), as they were taken: one that reached the sidecar
  // another way is shown but asks no one. A run woken by another buddy's
  // change only takes a step (takeStep).
  async function asks() {
    if (door.closed()) return [];
    const here = await buddies();
    if (here.length === 0) return [];
    const { lines, problem } = await door.readComments();
    if (problem) return []; // a buddy could not post its comments
    const editors = (place().room?.list()?.players ?? []).filter((p) => p.level === 'write').map((p) => p.id);
    const askers = [(await me()).id, ...editors];
    const taken = await readTaken(place().docPath, settingsDir);
    const threads = threadsOf(lines.map((l) => l.comment).filter(Boolean), here.map(({ id, name }) => ({ id, name })), door.text());
    const { inboxes, asking } = whoIsDue({ buddies: here, threads, askers, taken, looked, watching, changedAt, text: door.text(), now: performance.now() });
    refill((await readSettings(settingsDir)).settings);
    // A failure is shown while its thread still asks the buddy.
    let gone = false;
    for (const [id, failed] of failures) for (const thread of failed.keys()) if (!asking.has(`${id} ${thread}`)) gone = failed.delete(thread);
    if (gone) broadcastAgents();
    return inboxes.map(({ asked, paid, ...inbox }) => ({ ...inbox, buddies: here, watchOnly: !asked && inbox.watch !== null, ...(paid ? { pay: takeStep } : {}) }));
  }
  // What each buddy's runs were given: buddy → Map(thread → the time of the
  // last comment it was given there). A run that answered nothing there, or
  // whose comments could not be written, is not run again until someone
  // writes more, so a sidecar that cannot be written never makes runs land
  // edits again and again.
  const looked = new Map();
  // The threads where each buddy's last run failed: buddy → Map(thread → {
  // at, why }), in memory only: a failure is this machine's, not the doc's.
  const failures = new Map();

  // The buddies watching this doc on this host (docs/host-spec.md, Asks
  // and watches): buddy → { by (who turned it on), thread (its watch
  // thread, or null), looked (when its last run started, by
  // performance.now(), a clock that never goes back; null: never since it
  // was turned on or retried, so it looks at once), base (the doc then, or
  // null before its first run here), failed (null, or { at, why } when its
  // last run failed: shown on the buddy, as it may have no thread yet) }. Only a person changes it
  // (watch); kept on this host (noteWatching), never in the sidecar. People's
  // edits since it looked, once they pause for SETTLE_MS, run each watcher.
  const watching = new Map(Object.entries(await readWatching(place().docPath, settingsDir)).map(([id, { by, thread }]) => [id, { by, thread: thread ?? null, looked: performance.now(), base: null, failed: null }]));
  // Who last changed the doc, and when (performance.now()), noted as each
  // change lands: a buddy by its id, people (and the doc changed outside)
  // as null. asks() tells from it, against when each watcher last looked,
  // whether it is due, so a look at any time finds the same.
  const changedAt = new Map();
  // Look again once people's edits pause: only a wake-up.
  let settling = null;
  function wakeOnPause() {
    if (!watching.size) return;
    clearTimeout(settling);
    settling = setTimeout(() => runner.reconcile(), SETTLE_MS + 5);
    settling.unref?.();
  }
  // The steps the doc's buddies have to wake each other: up to `steps`
  // (settings), one more every `refillEvery` seconds (0: none), all on
  // Refill (refillSteps). A run woken by another buddy's change takes one;
  // with none left it waits, until one comes (a timer, only then) or someone
  // refills them. In memory: a restart fills it.
  let bucket = { left: null, cap: DEFAULT_SETTINGS.steps, every: DEFAULT_SETTINGS.refillEvery * 1000, at: performance.now() };
  let stepTimer = null;
  // The bucket as `settings` make it now.
  function refill({ steps, refillEvery }) {
    const before = JSON.stringify(stepsView());
    bucket = refilled(bucket, { cap: steps, every: refillEvery * 1000 }, performance.now());
    if (JSON.stringify(stepsView()) !== before) emit('steps', stepsView());
  }
  // Take a step for a run woken by another buddy: false, with a look set for
  // when the next one comes, when none is left.
  function takeStep() {
    const now = performance.now();
    const step = take(bucket, now);
    const next = nextStepAt(bucket);
    if (!step.ok && next !== null && !stepTimer) {
      stepTimer = setTimeout(() => {
        stepTimer = null;
        runner.reconcile();
      }, Math.max(0, next - now) + 5);
      stepTimer.unref?.();
    }
    if (!step.ok) return false;
    bucket = step.bucket;
    emit('steps', stepsView());
    return true;
  }
  // The steps as the windows show them: { left, cap, next (when the next
  // comes, by the wall clock, or null) }.
  function stepsView() {
    const next = nextStepAt(bucket);
    return { left: bucket.left ?? bucket.cap, cap: bucket.cap, next: next === null ? null : Math.round((Date.now() + Math.max(0, next - performance.now())) / 1000) * 1000 };
  }
  // Someone refills the steps: all of them, and the buddies waiting go on.
  function refillSteps() {
    bucket = filled(bucket, performance.now());
    emit('steps', stepsView());
    runner.reconcile();
    return {};
  }

  // Note who watches, and tell the windows.
  function keepWatching() {
    const noted = Object.fromEntries([...watching].map(([id, { by, thread }]) => [id, { by, thread }]));
    noteWatching(place().docPath, settingsDir, noted).catch((error) => console.error('Could not note the buddies watching:', error));
    broadcastAgents();
  }
  // Buddy `buddy` watches the doc (`on`), or no longer, as `who` says: it
  // looks at once; turned off, a run of it on now ends with no answer
  // unless something else asks it.
  async function watch({ buddy, on } = {}, who) {
    if (typeof buddy !== 'string' || typeof on !== 'boolean') throw new DocError('bad_input', 'expected { buddy, on }');
    if (!(await buddies()).some((b) => b.id === buddy)) throw new DocError('not_found', 'no such buddy here');
    if (on && !watching.has(buddy)) watching.set(buddy, { by: who.id, thread: null, looked: null, base: null, failed: null });
    if (!on) watching.delete(buddy);
    keepWatching();
    runner.reconcile();
    return {};
  }

  // The agent or its settings changed: the failed asks run again.
  function retryFailed(buddy = null) {
    for (const [id, failed] of failures) {
      if (buddy !== null && id !== buddy) continue;
      for (const thread of failed.keys()) looked.get(id)?.delete(thread);
    }
    for (const [id, w] of watching) if (w.failed && (buddy === null || id === buddy)) w.looked = null; // it looks again at once
    runner.reconcile();
  }

  // The buddies the doc reaches, which are at work, the threads where each
  // one's last run failed ([{ thread, at, why }]), whether it watches the doc,
  // and whether its last watch run failed ({ at, why } or null); `why` for
  // the owner alone (agentsFor).
  let shownBuddies = [];
  function agentStatuses() {
    const statuses = runner.statuses();
    return shownBuddies.map((b) => {
      const threadIds = statuses.find((r) => r.id === b.id)?.threadIds ?? [];
      const failed = [...(failures.get(b.id) ?? [])].map(([thread, { at, why }]) => ({ thread, at, why }));
      return { ...b, state: threadIds.length ? 'running' : 'ready', threadIds, failed, watching: watching.has(b.id), watchFailed: watching.get(b.id)?.failed ?? null };
    });
  }

  // The buddies or the sidecar changed: show who is here, and start the runs due.
  async function syncAgents() {
    if (door.closed()) return;
    try {
      shownBuddies = await buddies();
    } catch (error) {
      console.error('Could not read the buddies:', error);
    }
    broadcastAgents();
    await runner.reconcile();
  }

  // A run ended (runner.js): each comment it appended is posted, and the
  // edits each carries (its group, PONJO_GROUPS) land as a version of their
  // own, hung on it and merged with what landed since (merge3), so each
  // comment's edits are undone on their own. An agent that wrote no groups
  // lands its edits on its last comment, or, with none, on an empty reply
  // in the first thread that asked it: no edit lands without a comment.
  // Where people changed the same lines meanwhile, their lines stay, the
  // rest lands, and its versions say `conflict`. A reply in a thread resolved
  // meanwhile is dropped, with its edits. In a thread that asked it, its
  // comments come just after the last comment it saw, so one written while
  // it worked is after them, still to answer; elsewhere, after the latest.
  // Only people resolve: a line's `resolved` is ignored (appendedComments).
  // A failed run posts nothing: it is kept as this buddy's failure in each
  // thread that asked it (failures), and asks again only when someone
  // writes there, Retry is pressed, or the agent or its settings change.
  // The buddy acts with the level of whoever asked it, at most write, asked
  // now: a run one of whose askers was removed or set to Read meanwhile
  // lands nothing. A watcher's run notes when it looked and at what, and the
  // first thread on the whole doc it opens is its watch thread. Resolves to the ids of the comments it posted and what
  // landed, in words, for its trace.
  async function finishRun({ id: buddyId, name, threadIds, askers, seen, from, watched = false, base, edited, comments, groups = [], failed, body }) {
    const saw = looked.get(buddyId) ?? new Map();
    for (const [thread, at] of Object.entries(seen)) saw.set(thread, Date.parse(at));
    looked.set(buddyId, saw);
    const watcher = watching.get(buddyId);
    if (watcher) {
      watcher.looked = from;
      if (!failed) watcher.base = base;
      if (watched) watcher.failed = failed ? { at: new Date().toISOString(), why: body } : null;
    }
    for (const asker of askers) if (!can({ level: await levelOf(asker) }, 'write')) return { comments: [], landed: 'Dropped: whoever asked can no longer edit' };
    const by = { id: buddyId, name, kind: 'ai' };
    const all = (await door.readComments()).lines.map((l) => l.comment).filter(Boolean);
    const threads = threadsOf(all, [], door.text());
    const open = new Map(threads.filter((t) => !t.resolved).map((t) => [t.id, t]));
    const asking = threadIds.filter((id) => open.has(id));
    const failedHere = failures.get(buddyId) ?? new Map();
    failures.set(buddyId, failedHere);
    for (const thread of threadIds) failedHere.delete(thread);
    if (failed) {
      const at = new Date().toISOString();
      for (const thread of asking) failedHere.set(thread, { at, why: body });
      broadcastAgents();
      return { comments: [], landed: 'Failed' };
    }
    const { posts, carried, dropped } = toChanges({ by, base, edited, comments, groups, threads, asking: threadIds });
    if (dropped) return { comments: [], landed: `Dropped: ${dropped}` };
    // Through the door, as the buddy: each comment's edits, merged by line
    // with the doc as it is, then its comments.
    const who = { ...by, level: 'write' };
    let prev = base;
    let conflict = false;
    for (const { comment, doc, lands } of carried) {
      if (!door.missing() && lands && doc !== prev) { // a doc gone has nothing to land on
        const now = { text: door.text(), rev: door.rev() };
        const merged = merge3(prev, now.text, doc);
        conflict ||= merged.conflicts > 0;
        const thread = comment.thread ?? comment.id;
        await door.submit({ ops: diffOps(now.text, merged.text), rev: now.rev, epoch: door.epoch(), id: newId('e'), reply: comment.id, thread, conflict: merged.conflicts > 0 }, who)
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
    const after = new Map(Object.entries(seen));
    try {
      for (const c of posts) {
        const { at } = await door.comment({ id: c.id, thread: c.thread, anchor: c.anchor ?? null, body: c.body, after: c.thread !== undefined ? after.get(c.thread) : undefined }, who);
        if (c.thread !== undefined && after.has(c.thread)) after.set(c.thread, at);
      }
    } catch (error) {
      console.error(`Could not post ${name}'s comments:`, error);
      return { comments: [], landed: 'Its comments were not posted' };
    }
    // The first thread on the whole doc a watcher opens is its watch thread.
    const opened = posts.find((c) => c.thread === undefined && !c.anchor);
    if (watcher && watching.get(buddyId) === watcher && opened && !(watcher.thread !== null && open.has(watcher.thread))) {
      watcher.thread = opened.id;
      keepWatching();
    }
    return { comments: posts.map((c) => c.id), landed: conflict ? 'Posted; where it collided with people, their lines stayed' : 'Posted' };
  }

  return {
    runner,
    /** Someone's change landed: `by` a buddy's id, or null for people (or outside). */
    changed(by) {
      changedAt.set(by, performance.now());
      if (by === null) {
        wakeOnPause();
        // A watcher's run on now saw the doc as it was: it ends, as looked,
        // and runs again once the edits pause.
        for (const { id, from } of runner.interrupt()) if (watching.has(id)) watching.get(id).looked = from;
      } else if (watching.size) runner.reconcile(); // at once: a buddy's edit lands whole
    },
    /** What is asked may have changed: look again. */
    look: () => runner.reconcile(),
    /** The buddies, or who may ask, may have changed: show who is here, and look again. */
    sync: () => syncAgents(),
    /** The agent, its settings or its secrets changed: the failed asks run again. */
    agentChanged: () => retryFailed(),
    statuses: () => agentStatuses(),
    steps: () => stepsView(),
    testAgent: async () => testAgent(await pickAgent()),
    calls: {
      watch: (body, who) => watch(body, who),
      refillSteps,
      retry: (body) => {
        if (typeof body?.buddy !== 'string') throw new DocError('bad_input', 'expected { buddy }');
        retryFailed(body.buddy);
        return {};
      },
    },
    async close() {
      clearTimeout(settling);
      clearTimeout(stepTimer);
      await runner.stop();
    },
  };
}
