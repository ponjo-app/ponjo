// Live preview: decorations over the Markdown text, from its syntax tree.
// Away from the lines the selection touches the syntax is hidden and blocks
// are drawn; on them the source shows, its marks faded. Out of focus, no line
// is being edited, so the whole doc is drawn. Nothing here changes the text.
// Tables and diagrams are drawn in place of their lines (a state field, as
// block decorations must be); everything else only for the lines on screen.

import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { diagramDom, forgetDiagram } from '../../diagrams.js';

const INDENT_EM = 1.5; // one list level, and a list marker's width
// The nodes blocks are in: the doc (its Markdown is the front matter
// parser's Body), quotes and lists.
const CONTAINERS = new Set(['Document', 'Body', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

// Whether the person has been in the editor, or put the selection somewhere
// (the find bar does): until then, as a doc opens, nothing is being edited.
// After, the selection's lines stay source out of focus too, as the caret
// stays drawn: drawn again, a table or a link the caret is in would push it out.
const setFocus = StateEffect.define();
const engagedField = StateField.define({
  create: () => false,
  update: (engaged, tr) => engaged || Boolean(tr.selection) || tr.effects.some((e) => e.is(setFocus) && e.value),
});

// While the pointer is down, the lines being edited stay those they were
// when it was pressed: drawn as source under it, a code block or a table
// takes another height and would move the text the press is selecting. They
// follow the selection once it is let go.
const setHeld = StateEffect.define();
const heldField = StateField.define({
  create: () => null,
  update: (held, tr) => tr.effects.reduce((h, e) => (e.is(setHeld) ? e.value : h), held),
});

const hold = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || view.state.field(heldField)) return false;
    view.dispatch({ effects: setHeld.of(activeLines(view.state)) });
    // After the editor has taken the release (it may select once more on it).
    const release = () => setTimeout(() => {
      window.removeEventListener('mouseup', release);
      window.removeEventListener('blur', release);
      if (view.state.field(heldField)) view.dispatch({ effects: setHeld.of(null) });
    });
    window.addEventListener('mouseup', release);
    window.addEventListener('blur', release);
    return false;
  },
});

/**
 * The numbers of the lines the selection touches, once the person has been
 * in the editor, and every line of a table it touches: a table shows as its
 * source whole. None in a read-only view.
 */
function activeLines(state) {
  const held = state.field(heldField);
  if (held) return held;
  const lines = new Set();
  if (state.readOnly || !state.field(engagedField)) return lines;
  const { doc } = state;
  for (const range of state.selection.ranges) {
    let [from, to] = [range.from, range.to];
    for (const end of [range.from, range.to]) {
      for (let node = syntaxTree(state).resolveInner(end, 1); node; node = node.parent) {
        if (node.name !== 'Table') continue;
        from = Math.min(from, node.from);
        to = Math.max(to, node.to);
      }
    }
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) lines.add(n);
  }
  return lines;
}

// ---- what the text means ----

const decoder = document.createElement('textarea');
const decodeEntity = (entity) => {
  decoder.innerHTML = entity;
  return decoder.value;
};

// A link label as CommonMark matches it: case and runs of space don't count.
const normalLabel = (label) => label.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

const referencesOf = new WeakMap(); // tree → its references
/**
 * The doc's link definitions (`[label]: url`) by label, and its footnotes
 * numbered in the order they are first referenced.
 */
function references(state) {
  const tree = syntaxTree(state);
  let refs = referencesOf.get(tree);
  if (refs) return refs;
  const links = new Map();
  tree.iterate({
    enter(node) {
      if (CONTAINERS.has(node.name)) return undefined;
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel');
        const url = node.node.getChild('URL');
        const key = label && normalLabel(state.sliceDoc(label.from, label.to));
        if (url && !links.has(key)) links.set(key, state.sliceDoc(url.from, url.to).replace(/^<|>$/g, ''));
      }
      return false;
    },
  });
  const notes = new Map();
  for (const [, label] of state.doc.toString().matchAll(/\[\^([^\]\s^]+)\](?!:)/g)) {
    const key = label.toLowerCase();
    if (!notes.has(key)) notes.set(key, notes.size + 1);
  }
  refs = { links, notes };
  referencesOf.set(tree, refs);
  return refs;
}

