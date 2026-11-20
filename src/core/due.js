// The rules (docs/agent-runtime.md, How it decides): what a doc's buddies
// should be doing now, from the doc's threads and what this machine noted,
// with no clock or file of its own: a look at any time finds the same.

import { askedBy } from './comments.js';
import { lineChanges } from './diff.js';
import { nextStepAt, take } from './bucket.js';

/** How long people's edits pause before a buddy watching runs on them (ms). */
export const SETTLE_MS = 5000;

/** Who made a change found on disk (another program), in `changedAt`. */
export const OUTSIDE = Symbol('outside');

/**
 * What to start and stop now. `buddies` those the doc reaches; `threads`
 * its threads (threadsOf); `askers` the ids whose comments ask and `taken`
 * the comments this host took (askedBy); `relayed` the comments a run here
 * posted → the people that run was for, whose @mentions ask for a step;
 * `notes` buddy → { seen (thread → the time of the last comment its runs
 * were given there), lookedAt (the
 * rev its last run started at, or null: look at once), base (the doc then,
 * or null), heard (the ids of the comments then, a Set, or null), wake (the
 * lines of the doc its last run said wake it, or null: any), watch ({
 * by }, who turned it on, or null) }; `changedAt` who last
 * changed the doc's text → { rev, at (when, on the clock of `now`) }, people
 * as one (null), another program writing the file as OUTSIDE; `running`
 * the ids of the buddies running; `steps` the bucket buddies wake each other from (bucket.js); `text` the doc now.
 *
 * Returns { start ([{ buddy, buddies, threads, askers, watch (null, or {
 * changes, threads (the open ones with another member's comment since it
 * last looked), heard (the ids of the comments now) }), watchOnly }]),
 * stop (ids), steps (the bucket, less
 * those spent), wakeAt (when to look again, or null), asking (a Set of
 * `${buddy} ${thread}`, each ask, looked at or not), why (buddy id → why it
 * starts or not, in words: the agent log's) }.
 *
 * A comment asks a buddy until it comments after it, or a run was given it.
 * A buddy's (relayed) asks for a step, as the people its run was for, while
 * one of them may ask.
 * A watcher, while whoever turned it on may ask, is due once turned on, and
 * on another member's change since its last run started: people's once
 * they pause SETTLE_MS, a file written outside at once (it is whole: the
 * door took it once it held still), a buddy's once its run ended (so the
 * watcher sees the comment that came with it), for a step. Its own never
 * counts. One whose last run named lines to wake it is due only while the
 * doc holds one.
 */
