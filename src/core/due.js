// Which of a doc's buddies are due to run now (docs/architecture.md, When a
// buddy runs), from the doc's threads and what the host noted, with no
// clock or file of its own: a look at any time finds the same.

import { askedBy } from './comments.js';
import { lineChanges } from './diff.js';

/** How long people's edits pause before a buddy watching runs on them (ms). */
export const SETTLE_MS = 5000;

/**
 * The buddies asked or watching now, each with its inbox, and every ask.
 * `buddies` those the doc reaches; `threads` its threads (threadsOf);
 * `askers` the ids whose comments ask and `taken` the comments this host
 * took (askedBy); `looked` buddy → Map(thread → the time of the last comment
 * its runs were given there), so a comment a run was given asks no more;
 * `watching` buddy → { by (who turned it on), thread (its watch thread, or
 * null), looked (when its last run started, or null: never), base (the doc
 * then, or null) }; `changedAt` who last changed the doc → when (null:
 * people); `text` the doc now; `now` the time, on the clock of `looked` and
 * `changedAt` (performance.now()).
 *
 * Returns { inboxes: [{ buddy, threads (that ask it, oldest first, then its
 * watch thread), askers (ids), asked (whether a comment asks it), watch
 * (null, or { thread, changes }), due, paid (whether only another buddy's
 * change has it due: it takes a step) }], asking (a Set of
 * `${buddy} ${thread}`, each ask, looked at or not) }. A watcher is due once
 * it was turned on, on people's changes since it last looked once they
 * pause, or on another buddy's at once; never on its own.
 */
export function whoIsDue({ buddies, threads, askers, taken, looked, watching, changedAt, text, now }) {
  const inboxes = new Map(); // buddy id → { threads, askers, asked, watch }
  const inboxOf = (id) => inboxes.get(id) ?? inboxes.set(id, { threads: [], askers: new Set(), asked: false, watch: null }).get(id);
  const asking = new Set();
  const open = new Map(threads.filter((t) => !t.resolved).map((t) => [t.id, t]));
  for (const thread of threads) {
    for (const [id, ask] of askedBy(thread, askers, taken)) {
      asking.add(`${id} ${thread.id}`);
      if (Date.parse(ask.at) <= (looked.get(id)?.get(thread.id) ?? -Infinity)) continue;
      const inbox = inboxOf(id);
      inbox.threads.push(thread);
      inbox.askers.add(ask.by.id);
      inbox.asked = true;
    }
  }
  for (const [id, w] of watching) {
    if (!buddies.some((b) => b.id === id) || !askers.includes(w.by)) continue;
    const inbox = inboxOf(id);
    const thread = w.thread !== null && open.has(w.thread) ? w.thread : null; // resolved or gone: it starts another
    if (thread !== null && !inbox.threads.some((t) => t.id === thread)) inbox.threads.push(open.get(thread));
    inbox.askers.add(w.by);
    let byPeople = w.looked === null;
    let byBuddy = false;
    for (const [by, at] of changedAt) {
      if (by === id || at <= w.looked) continue;
      if (by === null) byPeople ||= now - at >= SETTLE_MS;
      else byBuddy = true;
    }
    inbox.watch = { thread, changes: w.base === null ? null : lineChanges(w.base, text), due: byPeople || byBuddy, paid: !byPeople && byBuddy };
  }
  return {
    asking,
    inboxes: [...inboxes].map(([id, { threads: given, askers: by, asked, watch }]) => ({
      buddy: buddies.find((b) => b.id === id), threads: given, askers: [...by], asked,
      watch: watch && { thread: watch.thread, changes: watch.changes },
      due: asked || Boolean(watch?.due),
      paid: !asked && Boolean(watch?.paid),
    })).filter((inbox) => inbox.buddy), // a thread's opener may be gone
  };
}