const noteNumber = (state, label) => references(state).notes.get(label.replace(/^\[\^|\]:?\s*$/g, '').toLowerCase()) ?? '?';

/**
 * Where a link goes: its URL, or its definition's; null for a `[text]` no
 * definition names, which is not a link.
 */
export function linkTarget(state, node) {
  const url = node.getChild('URL');
  if (url) return state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '');
  const label = node.getChild('LinkLabel');
  const marks = node.getChildren('LinkMark');
  const text = label && label.to - label.from > 2 ? state.sliceDoc(label.from, label.to) : state.sliceDoc(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
  return references(state).links.get(normalLabel(text)) ?? null;
}

// ---- widgets ----

class Text extends WidgetType {
  constructor(text, className) {
    super();
    Object.assign(this, { text, className });
  }

  eq(other) {
    return other.text === this.text && other.className === this.className;
  }

  toDOM() {
    return Object.assign(document.createElement('span'), { className: this.className, textContent: this.text });
  }
}

// A task's box: a click ticks it, typing `x` or a space into the text.
class Checkbox extends WidgetType {
  constructor(checked, at, className) {
    super();
    Object.assign(this, { checked, at, className });
  }

  eq(other) {
    return other.checked === this.checked && other.at === this.at && other.className === this.className;
  }

  toDOM(view) {
    const wrap = Object.assign(document.createElement('span'), { className: this.className });
    const box = Object.assign(document.createElement('span'), { className: `pj-md-check${this.checked ? ' pj-md-checked' : ''}` });
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (!view.state.readOnly) view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' } });
    });
    wrap.append(box);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

class Image extends WidgetType {
  constructor(src, alt, url) {
    super();
    Object.assign(this, { src, alt, url });
  }

  eq(other) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM() {
    const img = Object.assign(document.createElement('img'), { className: 'pj-md-img', alt: this.alt });
    this.url(this.src).then((url) => url && (img.src = url));
    const wrap = Object.assign(document.createElement('span'), { className: 'pj-md-image' });
    wrap.append(img);
    return wrap;
  }
}

// A block drawn in place of its lines; a click puts the caret at its start, showing its source.
class Block extends WidgetType {
  constructor(key, at, render, forget = () => {}) {
    super();
    Object.assign(this, { key, at, render, forget });
  }

  eq(other) {
    return other.key === this.key && other.at === this.at;
  }

  toDOM(view) {
    const dom = this.render();
    dom.addEventListener('mousedown', (event) => {
      if (event.target.closest('a') || view.state.readOnly) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.at } });
      view.focus();
    });
    return dom;
  }

  destroy(dom) {
    this.forget(dom);
  }

  ignoreEvent() {
    return true;
  }
}

// ---- inline Markdown drawn as HTML: a table's cells ----

function inlineInto(state, node, from, to, parent) {
  let pos = from;
  const text = (a, b) => {
    if (b > a) parent.append(state.sliceDoc(a, b));
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    text(pos, child.from);
    pos = child.to;
    parent.append(inlineElement(state, child));
  }
  text(pos, to);
}

function inlineElement(state, node) {
  const el = (tag, className) => Object.assign(document.createElement(tag), className ? { className } : {});
  const between = (markName, tag) => {
    const marks = node.getChildren(markName);
    const out = el(tag);
    inlineInto(state, node, marks[0]?.to ?? node.from, marks.at(-1)?.from ?? node.to, out);
    return out;
  };
  switch (node.name) {
    case 'StrongEmphasis': return between('EmphasisMark', 'strong');
    case 'Emphasis': return between('EmphasisMark', 'em');
    case 'Strikethrough': return between('StrikethroughMark', 's');
    case 'InlineCode': {
      const marks = node.getChildren('CodeMark');
      return Object.assign(el('code'), { textContent: state.sliceDoc(marks[0]?.to ?? node.from, marks.at(-1)?.from ?? node.to).trim() });
    }
    case 'Link': {
      const href = linkTarget(state, node);
      const marks = node.getChildren('LinkMark');
      const out = href === null ? el('span') : Object.assign(el('a'), { href });
      inlineInto(state, node, marks[0]?.to ?? node.from, marks[1]?.from ?? node.to, out);
      return out;
    }
    case 'Autolink': case 'URL': {
      const url = node.name === 'URL' ? node : node.getChild('URL');
      return Object.assign(el('a'), { textContent: state.sliceDoc(url?.from ?? node.from, url?.to ?? node.to) });
    }
    case 'Escape': return document.createTextNode(state.sliceDoc(node.from + 1, node.to));
    case 'Entity': return document.createTextNode(decodeEntity(state.sliceDoc(node.from, node.to)));
    case 'HardBreak': return el('br');
    case 'FootnoteReference': return Object.assign(el('sup', 'pj-md-fnref'), { textContent: noteNumber(state, state.sliceDoc(node.from, node.to)) });
    default: return Object.assign(el('span', 'pj-md-muted'), { textContent: state.sliceDoc(node.from, node.to) });
  }
}

