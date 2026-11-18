// What a buddy's run comes to (docs/agent-runtime.md, A run): from the copies
// its agent left, the comments to post and the edits each carries, with no
// file or clock of its own.

import { appendedComments, newComment } from './comments.js';

// What a buddy that edited and said nothing, not even on its way out, says.
const EDITED = 'Edited the doc.';
// How long a comment may be (src/core/prompt.js).
const MOST = 280;

// What an agent said last on its way out (its output's last paragraph, in
// one line, at most a comment's length), or null.
function lastWords(output) {
  const said = (output ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim().split(/\n\s*\n/).at(-1).replace(/\s+/g, ' ').trim();
  if (!said) return null;
  return said.length > MOST ? `${said.slice(0, MOST - 1).trimEnd()}…` : said;
}

/**
 * The changes a run made, as buddy `by` ({ id, name, kind }): `base` the
 * doc's copy as the run started and `edited` as it ended, `comments` the
 * sidecar's copy `{ before, after }`, `groups` the lines its agent wrote to
 * PONJO_GROUPS ({ comment (its line among the appended), doc (the doc after
 * that comment's edits) }), `threads` the doc's threads now (threadsOf),
 * `asking` the ids of the threads that asked the run and `output` what its
 * agent printed.
 *
 * Returns { posts (the comments to post, in order), carried ([{ comment,
 * doc (the doc after its edits), lands }], in order: the edits each comment
 * carries, merged one after another, `lands` false for one in a thread
 * resolved meanwhile) }. Each comment's edits are its group; an agent that
 * wrote no good groups hangs every edit on its last comment, and one that
 * wrote no comment on the comment it left out: what it said last on its way
 * out, else that it edited the doc, in the first thread that asked it, still
 * open, else on the whole doc. No edit lands without a comment. A reply in a thread resolved meanwhile is
 * not posted.
 */
export function toChanges({ by, base, edited, comments, groups = [], threads, asking = [], output = '' }) {
  const open = new Set(threads.filter((t) => !t.resolved).map((t) => t.id));
  const kept = (c) => c.thread === undefined || open.has(c.thread);
  const added = appendedComments(comments.before, comments.after, { text: edited, by, at: '', threads: new Set(threads.map((t) => t.id)) });
  const posts = added.map((a) => a.comment);
  const byLine = new Map(added.map((a) => [a.line, a.comment]));
  let carried = [];
  if (groups.length && groups.every((g) => byLine.has(g?.comment) && typeof g.doc === 'string') && groups.at(-1).doc === edited) {
    carried = groups.map((g) => ({ comment: byLine.get(g.comment), doc: g.doc }));
  } else if (edited !== base) {
    if (!posts.length) posts.push(newComment({ thread: asking.find((id) => open.has(id)), body: lastWords(output) ?? EDITED }, { by, at: '' }));
    carried = [{ comment: posts.at(-1), doc: edited }];
  }
  return { posts: posts.filter(kept), carried: carried.map((c) => ({ ...c, lands: kept(c.comment) })) };
}
