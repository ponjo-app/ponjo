// The plain view: a text file as it is, in CodeMirror, with no formatting,
// for any text file no other view claims (index.js): the shared editor
// (web/views/codemirror.js) with line numbers, wrapping, whitespace marks,
// indent guides, indentation and the file's language as its settings say,
// and a status bar.

import { Compartment } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { createEditor } from '../codemirror.js';
import { indentKeys, resolveIndent } from './indent.js';
import { createStatusBar } from './status.js';
import { indentGuides, whitespaceMarks } from './whitespace.js';

/**
 * The same options and interface as the Markdown view (createMarkdownView in
 * web/views/markdown/view.js). It has no tools, so `toolbar` is not used; given
 * `onComment`, a bubble over a selection offers Comment. `settings` are the
 * view's (web/views/plain/index.js), changed through `saveSettings`; an editable
 * view also has a status bar.
 *
 * @param {{ stage: HTMLElement, text: string, name: string, settings: object, saveSettings?: (patch: object) => void, editable?: boolean, color?: boolean, onChange?: () => void, onEdit?: () => void,
 *           onMarkClick?: (id: string) => void, onLayout?: () => void, onComment?: () => void }} options
 */
export async function createPlainView({ stage, text, name, settings, saveSettings = () => {}, editable = true, color = true, onChange, onEdit, onMarkClick, onLayout, onComment = null }) {
  const host = stage.querySelector('.pj-editor');
  stage.dataset.plain = ''; // the page runs edge to edge (app.css)
  let destroyed = false;
  let status = null;
  // The settings that change what CodeMirror does; the font size is a CSS variable.
  const numbers = new Compartment();
  const wrapping = new Compartment();
  const numbersFor = (own) => (own.lineNumbers ? lineNumbers() : []);
  const wrapFor = (own) => (own.wrap ? EditorView.lineWrapping : []);
  const syntax = new Compartment();
  const marking = new Compartment();
  const guiding = new Compartment();
  const markingFor = (own) => (own.whitespace === 'off' ? [] : whitespaceMarks(own.whitespace));
  const guidingFor = (own) => (own.guides ? indentGuides : []);
  const shown = (own) => [
    numbers.reconfigure(numbersFor(own)), wrapping.reconfigure(wrapFor(own)),
    marking.reconfigure(markingFor(own)), guiding.reconfigure(guidingFor(own)),
  ];
  // The indent Tab types, from the file or the settings; seen again when the settings or the file change.
  let own = settings;
  let indent;
  const reindent = (current) => {
    indent = resolveIndent(own, current);
    host.style.setProperty('--indent', indent.tabs ? 4 : indent.size);
    status?.paint(own, indent);
  };
  reindent(text);
  host.style.setProperty('--code-size', `${settings.fontSize}px`);
  const { view, editor } = createEditor({
    stage, host, text, editable, onChange, onEdit, onMarkClick, onLayout, onComment,
    keys: indentKeys({ indent: () => indent, keep: () => own.keepIndent }),
    extensions: [numbers.of(numbersFor(settings)), wrapping.of(wrapFor(settings)), syntax.of([]), marking.of(markingFor(settings)), guiding.of(guidingFor(settings))],
    onUpdate: (update) => {
      if (update.selectionSet || update.docChanged) status?.update();
    },
  });

  // The file's language, by its name, loads after the text is shown; no language, no colour.
  // Not `color`, no colour either (web/views/index.js: a long run is parsed again on each key).
  const language = color ? LanguageDescription.matchFilename(languages, name) : null;
  language?.load().then((support) => {
    if (!destroyed) view.dispatch({ effects: syntax.reconfigure([support, syntaxHighlighting(defaultHighlightStyle)]) });
  }, () => {});

  if (editable) {
    status = createStatusBar(view, stage.parentElement, saveSettings);
    status.paint(own, indent);
  }

  return {
    ...editor,
    applyText(next, options) {
      editor.applyText(next, options);
      reindent(next);
    },
    /** The view's settings changed. */
    applySettings(next) {
      own = next;
      host.style.setProperty('--code-size', `${next.fontSize}px`);
      reindent(editor.getText());
      view.dispatch({ effects: shown(next) });
    },
    destroy() {
      destroyed = true;
      delete stage.dataset.plain;
      status?.destroy();
      editor.destroy();
    },
  };
}
