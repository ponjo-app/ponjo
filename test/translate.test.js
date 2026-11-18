// What a buddy's run comes to (src/core/translate.js): the comments to post
// and the edits each carries, from the copies its agent left, with no agent
// and no doc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT_VERSION } from '../src/core/comments.js';
import { toChanges } from '../src/core/translate.js';

const by = { id: 'b_ada', name: 'Ada', kind: 'ai' };
const header = `${JSON.stringify({ comments: FORMAT_VERSION })}\n`;
const sidecar = (...lines) => ({ before: header, after: header + lines.map((l) => `${JSON.stringify(l)}\n`).join('') });
const open = (id) => ({ id, resolved: false, anchor: null, comments: [] });
const run = (over) => toChanges({ by, base: 'One.\n', edited: 'One.\n', comments: sidecar(), groups: [], threads: [open('c_1')], asking: ['c_1'], ...over });
const shape = ({ posts, carried, dropped }) => ({ posts: posts.map((c) => [c.thread ?? null, c.body]), carried: carried.map((c) => [c.comment.body, c.doc, c.lands]), dropped });

test('each comment carries the edits of its group, in order', () => {
  const result = run({
    edited: 'Two.\nThree.\n',
    comments: sidecar({ thread: 'c_1', body: 'First.' }, { thread: 'c_1', body: 'Second.' }),
    groups: [{ comment: 0, doc: 'Two.\n' }, { comment: 1, doc: 'Two.\nThree.\n' }],
  });
  assert.deepEqual(shape(result), { posts: [['c_1', 'First.'], ['c_1', 'Second.']], carried: [['First.', 'Two.\n', true], ['Second.', 'Two.\nThree.\n', true]], dropped: null });
  assert.ok(result.posts.every((c) => c.by.id === 'b_ada' && c.id));
});

test('with no good groups, every edit hangs on the last comment, or on an empty reply in the first open thread that asked', () => {
  const edited = 'Two.\n';
  const lastDocWrong = [{ comment: 0, doc: 'Other.\n' }];
  assert.deepEqual(shape(run({ edited, comments: sidecar({ thread: 'c_1', body: 'Done.' }), groups: lastDocWrong })), { posts: [['c_1', 'Done.']], carried: [['Done.', edited, true]], dropped: null });
  assert.deepEqual(shape(run({ edited, threads: [{ ...open('c_1'), resolved: true }, open('c_2')], asking: ['c_1', 'c_2'] })), { posts: [['c_2', '']], carried: [['', edited, true]], dropped: null });
  assert.equal(run({ edited, threads: [{ ...open('c_1'), resolved: true }] }).dropped, 'the threads that asked it were resolved meanwhile');
});

test('a reply in a thread resolved meanwhile is not posted, and its edits do not land; a new thread is', () => {
  const result = run({
    edited: 'Two.\n',
    threads: [{ ...open('c_1'), resolved: true }],
    comments: sidecar({ thread: 'c_1', body: 'Late.' }, { body: 'New thread.', anchor: { exact: 'Two.' } }),
    groups: [{ comment: 0, doc: 'Two.\n' }, { comment: 1, doc: 'Two.\n' }],
  });
  assert.deepEqual(shape(result), { posts: [[null, 'New thread.']], carried: [['Late.', 'Two.\n', false], ['New thread.', 'Two.\n', true]], dropped: null });
  assert.equal(result.posts[0].anchor.exact, 'Two.', 'anchored on the doc it edited');
});

test('a run that changed nothing comes to nothing; lines it could not mean are left out', () => {
  assert.deepEqual(shape(run({})), { posts: [], carried: [], dropped: null });
  const odd = { before: header, after: `${header}not json\n${JSON.stringify({ thread: 'c_9', body: 'Nowhere.' })}\n${JSON.stringify({ thread: 'c_1', body: '  ' })}\n` };
  assert.deepEqual(shape(run({ comments: odd })), { posts: [], carried: [], dropped: null });
});
