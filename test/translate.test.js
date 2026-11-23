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
const run = (over) => toChanges({ by, base: 'One.\n', edited: 'One.\n', comments: sidecar(), groups: [], threads: [open('c_1')], ...over });
const shape = ({ posts, carried }) => ({ posts: posts.map((c) => [c.thread ?? null, c.body]), carried: carried.map((c) => [c.comment.body, c.doc, c.lands]) });

test('each comment carries the edits of its group, in order', () => {
  const result = run({
    edited: 'Two.\nThree.\n',
    comments: sidecar({ thread: 'c_1', body: 'First.' }, { thread: 'c_1', body: 'Second.' }),
    groups: [{ comment: 0, doc: 'Two.\n' }, { comment: 1, doc: 'Two.\nThree.\n' }],
  });
  assert.deepEqual(shape(result), { posts: [['c_1', 'First.'], ['c_1', 'Second.']], carried: [['First.', 'Two.\n', true], ['Second.', 'Two.\nThree.\n', true]] });
  assert.ok(result.posts.every((c) => c.by.id === 'b_ada' && c.id));
});

test('with no good groups, every edit hangs on the last comment; with no comment, on the one it left out (its last words, else that it edited): in the thread that asked it, else on the whole doc', () => {
  const edited = 'Two.\n';
  const lastDocWrong = [{ comment: 0, doc: 'Other.\n' }];
  assert.deepEqual(shape(run({ edited, comments: sidecar({ thread: 'c_1', body: 'Done.' }), groups: lastDocWrong })), { posts: [['c_1', 'Done.']], carried: [['Done.', edited, true]] });
  assert.deepEqual(shape(run({ edited, asking: ['c_1'] })), { posts: [['c_1', 'Edited the doc.']], carried: [['Edited the doc.', edited, true]] }, 'the comment it left out, in the thread that asked it');
  assert.deepEqual(shape(run({ edited, asking: ['c_1'], threads: [{ ...open('c_1'), resolved: true }] })), { posts: [[null, 'Edited the doc.']], carried: [['Edited the doc.', edited, true]] }, 'that thread resolved meanwhile, or none asked: on the whole doc');
  const output = '\u001b[1mReading the doc.\u001b[0m\n\nShortened the second\nparagraph to two sentences.\n';
  assert.equal(run({ edited, asking: ['c_1'], output }).posts[0].body, 'Shortened the second paragraph to two sentences.', 'what it said last on its way out, in one line');
  assert.equal(run({ edited, output: `${'word '.repeat(80)}\n` }).posts[0].body.length, 280, 'at most a comment\'s length');
});

test('a reply in a thread resolved meanwhile is not posted, and its edits do not land; a new thread is', () => {
  const result = run({
    edited: 'Two.\n',
    threads: [{ ...open('c_1'), resolved: true }],
    comments: sidecar({ thread: 'c_1', body: 'Late.' }, { body: 'New thread.', anchor: { exact: 'Two.' } }),
    groups: [{ comment: 0, doc: 'Two.\n' }, { comment: 1, doc: 'Two.\n' }],
  });
  assert.deepEqual(shape(result), { posts: [[null, 'New thread.']], carried: [['Late.', 'Two.\n', false], ['New thread.', 'Two.\n', true]] });
  assert.equal(result.posts[0].anchor.exact, 'Two.', 'anchored on the doc it edited');
});

test('a run that changed nothing comes to nothing; lines it could not mean are left out', () => {
  assert.deepEqual(shape(run({})), { posts: [], carried: [] });
  const odd = { before: header, after: `${header}not json\n${JSON.stringify({ thread: 'c_9', body: 'Nowhere.' })}\n${JSON.stringify({ thread: 'c_1', body: '  ' })}\n` };
  assert.deepEqual(shape(run({ comments: odd })), { posts: [], carried: [] });
});

test('each open thread that asked it, where it posted nothing, gets "Looked; nothing to change.": every ask is answered by a comment', () => {
  const threads = [open('c_1'), open('c_2'), { ...open('c_3'), resolved: true }];
  const result = run({ threads, asking: ['c_1', 'c_2', 'c_3'], comments: sidecar({ thread: 'c_1', body: 'Done.' }) });
  assert.deepEqual(shape(result), { posts: [['c_1', 'Done.'], ['c_2', 'Looked; nothing to change.']], carried: [] }, 'not where it replied, nor in a thread resolved meanwhile');
  assert.deepEqual([...result.byLine.keys()], [0], 'not a line its agent wrote');
});
