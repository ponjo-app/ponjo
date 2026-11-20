// The plan (src/core/due.js) decides as the plan before #431 did
// (test/fixtures/old-plan.js), on 10,000 random states of a doc: whom it
// starts and stops, what it spends, when it looks again, and why. The old
// one read the doc's threads and text; the new one is given the doc
// world's asks (asksIn), whose views hold what wakes them, and a watcher is
// told what is new (newSince) by its view. Here each watcher's view changed
// since it last looked, as the old plan took any change to mean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksIn } from '../src/core/comments.js';
import * as now from '../src/core/due.js';
import { newSince } from '../src/core/prompt.js';
import * as old from './fixtures/old-plan.js';

const BUDDIES = [{ id: 'b_ada', name: 'Ada' }, { id: 'b_ben', name: 'Ben' }, { id: 'b_cal', name: 'Cal' }];
const PEOPLE = ['u_me', 'u_tim', 'u_ro'];
const LINES = ['# Plan', 'We ship in week one.', 'GO', 'Risks.', ''];
const NOW = 100_000;
const T0 = Date.parse('2026-11-18T10:00:00.000Z');

// A random state of a doc and this machine's notes on it, from `rand()`.
function state(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const some = (list, p = 0.5) => list.filter(() => rand() < p);
  const buddies = BUDDIES.filter(() => rand() < 0.8);
  const members = [...PEOPLE, ...BUDDIES.map((b) => b.id), 'b_gone'];
  const askers = some(PEOPLE, 0.7);
  let at = T0;
  let count = 0;
  const threads = Array.from({ length: Math.floor(rand() * 4) }, () => {
    const comments = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => {
      at += 1 + Math.floor(rand() * 3) * 1000;
      const by = pick(members);
      return { id: `c_${++count}`, by: { id: by, name: by }, body: i > 0 && rand() < 0.1 ? '' : 'Text', at: new Date(at).toISOString(), mentions: some([...BUDDIES.map((b) => b.id), 'b_gone'], 0.3), ...(i > 0 && rand() < 0.1 ? { resolved: true } : {}) };
    });
    return { id: comments[0].id, anchor: null, resolved: comments.at(-1).resolved === true, comments };
  });
  const comments = threads.flatMap((t) => t.comments);
  const taken = new Set(some(comments.map((c) => c.id), 0.8));
  const relayed = new Map(some(comments.filter((c) => c.by.id.startsWith('b_')), 0.5).map((c) => [c.id, some(PEOPLE, 0.6)]));
  const times = comments.map((c) => Date.parse(c.at));
  const notes = new Map();
  for (const b of [...BUDDIES, { id: 'b_gone' }]) {
    if (rand() < 0.3) continue;
    notes.set(b.id, {
      seen: new Map(some(threads, 0.5).map((t) => [t.id, rand() < 0.5 ? pick(times) : Date.parse(t.comments.at(-1).at)])),
      lookedAt: rand() < 0.3 ? null : Math.floor(rand() * 10),
      base: rand() < 0.3 ? null : some(LINES, 0.6).join('\n'),
      heard: rand() < 0.3 ? null : new Set(some(comments.map((c) => c.id), 0.6)),
      wake: rand() < 0.7 ? null : some(LINES, 0.4),
      watch: rand() < 0.4 ? null : { by: pick(PEOPLE) },
      failed: new Map(),
    });
  }
  const changers = [null, 'outside', ...BUDDIES.map((b) => b.id), 'b_gone'];
  const changedAt = new Map(some(changers, 0.4).map((by) => [by, { rev: 1 + Math.floor(rand() * 12), at: NOW - Math.floor(rand() * 10_000) }]));
  return {
    buddies, threads, askers, taken, relayed, notes, changedAt,
    running: new Set(some([...BUDDIES.map((b) => b.id), 'b_gone'], 0.3)),
    steps: { left: rand() < 0.3 ? null : Math.floor(rand() * 4), cap: 3, every: rand() < 0.5 ? 0 : 60_000, at: NOW - Math.floor(rand() * 120_000) },
    text: `${some(LINES, 0.6).join('\n')}\n`,
  };
}

// What a plan starts, as the two can be compared: each run's agent, asks,
// askers, whether it watches, and what it is told is new.
const compared = (r, told) => ({
  start: r.start.map(({ w, ...t }) => ({ ...t, told: told({ ...t, w }) })), stop: r.stop, steps: r.steps, wakeAt: r.wakeAt, asking: [...r.asking], why: [...r.why],
});
const ids = (list) => list.map((x) => x.id);

// The old plan on state `s`.
function before(s) {
  const changedAt = new Map([...s.changedAt].map(([by, c]) => [by === 'outside' ? old.OUTSIDE : by, c]));
  const r = old.plan({ ...s, taken: (c) => s.taken.has(c.id), changedAt, now: NOW });
  return compared({ ...r, start: r.start.map((t) => ({ agent: t.buddy.id, asks: ids(t.threads), askers: t.askers, watch: t.watch !== null, watchOnly: t.watchOnly, w: t.watch })) },
    (t) => t.w && { changes: t.w.changes, threads: ids(t.w.threads) });
}

// The new plan on the same state, given what the doc world makes of it.
function after(s) {
  const changedAt = new Map([...s.changedAt].map(([by, c]) => [by === 'outside' ? now.OUTSIDE : by, c]));
  const lines = new Set(s.text.split(/\r?\n/));
  const woken = new Set([...s.notes].filter(([, n]) => n.wake?.some((l) => lines.has(l))).map(([id]) => id));
  const asks = asksIn(s.threads, s.askers, (c) => s.taken.has(c.id), s.relayed);
  const r = now.plan({ agents: s.buddies, asks, askers: s.askers, notes: s.notes, changedAt, running: s.running, steps: s.steps, prints: new Map(), woken, now: NOW });
  return compared({ ...r, start: r.start.map((t) => ({ agent: t.agent.id, asks: ids(t.asks), askers: t.askers, watch: t.watch, watchOnly: t.watchOnly })) }, (t) => {
    if (!t.watch) return null;
    const note = s.notes.get(t.agent);
    const told = newSince({ agent: t.agent, base: note.base, heard: note.heard, text: s.text, threads: s.threads });
    return { changes: told.changes, threads: ids(told.threads) };
  });
}

// A seeded random number generator (mulberry32): the same states each run.
function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the plan decides as the old one did, on 10,000 random states', () => {
  const rand = random(431);
  let started = 0;
  for (let i = 0; i < 10_000; i++) {
    const s = state(rand);
    const got = after(s);
    assert.deepEqual(got, before(s), `state ${i}`);
    started += got.start.length;
  }
  assert.ok(started > 2000, `the states start runs often enough to tell (${started})`);
});
