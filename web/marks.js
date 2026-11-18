// A revision as marks a view draws (see web/views/markdown/view.js): recorded edits
// found in the doc's text as it is now. An edit changed since is left out.

import { findEdit } from '../src/core/diff.js';
import { buddyColor } from './faces.js';

/** Edit marks on `text` for `edits` (diffEdits records), shown as `by`'s, animated once by a new `replay` number. */
export function revisionMarks(text, edits, { by = null, replay = 0 } = {}) {
  return edits.flatMap((edit) => {
    const range = findEdit(text, edit);
    return range ? [{ kind: 'edit', from: range.start, to: range.end, removed: edit.before, by, replay }] : [];
  });
}

/** The node of someone's cursor mark (kind 'cursor'): a blinking line in their colour. */
export function cursorNode({ by }) {
  const node = document.createElement('span');
  node.className = 'pj-cursor';
  node.style.cssText = `--buddy: ${buddyColor(by)}`;
  node.contentEditable = 'false';
  return node;
}
