// The Markdown view: the doc's Markdown in the editor every view is
// (web/views/codemirror.js), drawn formatted as it is typed (preview.js), its
// syntax showing on the lines being edited. Its text is the file's: what it
// shows is what is saved, and nothing but the person's typing changes it.
// Its tools type the syntax (chrome.js). See docs/markdown-view.md.

import { EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { redoDepth, undoDepth } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import { createEditor } from '../codemirror.js';
import { createChrome } from './chrome.js';
import { linkTarget, livePreview } from './preview.js';
import { footnotes, singleTilde } from './syntax.js';
import { paste } from './paste.js';
import { pairs } from './pairs.js';

// Colour for code in code blocks; Markdown's own spans are the preview's.
const codeColours = HighlightStyle.define([
  { tag: tags.keyword, color: '#708' },
  { tag: [tags.atom, tags.bool], color: '#219' },
  { tag: tags.literal, color: '#164' },
  { tag: tags.string, color: '#a11' },
  { tag: [tags.regexp, tags.special(tags.string)], color: '#e40' },
  { tag: tags.definition(tags.variableName), color: '#00f' },
  { tag: tags.local(tags.variableName), color: '#30a' },
  { tag: [tags.typeName, tags.namespace], color: '#085' },
  { tag: tags.className, color: '#167' },
  { tag: [tags.special(tags.variableName), tags.macroName], color: '#256' },
  { tag: tags.definition(tags.propertyName), color: '#00c' },
  { tag: tags.comment, color: '#940' },
]);

// A line's block prefix: its indent, then a heading's, a quote's or a list item's marker.
const PREFIX = /^(\s*)(#{1,6} |> ?|[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/;
// All of a line's block prefixes, one in another (`> - [ ] `).
const PREFIXES = /^(\s*(#{1,6} |> ?|[-*+] \[[ xX]\] |[-*+] |\d+[.)] ))*/;

/**
 * The view interface, as every view has it, in offsets on the doc's text
 * (web/views/codemirror.js), with these options:
 *
 * A mark is drawn over a range of the doc's text:
 * - { kind: 'comment', id, from, to, active }: commented text, `id` its
 *   thread's (or 'draft'); clicking it calls onMarkClick(id).
 * - { kind: 'edit', from, to, removed, by, replay }: part of a revision,
 *   [from, to) new text and `removed` the text it replaced, shown struck
 *   through before it; `by` shows it as that buddy's, and a new `replay`
 *   number (0: none) animates it once.
 * - { kind: 'cursor', at, by, name, working }: buddy `by`'s cursor after
 *   the character before text offset `at`; `working` shows its `name`.
 *
 * @param {{ stage: HTMLElement, text: string, editable?: boolean, onChange?: () => void, onEdit?: () => void,
 *           onMarkClick?: (id: string) => void, onLayout?: () => void,
 *           toolbar?: HTMLElement, onComment?: () => void, image?: (src: string) => Promise<string | null>,
           saveImage?: ((image: { name: string, type: string, data: string }) => Promise<string>) | null,
 *           files?: () => { paths: string[], current: string } | null,
 *           settings?: object, saveSettings?: (patch: object) => void }} options
 */
// `onChange` fires once the person pauses after changing the doc, `onEdit`
// on each change they make.
// `editable: false` makes a read-only view, such as an earlier version of the doc;
// it shows diagrams as their source, so the changes in them can be seen, and
// its chrome has no formatting tools or Comment bubble.
// Given a `toolbar`, the view puts its tools there and the rest of its chrome
// around `stage`; its bubble's Comment button calls `onComment`. The chrome
// follows the view's `settings` (web/views/markdown/index.js) and changes
// them through `saveSettings` (the focus mode shortcut).
// An image at a path, not on the web, shows what `image` gives for its `src`
// as written: a URL the page may show, or null for none. `saveImage(image)`,
// given, writes an image pasted or dropped in ({ name, type, data }, data
// base64) beside the doc and gives the path to link it by. `files` says the
// project's files and the doc's path in it, for the link popover to offer.
export async function createMarkdownView({
  stage, text, editable = true, onChange, onEdit, onMarkClick, onLayout, toolbar = null, onComment = () => {},
  image = async () => null, saveImage = null, files = () => null,
  settings = null, saveSettings = () => {},
}) {
  const host = stage.querySelector('.pj-editor');
  let chrome = null;
  let linkHeld = null; // the range the link popover edits: { from, to, link }

  const keys = [
    { key: 'Mod-b', run: () => run('bold') },
    { key: 'Mod-i', run: () => run('italic') },
    { key: 'Mod-e', run: () => run('code') },
    { key: 'Mod-Shift-x', run: () => run('strike') },
    { key: 'Mod-k', run: () => Boolean(chrome?.link()) },
    // The block styles, as Google Docs keys them (Mod+digit is the browser's tabs).
    { key: 'Mod-Alt-0', run: () => run('paragraph') },
    { key: 'Mod-Alt-1', run: () => run('h1') },
    { key: 'Mod-Alt-2', run: () => run('h2') },
    { key: 'Mod-Alt-3', run: () => run('h3') },
    { key: 'Mod-Alt-q', run: () => run('quote') },
    { key: 'Mod-Alt-c', run: () => run('codeBlock') },
    { key: 'Mod-Shift-7', run: () => run('numbers') },
    { key: 'Mod-Shift-8', run: () => run('bullets') },
    { key: 'Mod-Shift-9', run: () => run('tasks') },
    { key: 'Tab', run: () => tab(1) },
    { key: 'Shift-Tab', run: () => tab(-1) },
  ];
  const { view, editor } = createEditor({
    stage, host, text, editable, onChange, onEdit, onMarkClick, onLayout, keys,
    extensions: [
      Prec.highest(keymap.of([{ key: 'Enter', run: endBlock }, { key: 'Backspace', run: unmark }])), // before Markdown's own
      // CommonMark and GFM only: CodeMirror's markdownLanguage reads ~x~ as subscript, ^x^ and :x: too.
      yamlFrontmatter({ content: markdown({ base: commonmarkLanguage, codeLanguages: languages, extensions: [GFM, singleTilde, footnotes] }) }),
      syntaxHighlighting(codeColours),
      EditorView.lineWrapping,
      EditorView.editorAttributes.of({ class: 'pj-md' }),
      EditorView.contentAttributes.of({ spellcheck: String(editable) }), // prose; not its code (preview.js)
      livePreview({ image, diagrams: editable, pickLanguage: (at, where) => chrome?.pickLanguage(at, where) }),
      paste(saveImage),
      pairs(),
    ],
    onUpdate: () => chrome?.update(),
  });

  // The nodes from the one at `pos` out to the doc's.
  function* around(pos = view.state.selection.main.head, side = -1) {
    for (let node = syntaxTree(view.state).resolveInner(pos, side); node; node = node.parent) yield node;
  }
  const inside = (name) => [...around()].find((node) => node.name === name) ?? null;

  // ---- formatting: each command types or removes Markdown ----

  // The lines the selection touches.
  function touched() {
    const { doc, selection } = view.state;
    const lines = [];
    for (let n = doc.lineAt(selection.main.from).number; n <= doc.lineAt(selection.main.to).number; n++) lines.push(doc.line(n));
    return lines;
  }

  // Wrap each selection in `marker`, or unwrap it if it is wrapped.
  const wrap = (marker) => () => {
    const { state } = view;
    const n = marker.length;
    view.dispatch(state.changeByRange((range) => {
      if (state.sliceDoc(range.from - n, range.from) === marker && state.sliceDoc(range.to, range.to + n) === marker) {
        return { changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }], range: EditorSelection.range(range.from - n, range.to - n) };
      }
      const inner = state.sliceDoc(range.from, range.to);
      if (inner.length >= 2 * n && inner.startsWith(marker) && inner.endsWith(marker)) {
        return { changes: { from: range.from, to: range.to, insert: inner.slice(n, -n) }, range: EditorSelection.range(range.from, range.to - 2 * n) };
      }
      return { changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }], range: EditorSelection.range(range.from + n, range.to + n) };
    }), { userEvent: 'input.format' });
  };

  // The lines that open the items of the list the selection is in, when it is all in one.
  function listLines() {
    const { doc, selection } = view.state;
    const isList = (node) => node.name === 'BulletList' || node.name === 'OrderedList';
    const list = [...around(selection.main.from, -1)].find(isList) ?? [...around(selection.main.from, 1)].find(isList);
    if (!list || selection.main.to > list.to) return null;
    return list.getChildren('ListItem').map((item) => doc.lineAt(item.from));
  }

  // Each line the selection touches gets `make(i)` in place of its block
  // prefix, or loses it if every line has it already (`has`). A list made
  // another kind is made so whole; a heading is one line, without the break
  // that ended it; a new list or quote is kept apart from the paragraph line
  // after it, which would read as part of it.
  const prefix = (make, has, { list = false, heading = false } = {}) => () => {
    const { doc } = view.state;
    let lines = touched();
    const all = lines.every((line) => has.test(line.text));
    const whole = list && !all && listLines();
    if (whole) lines = whole;
    const changes = lines.flatMap((line, i) => {
      const [marker, indent] = PREFIX.exec(line.text);
      const change = { from: line.from + indent.length, to: line.from + marker.length, insert: all ? '' : make(i) };
      const hardBreak = heading && !all && /(\\| {2,})$/.exec(line.text);
      return hardBreak ? [change, { from: line.to - hardBreak[0].length, to: line.to }] : [change];
    });
    const next = lines.at(-1).number < doc.lines ? doc.line(lines.at(-1).number + 1) : null;
    if (!heading && !all && !whole && next?.text.trim() && !PREFIX.exec(next.text)[2] && !inside('FencedCode')) changes.push({ from: next.from, insert: '\n' });
    view.dispatch({ changes, userEvent: 'input.format' });
  };

  // Take the fences of fenced code block `node` away.
  function unfence(node) {
    const { doc } = view.state;
    const open = doc.lineAt(node.from);
    const close = doc.lineAt(node.to);
    const changes = [{ from: open.from, to: Math.min(open.to + 1, doc.length) }];
    if (close.number !== open.number && /^\s*(`{3,}|~{3,})\s*$/.test(close.text)) changes.push({ from: close.from - 1, to: close.to });
    view.dispatch({ changes, userEvent: 'input.format' });
  }

  // Fence the lines the selection touches as code, or take a block's fences away.
  function codeBlock() {
    const fence = inside('FencedCode');
    if (fence) return unfence(fence);
    const lines = touched();
    const { anchor, head } = view.state.selection.main; // on the same characters, in the block
    return view.dispatch({ changes: [{ from: lines[0].from, insert: '```\n' }, { from: lines.at(-1).to, insert: '\n```' }], selection: { anchor: anchor + 4, head: head + 4 }, userEvent: 'input.format' });
  }

  // Normal text: no heading, quote, list item or fence.
  function paragraph() {
    const fence = inside('FencedCode');
    if (fence) return unfence(fence);
    // Every prefix: a quote's, a list item's in it, a heading's.
    const changes = touched().flatMap((line) => {
      const indent = /^\s*/.exec(line.text)[0].length;
      const prefixes = PREFIXES.exec(line.text)[0].length;
      return prefixes > indent ? [{ from: line.from + indent, to: line.from + prefixes }] : [];
    });
    return view.dispatch({ changes, userEvent: 'input.format' });
  }

  // `block` on lines of its own after the selection's last line, a blank line before it; the caret `caret` into it.
  const insertBlock = (block, caret) => () => {
    const last = touched().at(-1);
    const lead = last.text.trim() ? '\n\n' : '';
    view.dispatch({ changes: { from: last.to, insert: `${lead}${block}\n` }, selection: { anchor: last.to + lead.length + caret }, userEvent: 'input.format', scrollIntoView: true });
  };

  // A footnote: its reference at the caret, its note at the doc's end, the caret there.
  function footnote() {
    const all = view.state.doc.toString();
    const n = Math.max(0, ...[...all.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]))) + 1;
    const at = view.state.selection.main.to;
    const note = `${all.endsWith('\n\n') || !all ? '' : all.endsWith('\n') ? '\n' : '\n\n'}[^${n}]: `;
    view.dispatch({
      changes: [{ from: at, insert: `[^${n}]` }, { from: all.length, insert: note }],
      selection: { anchor: all.length + `[^${n}]`.length + note.length },
      userEvent: 'input.format',
      scrollIntoView: true,
    });
  }

  const COMMANDS = {
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    paragraph,
    h1: prefix(() => '# ', /^\s*# /, { heading: true }),
    h2: prefix(() => '## ', /^\s*## /, { heading: true }),
    h3: prefix(() => '### ', /^\s*### /, { heading: true }),
    quote: prefix(() => '> ', /^\s*> /),
    codeBlock,
    bold: wrap('**'),
    italic: wrap('*'),
    strike: wrap('~~'),
    code: wrap('`'),
    bullets: prefix(() => '- ', /^\s*[-*+] (?!\[[ xX]\] )/, { list: true }),
    numbers: prefix((i) => `${i + 1}. `, /^\s*\d+[.)] /, { list: true }),
    tasks: prefix(() => '- [ ] ', /^\s*[-*+] \[[ xX]\] /, { list: true }),
    table: insertBlock('|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', 2),
    divider: insertBlock('---', 3),
    footnote,
  };

  /** Run a named formatting command against the selection; true, as a key's command. */
  function run(name) {
    // Front matter is source: nothing formats it.
    if (editable && (name === 'undo' || name === 'redo' || !inside('Frontmatter'))) COMMANDS[name]?.();
    view.focus();
    return true;
  }

  // Enter on an empty item of a list, or an empty line of a quote, not in
  // another block, ends it with a blank line, so what is typed next is not
  // read as part of it. Enter in a paragraph or an ATX heading not in a list
  // or a quote starts a new paragraph a blank line apart, as in Typora, so
  // the next line reads on its own (`- ` there is a list, not the line above
  // made a heading); Shift+Enter is a new line in it. Otherwise Enter is
  // Markdown's: it continues a list or a quote (insertNewlineContinueMarkup).
  function endBlock() {
    const { state } = view;
    const { main } = state.selection;
    const line = state.doc.lineAt(main.head);
    if (!editable || !main.empty || inside('FencedCode') || inside('CodeBlock')) return false;
    if (/^([-*+]( \[[ xX]\])?|\d+[.)]|>)\s*$/.test(line.text)) {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, userEvent: 'input' });
      return true;
    }
    const blocks = [...around()].map((node) => node.name);
    if (!blocks.some((name) => /^(Paragraph|ATXHeading\d)$/.test(name)) || blocks.includes('ListItem') || blocks.includes('Blockquote')) return false;
    view.dispatch({ changes: { from: main.head, insert: '\n\n' }, selection: { anchor: main.head + 2 }, userEvent: 'input' });
    return true;
  }

  // Backspace right after a list item's marker or a quote's: a nested item
  // moves out a level; else the marker goes, and the line is kept apart from
  // the line before, which would read it as part of its list or quote.
  // Otherwise Backspace is Markdown's (deleteMarkupBackward).
  function unmark() {
    const { state } = view;
    const { main } = state.selection;
    if (!editable || !main.empty) return false;
    const line = state.doc.lineAt(main.head);
    const marker = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)/.exec(line.text);
    if (!marker || line.from + marker[0].length !== main.head || inside('FencedCode') || inside('CodeBlock')) return false;
    if (marker[1] && !marker[2].startsWith('>')) return tab(-1);
    const apart = line.number > 1 && state.doc.line(line.number - 1).text.trim() ? '\n' : '';
    const changes = [{ from: line.from + marker[1].length, to: main.head }, { from: line.from, insert: apart }];
    view.dispatch({ changes, selection: { anchor: line.from + apart.length + marker[1].length }, userEvent: 'delete.backward' });
    return true;
  }

  // Tab and Shift+Tab: in a code block or a list item, indent and outdent the
  // lines the selection touches, by the block's own indent; in a table, go to
  // the next cell and the one before. Elsewhere Tab stays in the page.
  function tab(dir) {
    if (!editable) return false;
    const { state } = view;
    const table = inside('Table');
    if (table) {
      const head = state.selection.main.head;
      const pipes = [];
      table.cursor().iterate((node) => {
        if (node.name === 'TableDelimiter' && node.to - node.from === 1) pipes.push(node.from);
      });
      // A cell starts after a pipe that does not end its row, and a space.
      const starts = pipes.filter((p) => state.sliceDoc(p + 1, state.doc.lineAt(p).to).trim());
      const next = dir > 0 ? starts.find((p) => p >= head) : pipes.findLast((p) => p < head - 1);
      const cell = (p) => p + (state.sliceDoc(p + 1, p + 2) === ' ' ? 2 : 1);
      if (next !== undefined) view.dispatch({ selection: { anchor: dir > 0 ? cell(next) : Math.max(next - 1, state.doc.lineAt(next).from) } });
      return true;
    }
    const code = inside('FencedCode') ?? inside('CodeBlock');
    const item = inside('ListItem');
    if (!code && !item) return true;
    let unit;
    if (code) {
      const leads = state.sliceDoc(code.from, code.to).split('\n').map((l) => /^[ \t]*/.exec(l)[0]).filter(Boolean);
      unit = leads.some((l) => l.startsWith('\t')) ? '\t' : ' '.repeat(leads.length > 0 ? Math.min(...leads.map((l) => l.length)) : 2);
    } else {
      const marker = item.getChild('ListMark');
      unit = ' '.repeat(marker ? marker.to - marker.from + 1 : 2);
    }
    const changes = touched().flatMap((line) => {
      if (code?.name === 'FencedCode' && /^\s*(`{3,}|~{3,})/.test(line.text)) return []; // not its fences
      if (dir > 0) return [{ from: line.from, insert: unit }];
      const lead = /^[ \t]*/.exec(line.text)[0];
      const cut = lead.startsWith('\t') ? 1 : Math.min(lead.length, unit.length);
      return cut ? [{ from: line.from, to: line.from + cut }] : [];
    });
    if (changes.length > 0) view.dispatch({ changes, userEvent: dir > 0 ? 'input.indent' : 'delete.dedent' });
    return true;
  }

  /** What the toolbar reflects: the formatting and the block at the caret, and whether there is anything to undo or redo. */
  function formatState() {
    const active = new Set();
    let block = 'paragraph';
    const set = (name) => {
      if (block === 'paragraph') block = name;
    };
    let listed = false;
    for (const node of around()) {
      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (heading) set(`h${heading[1]}`);
      if (node.name === 'StrongEmphasis') active.add('bold');
      if (node.name === 'Emphasis') active.add('italic');
      if (node.name === 'Strikethrough') active.add('strike');
      if (node.name === 'InlineCode') active.add('code');
      if (node.name === 'Link') active.add('link');
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') set('codeBlock');
      if (node.name === 'Frontmatter') set('front_matter');
      if (node.name === 'Blockquote') set('quote');
      if (node.name === 'ListItem' && !listed) {
        listed = true;
        active.add(node.getChild('Task') ? 'tasks' : node.parent?.name === 'OrderedList' ? 'numbers' : 'bullets');
      }
    }
    active.add(block);
    return { active, block, canUndo: undoDepth(view.state) > 0, canRedo: redoDepth(view.state) > 0 };
  }

  // ---- links ----

  // The link at `pos`: { from, to, href, text, url }, for an inline or a
  // reference link, an autolink or a bare URL; null when none.
  function linkAt(pos) {
    const { state } = view;
    for (const side of [-1, 1]) {
      for (const node of around(pos, side)) {
        if (node.name === 'Link') {
          const marks = node.getChildren('LinkMark');
          const href = linkTarget(state, node);
          if (marks.length < 2 || href === null) return null;
          return { from: node.from, to: node.to, href, text: { from: marks[0].to, to: marks[1].from }, url: node.getChild('URL') };
        }
        if (node.name === 'Autolink' || (node.name === 'URL' && !/^(Link|Image|LinkReference|Autolink)$/.test(node.parent?.name ?? ''))) {
          const url = node.name === 'URL' ? node : node.getChild('URL');
          return { from: node.from, to: node.to, href: state.sliceDoc(url.from, url.to), text: null, url };
        }
      }
    }
    return null;
  }

  // A URL as Markdown writes it in a link: in `<…>` if it has spaces or brackets.
  const written = (href) => (/[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href);

  const rect = (from, to) => {
    const start = view.coordsAtPos(from, 1);
    const end = view.coordsAtPos(to, -1) ?? start;
    if (!start) return null;
    return { top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), left: Math.min(start.left, end.left), right: Math.max(start.right, end.right) };
  };

  /** Hold the link at the caret, or the selection, for the link popover; its href, or null for a new link. */
  function beginLink() {
    const { from, to, head } = view.state.selection.main;
    const link = linkAt(head);
    linkHeld = { from: link?.from ?? from, to: link?.to ?? to, link };
    return link?.href ?? null;
  }

  /** Finish the held link: `href` sets it, '' removes it, null cancels. A new link at a bare caret has its URL as its text. */
  function endLink(href) {
    const held = linkHeld;
    linkHeld = null;
    if (!held || href === null || !editable || inside('FencedCode') || inside('CodeBlock') || inside('InlineCode')) {
      view.focus();
      return;
    }
    const { state } = view;
    const { link, from, to } = held;
    let spec = null;
    if (link && !href) {
      // The link's text stays; its syntax goes.
      const kept = link.text ? state.sliceDoc(link.text.from, link.text.to) : state.sliceDoc(link.url.from, link.url.to);
      spec = { changes: { from: link.from, to: link.to, insert: kept }, selection: { anchor: link.from + kept.length } };
    } else if (link?.text && link.url) {
      spec = { changes: { from: link.url.from, to: link.url.to, insert: written(href) } }; // its title stays
    } else if (link?.text) {
      spec = { changes: { from: link.from, to: link.to, insert: `[${state.sliceDoc(link.text.from, link.text.to)}](${written(href)})` } };
    } else if (link) {
      spec = { changes: { from: link.from, to: link.to, insert: `<${href}>` } };
    } else if (href) {
      const insert = `[${state.sliceDoc(from, to) || href}](${written(href)})`;
      spec = { changes: { from, to, insert }, selection: { anchor: from + insert.length } };
    }
    if (spec) view.dispatch({ ...spec, userEvent: 'input.format', scrollIntoView: true });
    view.focus();
  }

  /** Make the first word of the info string on the fence line at `at` `tag` ('' none; null: as it is); the focus goes back to the text. */
  function setLanguage(at, tag) {
    const line = view.state.doc.lineAt(at);
    const [, fence, space, word] = /^(\s*(?:`{3,}|~{3,}))(\s*)(\S*)/.exec(line.text) ?? [];
    if (editable && fence && tag !== null && tag !== word) {
      const from = line.from + fence.length + space.length;
      view.dispatch({ changes: { from, to: from + word.length, insert: tag }, userEvent: 'input.format' });
    }
    view.focus();
  }

  /** Viewport rectangle of the held link, or null when none is held. */
  const linkRect = () => (linkHeld ? rect(linkHeld.from, linkHeld.to) : null);

  /** The link at the caret while the editor has focus and nothing is selected: { href, rect }, or null. */
  function caretLink() {
    const { main } = view.state.selection;
    if (!view.hasFocus || !main.empty) return null;
    const link = linkAt(main.head);
    const where = link && rect(link.from, link.to);
    return where ? { href: link.href, rect: where } : null;
  }

  // ---- outline ----

  /** The doc's headings, as a reader sees them: { level, text, pos }. */
  function headings() {
    const { state } = view;
    const result = [];
    syntaxTree(state).iterate({
      enter: ({ name, node }) => {
        const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
        if (!heading) return name === 'Document' || name === 'Body'; // the doc's own blocks only
        const marks = node.getChildren('HeaderMark');
        const atx = heading[1] === 'ATX';
        const from = atx ? (marks[0]?.to ?? node.from) : node.from;
        const to = atx ? (marks.length > 1 ? marks.at(-1).from : node.to) : state.doc.lineAt(node.to).from - 1;
        const shown = state.sliceDoc(from, to).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '').trim();
        if (shown) result.push({ level: Number(heading[2]), text: shown, pos: node.from });
        return false;
      },
    });
    return result;
  }

  function scrollToHeading(pos) {
    view.dispatch({ selection: { anchor: view.state.doc.lineAt(pos).to }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
    view.focus();
  }

  /** Scroll to the heading a `#fragment` link names, as GitHub names it; false when there is none. */
  function scrollToAnchor(fragment) {
    const slug = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const heading = headings().find((h) => slug(h.text) === decodeURIComponent(fragment).toLowerCase());
    if (heading) scrollToHeading(heading.pos);
    return Boolean(heading);
  }

  /** Viewport rectangle of the selection while the editor has focus, or null. */
  function selectionRect() {
    const { from, to, empty } = view.state.selection.main;
    const where = !empty && view.hasFocus && rect(from, to);
    return where ? { ...where, commentable: true } : null;
  }

  // The text the word count reads: the doc's, with what a reader does not see
  // (URLs, link labels and titles, a code block's language, HTML, front
  // matter) blanked, so offsets on it stay.
  function readerText() {
    const all = view.state.doc.toString().split('');
    syntaxTree(view.state).iterate({
      enter(node) {
        const bare = node.name === 'URL' && !/^(Link|Image|LinkReference)$/.test(node.parent?.name ?? '');
        if (bare || !/^(URL|LinkLabel|LinkTitle|CodeInfo|HTMLTag|HTMLBlock|Comment|CommentBlock|Frontmatter|LinkReference)$/.test(node.name)) return undefined;
        all.fill(' ', node.from, node.to);
        return false;
      },
    });
    return all.join('');
  }

  if (toolbar) {
    chrome = createChrome({
      run, formatState, getText: readerText, selection: editor.selection, headings, scrollToHeading, scrollToAnchor,
      selectionRect, beginLink, endLink, linkRect, caretLink, setLanguage, tops: editor.tops,
    }, { toolbar, stage, host, onComment, files, settings, saveSettings, editable });
  }

  return {
    ...editor,
    /** The view's settings changed. */
    applySettings: (next) => chrome?.applySettings(next),
    destroy() {
      chrome?.destroy();
      editor.destroy();
    },
  };
}
