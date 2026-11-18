// Who is due to run (src/core/due.js) and the steps buddies have to wake
// each other (src/core/bucket.js): pure, so each case is a time and the
// host's notes, with no agent and no waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTLE_MS, whoIsDue } from '../src/core/due.js';
import { filled, nextStepAt, refilled, take } from '../src/core/bucket.js';

const ME = 'u_me000001';
const buddies = [{ id: 'b_ada', name: 'Ada' }, { id: 'b_ben', name: 'Ben' }];
const say = (by, body, at, mentions = []) => ({ by: { id: by }, body, at, mentions });
const thread = (id, comments, resolved = false) => ({ id, resolved, comments });
const look = (over = {}) => whoIsDue({ buddies, threads: [], askers: [ME], taken: () => true, looked: new Map(), watching: new Map(), changedAt: new Map(), text: 'Text.\n', now: 100_000, ...over });
const due = (result) => result.inboxes.filter((i) => i.due).map((i) => [i.buddy.id, i.paid]);

test('a person\'s comment asks the buddy it names until the buddy comments after it, or a run was given it', () => {
  const asked = thread('c_1', [say(ME, '@Ada look', '2026-11-18T10:00:00.000Z', ['b_ada'])]);
  const { inboxes, asking } = look({ threads: [asked] });
  assert.deepEqual(inboxes.map((i) => [i.buddy.id, i.asked, i.due, i.paid, i.threads.map((t) => t.id), i.askers]), [['b_ada', true, true, false, ['c_1'], [ME]]]);
  assert.deepEqual([...asking], ['b_ada c_1']);

  const answered = thread('c_1', [...asked.comments, say('b_ada', 'Done.', '2026-11-18T10:00:05.000Z')]);
  assert.deepEqual(look({ threads: [answered] }).inboxes, []);

  const given = look({ threads: [asked], looked: new Map([['b_ada', new Map([['c_1', Date.parse('2026-11-18T10:00:00.000Z')]])]]) });
  assert.deepEqual(given.inboxes, [], 'a run was given it');
  assert.deepEqual([...given.asking], ['b_ada c_1'], 'yet it still asks: its failure stays shown');
});

test('a watcher is due once turned on, on people\'s changes once they pause, and on another buddy\'s at once for a step; never on its own', () => {
  const watching = (looked) => new Map([['b_ada', { by: ME, thread: null, looked, base: null }]]);
  assert.deepEqual(due(look({ watching: watching(null) })), [['b_ada', false]], 'turned on: it looks at once');
  assert.deepEqual(due(look({ watching: watching(50_000) })), [], 'no change since it looked');

  const people = new Map([[null, 98_000]]);
  assert.deepEqual(due(look({ watching: watching(50_000), changedAt: people })), [], 'people still typing');
  assert.deepEqual(due(look({ watching: watching(50_000), changedAt: people, now: 98_000 + SETTLE_MS })), [['b_ada', false]], 'their pause: free');
  assert.deepEqual(due(look({ watching: watching(99_000), changedAt: people, now: 98_000 + SETTLE_MS })), [], 'a run since saw them');

  assert.deepEqual(due(look({ watching: watching(50_000), changedAt: new Map([['b_ben', 99_000]]) })), [['b_ada', true]], 'another buddy: at once, for a step');
  assert.deepEqual(due(look({ watching: watching(50_000), changedAt: new Map([['b_ada', 99_000]]) })), [], 'its own change');
  assert.deepEqual(due(look({ watching: watching(50_000), changedAt: new Map([['b_ben', 99_000], [null, 90_000]]) })), [['b_ada', false]], 'people\'s pause too: free');
});

test('a watcher is in only while whoever turned it on may ask, with its watch thread while open and what changed since it looked', () => {
  const w = (over) => new Map([['b_ada', { by: ME, thread: 'c_w', looked: 50_000, base: 'Text.\n', ...over }]]);
  const open = thread('c_w', [say('b_ada', 'Watching.', '2026-11-18T10:00:00.000Z')]);
  const [inbox] = look({ watching: w(), threads: [open], text: 'Text.\nMore.\n' }).inboxes;
  assert.deepEqual([inbox.due, inbox.asked, inbox.watch.thread, inbox.threads.map((t) => t.id), inbox.askers], [false, false, 'c_w', ['c_w'], [ME]]);
  assert.deepEqual(inbox.watch.changes, [{ before: '', after: 'More.\n' }]);
  assert.equal(look({ watching: w(), threads: [{ ...open, resolved: true }] }).inboxes[0].watch.thread, null, 'resolved: it starts another');
  assert.deepEqual(look({ watching: w({ by: 'u_gone00001' }) }).inboxes, [], 'turned on by one who may no longer ask');
  assert.deepEqual(look({ watching: new Map([['b_gone', { by: ME, thread: null, looked: null, base: null }]]) }).inboxes, [], 'a buddy no longer here');
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
