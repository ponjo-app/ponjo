// Pairs typed as one (#367). `(`, `[` and `` ` `` type their closer after
// the caret (CodeMirror's closeBrackets: typing the closer steps over it,
// Backspace in an empty pair takes both); a code fence's backticks are
// typed as they are. `**` does the same: a `*` typed after a `*` that
// starts a word types the closing `**`, and a third `*` there makes `***`
// (a rule) instead. `*`, `_` or `~` typed over a selection wraps it. In
// code and front matter, only closeBrackets' pairs, as the code's language has them.

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

const WRAPS = new Set(['*', '_', '~']);
const VERBATIM = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'Frontmatter', 'HTMLBlock']);

// Where the `**` typed for the person starts, while the caret is in the pair: else null.
const setCloser = StateEffect.define();
const closerField = StateField.define({
  create: () => null,
  update(at, tr) {
    for (const effect of tr.effects) if (effect.is(setCloser)) return effect.value;
    if (at === null) return null;
    const next = tr.changes.mapPos(at, 1);
    const head = tr.state.selection.main.head;
    const { doc } = tr.state;
    const kept = tr.state.sliceDoc(next, next + 2).startsWith('*') && head <= next + 1 && doc.lineAt(head).number === doc.lineAt(next).number;
    return kept ? next : null;
  },
});

function typed(view, from, to, text) {
  const { state } = view;
  const at = (pos) => state.sliceDoc(pos, pos + 1);
  if (text === '`' && from === to) {
    // A fence's backticks, on a line of their own.
    const line = state.doc.lineAt(from);
    if (!/^\s*`*$/.test(state.sliceDoc(line.from, from))) return false;
    view.dispatch({ changes: { from, insert: '`' }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
    return true;
  }
  for (let node = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) if (VERBATIM.has(node.name)) return false;
  if (WRAPS.has(text) && !state.selection.ranges.every((r) => r.empty)) {
    view.dispatch(state.changeByRange((range) => (range.empty
      ? { changes: { from: range.from, insert: text }, range: EditorSelection.cursor(range.from + 1) }
      : { changes: [{ from: range.from, insert: text }, { from: range.to, insert: text }], range: EditorSelection.range(range.anchor + 1, range.head + 1) })), { userEvent: 'input.type' });
    return true;
  }
  if (text !== '*' || from !== to || state.selection.ranges.length > 1) return false;
  const closer = state.field(closerField);
  if (closer !== null && from === closer && state.sliceDoc(from - 2, from) === '**') {
    // `***` in an empty pair: a rule, not bold.
    view.dispatch({ changes: { from, to: from + 2, insert: '*' }, selection: { anchor: from + 1 }, effects: setCloser.of(null), userEvent: 'input.type' });
    return true;
  }
  if (closer !== null && (from === closer || from === closer + 1) && at(from) === '*') {
    view.dispatch({ selection: { anchor: from + 1 }, effects: setCloser.of(from === closer ? closer : null), userEvent: 'select' });
    return true;
  }
  const line = state.doc.lineAt(from);
  const opens = at(from - 1) === '*' && (from - 1 === line.from || /[\s([]/.test(at(from - 2)));
  if (!opens || !(from === line.to || /[\s)\]]/.test(at(from)))) return false;
  view.dispatch({ changes: { from, insert: '***' }, selection: { anchor: from + 1 }, effects: setCloser.of(from + 1), userEvent: 'input.type' });
  return true;
}

// Backspace in an empty `**‸**` takes both.
function unpair(view) {
  const { state } = view;
  const closer = state.field(closerField);
  const { head, empty } = state.selection.main;
  if (!empty || closer !== head || state.sliceDoc(head - 2, head + 2) !== '****') return false;
  view.dispatch({ changes: { from: head - 2, to: head + 2 }, effects: setCloser.of(null), userEvent: 'delete.backward' });
  return true;
}

/** The pairs, for the Markdown view's editor. */
export function pairs() {
  return [
    closerField,
    Prec.high(EditorView.inputHandler.of(typed)),
    Prec.high(keymap.of([{ key: 'Backspace', run: unpair }, ...closeBracketsKeymap])), // before the editor's own Backspace
    closeBrackets(),
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '`'] } }]),
  ];
}