// A table row's cells, split at its pipes: an empty cell has no node.
function rowCells(row) {
  const pipes = row.getChildren('TableDelimiter');
  const bounds = [row.from, ...pipes.flatMap((p) => [p.from, p.to]), row.to];
  const segments = [];
  for (let i = 0; i < bounds.length; i += 2) segments.push({ from: bounds[i], to: bounds[i + 1] });
  if (pipes[0]?.from === row.from) segments.shift();
  if (pipes.at(-1)?.to === row.to) segments.pop();
  const cells = row.getChildren('TableCell');
  return segments.map((s) => cells.find((c) => c.from >= s.from && c.to <= s.to) ?? null);
}

function tableDom(state, table) {
  const delimiter = table.getChildren('TableDelimiter')[0];
  const align = delimiter ? state.sliceDoc(delimiter.from, delimiter.to).replace(/^\s*\||\|\s*$/g, '').split('|')
    .map((d) => d.trim()).map((d) => (d.endsWith(':') ? (d.startsWith(':') ? 'center' : 'right') : 'left')) : [];
  const dom = Object.assign(document.createElement('table'), { className: 'pj-md-table' });
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
    const cells = rowCells(row);
    // A header with no text (`| | |`), as tables of terms have, is not drawn.
    if (row.name === 'TableHeader' && cells.every((cell) => !cell || !state.sliceDoc(cell.from, cell.to).trim())) continue;
    const tr = dom.insertRow();
    cells.forEach((cell, k) => {
      const td = document.createElement(row.name === 'TableHeader' ? 'th' : 'td');
      if (cell) inlineInto(state, cell, cell.from, cell.to, td);
      td.style.textAlign = align[k] ?? 'left';
      tr.append(td);
    });
  }
  const wrap = Object.assign(document.createElement('div'), { className: 'pj-md-block' });
  wrap.append(dom);
  return wrap;
}

// ---- the decorations ----

const hide = Decoration.replace({});
const faded = Decoration.mark({ class: 'pj-md-mark' });
const lineClass = (className) => Decoration.line({ class: className });
const mark = (className, attributes) => Decoration.mark({ class: className, attributes });
// Not words: code, URLs, HTML and front matter are not spell checked.
const VERBATIM = { spellcheck: 'false' };

const ancestors = (node, name) => {
  let n = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === name) n++;
  return n;
};

// The whole lines a block takes, when only spaces come before it on its first line; else null.
function wholeLines(doc, node) {
  const first = doc.lineAt(node.from);
  if (doc.sliceString(first.from, node.from).trim()) return null;
  return { from: first.from, to: doc.lineAt(node.to).to };
}

