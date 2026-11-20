// What a doc's buddies should do now (src/core/due.js, plan, given the
// doc's asks as its world finds them, asksIn), what a watcher is told is new
// (newSince), and how deep agents wake each other: pure, so each case is a
// time and the host's notes, with no agent and no waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksIn } from '../src/core/comments.js';
import { OUTSIDE, SETTLE_MS, plan } from '../src/core/due.js';
import { newSince } from '../src/core/prompt.js';

const ME = 'u_me000001';
const buddies = [{ id: 'b_ada', name: 'Ada' }, { id: 'b_ben', name: 'Ben' }];
const say = (by, body, at, mentions = []) => ({ by: { id: by }, body, at, mentions });
const thread = (id, comments, resolved = false) => ({ id, resolved, anchor: null, comments });
const note = (over = {}) => ({ seen: new Map(), lookedAt: null, watch: null, ...over });
// The plan on a doc holding `threads` and `text`: its asks (asksIn; each
// of `relayed`, a comment a run here posted → the people it was for, at
// that run's `depth`), and the watchers whose wake lines the text holds, whole.
function look(over = {}) {
  const s = { threads: [], askers: [ME], taken: () => true, relayed: new Map(), depth: 0, notes: new Map(), changedAt: new Map(), running: new Set(), limit: 1000, paused: false, text: 'Text.\n', now: 100_000, ...over };
  const posted = new Map([...s.relayed].map(([id, people]) => [id, { for: people, depth: s.depth }]));
  const lines = new Set(s.text.split(/\r?\n/));
  const woken = new Set([...s.notes].filter(([, n]) => n.wake?.some((l) => lines.has(l))).map(([id]) => id));
  return plan({ agents: buddies, asks: asksIn(s.threads, s.askers, s.taken, posted), askers: s.askers, notes: s.notes, changedAt: s.changedAt, running: s.running, limit: s.limit, paused: s.paused, prints: s.prints ?? new Map(), woken, now: s.now });
}
const started = (result) => result.start.map((t) => t.agent.id);
const watching = (lookedAt, over = {}) => new Map([['b_ada', note({ watch: { by: ME }, lookedAt, ...over })]]);

test('a person\'s comment asks the buddy it names until the buddy comments after it, or a run was given it', () => {
  const asked = thread('c_1', [say(ME, '@Ada look', '2026-11-18T10:00:00.000Z', ['b_ada'])]);
  const result = look({ threads: [asked] });
  assert.deepEqual(result.start.map((t) => [t.agent.id, t.asks.map((x) => x.id), t.askers, t.watchOnly]), [['b_ada', ['c_1'], [ME], false]]);
  assert.deepEqual([...result.asking], ['b_ada c_1']);
  assert.deepEqual(started(look({ threads: [thread('c_1', [...asked.comments, say('b_ada', 'Done.', '2026-11-18T10:00:05.000Z')])] })), []);
  const given = look({ threads: [asked], notes: new Map([['b_ada', note({ seen: new Map([['c_1', Date.parse('2026-11-18T10:00:00.000Z')]]) })]]) });
  assert.deepEqual(started(given), [], 'a run was given it');
  assert.deepEqual([...given.asking], ['b_ada c_1'], 'yet it still asks: its failure stays shown');
  assert.deepEqual(started(look({ threads: [asked], running: new Set(['b_ada']) })), [], 'one run at a time');
});

