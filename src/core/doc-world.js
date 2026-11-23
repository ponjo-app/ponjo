// The doc as a world (docs/app/worlds/doc.md): its tasks from the state
// alone, and what a change by a buddy, a person or the clock does to the
// part of the state the door does not keep. Pure: the doc's store
// (src/host/doc-store.js) gives the state, and wraps it in the ledger.
//
// State { text, lines, threads, problem, hash, members, taken, posted, watches, typed, settled, n }
// `text` and `lines` the doc and its sidecar's lines, `threads` theirs
// (threadsOf), `problem` why the sidecar may not be written, `hash` the
// text's fingerprint; `members` { owner, people: [{ id, name, level }],
// buddies }; `taken` the ids of the comments the door took, `posted` the
// comments runs here posted → { for, depth }; `watches` buddy → Watch;
// `typed` { at, n } when people last changed the text, `settled` the `n` of
// the typing the clock last settled; `n` counts the changes, so a watch set
// off again is a new task.
// Watch { by, seen (the hash its last run saw, or null), since (null, or
// { depth (least of the changes since), n }), wake (lines, or null) }

import { asksOf } from './comments.js';

/** The clock, the member whose task is to settle people's typing. */
export const CLOCK = 'clock';
/** How long people's edits pause before a buddy watching runs on them (ms). */
export const SETTLE_MS = 5000;

const askersOf = (s) => [s.members.owner.id, ...s.members.people.filter((p) => p.level === 'write').map((p) => p.id)];
const settling = (s) => s.typed !== null && s.settled !== s.typed.n;
const lower = (w, depth, n) => ({ ...w, since: w.since ? { ...w.since, depth: Math.min(w.since.depth, depth) } : { depth, n } });

// Buddy `id`'s asks: one per thread that asks it, `given` the first comment
// there that asks it since its last (`at` when), `from` whom they were for,
// while each of them may still ask; `until` the thread's latest comment.
function asks(s, id) {
  const askers = askersOf(s);
  const relayed = new Set(Object.keys(s.posted));
  return s.threads.flatMap((thread) => {
    const asking = asksOf(thread, askers, (c) => s.taken.has(c.id), relayed).get(id);
    if (!asking) return [];
    const from = [...new Set(asking.flatMap((c) => s.posted[c.id]?.for ?? [c.by.id]))];
    if (!from.every((p) => askers.includes(p))) return [];
    const depth = Math.min(...asking.map((c) => (s.posted[c.id] ? s.posted[c.id].depth + 1 : 0)));
    return [{ given: asking[0].id, as: id, kind: 'ask', from, depth, thread: thread.id, at: asking[0].at, until: thread.comments.at(-1).at, why: `asked in ${thread.id}${depth ? ' by an agent' : ''}` }];
  });
}

// Buddy `id`'s watch, while it is set off, people are not typing, the text
// is not what its last run saw, and holds a line that wakes it if it named any.
function watched(s, id) {
  const w = s.watches[id];
  if (!w?.since || !askersOf(s).includes(w.by) || settling(s) || s.hash === w.seen) return [];
  if (w.wake && !s.text.split(/\r?\n/).some((line) => w.wake.includes(line))) return [];
  return [{ given: `watch ${w.since.n}`, as: id, kind: 'watch', from: [w.by], depth: w.since.depth, why: w.seen === null ? 'its first look' : 'its watch: the doc changed' }];
}

function tasks(s, member) {
  if (member === CLOCK) return settling(s) ? [{ given: `settle ${s.typed.n}`, as: CLOCK, kind: 'turn', from: [], depth: 0, at: s.typed.at + SETTLE_MS, why: 'people to pause' }] : [];
  if (s.problem || !s.members.buddies.some((b) => b.id === member)) return [];
  return [...asks(s, member), ...watched(s, member)];
}

/**
 * The state once the door landed a change of its own accord, by `kind`
 * ('person', 'outside' or 'buddy') at `at`, `text` whether it changed the
 * text: each watch is set off, at depth 0, and a person's typing is to settle.
 * `s` needs only the door's own part: watches, typed, n.
 */
