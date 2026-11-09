// A GFM table drawn as a grid and edited a cell at a time (#364). A click on
// a cell edits it in place: its own text, a range of the doc's, in a box
// that types into that range, its `|` typed escaped. Tab and Shift+Tab go
// to the next cell and the one before, Enter and the arrows to the cell
// below or above (past the last row, Tab and Enter add one), Escape leaves
// the table. The ⋯ menu adds and deletes rows and columns, aligns a column,
// or edits the table as its source. The pipes are typed as written, never
// lined up again, so the rows no one changed keep their bytes.

import { redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { WidgetType } from '@codemirror/view';
import { hydrateIcons } from '../../icons.js';

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const ALIGN = { left: ':---', center: ':---:', right: '---:' };

// ---- the table in the text ----

// A row's cells between its pipes at `pipes`: { from, to }, outer pipes left out.
function segments(from, to, pipes) {
  const bounds = [from, ...pipes.flatMap((p) => [p, p + 1]), to];
  const segs = [];
  for (let i = 0; i < bounds.length; i += 2) segs.push({ from: bounds[i], to: bounds[i + 1] });
  if (pipes[0] === from) segs.shift();
  if (pipes.at(-1) === to - 1) segs.pop();
  return segs;
}

/** The table starting at `at`: its rows (the header first) with their cells, its delimiter row, its columns' alignment. */
function tableAt(state, at) {
  let table = null;
  syntaxTree(state).iterate({ from: at, to: at, enter: (n) => (table ? false : n.name === 'Table' && n.from === at ? void (table = n.node) : undefined) });
  if (!table) return null;
  const rows = [];
  let delimiter = null;
  for (let n = table.firstChild; n; n = n.nextSibling) {
    if (n.name === 'TableHeader' || n.name === 'TableRow') {
      const cells = n.getChildren('TableCell');
      const segs = segments(n.from, n.to, n.getChildren('TableDelimiter').map((p) => p.from));
      rows.push({ from: n.from, to: n.to, cells: segs.map((s) => ({ ...s, node: cells.find((c) => c.from >= s.from && c.to <= s.to) ?? null })) });
    } else if (n.name === 'TableDelimiter' && !delimiter) {
      const text = state.sliceDoc(n.from, n.to);
      const pipes = [...text].flatMap((ch, i) => (ch === '|' ? [n.from + i] : []));
      delimiter = { from: n.from, to: n.to, cells: segments(n.from, n.to, pipes) };
    }
  }
  if (!delimiter || rows.length === 0) return null;
  const aligns = delimiter.cells.map((s) => {
    const d = state.sliceDoc(s.from, s.to).trim();
    return d.endsWith(':') ? (d.startsWith(':') ? 'center' : 'right') : 'left';
  });
  return { from: table.from, to: table.to, rows, delimiter, aligns, outer: state.sliceDoc(rows[0].from, rows[0].from + 1) === '|' };
}

const cellText = (state, cell) => (cell?.node ? state.sliceDoc(cell.node.from, cell.node.to) : '');

/** The spaces around a cell's text, kept while it is edited: { lead, trail }; an empty cell's are one space each. */
function padsOf(state, cell) {
  const text = cell ? state.sliceDoc(cell.from, cell.to) : '';
  if (!text.trim()) return { lead: ' ', trail: ' ' };
  const [, lead, , trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return { lead, trail };
}

/** The text of a cell edited with `pads`: its source between them. */
function editedText(state, cell, { lead, trail }) {
  const text = cell ? state.sliceDoc(cell.from, cell.to) : '';
  if (!text.trim()) return '';
  const start = text.startsWith(lead) ? lead.length : 0;
  const end = text.endsWith(trail) && text.length - trail.length >= start ? text.length - trail.length : text.length;
  return text.slice(start, end);
}

// Type `text` into cell `c` of row `r`, between its `pads`: only what changed.
function writeCell(view, at, r, c, text, pads) {
  const { state } = view;
  const table = tableAt(state, at);
  const row = table?.rows[r];
  if (!row) return;
  const cell = row.cells[c];
  let change;
  if (cell) {
    const old = state.sliceDoc(cell.from, cell.to);
    const next = text || old.trim() ? `${pads.lead}${text}${pads.trail}` : old;
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let end = 0;
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
    change = { from: cell.from + start, to: cell.to - end, insert: next.slice(start, next.length - end) };
  } else {
    if (!text) return;
    const missing = c - row.cells.length;
    change = { from: row.to, insert: table.outer ? `${'   |'.repeat(missing)} ${text} |` : `${' |  '.repeat(missing)} | ${text}` };
  }
  if (change.from !== change.to || change.insert) view.dispatch({ changes: change, userEvent: 'input.type' });
}

// The changes an operation of the ⋯ menu makes on `table`, at cell (r, c), and the cell to edit after it.
function operation(state, table, op, r, c) {
  const columns = table.aligns.length;
  const doc = state.doc;
  const empty = table.outer ? `|${'   |'.repeat(columns)}` : Array(columns).fill('   ').join('|');
  const lines = [...table.rows, table.delimiter];
  switch (op) {
    case 'rowAbove': return { changes: { from: doc.lineAt(table.rows[r].from).from, insert: `${empty}\n` }, r, c };
    case 'rowBelow': return { changes: { from: doc.lineAt(r === 0 ? table.delimiter.from : table.rows[r].from).to, insert: `\n${empty}` }, r: r + 1, c };
    case 'deleteRow': {
      const line = doc.lineAt(table.rows[r].from);
      return { changes: { from: line.from - 1, to: line.to }, r: Math.min(r, table.rows.length - 2), c };
    }
    case 'columnLeft': case 'columnRight': {
      const k = op === 'columnLeft' ? c : c + 1;
      const changes = lines.map((line) => {
        const text = line === table.delimiter ? ' --- ' : '   ';
        if (k < line.cells.length) return { from: line.cells[k].from, insert: `${text}|` };
        return { from: line.to, insert: table.outer ? `${text}|` : `|${text}` };
      });
      return { changes, r, c: k };
    }
    case 'deleteColumn': {
      const changes = lines.flatMap((line) => {
        const seg = line.cells[c];
        if (!seg) return [];
        const last = c === line.cells.length - 1 && !table.outer;
        return [last ? { from: seg.from - 1, to: seg.to } : { from: seg.from, to: seg.to + 1 }];
      });
      return { changes, r, c: Math.min(c, columns - 2) };
    }
    default: { // alignLeft, alignCenter, alignRight
      const seg = table.delimiter.cells[c];
      return { changes: { from: seg.from, to: seg.to, insert: ` ${ALIGN[op.slice(5).toLowerCase()]} ` }, r, c };
    }
  }
}

// ---- the grid ----

const MENU = [
  ['rowAbove', 'Insert row above'], ['rowBelow', 'Insert row below'], ['columnLeft', 'Insert column left'], ['columnRight', 'Insert column right'],
  ['deleteRow', 'Delete row'], ['deleteColumn', 'Delete column'],
  ['alignLeft', 'Align column left'], ['alignCenter', 'Align column center'], ['alignRight', 'Align column right'],
  ['source', 'Edit as Markdown'],
];

/**
 * A table drawn in place of its lines (`at` its start), its cells' inline
 * Markdown drawn by `draw(state, node, element)`. Its element keeps the cell
 * being edited ({ r, c, box }) through the table's text changing.
 */
export class TableGrid extends WidgetType {
  constructor(source, at, state, draw) {
    super();
    Object.assign(this, { source, at, state, draw });
  }

  eq(other) {
    return other.source === this.source && other.at === this.at;
  }

  toDOM(view) {
    const wrap = Object.assign(document.createElement('div'), { className: 'pj-md-block pj-md-grid' });
    Object.assign(wrap, { pjView: view, pjDraw: this.draw, pjEdit: null, pjShape: '' });
    render(wrap, this.state, this.at);
    return wrap;
  }

  updateDOM(dom) {
    if (!dom.classList.contains('pj-md-grid')) return false;
    render(dom, this.state, this.at);
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

// Draw the table at `at` in `wrap`: in place when only its text changed
// (the cell being edited is never moved, as an input method may be
// composing in it), anew when its rows or columns did.
function render(wrap, state, at) {
  const table = tableAt(state, at);
  if (!table) return;
  const edit = wrap.pjEdit;
  // A header with no text, as tables of terms have, is not drawn, but while the table is edited.
  const bare = !edit && table.rows[0].cells.every((cell) => !cellText(state, cell).trim());
  const shape = `${table.rows.length}x${table.aligns.length}${bare ? '-' : ''}${edit ? `@${edit.r},${edit.c}` : ''}`;
  const grid = wrap.querySelector('table');
  const rebuild = !grid || wrap.pjShape !== shape;
  const focused = edit && document.activeElement === edit.box;
  const [start, end] = edit ? [edit.box.selectionStart, edit.box.selectionEnd] : [0, 0];
  wrap.pjRendering = true;
  const dom = rebuild ? Object.assign(document.createElement('table'), { className: 'pj-md-table' }) : grid;
  table.rows.forEach((row, r) => {
    if (r === 0 && bare) return;
    const tr = rebuild ? dom.insertRow() : dom.rows[r - (bare ? 1 : 0)];
    for (let c = 0; c < table.aligns.length; c++) {
      let cell = tr.cells[c];
      if (rebuild) {
        cell = document.createElement(r === 0 ? 'th' : 'td');
        cell.addEventListener('mousedown', (event) => {
          if (event.target.closest('a') || wrap.pjView.state.readOnly || event.target === wrap.pjEdit?.box) return;
          event.preventDefault();
          editCell(wrap, r, c, clickedAt(event));
        });
        tr.append(cell);
      }
      cell.style.textAlign = table.aligns[c];
      if (edit && edit.r === r && edit.c === c) {
        const text = editedText(state, row.cells[c], edit.pads);
        if (edit.box.value !== text) edit.box.value = text;
        if (edit.box.parentElement !== cell) cell.replaceChildren(edit.box);
        cell.classList.add('pj-md-editing');
      } else {
        cell.replaceChildren();
        cell.classList.remove('pj-md-editing');
        if (row.cells[c]?.node) wrap.pjDraw(state, row.cells[c].node, cell);
      }
    }
  });
  if (rebuild) {
    wrap.replaceChildren(dom);
    if (edit && !wrap.pjView.state.readOnly) wrap.append(menuButton(wrap));
    wrap.pjShape = shape;
  }
  if (focused && document.activeElement !== edit.box) {
    edit.box.focus();
    edit.box.setSelectionRange(Math.min(start, edit.box.value.length), Math.min(end, edit.box.value.length));
  }
  wrap.pjRendering = false;
}

const refresh = (wrap) => render(wrap, wrap.pjView.state, wrap.pjView.posAtDOM(wrap));
const tableOf = (wrap) => tableAt(wrap.pjView.state, wrap.pjView.posAtDOM(wrap));

// The doc's position of the character a click on a drawn cell lands at
// (its text says where it came from: preview.js `sourced`), or 'end' for a
// click on no text.
function clickedAt(event) {
  const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = point?.startContainer;
  if (!node || node.pjFrom === undefined) return 'end';
  return Math.min(node.pjFrom + point.startOffset, node.pjTo);
}

/**
 * Edit cell (r, c) of the table drawn in `wrap`, the caret at its end, at
 * its start (`caret` 'start'), or at the doc's position `caret`.
 */
function editCell(wrap, r, c, caret = 'end') {
  const box = wrap.pjEdit?.box ?? makeBox(wrap);
  const table = tableOf(wrap);
  const cell = table?.rows[r]?.cells[c];
  wrap.pjEdit = { r, c, box, pads: padsOf(wrap.pjView.state, cell) };
  refresh(wrap);
  box.focus();
  const at = caret === 'start' ? 0
    : typeof caret === 'number' && cell ? Math.max(0, Math.min(caret - cell.from - wrap.pjEdit.pads.lead.length, box.value.length))
    : box.value.length;
  box.setSelectionRange(at, at);
  box.scrollIntoView({ block: 'nearest' });
}

function endEdit(wrap) {
  if (!wrap.pjEdit) return;
  wrap.pjEdit = null;
  wrap.querySelector('.pj-md-table-menu')?.remove();
  refresh(wrap);
}

// The box a cell is edited in.
function makeBox(wrap) {
  const view = wrap.pjView;
  const box = Object.assign(document.createElement('textarea'), { className: 'pj-md-cell', rows: 1, spellcheck: true });
  box.setAttribute('aria-label', 'Table cell');
  box.addEventListener('input', () => {
    // A cell is one line, and a `|` typed in it is text.
    const text = box.value.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
    if (text !== box.value) {
      const caret = box.selectionStart + text.length - box.value.length;
      box.value = text;
      box.setSelectionRange(caret, caret);
    }
    const { r, c, pads } = wrap.pjEdit;
    writeCell(view, view.posAtDOM(wrap), r, c, text, pads);
  });
  box.addEventListener('blur', () => {
    if (!wrap.pjRendering) setTimeout(() => document.activeElement !== box && endEdit(wrap));
  });
  box.addEventListener('keydown', (event) => keydown(wrap, event));
  return box;
}

// Leave the table, the caret on the line above it or below it.
function leave(wrap, dir) {
  const view = wrap.pjView;
  const table = tableOf(wrap);
  const { doc } = view.state;
  endEdit(wrap);
  if (!table) return;
  const pos = dir < 0 ? (table.from > 0 ? doc.lineAt(table.from - 1).to : table.from) : Math.min(doc.lineAt(table.to).to + 1, doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function keydown(wrap, event) {
  const view = wrap.pjView;
  const { r, c, box } = wrap.pjEdit;
  const table = tableOf(wrap);
  if (!table || event.isComposing) return;
  const last = table.rows.length - 1;
  const columns = table.aligns.length;
  const mod = mac ? event.metaKey : event.ctrlKey;
  const handled = () => event.preventDefault();
  const addRow = (col) => {
    run(wrap, 'rowBelow', last, col);
  };
  if (event.key === 'Tab') {
    handled();
    if (event.shiftKey) {
      if (c > 0) editCell(wrap, r, c - 1);
      else if (r > 0) editCell(wrap, r - 1, columns - 1);
    } else if (c < columns - 1) editCell(wrap, r, c + 1);
    else if (r < last) editCell(wrap, r + 1, 0);
    else addRow(0);
  } else if (event.key === 'Enter') {
    handled();
    if (r < last) editCell(wrap, r + 1, c);
    else addRow(c);
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    handled();
    const next = r + (event.key === 'ArrowUp' ? -1 : 1);
    if (next < 0 || next > last) leave(wrap, next < 0 ? -1 : 1);
    else editCell(wrap, next, c);
  } else if (event.key === 'ArrowLeft' && box.selectionStart === 0 && box.selectionEnd === 0 && !event.shiftKey) {
    handled();
    if (c > 0) editCell(wrap, r, c - 1);
    else if (r > 0) editCell(wrap, r - 1, columns - 1);
  } else if (event.key === 'ArrowRight' && box.selectionStart === box.value.length && box.selectionEnd === box.value.length && !event.shiftKey) {
    handled();
    if (c < columns - 1) editCell(wrap, r, c + 1, 'start');
    else if (r < last) editCell(wrap, r + 1, 0, 'start');
  } else if (event.key === 'Escape') {
    handled();
    leave(wrap, 1);
  } else if (mod && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
    handled();
    (event.key.toLowerCase() === 'y' || event.shiftKey ? redo : undo)(view);
  } else if (mod && !event.altKey && !event.shiftKey && ['b', 'i', 'e'].includes(event.key.toLowerCase())) {
    // Bold, italic and inline code wrap what is selected in the cell, as in the text.
    handled();
    const marker = { b: '**', i: '*', e: '`' }[event.key.toLowerCase()];
    const [from, to] = [box.selectionStart, box.selectionEnd];
    box.setRangeText(`${marker}${box.value.slice(from, to)}${marker}`, from, to);
    box.setSelectionRange(from + marker.length, to + marker.length);
    box.dispatchEvent(new Event('input'));
  }
}

// Run an operation of the ⋯ menu at cell (r, c), then edit the cell it leaves the caret in.
function run(wrap, op, r, c) {
  const view = wrap.pjView;
  const table = tableOf(wrap);
  if (!table) return;
  if (op === 'source') {
    endEdit(wrap);
    const cell = table.rows[r]?.cells[c];
    view.dispatch({ selection: { anchor: cell?.node?.to ?? cell?.from ?? table.from } });
    view.focus();
    return;
  }
  const done = operation(view.state, table, op, r, c);
  wrap.pjEdit = { ...wrap.pjEdit, r: done.r, c: done.c };
  view.dispatch({ changes: done.changes, userEvent: 'input.format' });
  editCell(wrap, done.r, done.c);
}

// The ⋯ button at the table's top right, while a cell is edited, and its menu.
function menuButton(wrap) {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'pj-md-table-menu' });
  button.dataset.icon = 'more';
  button.dataset.tip = 'Table';
  button.setAttribute('aria-label', 'Table');
  button.setAttribute('aria-haspopup', 'menu');
  const menu = Object.assign(document.createElement('ul'), { className: 'pj-block-menu', hidden: true });
  menu.setAttribute('role', 'menu');
  const holder = Object.assign(document.createElement('span'), { className: 'pj-md-table-tools' });
  holder.append(button, menu);
  hydrateIcons(holder);
  button.addEventListener('mousedown', (event) => {
    event.preventDefault(); // the cell keeps the focus
    const table = tableOf(wrap);
    if (!table || !wrap.pjEdit) return;
    const { r } = wrap.pjEdit;
    const off = { rowAbove: r === 0, deleteRow: r === 0, deleteColumn: table.aligns.length < 2 };
    menu.replaceChildren(...MENU.map(([op, label]) => {
      const item = Object.assign(document.createElement('li'), { textContent: label });
      item.setAttribute('role', 'menuitem');
      if (off[op]) item.setAttribute('aria-disabled', 'true');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (off[op] || !wrap.pjEdit) return;
        menu.hidden = true;
        run(wrap, op, wrap.pjEdit.r, wrap.pjEdit.c);
      });
      return item;
    }));
    menu.hidden = !menu.hidden;
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, rect.right - 220)}px`;
  });
  return holder;
}

/**
 * Arrow down on the line above a drawn table, or up on the line below it,
 * edits its first cell or its last row's: the caret goes into the table
 * as it goes into any line.
 */
export function enterTable(view, dir) {
  const { main } = view.state.selection;
  if (!main.empty) return false;
  const line = view.state.doc.lineAt(main.head);
  const next = dir > 0 ? line.to + 1 : line.from - 1;
  if (next < 0 || next > view.state.doc.length) return false;
  const target = view.state.doc.lineAt(next);
  const wrap = [...view.contentDOM.querySelectorAll('.pj-md-grid')].find((el) => {
    const at = view.posAtDOM(el);
    const table = tableAt(view.state, at);
    return table && (dir > 0 ? at === target.from : view.state.doc.lineAt(table.to).number === target.number);
  });
  if (!wrap) return false;
  editCell(wrap, dir > 0 ? 0 : tableOf(wrap).rows.length - 1, 0);
  return true;
}