test('a buddy\'s comment posted by a run here asks the buddies it @mentions, a step deeper than that run, as the people it was for', () => {
  const said = (id, by, body, at, mentions = []) => ({ ...say(by, body, at, mentions), id });
  const handed = thread('c_1', [said('c_1', ME, '@Ada start', '2026-11-18T10:00:00.000Z', ['b_ada']), said('c_2', 'b_ada', '@Ben your turn', '2026-11-18T10:00:05.000Z', ['b_ben'])]);
  const relayed = new Map([['c_2', [ME]]]);
  const result = look({ threads: [handed], relayed });
  assert.deepEqual(result.start.map((t) => [t.agent.id, t.asks.map((x) => x.id), t.askers, t.watchOnly]), [['b_ben', ['c_1'], [ME], false]]);
  assert.equal(result.start[0].depth, 1, 'one deeper than the run a person asked');
  assert.equal(result.why.get('b_ben'), 'due: asked in c_1 by an agent · depth 1');
  assert.equal(look({ threads: [handed], relayed, depth: 7 }).start[0].depth, 8);
  assert.deepEqual(started(look({ threads: [handed] })), [], 'a buddy\'s comment found in the file asks no one');
  assert.deepEqual(started(look({ threads: [handed], relayed: new Map([['c_2', ['u_gone00001']]]) })), [], 'not once the people it was for may not ask');
  const none = look({ threads: [handed], relayed, depth: 3, limit: 3 });
  assert.deepEqual([started(none), none.why.get('b_ben')], [[], 'not due: asked in c_1 by an agent, but at the depth limit (3)'], 'the chain stops at the limit');
  assert.deepEqual([...none.asking], ['b_ben c_1'], 'it still asks');
  const plain = thread('c_1', [said('c_1', ME, '@Ada start', '2026-11-18T10:00:00.000Z', ['b_ada']), said('c_2', 'b_ada', 'Done, and @Ada it is', '2026-11-18T10:00:05.000Z', ['b_ada'])]);
  assert.deepEqual(started(look({ threads: [plain], relayed })), [], 'never itself, and one that names no other asks no one');
  const answered = thread('c_1', [...handed.comments, said('c_3', 'b_ben', 'Done.', '2026-11-18T10:00:09.000Z')]);
  assert.deepEqual(started(look({ threads: [answered], relayed })), [], 'its reply answers it');
});

test('it says why each buddy starts or not, for the agent log', () => {
  const why = (over) => Object.fromEntries(look(over).why);
  const asked = thread('c_1', [say(ME, '@Ada look', '2026-11-18T10:00:00.000Z', ['b_ada'])]);
  assert.deepEqual(why({ threads: [asked] }), { b_ada: 'due: asked in c_1', b_ben: 'not due: no ask, not watching' });
  assert.equal(why({ threads: [asked], running: new Set(['b_ada']) }).b_ada, 'not due: already running (asked in c_1)');
  assert.equal(why({ notes: watching(null) }).b_ada, 'due: its first look');
  assert.equal(why({ notes: watching(5) }).b_ada, 'not due: no change since its look at rev 5');
  assert.equal(why({ notes: watching(5), changedAt: new Map([[null, { rev: 7, at: 98_000 }]]) }).b_ada, 'not due: changed by people at rev 7, still typing, after its look at rev 5');
  assert.equal(why({ notes: watching(5), changedAt: new Map([['b_ada', { rev: 7, at: 0 }]]) }).b_ada, 'not due: changed by itself at rev 7, which does not count, after its look at rev 5');
  const ben = new Map([['b_ben', { rev: 7, at: 99_000 }]]);
  assert.equal(why({ notes: watching(5), changedAt: ben }).b_ada, 'due: changed by Ben at rev 7, after its look at rev 5 · depth 1');
  assert.equal(why({ notes: watching(5), changedAt: ben, running: new Set(['b_ben']) }).b_ada, 'not due: changed by Ben at rev 7, still landing, after its look at rev 5');
  assert.equal(why({ notes: watching(5), changedAt: new Map([['b_ben', { rev: 7, at: 99_000, depth: 1000 }]]) }).b_ada, 'not due: changed by Ben at rev 7, after its look at rev 5, but at the depth limit (1000)');
  assert.equal(why({ notes: watching(5), changedAt: ben, paused: true }).b_ada, 'not due: changed by Ben at rev 7, after its look at rev 5, but watches are paused');
  assert.equal(why({ notes: watching(5, { watch: { by: 'u_gone00001' } }) }).b_ada, 'not due: whoever turned on its watch may not ask');
  assert.equal(why({ running: new Set(['b_ada']) }).b_ada, 'stopped: nothing asks it now');
});