export function noted(s, { kind, text, at }) {
  if (!text || kind === 'buddy') return s;
  const n = s.n + 1;
  return { ...s, n, watches: Object.fromEntries(Object.entries(s.watches).map(([id, w]) => [id, lower(w, 0, n)])), ...(kind === 'person' ? { typed: { at, n } } : {}) };
}

export const docWorld = {
  view: (s, member) => ({
    content: { text: s.text, lines: s.lines, threads: s.threads, watch: Boolean(s.watches[member]) },
    actions: [],
    tasks: tasks(s, member),
    seen: [s.members.owner.id, ...s.members.people.map((p) => p.id), ...s.members.buddies.map((b) => b.id)],
    rules: '',
  }),

  /**
   * A change the door does not land of its own accord:
   * - the clock's, answering `settle <n>`: the typing is settled, unless it went on;
   * - a person's `{ type: 'watch', buddy, on }`, `{ type: 'resume' }` (each
   *   watch whose text changed since its last run looks again) and
   *   `{ type: 'retry', buddies }` (their watches look again);
   * - a buddy's `{ type: 'landed', base, before, after, posted, from, depth,
   *   wake, failed }`, once its run landed through the door: the hash of the
   *   text it was given (null: none), around its landing, the ids of the
   *   comments it posted, for whom and how deep; with `refused`, why the door
   *   did not take it. Each other watch is set off a step deeper; its own
   *   moves on.
   */
  apply(s, { by, as, answers = [], body }) {
    const n = s.n + 1;
    if (by === CLOCK) return s.typed && answers.includes(`settle ${s.typed.n}`) ? { state: { ...s, settled: s.typed.n }, effects: [] } : { refused: 'People typed again.' };
    if (body?.type === 'landed') {
      if (as !== by) return { refused: 'A run lands as its own buddy.' };
      if (body.refused) return { refused: body.refused }; // the door did not take it
      const watches = { ...s.watches };
      if (body.before !== body.after) for (const [id, w] of Object.entries(watches)) if (id !== by) watches[id] = lower(w, body.depth + 1, n);
      const own = watches[by];
      if (own && (body.base !== null || answers.includes(`watch ${own.since?.n}`))) {
        const saw = body.base !== null && body.base === body.before;
        watches[by] = { ...own, seen: body.base === null ? own.seen : saw ? body.after : body.base, since: saw || !own.since || body.base === null ? null : { ...own.since, n }, wake: body.failed ? null : body.wake ?? null };
      }
      const posted = { ...s.posted, ...Object.fromEntries(body.posted.map((id) => [id, { for: body.from, depth: body.depth }])) };
      return { state: { ...s, n, watches, posted }, effects: [] };
    }
    if (!askersOf(s).includes(by)) return { refused: 'Only a person who may write changes the watches.' };
    if (body?.type === 'watch') {
      if (!s.members.buddies.some((b) => b.id === body.buddy)) return { refused: 'No such buddy here.' };
      const { [body.buddy]: was, ...watches } = s.watches;
      return { state: { ...s, n, watches: body.on ? { ...watches, [body.buddy]: was ?? { by, seen: null, since: { depth: 0, n }, wake: null } } : watches }, effects: [] };
    }
    const again = body?.type === 'resume' ? (w) => w.seen !== s.hash : body?.type === 'retry' ? (w, id) => body.buddies.includes(id) : null;
    if (!again) return { refused: 'Not a change of the doc\'s.' };
    const watches = Object.fromEntries(Object.entries(s.watches).map(([id, w]) => [id, again(w, id) ? { ...w, ...(body.type === 'retry' ? { seen: null } : {}), since: { depth: 0, n } } : w]));
    return { state: { ...s, n, watches }, effects: [] };
  },

  // An ask or a watch past its tries is gone; the clock's turn, settled.
  fallback: (s, task) => (task.as === CLOCK ? { ...s, settled: s.typed?.n ?? null } : s),
  tries: 3,
};
