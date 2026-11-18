// The rules (docs/agent-runtime.md, How it decides): what a doc's buddies
// should be doing now, from the doc's threads and what this machine noted,
// with no clock or file of its own: a look at any time finds the same.

import { askedBy } from './comments.js';
import { lineChanges } from './diff.js';
import { nextStepAt, take } from './bucket.js';

/** How long people's edits pause before a buddy watching runs on them (ms). */
export const SETTLE_MS = 5000;

/**
 * What to start and stop now. `buddies` those the doc reaches; `threads`
 * its threads (threadsOf); `askers` the ids whose comments ask and `taken`
 * the comments this host took (askedBy); `notes` buddy → { seen (thread →
 * the time of the last comment its runs were given there), lookedAt (the
 * rev its last run started at, or null: look at once), base (the doc then,
 * or null), watch ({ by }, who turned it on, or null) }; `changedAt` who last
 * changed the doc's text → { rev, at (when, on the clock of `now`) }, people
 * as one (null); `running` the ids of the buddies running; `steps` the
 * bucket buddies wake each other from (bucket.js); `text` the doc now.
 *
 * Returns { start ([{ buddy, buddies, threads, askers, watch (null, or {
 * thread, changes }), watchOnly }]), stop (ids), steps (the bucket, less
 * those spent), wakeAt (when to look again, or null), asking (a Set of
 * `${buddy} ${thread}`, each ask, looked at or not) }.
 *
 * A comment asks a buddy until it comments after it, or a run was given it.
 * A watcher, while whoever turned it on may ask, is due once turned on, and
 * on another member's change since its last run started: people's once
 * they pause SETTLE_MS, a buddy's at once, for a step. Its own never counts.
 * Its watch thread is its oldest open thread on the whole doc.
 */
export function plan({ buddies, threads, askers, taken, notes, changedAt, running, steps, text, now }) {
  const noteOf = (id) => notes.get(id) ?? { seen: new Map(), lookedAt: null, base: null, watch: null };
  const tasks = new Map(); // buddy id → { threads, askers, asked, watch }
  const taskOf = (id) => tasks.get(id) ?? tasks.set(id, { threads: [], askers: new Set(), asked: false, watch: null }).get(id);
  const asking = new Set();
  let wakeAt = null;
  const soonest = (at) => { wakeAt = wakeAt === null ? at : Math.min(wakeAt, at); };
  for (const thread of threads) {
    for (const [id, ask] of askedBy(thread, askers, taken)) {
      asking.add(`${id} ${thread.id}`);
      if (Date.parse(ask.at) <= (noteOf(id).seen.get(thread.id) ?? -Infinity)) continue;
      const task = taskOf(id);
      task.threads.push(thread);
      task.askers.add(ask.by.id);
      task.asked = true;
    }
  }
  for (const [id, note] of notes) {
    if (!note.watch || !buddies.some((b) => b.id === id) || !askers.includes(note.watch.by)) continue;
    const task = taskOf(id);
    const own = threads.find((t) => !t.resolved && !t.anchor && t.comments[0]?.by.id === id);
    if (own && !task.threads.includes(own)) task.threads.push(own);
    task.askers.add(note.watch.by);
    let byPeople = note.lookedAt === null;
    let byBuddy = false;
    for (const [by, { rev, at }] of changedAt) {
      if (by === id || (note.lookedAt !== null && rev <= note.lookedAt)) continue;
      if (by !== null) byBuddy = true;
      else if (now - at >= SETTLE_MS) byPeople = true;
      else soonest(at + SETTLE_MS); // people still typing: look once they pause
    }
    task.watch = { thread: own?.id ?? null, changes: note.base === null ? null : lineChanges(note.base, text), due: byPeople || byBuddy, paid: !byPeople && byBuddy };
  }
  const start = [];
  for (const [id, task] of tasks) {
    const buddy = buddies.find((b) => b.id === id); // a thread's opener may be gone
    if (!buddy || running.has(id) || !(task.asked || task.watch?.due)) continue;
    if (!task.asked && task.watch.paid) { // woken by another buddy: a step, or wait for the next
      const step = take(steps, now);
      if (!step.ok) {
        const next = nextStepAt(steps);
        if (next !== null) soonest(next);
        continue;
      }
      steps = step.bucket;
    }
    start.push({ buddy, buddies, threads: task.threads, askers: [...task.askers], watch: task.watch && { thread: task.watch.thread, changes: task.watch.changes }, watchOnly: !task.asked && task.watch !== null });
  }
  const wanted = new Set([...tasks.keys()].filter((id) => buddies.some((b) => b.id === id)));
  return { start, stop: [...running].filter((id) => !wanted.has(id)), steps, wakeAt, asking };
}