test('a watcher is due once turned on, on people\'s changes once they pause, and on another buddy\'s at once, a step deeper; never on its own', () => {
  assert.deepEqual(started(look({ notes: watching(null) })), ['b_ada'], 'turned on: it looks at once');
  assert.deepEqual(started(look({ notes: watching(5) })), [], 'no change since it looked');

  const people = new Map([[null, { rev: 7, at: 98_000 }]]);
  const typing = look({ notes: watching(5), changedAt: people });
  assert.deepEqual([started(typing), typing.wakeAt], [[], 98_000 + SETTLE_MS], 'people still typing: look once they pause');
  const paused = look({ notes: watching(5), changedAt: people, now: 98_000 + SETTLE_MS });
  assert.deepEqual([started(paused), paused.start[0].depth], [['b_ada'], 0], 'their pause: depth 0');
  assert.deepEqual(started(look({ notes: watching(7), changedAt: people, now: 98_000 + SETTLE_MS })), [], 'a run since saw them');

  const outside = look({ notes: watching(5), changedAt: new Map([[OUTSIDE, { rev: 7, at: 99_999 }]]) });
  assert.deepEqual([started(outside), outside.start[0].depth, outside.wakeAt], [['b_ada'], 0, null], 'a file written outside: at once, depth 0, for it is whole');
  assert.equal(outside.why.get('b_ada'), 'due: changed by outside the app at rev 7, after its look at rev 5');

  const buddy = look({ notes: watching(5), changedAt: new Map([['b_ben', { rev: 7, at: 99_000, depth: 4 }]]) });
  assert.deepEqual([started(buddy), buddy.start[0].depth], [['b_ada'], 5], 'another buddy: at once, one deeper than its run');
  const landing = look({ notes: watching(5), changedAt: new Map([['b_ben', { rev: 7, at: 99_000 }]]), running: new Set(['b_ben']) });
  assert.deepEqual([started(landing), landing.wakeAt], [[], null], 'not while its run still lands: the comment with the edit comes after it, and its end looks again');
  assert.deepEqual(started(look({ notes: watching(5), changedAt: new Map([['b_ada', { rev: 7, at: 99_000 }]]) })), [], 'its own change');
  const deep = new Map([['b_ben', { rev: 7, at: 99_000, depth: 1000 }]]);
  assert.deepEqual(started(look({ notes: watching(5), changedAt: deep })), [], 'past the depth limit: they come to rest');
  assert.deepEqual(started(look({ notes: watching(5), changedAt: new Map([...deep, [null, { rev: 8, at: 0 }]]) })).concat(look({ notes: watching(5), changedAt: new Map([...deep, [null, { rev: 8, at: 0 }]]) }).start.map((t) => t.depth)), ['b_ada', 0], 'a person\'s change starts it again at depth 0');
  assert.deepEqual(look({ notes: watching(5), changedAt: new Map([...deep, [OUTSIDE, { rev: 8, at: 99_999 }]]) }).start.map((t) => t.depth), [0], 'as does an outside one');
  assert.deepEqual(started(look({ notes: watching(5), changedAt: new Map([[null, { rev: 8, at: 0 }]]), paused: true })), [], 'watches paused: none');
});

test('a watcher whose view is as it was when its last run started is not due, whoever changed it meanwhile', () => {
  const people = new Map([[null, { rev: 7, at: 0 }]]);
  const same = look({ notes: watching(5, { print: 'p1' }), changedAt: people, prints: new Map([['b_ada', 'p1']]) });
  assert.deepEqual([started(same), same.why.get('b_ada')], [[], 'not due: changed by people at rev 7, after its look at rev 5, but its view is as it was']);
  assert.deepEqual(started(look({ notes: watching(5, { print: 'p1' }), changedAt: people, prints: new Map([['b_ada', 'p2']]) })), ['b_ada'], 'changed');
  assert.deepEqual(started(look({ notes: watching(5, { print: 'p1' }), changedAt: new Map([['b_ben', { rev: 7, at: 0 }]]), prints: new Map([['b_ada', 'p1']]) })), [], 'a buddy\'s change undone');
  assert.deepEqual(started(look({ notes: watching(null, { print: 'p1' }), prints: new Map([['b_ada', 'p1']]) })), ['b_ada'], 'turned on, or Retry: it looks at once');
});

