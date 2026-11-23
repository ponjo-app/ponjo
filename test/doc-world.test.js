// The doc world (src/core/doc-world.js): a buddy's tasks from the state
// alone, with the answer ledger round it; what a watcher is told is new
// (newSince); and how deep buddies wake each other. Pure, so each case is a
// state, with no agent and no waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadsOf } from '../src/core/comments.js';
import { CLOCK, SETTLE_MS, docWorld, noted } from '../src/core/doc-world.js';
import { ledger } from '../src/core/ledger.js';
import { newSince } from '../src/core/prompt.js';

const ME = 'u_me000001';
const buddies = [{ id: 'b_ada', name: 'Ada', about: '' }, { id: 'b_ben', name: 'Ben', about: '' }];
const say = (id, by, body, at, more = {}) => ({ id, by: { id: by, name: by, kind: by.startsWith('b_') ? 'ai' : 'human' }, at, body, ...more });
// A state of a doc holding `comments` (each taken, unless `taken` says) and `text`.
function doc({ comments = [], text = 'Text.\n', hash = 'h0', taken, ...over } = {}) {
  return {
    text, hash, lines: comments.map((comment) => ({ comment })), threads: threadsOf(comments, buddies), problem: null,
    members: { owner: { id: ME, name: 'me' }, people: [], buddies }, taken: new Set(taken ?? comments.map((c) => c.id)),
    posted: {}, watches: {}, typed: null, settled: null, n: 0, ...over,
  };
}
const tasks = (s, member = 'b_ada') => docWorld.view(s, member).tasks;
const watching = (over = {}) => ({ b_ada: { by: ME, seen: 'h0', since: { depth: 0, n: 1 }, wake: null, ...over } });

test('a person\'s comment asks the buddy it names until the buddy comments after it; a comment written meanwhile is for the same task', () => {
  const ask = say('c_1', ME, '@Ada look', '2026-11-18T10:00:00.000Z');
  const [task] = tasks(doc({ comments: [ask] }));
  assert.deepEqual(task, { given: 'c_1', as: 'b_ada', kind: 'ask', from: [ME], depth: 0, thread: 'c_1', at: ask.at, until: ask.at, why: 'asked in c_1' });
  const more = say('c_2', ME, '@Ada and this', '2026-11-18T10:00:03.000Z', { thread: 'c_1' });
  assert.deepEqual(tasks(doc({ comments: [ask, more] })).map((t) => [t.given, t.until]), [['c_1', more.at]], 'the same given: a run on it goes on');
  assert.deepEqual(tasks(doc({ comments: [ask, say('c_3', 'b_ada', 'Done.', '2026-11-18T10:00:05.000Z', { thread: 'c_1' })] })), [], 'answered');
  assert.deepEqual(tasks(doc({ comments: [ask, say('c_3', ME, '', '2026-11-18T10:00:05.000Z', { thread: 'c_1', resolved: true })] })), [], 'resolved');
  assert.deepEqual(tasks(doc({ comments: [ask], taken: [] })), [], 'a comment the door did not take asks no one');
  assert.deepEqual(tasks(doc({ comments: [ask], problem: 'newer' })), [], 'a sidecar of another version: nothing is due');
  assert.deepEqual(tasks(doc({ comments: [ask] }), 'b_ben'), [], 'only whom it asks');
});

test('a buddy\'s comment posted by a run here asks the buddies it @mentions, a step deeper than that run, for the people it was for', () => {
  const handed = [say('c_1', ME, '@Ada start', '2026-11-18T10:00:00.000Z'), say('c_2', 'b_ada', '@Ben your turn', '2026-11-18T10:00:05.000Z', { thread: 'c_1' })];
  const posted = { c_2: { for: [ME], depth: 0 } };
  assert.deepEqual(tasks(doc({ comments: handed, posted }), 'b_ben').map((t) => [t.given, t.from, t.depth, t.why]), [['c_2', [ME], 1, 'asked in c_1 by an agent']]);
  assert.equal(tasks(doc({ comments: handed, posted: { c_2: { for: [ME], depth: 7 } } }), 'b_ben')[0].depth, 8);
  assert.deepEqual(tasks(doc({ comments: handed }), 'b_ben'), [], 'a buddy\'s comment found in the file asks no one');
  assert.deepEqual(tasks(doc({ comments: handed, posted: { c_2: { for: ['u_gone00001'], depth: 0 } } }), 'b_ben'), [], 'not once the people it was for may not ask');
  const self = [handed[0], say('c_2', 'b_ada', 'Done, and @Ada it is', '2026-11-18T10:00:05.000Z', { thread: 'c_1' })];
  assert.deepEqual(tasks(doc({ comments: self, posted })), [], 'never itself');
});

