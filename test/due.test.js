// What a doc's buddies should do now (src/core/due.js, plan) and the steps
// they have to wake each other (src/core/bucket.js): pure, so each case is
// a time and the host's notes, with no agent and no waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTLE_MS, plan } from '../src/core/due.js';
import { filled, nextStepAt, refilled, take } from '../src/core/bucket.js';

const ME = 'u_me000001';
const buddies = [{ id: 'b_ada', name: 'Ada' }, { id: 'b_ben', name: 'Ben' }];
const say = (by, body, at, mentions = []) => ({ by: { id: by }, body, at, mentions });
const thread = (id, comments, resolved = false) => ({ id, resolved, anchor: null, comments });
const full = { left: 3, cap: 3, every: 60_000, at: 0 };
const note = (over = {}) => ({ seen: new Map(), lookedAt: null, base: null, watch: null, ...over });
const look = (over = {}) => plan({ buddies, threads: [], askers: [ME], taken: () => true, notes: new Map(), changedAt: new Map(), running: new Set(), steps: full, text: 'Text.\n', now: 100_000, ...over });
const started = (result) => result.start.map((t) => t.buddy.id);
const watching = (lookedAt, over = {}) => new Map([['b_ada', note({ watch: { by: ME }, lookedAt, ...over })]]);

test('a person\'s comment asks the buddy it names until the buddy comments after it, or a run was given it', () => {
  const asked = thread('c_1', [say(ME, '@Ada look', '2026-11-18T10:00:00.000Z', ['b_ada'])]);
  const result = look({ threads: [asked] });
  assert.deepEqual(result.start.map((t) => [t.buddy.id, t.threads.map((x) => x.id), t.askers, t.watchOnly]), [['b_ada', ['c_1'], [ME], false]]);
  assert.deepEqual([...result.asking], ['b_ada c_1']);
  assert.deepEqual(started(look({ threads: [thread('c_1', [...asked.comments, say('b_ada', 'Done.', '2026-11-18T10:00:05.000Z')])] })), []);
  const given = look({ threads: [asked], notes: new Map([['b_ada', note({ seen: new Map([['c_1', Date.parse('2026-11-18T10:00:00.000Z')]]) })]]) });
  assert.deepEqual(started(given), [], 'a run was given it');
  assert.deepEqual([...given.asking], ['b_ada c_1'], 'yet it still asks: its failure stays shown');
  assert.deepEqual(started(look({ threads: [asked], running: new Set(['b_ada']) })), [], 'one run at a time');
});

test('a watcher is due once turned on, on people\'s changes once they pause, and on another buddy\'s at once for a step; never on its own', () => {
  assert.deepEqual(started(look({ notes: watching(null) })), ['b_ada'], 'turned on: it looks at once');
  assert.deepEqual(started(look({ notes: watching(5) })), [], 'no change since it looked');

  const people = new Map([[null, { rev: 7, at: 98_000 }]]);
  const typing = look({ notes: watching(5), changedAt: people });
  assert.deepEqual([started(typing), typing.wakeAt], [[], 98_000 + SETTLE_MS], 'people still typing: look once they pause');
  const paused = look({ notes: watching(5), changedAt: people, now: 98_000 + SETTLE_MS });
  assert.deepEqual([started(paused), paused.steps.left], [['b_ada'], 3], 'their pause: free');
  assert.deepEqual(started(look({ notes: watching(7), changedAt: people, now: 98_000 + SETTLE_MS })), [], 'a run since saw them');

  const buddy = look({ notes: watching(5), changedAt: new Map([['b_ben', { rev: 7, at: 99_000 }]]) });
  assert.deepEqual([started(buddy), buddy.steps.left], [['b_ada'], 2], 'another buddy: at once, for a step');
  assert.deepEqual(started(look({ notes: watching(5), changedAt: new Map([['b_ada', { rev: 7, at: 99_000 }]]) })), [], 'its own change');
  const none = look({ notes: watching(5), changedAt: new Map([['b_ben', { rev: 7, at: 99_000 }]]), steps: { ...full, left: 0, at: 90_000 } });
  assert.deepEqual([started(none), none.wakeAt], [[], 150_000], 'no step left: look when the next comes');
});

test('a watcher is in only while whoever turned it on may ask, told what changed, given only the threads that ask it; a run nothing wants is stopped', () => {
  const its = thread('c_w', [say('b_ada', 'Watching.', '2026-11-18T10:00:00.000Z')]);
  const [task] = look({ notes: watching(null, { base: 'Text.\n' }), threads: [its], text: 'Text.\nMore.\n' }).start;
  assert.deepEqual([task.threads, task.askers, task.watchOnly], [[], [ME], true], 'it reads every thread in the comments itself');
  assert.deepEqual(task.watch, { changes: [{ before: '', after: 'More.\n' }] });
  const gone = look({ notes: watching(null, { watch: { by: 'u_gone00001' } }), running: new Set(['b_ada', 'b_ben']) });
  assert.deepEqual([started(gone), gone.stop], [[], ['b_ada', 'b_ben']], 'nothing wants them');
});

test('steps: one gained every `every` up to the cap, taken one at a time, none on their own with every 0, all on Refill', () => {
  let b = refilled({ left: null, cap: 20, every: 60_000, at: 0 }, { cap: 3, every: 1000 }, 0);
  assert.deepEqual([b.left, nextStepAt(b)], [3, null], 'full at first, the cap the settings give');
  for (let i = 0; i < 3; i++) ({ bucket: b } = take(b, 100));
  assert.deepEqual([b.left, nextStepAt(b)], [0, 1100], 'the time counts from the first step taken while full');
  assert.equal(take(b, 200).ok, false);
  b = refilled(b, { cap: 3, every: 1000 }, 2500);
  assert.deepEqual([b.left, nextStepAt(b)], [2, 3100], 'two gained, the part of the third kept');
  b = refilled(b, { cap: 3, every: 1000 }, 9000);
  assert.deepEqual([b.left, nextStepAt(b)], [3, null], 'no more than the cap');
  assert.equal(refilled({ ...b, left: 3 }, { cap: 1, every: 1000 }, 9000).left, 1, 'a smaller cap cuts it');

  let none = refilled({ left: 0, cap: 3, every: 0, at: 0 }, { cap: 3, every: 0 }, 1e9);
  assert.deepEqual([none.left, nextStepAt(none)], [0, null], 'every 0: none come on their own');
  none = filled(none, 1e9);
  assert.equal(none.left, 3);
});