test('a watcher whose last run named lines to wake it is due only on a change while the doc holds one, whoever made it', () => {
  const people = new Map([[null, { rev: 7, at: 0 }]]);
  const waits = look({ notes: watching(5, { wake: ['Action on: Ada'] }), changedAt: people, text: 'Action on: Ben\n' });
  assert.deepEqual(started(waits), []);
  assert.equal(waits.why.get('b_ada'), 'not due: changed by people at rev 7, after its look at rev 5, but its view holds nothing that wakes it');
  assert.deepEqual(started(look({ notes: watching(5, { wake: ['Action on: Ada'] }), changedAt: people, text: 'Pot: 10\nAction on: Ada\n' })), ['b_ada'], 'the line, whole');
  assert.deepEqual(started(look({ notes: watching(5, { wake: ['Action on: Ada'] }), changedAt: people, text: 'Action on: Adam\n' })), [], 'not part of a line');
  const ben = look({ notes: watching(5, { wake: ['Action on: Ada'] }), changedAt: new Map([['b_ben', { rev: 7, at: 0 }]]), text: 'Action on: Ben\n' });
  assert.deepEqual(started(ben), [], 'another buddy\'s change too');
  assert.deepEqual(started(look({ notes: watching(5, { wake: ['Action on: Ada'] }), text: 'Action on: Ada\n' })), [], 'still only on a change');
  assert.deepEqual(started(look({ notes: watching(null, { wake: ['Action on: Ada'] }), text: '' })), ['b_ada'], 'turned on, or Retry: it looks at once');
  const asked = thread('c_1', [say(ME, '@Ada look', '2026-11-18T10:00:00.000Z', ['b_ada'])]);
  assert.deepEqual(started(look({ threads: [asked], notes: watching(5, { wake: ['Action on: Ada'] }), text: '' })), ['b_ada'], 'an ask runs it whatever the lines');
});

test('a watcher is in only while whoever turned it on may ask, told what changed, given only the threads that ask it; a run nothing wants is stopped', () => {
  const its = thread('c_w', [say('b_ada', 'Watching.', '2026-11-18T10:00:00.000Z')]);
  const [task] = look({ notes: watching(null), threads: [its], text: 'Text.\nMore.\n' }).start;
  assert.deepEqual([task.asks, task.askers, task.watch, task.watchOnly], [[], [ME], true, true], 'it reads every thread in the comments itself');
  const told = (over) => newSince({ agent: 'b_ada', base: 'Text.\n', heard: null, text: 'Text.\nMore.\n', threads: [], ...over });
  assert.deepEqual(told().changes, [{ before: '', after: 'More.\n' }]);
  const said = (id, by, at) => ({ ...say(by, 'Your move.', at), id });
  const game = thread('c_g', [said('c_g', ME, '2026-11-18T10:00:00.000Z'), said('c_m1', 'b_ben', '2026-11-18T10:00:05.000Z')]);
  const mine = thread('c_w2', [said('c_w2', 'b_ada', '2026-11-18T10:00:01.000Z')]);
  const threads = [game, mine, thread('c_old', [said('c_old', ME, '2026-11-18T09:00:00.000Z'), said('c_x', 'b_ben', '2026-11-18T09:00:01.000Z')], true)];
  assert.deepEqual(told({ heard: new Set(['c_g', 'c_w2']), threads }).threads.map((t) => t.id), ['c_g'], 'the open threads another member wrote in since it looked; not its own words, nor a resolved thread');
  assert.deepEqual(told({ base: null, threads: [game] }), { changes: null, threads: [] }, 'on its first look it reads them all itself');
  const gone = look({ notes: watching(null, { watch: { by: 'u_gone00001' } }), running: new Set(['b_ada', 'b_ben']) });
  assert.deepEqual([started(gone), gone.stop], [[], ['b_ada', 'b_ben']], 'nothing wants them');
});