test('a watch: due once turned on; on a change once people pause; set off a step deeper by a buddy\'s; never by its own', () => {
  const on = docWorld.apply(doc(), { by: ME, body: { type: 'watch', buddy: 'b_ada', on: true } }).state;
  assert.deepEqual(tasks(on).map((t) => [t.kind, t.depth, t.from, t.why]), [['watch', 0, [ME], 'its first look']]);
  assert.deepEqual(docWorld.apply(doc(), { by: 'u_mate0001', body: { type: 'watch', buddy: 'b_ada', on: true } }), { refused: 'Only a person who may write changes the watches.' });
  assert.deepEqual(tasks(doc({ watches: watching({ since: null }), hash: 'h1' })), [], 'no change since its last run');
  assert.deepEqual(tasks(doc({ watches: watching() })), [], 'its view is as its last run saw it');

  const typed = noted({ watches: watching({ since: null }), typed: null, settled: null, n: 4 }, { kind: 'person', text: true, at: 1000 });
  assert.deepEqual([typed.typed, typed.watches.b_ada.since], [{ at: 1000, n: 5 }, { depth: 0, n: 5 }]);
  assert.deepEqual(tasks(doc({ ...typed, hash: 'h1' })), [], 'people still typing');
  assert.deepEqual(tasks(doc({ ...typed, hash: 'h1' }), CLOCK), [{ given: 'settle 5', as: CLOCK, kind: 'turn', from: [], depth: 0, at: 1000 + SETTLE_MS, why: 'people to pause' }], 'the clock\'s task: settle it');
  const settled = docWorld.apply(doc({ ...typed, hash: 'h1' }), { by: CLOCK, answers: ['settle 5'] }).state;
  assert.deepEqual(tasks(settled).map((t) => [t.given, t.depth]), [['watch 5', 0]], 'once they paused');
  assert.deepEqual(docWorld.apply(doc({ ...typed, hash: 'h1' }), { by: CLOCK, answers: ['settle 4'] }), { refused: 'People typed again.' });
  assert.deepEqual(tasks(doc({ ...settled, hash: 'h0' })), [], 'typing then deleted: its view is as it was');

  const outside = noted({ watches: watching({ since: null }), typed: null, settled: null, n: 4 }, { kind: 'outside', text: true, at: 1000 });
  assert.deepEqual(tasks(doc({ ...outside, hash: 'h1' })).map((t) => t.depth), [0], 'a file written outside: at once');
  assert.deepEqual(noted({ watches: watching({ since: null }), n: 4 }, { kind: 'person', text: false, at: 1000 }).watches.b_ada.since, null, 'comments wake no watch');

  const ben = (s, depth = 4) => docWorld.apply(s, { by: 'b_ben', as: 'b_ben', answers: [], body: { type: 'landed', base: 'h0', before: 'h0', after: 'h1', posted: [], from: [ME], depth, wake: null, failed: false } }).state;
  assert.deepEqual(tasks(doc({ ...ben(doc({ watches: watching({ since: null }) })), hash: 'h1' })).map((t) => t.depth), [5], 'another buddy: at once, one deeper than its run');
  const own = docWorld.apply(doc({ watches: watching({ since: null }) }), { by: 'b_ada', as: 'b_ada', answers: [], body: { type: 'landed', base: 'h0', before: 'h0', after: 'h1', posted: [], from: [ME], depth: 0, wake: null, failed: false } }).state;
  assert.deepEqual(tasks(doc({ ...own, hash: 'h1' })), [], 'its own change never wakes it');
  assert.deepEqual(own.watches.b_ada.seen, 'h1', 'it saw what it landed');
  assert.deepEqual(tasks(doc({ watches: watching({ by: 'u_gone00001' }), hash: 'h1' })), [], 'only while whoever turned it on may ask');
});

