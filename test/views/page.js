// The page the view contract tests (test/views.test.js) drive: any view,
// made on demand in a stage like the doc window's, and DOM helpers that work
// for any view that edits through contenteditable.

import { EditorView } from '@codemirror/view';
import { createMarkdownView } from '../../web/views/markdown/view.js';
import { viewSettings } from '../../src/core/settings.js';
import { plain } from '../../web/views/plain/index.js';
import { markdown } from '../../web/views/markdown/index.js';

const VIEWS = { markdown: createMarkdownView, plain: plain.createView };
const stage = document.querySelector('.pj-stage');
let view = null;

const contract = {
  clicked: [],
  saved: [], // the settings changes the view asked to save
  edits: [], // getText at each onEdit
  changes: 0, // how many times onChange fired
  images: {}, // what the view's `image` gives, by src
  savedImages: [], // what the view's `saveImage` was given
  // `toolbar: true` gives a Markdown view its toolbar, with that view's settings.
  async make(name, text, { toolbar = false, ...options } = {}) {
    await view?.destroy();
    view = null;
    contract.early = false;
    document.querySelector('.pj-toolbar')?.remove();
    contract.clicked = [];
    contract.saved = [];
    contract.edits = [];
    contract.changes = 0;
    const bar = toolbar ? Object.assign(document.createElement('div'), { className: 'pj-toolbar', innerHTML: '<span class="pj-spacer"></span>' }) : null;
    if (bar) document.body.prepend(bar);
    const settings = viewSettings({ views: {} }, toolbar ? markdown : plain);
    // A view calls onLayout once it is made: the page lays its margin out by it (web/main.js).
    const onLayout = () => { if (!view) contract.early = true; };
    view = await VIEWS[name]({ stage, text, settings, toolbar: bar, image: async (src) => contract.images[src] ?? null, saveImage: async (image) => (contract.savedImages.push(image), `assets/${image.name}`), onLayout, ...options, onMarkClick: (id) => contract.clicked.push(id), onEdit: () => contract.edits.push(view.getText()), onChange: () => contract.changes++, saveSettings: (patch) => contract.saved.push(patch) });
    window.view = view;
  },
  // Press toolbar button `command`, as a click does.
  tool: (command) => document.querySelector(`.pj-toolbar [data-command="${command}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
  // Put the selection on characters [start, end) of the first piece of text holding `quote`.
  async select(quote, start = 0, end = quote.length) {
    view.focus(); // first: it can draw the text again, once it has drawn it
    await new Promise((done) => setTimeout(done, 30));
    const editable = stage.querySelector('[contenteditable]');
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.data.includes(quote)) node = walker.nextNode();
    const at = node.data.indexOf(quote);
    const range = document.createRange();
    range.setStart(node, at + start);
    range.setEnd(node, at + end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((done) => setTimeout(done, 50)); // the view takes in the selection
  },
  // The text drawn in the elements matching `selector`.
  drawn: (selector) => [...stage.querySelectorAll(selector)].map((el) => el.textContent).join(''),

  // ---- the Markdown view's own (test/markdown.test.js), through its CodeMirror editor ----

  errors: [], // what was thrown or logged as an error since the view was made
  editor: () => EditorView.findFromDOM(stage.querySelector('.cm-editor')),
  // A Markdown view of `marked`: its text with ‸ the caret, or « and » a selection's anchor and head.
  async at(marked, { focus = true, ...options } = {}) {
    options.toolbar ??= true;
    const { text, anchor, head } = unmark(marked);
    await contract.make('markdown', text, options);
    contract.errors = [];
    if (focus) contract.place(anchor, head);
  },
  // Put the selection on [anchor, head) as a click or the arrows do, with the focus.
  place(anchor, head = anchor) {
    const editor = contract.editor();
    editor.focus();
    editor.dispatch({ selection: { anchor, head }, userEvent: 'select' });
  },
  // The text, with the selection marked as `at` takes it.
  marked() {
    const { state } = contract.editor();
    const { anchor, head } = state.selection.main;
    const text = state.doc.toString();
    if (anchor === head) return `${text.slice(0, head)}‸${text.slice(head)}`;
    const marks = [[anchor, '«'], [head, '»']].sort((a, b) => b[0] - a[0]);
    return marks.reduce((out, [at, mark]) => `${out.slice(0, at)}${mark}${out.slice(at)}`, text);
  },
  // What each line shows, as a person reads it: { cls, text }. In `text`,
  // syntax drawn faded is ‹ ›, a widget ⟨ ⟩ (its text, ☐ ☑ a task's box,
  // — a rule, img:alt an image), formatting <b> <i> <s> <c> <a> <m> (muted)
  // <d> (done). `cls` is the line's pj-md- classes, without the prefix, and
  // `style` its own style (a list line's indent). A
  // table or a diagram drawn in place of its lines is one entry, its text
  // `[table a|b / 1|2]` or `[diagram]`.
  lines: () => [...stage.querySelector('.cm-content').children].map((el) => {
    if (el.matches('.pj-md-block')) return { cls: 'block', text: `[table ${[...el.querySelectorAll('tr')].map((tr) => [...tr.cells].map((c) => c.textContent).join('|')).join(' / ')}]` };
    if (el.matches('.pj-diagram')) return { cls: 'block', text: '[diagram]' };
    const cls = [...new Set([...el.classList].filter((c) => c.startsWith('pj-md-')).map((c) => c.slice(6)))].sort().join(' ');
    return { cls, style: el.getAttribute('style') ?? '', text: shown(el) };
  }),
};
window.contract = contract;

window.addEventListener('error', (event) => contract.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => contract.errors.push(String(event.reason)));
const logged = console.error;
console.error = (...args) => {
  contract.errors.push(args.map(String).join(' '));
  logged(...args);
};

function unmark(marked) {
  const text = marked.replace(/[‸«»]/g, '');
  const caret = marked.indexOf('‸');
  if (caret !== -1) return { text, anchor: caret, head: caret };
  if (!marked.includes('«')) return { text, anchor: 0, head: 0 };
  return { text, anchor: marked.replace('»', '').indexOf('«'), head: marked.replace('«', '').indexOf('»') };
}

const TAGS = [['pj-md-strong', 'b'], ['pj-md-em', 'i'], ['pj-md-strike', 's'], ['pj-md-code', 'c'], ['pj-md-link', 'a'], ['pj-md-muted', 'm'], ['pj-md-done', 'd']];
function shown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data;
  if (node.matches('.cm-widgetBuffer, br')) return '';
  if (node.getAttribute('contenteditable') === 'false') {
    const box = node.querySelector('.pj-md-check');
    const what = box ? (box.matches('.pj-md-checked') ? '☑' : '☐') : node.matches('.pj-md-hr') ? '—' : node.querySelector('img') ? `img:${node.querySelector('img').alt}` : node.textContent;
    return what ? `⟨${what}⟩` : ''; // hidden syntax: an empty widget
  }
  let inner = [...node.childNodes].map(shown).join('');
  if (node.classList.contains('pj-md-mark')) inner = `‹${inner}›`;
  for (const [cls, tag] of TAGS) if (node.classList.contains(cls)) inner = `<${tag}>${inner}</${tag}>`;
  return inner;
}