export function plan({ buddies, threads, askers, taken, relayed = new Map(), notes, changedAt, running, steps, text, now }) {
  const noteOf = (id) => notes.get(id) ?? { seen: new Map(), lookedAt: null, base: null, heard: null, wake: null, watch: null };
  const lines = new Set(text.split(/?
/));
  const heard = new Set(threads.flatMap((t) => t.comments.map((c) => c.id)));
  const tasks = new Map(); // buddy id → { threads, askers, asked, watch }
  const taskOf = (id) => tasks.get(id) ?? tasks.set(id, { threads: [], askers: new Set(), asked: false, relayed: false, watch: null }).get(id);
  const asking = new Set();
  const why = new Map();
  const nameOf = (by) => (by === null ? 'people' : by === OUTSIDE ? 'outside the app' : buddies.find((b) => b.id === by)?.name ?? by);
  let wakeAt = null;
  const soonest = (at) => { wakeAt = wakeAt === null ? at : Math.min(wakeAt, at); };
  for (const thread of threads) {
    for (const [id, ask] of askedBy(thread, askers, taken, relayed)) {
      const via = relayed.get(ask.id)?.filter((p) => askers.includes(p)) ?? [ask.by.id];
      if (!via.length) continue; // the people a buddy asked for may no longer ask
      asking.add(`${id} ${thread.id}`);
      if (Date.parse(ask.at) <= (noteOf(id).seen.get(thread.id) ?? -Infinity)) continue;
      const task = taskOf(id);
      task.threads.push(thread);
      for (const p of via) task.askers.add(p);
      if (relayed.has(ask.id)) task.relayed = true;
      else task.asked = true;
    }
  }
  for (const [id, note] of notes) {
    if (!note.watch || !buddies.some((b) => b.id === id)) continue;
    if (!askers.includes(note.watch.by)) {
      why.set(id, 'not due: whoever turned on its watch may not ask');
      continue;
    }
    const task = taskOf(id);
    task.askers.add(note.watch.by);
    let byPeople = note.lookedAt === null;
    let byBuddy = false;
    const changed = [];
    for (const [by, { rev, at }] of changedAt) {
      if (note.lookedAt !== null && rev <= note.lookedAt) continue;
      if (by === id) {
        changed.push(`itself at rev ${rev}, which does not count`);
        continue;
      }
      const buddy = by !== null && by !== OUTSIDE;
      // A buddy's counts once its run has landed, the comment with the edit.
      if (by === OUTSIDE) byPeople = true;
      else if (buddy && !running.has(by)) byBuddy = true;
      else if (by === null && now - at >= SETTLE_MS) byPeople = true;
      else if (by === null) soonest(at + SETTLE_MS); // people still typing: look once they pause
      changed.push(`${nameOf(by)} at rev ${rev}${by === null && now - at < SETTLE_MS ? ', still typing' : ''}${buddy && running.has(by) ? ', still landing' : ''}`);
    }
    let since = note.lookedAt === null ? 'its first look' : changed.length ? `changed by ${changed.join(', ')}, after its look at rev ${note.lookedAt}` : `no change since its look at rev ${note.lookedAt}`;
    // Its last run said which lines wake it: not before the doc holds one.
    if (note.lookedAt !== null && note.wake && !note.wake.some((l) => lines.has(l))) {
      if (byPeople || byBuddy) since += ', but the doc holds no line that wakes it';
      byPeople = false;
      byBuddy = false;
    }
    // What members said since it looked, as what they wrote: its own words it knows.
    const said = note.heard === null ? [] : threads.filter((t) => !t.resolved && t.comments.some((c) => c.by.id !== id && !note.heard.has(c.id)));
    task.watch = { changes: note.base === null ? null : lineChanges(note.base, text), threads: said, heard, due: byPeople || byBuddy, paid: !byPeople && byBuddy, since };
  }
  const start = [];
  for (const [id, task] of tasks) {
    const buddy = buddies.find((b) => b.id === id); // a thread's opener may be gone
    if (!buddy) continue;
    const asked = task.asked || task.relayed;
    const reason = asked ? `asked in ${task.threads.map((t) => t.id).join(', ')}${task.asked ? '' : ' by a buddy'}` : task.watch.since;
    if (running.has(id)) {
      why.set(id, `not due: already running (${reason})`);
      continue;
    }
    if (!(asked || task.watch.due)) {
      why.set(id, `not due: ${reason}`);
      continue;
    }
    if (!task.asked && (task.relayed || task.watch.paid)) { // woken by another buddy: a step, or wait for the next
      const step = take(steps, now);
      if (!step.ok) {
        const next = nextStepAt(steps);
        if (next !== null) soonest(next);
        why.set(id, `not due: ${reason}, but no step is left${next === null ? '' : `, the next in ${Math.ceil((next - now) / 1000)} s`}`);
        continue;
      }
      steps = step.bucket;
      why.set(id, `due: ${reason} · a step taken, ${steps.left} left`);
    } else why.set(id, `due: ${reason}`);
    start.push({ buddy, buddies, threads: task.threads, askers: [...task.askers], watch: task.watch && { changes: task.watch.changes, threads: task.watch.threads, heard }, watchOnly: !asked && task.watch !== null });
  }
  const wanted = new Set([...tasks.keys()].filter((id) => buddies.some((b) => b.id === id)));
  const stop = [...running].filter((id) => !wanted.has(id));
  for (const id of stop) why.set(id, 'stopped: nothing asks it now');
  for (const b of buddies) if (!why.has(b.id)) why.set(b.id, 'not due: no ask, not watching');
  return { start, stop, steps, wakeAt, asking, why };
}
