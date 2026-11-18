// What a buddy's run comes to (docs/agent-runtime.md, A run): from the copies
// its agent left, the comments to post and the edits each carries, with no
// file or clock of its own.

import { appendedComments, newComment } from './comments.js';

/**
 * The changes a run made, as buddy `by` ({ id, name, kind }): `base` the
 * doc's copy as the run started and `edited` as it ended, `comments` the
 * sidecar's copy `{ before, after }`, `groups` the lines its agent wrote to
 * PONJO_GROUPS ({ comment (its line among the appended), doc (the doc after
 * that comment's edits) }), `threads` the doc's threads now (threadsOf) and
 * `asking` the ids of the threads that asked the run.
 *
 * Returns { posts (the comments to post, in order), carried ([{ comment,
 * doc (the doc after its edits), lands }], in order: the edits each comment
 * carries, merged one after another, `lands` false for one in a thread
 * resolved meanwhile), dropped (null, or why nothing lands) }. Each comment's
 * edits are its group; an agent that wrote no good groups hangs every edit
 * on its last comment, or, with none, on an empty reply in the first thread
 * that asked it and is still open: no edit lands without a comment. A reply
 * in a thread resolved meanwhile is not posted.
 */
export function toChanges({ by, base, edited, comments, groups = [], threads, asking }) {
  const open = new Set(threads.filter((t) => !t.resolved).map((t) => t.id));
  const kept = (c) => c.thread === undefined || open.has(c.thread);
  const added = appendedComments(comments.before, comments.after, { text: edited, by, at: '', threads: new Set(threads.map((t) => t.id)) });
  const posts = added.map((a) => a.comment);
  const byLine = new Map(added.map((a) => [a.line, a.comment]));
  let carried = [];
  if (groups.length && groups.every((g) => byLine.has(g?.comment) && typeof g.doc === 'string') && groups.at(-1).doc === edited) {
    carried = groups.map((g) => ({ comment: byLine.get(g.comment), doc: g.doc }));
  } else if (edited !== base) {
    const still = asking.filter((id) => open.has(id));
    if (!posts.length && still.length) posts.push(newComment({ thread: still[0], body: '' }, { by, at: '' }));
    if (!posts.length) return { posts: [], carried: [], dropped: 'the threads that asked it were resolved meanwhile' };
    carried = [{ comment: posts.at(-1), doc: edited }];
  }
  return { posts: posts.filter(kept), carried: carried.map((c) => ({ ...c, lands: kept(c.comment) })), dropped: null };
}