// Tables, and diagrams if `diagrams`, drawn in place of their lines while the selection is not on them.
function blocks(state, diagrams) {
  const tree = syntaxTree(state);
  const active = activeLines(state);
  const { doc } = state;
  const on = ({ from, to }) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) if (active.has(n)) return true;
    return false;
  };
  const ranges = [];
  tree.iterate({
    enter(node) {
      if (CONTAINERS.has(node.name)) return undefined;
      const lines = (node.name === 'Table' || node.name === 'FencedCode') && wholeLines(doc, node);
      if (!lines || on(lines)) return false;
      if (node.name === 'Table') {
        const table = node.node;
        const source = doc.sliceString(node.from, node.to);
        ranges.push(Decoration.replace({ widget: new Block(`table:${source}`, node.from, () => tableDom(state, table)), block: true }).range(lines.from, lines.to));
      } else if (diagrams) {
        const info = node.node.getChild('CodeInfo');
        const text = node.node.getChild('CodeText');
        if (info && doc.sliceString(info.from, info.to).trim() === 'mermaid') {
          const source = text ? doc.sliceString(text.from, text.to) : '';
          ranges.push(Decoration.replace({ widget: new Block(`mermaid:${source}`, node.from, () => diagramDom(source), forgetDiagram), block: true }).range(lines.from, lines.to));
        }
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

// Everything else, for the lines from `from` to `to`.
function inline(state, from, to, image) {
  const tree = syntaxTree(state);
  const active = activeLines(state);
  const { doc } = state;
  const lineOf = (pos) => doc.lineAt(pos).number;
  const on = (a, b = a) => {
    for (let n = lineOf(a); n <= lineOf(b); n++) if (active.has(n)) return true;
    return false;
  };
  const ranges = [];
  const add = (a, b, deco) => ranges.push(deco.range(a, b));
  // A line decoration on each line from `a` to `b` that is in [from, to].
  // (A block that ends at a line's start, as front matter does, ends on the line before.)
  const eachLine = (a, b, deco) => {
    const last = b > a && doc.lineAt(b).from === b ? b - 1 : b;
    for (let n = lineOf(Math.max(a, from)); n <= lineOf(Math.min(last, to)); n++) add(doc.line(n).from, doc.line(n).from, deco);
  };
  const withSpace = (at) => (doc.sliceString(at, at + 1) === ' ' ? at + 1 : at);
  const codeLines = (a, b) => {
    const last = doc.lineAt(b > a && doc.lineAt(b).from === b ? b - 1 : b);
    eachLine(a, b, Decoration.line({ class: 'pj-md-codeblock', attributes: VERBATIM }));
    if (doc.lineAt(a).from >= from) add(doc.lineAt(a).from, doc.lineAt(a).from, lineClass('pj-md-codeblock-first'));
    if (last.from <= to) add(last.from, last.from, lineClass('pj-md-codeblock-last'));
  };

  tree.iterate({
    from,
    to,
    enter(node) {
      const { name, from: a, to: b } = node;
      const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        eachLine(a, heading[1] === 'Setext' ? doc.lineAt(b).from - 1 : a, lineClass(`pj-md-h pj-md-h${heading[2]}`));
        return undefined;
      }
      switch (name) {
        case 'HeaderMark':
          if (node.node.parent?.name.startsWith('Setext') || on(a)) add(a, b, faded);
          else add(a, withSpace(b), hide);
          return undefined;
        case 'Emphasis': add(a, b, mark('pj-md-em')); return undefined;
        case 'StrongEmphasis': add(a, b, mark('pj-md-strong')); return undefined;
        case 'Strikethrough': add(a, b, mark('pj-md-strike')); return undefined;
        case 'InlineCode': add(a, b, mark('pj-md-code', VERBATIM)); return undefined;
        case 'EmphasisMark': case 'StrikethroughMark': add(a, b, on(a) ? faded : hide); return undefined;
        case 'CodeMark': add(a, b, node.node.parent?.name === 'InlineCode' && !on(a) ? hide : faded); return undefined;
        case 'CodeInfo': add(a, b, faded); return undefined;
        case 'Escape': if (!on(a)) add(a, a + 1, hide); return undefined;
        case 'Entity':
          add(a, b, on(a) ? faded : Decoration.replace({ widget: new Text(decodeEntity(doc.sliceString(a, b)), '') }));
          return undefined;
        case 'Link': {
          const href = linkTarget(state, node.node);
          if (href === null) return false; // `[text]` no definition names is text
          add(a, b, mark('pj-md-link', { 'data-href': href }));
          const marks = node.node.getChildren('LinkMark');
          if (on(a, b)) {
            for (const part of [...marks, ...['URL', 'LinkLabel', 'LinkTitle'].flatMap((n) => node.node.getChildren(n))]) add(part.from, part.to, faded);
          } else if (marks.length >= 2) {
            add(marks[0].from, marks[0].to, hide);
            add(marks[1].from, b, hide);
          }
          return undefined; // its text may hold emphasis or code
        }
        case 'Autolink': {
          const url = node.node.getChild('URL');
          add(a, b, mark('pj-md-link', { 'data-href': url ? doc.sliceString(url.from, url.to) : '', ...VERBATIM }));
          for (const m of node.node.getChildren('LinkMark')) add(m.from, m.to, on(a) ? faded : hide);
          return false;
        }
        case 'URL':
          if (/^(Link|Image|LinkReference)$/.test(node.node.parent?.name)) add(a, b, mark('', VERBATIM));
          else add(a, b, mark('pj-md-link', { 'data-href': doc.sliceString(a, b), ...VERBATIM }));
          return undefined;
        case 'Image': {
          if (on(a, b)) {
            add(a, b, mark('pj-md-muted', VERBATIM));
            return false;
          }
          const url = node.node.getChild('URL');
          const src = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : linkTarget(state, node.node);
          const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(a, b))?.[1] ?? '';
          if (src) add(a, b, Decoration.replace({ widget: new Image(src, alt, image) }));
          return false;
        }
        case 'LinkReference': add(a, b, mark('pj-md-muted', VERBATIM)); return false;
        case 'FootnoteReference':
          add(a, b, on(a) ? faded : Decoration.replace({ widget: new Text(String(noteNumber(state, doc.sliceString(a, b))), 'pj-md-fnref') }));
          return undefined;
        case 'FootnoteDefinition': eachLine(a, b, lineClass('pj-md-footnote')); return undefined;
        case 'FootnoteLabel':
          add(a, b, on(a) ? faded : Decoration.replace({ widget: new Text(`${noteNumber(state, doc.sliceString(a, b))}.`, 'pj-md-fnlabel') }));
          return undefined;
        case 'ListMark': {
          const item = node.node.parent;
          if (on(a)) add(a, b, mark('pj-md-listmark'));
          else if (item?.getChild('Task')) add(a, withSpace(b), hide);
          else {
            const ordered = item?.parent?.name === 'OrderedList';
            add(a, withSpace(b), Decoration.replace({ widget: new Text(ordered ? doc.sliceString(a, b) : '•', ordered ? 'pj-md-marker pj-md-number' : 'pj-md-marker') }));
          }
          return undefined;
        }
        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(a, b));
          const off = !on(a);
          add(a, off ? withSpace(b) : b, Decoration.replace({ widget: new Checkbox(checked, a, off ? 'pj-md-marker' : 'pj-md-check-wrap') }));
          const task = node.node.parent;
          if (checked && task && b + 1 < task.to) add(b + 1, task.to, mark('pj-md-done'));
          return undefined;
        }
        case 'Blockquote': eachLine(a, b, lineClass(`pj-md-quote pj-md-quote-d${Math.min(ancestors(node.node, 'Blockquote') + 1, 3)}`)); return undefined;
        case 'QuoteMark': if (on(a)) add(a, b, faded); else add(a, withSpace(b), hide); return undefined;
        case 'CodeBlock': codeLines(a, b); return undefined;
        case 'FencedCode':
          codeLines(a, b);
          // Its fences show only while the selection is in it; else their lines are its padding.
          if (!on(a, b)) {
            const fences = [doc.lineAt(a), doc.lineAt(b)].filter((l, i, both) => (i === 0 || l.number !== both[0].number) && /^\s*(`{3,}|~{3,})/.test(l.text) && l.from >= from && l.from <= to);
            for (const line of fences) {
              add(line.from, line.from, lineClass('pj-md-fence'));
              add(line.from, line.to, hide);
            }
          }
          return undefined;
        case 'HorizontalRule':
          add(a, b, on(a) ? faded : Decoration.replace({ widget: new Text('', 'pj-md-hr') }));
          return undefined;
        case 'Table': eachLine(a, b, lineClass('pj-md-table-src')); return undefined;
        case 'TableDelimiter': add(a, b, faded); return undefined;
        case 'HTMLBlock': case 'CommentBlock': case 'ProcessingInstructionBlock': case 'HTMLTag': case 'Comment':
          add(a, b, mark('pj-md-muted', VERBATIM));
          return false;
        case 'Paragraph':
          // A backslash at a line's end is a hard break: drawn as the break alone.
          for (let n = lineOf(Math.max(a, from)); n < lineOf(b) && n <= lineOf(to); n++) {
            const line = doc.line(n);
            if (!active.has(n) && /(^|[^\\])(\\\\)*\\$/.test(line.text)) add(line.to - 1, line.to, hide);
          }
          return undefined;
        case 'Frontmatter': eachLine(a, b, Decoration.line({ class: 'pj-md-frontmatter', attributes: VERBATIM })); return false;
        default: return undefined;
      }
    },
  });

  // List lines not being edited: indented by their level, a wrapped line
  // hanging under its item's text; a quote in an item has its bar there.
  for (let n = lineOf(from); n <= lineOf(to); n++) {
    if (active.has(n)) continue;
    const line = doc.line(n);
    const lead = /^[ \t]*/.exec(line.text)[0].length;
    if (lead === line.length) continue;
    let item = null;
    let quoted = false;
    for (let node = tree.resolveInner(line.from + lead, 1); node && !item; node = node.parent) {
      if (node.name === 'ListItem') item = node;
      else if (node.name === 'Blockquote') quoted = true;
      else if (/^(FencedCode|CodeBlock|Table|HTMLBlock)$/.test(node.name)) break;
    }
    if (!item) continue;
    const pad = (ancestors(item, 'ListItem') + 1) * INDENT_EM;
    const style = quoted ? `--pj-indent: ${pad}em` : `padding-left: ${pad}em; text-indent: ${lineOf(item.from) === n ? -INDENT_EM : 0}em`;
    add(line.from, line.from, Decoration.line({ attributes: { style } }));
    if (lead > 0) add(line.from, line.from + lead, hide);
  }

  // The caret's block, which focus mode does not fade (app.css).
  const head = state.selection.main.head;
  let top = tree.resolveInner(head, 1);
  while (top.parent && top.parent.name !== 'Document') top = top.parent;
  const current = top.name === 'Document' ? doc.lineAt(head) : top;
  eachLine(current.from, current.to, lineClass('pj-current'));

  return Decoration.set(ranges, true);
}

/**
 * The live preview. `image(src)` gives the URL to show an image at `src`
 * (one on the web is shown as it is); `diagrams` draws mermaid blocks.
 */
export function livePreview({ image, diagrams = true }) {
  const urls = new Map(); // an image's URL by its src, asked for once
  const imageUrl = (src) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(src)) return Promise.resolve(src);
    if (!urls.has(src)) urls.set(src, image(src).catch(() => null));
    return urls.get(src);
  };
  const changed = (tr) => tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus) || e.is(setHeld)) || syntaxTree(tr.state) !== syntaxTree(tr.startState);

  const blockField = StateField.define({
    create: (state) => blocks(state, diagrams),
    update: (set, tr) => (changed(tr) ? blocks(tr.state, diagrams) : set),
    provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
  });

  const inlinePlugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = inline(view.state, view.viewport.from, view.viewport.to, imageUrl);
    }

    update(update) {
      if (update.viewportChanged || update.transactions.some(changed)) this.decorations = inline(update.state, update.view.viewport.from, update.view.viewport.to, imageUrl);
    }
  }, { decorations: (plugin) => plugin.decorations });

  // Hidden syntax and drawn widgets are atomic: the caret steps over them.
  const hidden = (view) => {
    const set = view.plugin(inlinePlugin)?.decorations ?? Decoration.none;
    const ranges = [];
    set.between(0, view.state.doc.length, (from, to, deco) => {
      if (from < to && (deco.spec.widget || deco === hide)) ranges.push(deco.range(from, to));
    });
    return RangeSet.of(ranges, true);
  };

  return [
    engagedField,
    heldField,
    hold,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    blockField,
    inlinePlugin,
    EditorView.atomicRanges.of(hidden),
  ];
}