test('a watch answered moves on: what its run saw, or what it was given if another\'s change landed meanwhile, and runs again on that', () => {
  const answer = (s, body) => docWorld.apply(s, { by: 'b_ada', as: 'b_ada', answers: ['watch 1'], body: { type: 'landed', posted: [], from: [ME], depth: 0, wake: null, failed: false, ...body } }).state;
  const quiet = answer(doc({ watches: watching(), hash: 'h1' }), { base: 'h1', before: 'h1', after: 'h1' });
  assert.deepEqual([quiet.watches.b_ada.seen, quiet.watches.b_ada.since, tasks(quiet)], ['h1', null, []]);
  const meantime = noted({ ...doc({ watches: watching(), hash: 'h1' }) }, { kind: 'outside', text: true, at: 0 });
  const late = answer({ ...meantime, hash: 'h2' }, { base: 'h1', before: 'h2', after: 'h3' });
  assert.equal(late.watches.b_ada.seen, 'h1');
  assert.deepEqual(tasks({ ...late, hash: 'h3' }).map((t) => t.given), [`watch ${late.n}`], 'a new task: on what it did not see');
  const failed = answer(doc({ watches: watching(), hash: 'h1' }), { base: 'h1', before: 'h1', after: 'h1', failed: true });
  assert.deepEqual(tasks(failed), [], 'failed: gone until its view changes');
  const retried = docWorld.apply(failed, { by: ME, body: { type: 'retry', buddies: ['b_ada'] } }).state;
  assert.deepEqual(tasks(retried).map((t) => t.why), ['its first look'], 'Retry: it looks again');
  const notStarted = answer(doc({ watches: watching(), hash: 'h1' }), { base: null, before: 'h1', after: 'h1' });
  assert.deepEqual([notStarted.watches.b_ada.seen, tasks(notStarted)], ['h0', []], 'not started: gone, what it saw kept');
  const resumed = docWorld.apply(notStarted, { by: ME, body: { type: 'resume' } }).state;
  assert.deepEqual(tasks(resumed).map((t) => t.kind), ['watch'], 'resumed: each watch whose text changed looks again');
});

test('a watcher whose last run named lines to wake it is due only while the doc holds one, whole; an ask runs it whatever the lines', () => {
  const at = (text) => tasks(doc({ watches: watching({ wake: ['Action on: Ada'] }), hash: 'h1', text }));
  assert.deepEqual(at('Action on: Ben\n'), []);
  assert.deepEqual(at('Pot: 10\nAction on: Ada\n').map((t) => t.kind), ['watch'], 'the line, whole');
  assert.deepEqual(at('Action on: Adam\n'), [], 'not part of a line');
  const asked = doc({ comments: [say('c_1', ME, '@Ada look', '2026-11-18T10:00:00.000Z')], watches: watching({ wake: ['Action on: Ada'] }), hash: 'h1', text: '' });
  assert.deepEqual(tasks(asked).map((t) => t.kind), ['ask']);
});

test('the ledger: a task answered is gone, keyed by its seat and given; a refused landing is a try, told in the view', () => {
  const world = ledger(docWorld);
  const s = { world: doc({ comments: [say('c_1', ME, '@Ada look', '2026-11-18T10:00:00.000Z')] }), answers: {} };
  const refused = world.apply(s, { by: 'b_ada', as: 'b_ada', answers: ['c_1'], body: { type: 'landed', refused: 'EACCES' } });
  assert.deepEqual([refused.refused, world.view(refused.state, 'b_ada').tasks[0].refused], ['EACCES', 'EACCES']);
  assert.deepEqual(world.view(refused.state, 'b_ben').tasks, [], 'only that seat\'s');
  const tried = [1, 2].reduce((t) => world.apply(t, { by: 'b_ada', as: 'b_ada', answers: ['c_1'], body: { type: 'landed', refused: 'EACCES' } }).state, refused.state);
  assert.deepEqual(world.view(tried, 'b_ada').tasks, [], 'at the limit of tries: gone');
});

test('a watcher is told what changed since its last run, and the threads another member wrote in since', () => {
  const told = (over) => newSince({ agent: 'b_ada', base: 'Text.\n', heard: null, text: 'Text.\nMore.\n', threads: [], ...over });
  assert.deepEqual(told().changes, [{ before: '', after: 'More.\n' }]);
  const comments = [
    say('c_g', ME, 'Your move.', '2026-11-18T10:00:00.000Z'), say('c_m1', 'b_ben', 'Your move.', '2026-11-18T10:00:05.000Z', { thread: 'c_g' }),
    say('c_w2', 'b_ada', 'Mine.', '2026-11-18T10:00:01.000Z'),
    say('c_old', ME, 'Old.', '2026-11-18T09:00:00.000Z'), say('c_x', 'b_ben', 'Done.', '2026-11-18T09:00:01.000Z', { thread: 'c_old', resolved: true }),
  ];
  const threads = threadsOf(comments, buddies);
  assert.deepEqual(told({ heard: new Set(['c_g', 'c_w2']), threads }).threads.map((t) => t.id), ['c_g'], 'the open threads another member wrote in since; not its own words, nor a resolved thread');
  assert.deepEqual(told({ base: null, threads }), { changes: null, threads: [] }, 'on its first look it reads them all itself');
});
