// Asking a buddy from the doc's text (docs/user-experience.md, Who asks
// whom): typing @ offers the buddies, as a comment box does, and one picked
// is armed, a chip. Once the caret is on another line and no key has come
// for ASK_MS, its line is asked: `onAsk({ from, to, names })`, the line
// without the space around it and the buddies armed on it. The wait starts
// over with each key and ends when the caret is back on the line; it is
// paused, to go on from where it was, while a composition is open or the
// editor has no focus (another app, a dialog, a comment box). Escape
// disarms; Mod+Enter asks at once.
// Only a name picked is armed: one typed out, pasted or already there is text.

import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, ViewPlugin, keymap } from '@codemirror/view';
import { buddyColor } from '../faces.js';
import { MENTION_BEFORE_CARET, fillMentionMenu } from '../threads.js';

const ASK_MS = 3000;
const arm = StateEffect.define(); // { from, to, id, name }, in the doc after the change
const disarm = StateEffect.define(); // the starts of those to disarm, or null for all

// The armed names, each from its @ to its end; one typed over is armed no more.
const armedField = StateField.define({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(arm)) next = next.update({ add: [Decoration.mark({ id: effect.value.id, name: effect.value.name }).range(effect.value.from, effect.value.to)] });
      if (effect.is(disarm)) next = effect.value ? next.update({ filter: (from) => !effect.value.includes(from) }) : Decoration.none;
    }
    return tr.docChanged ? next.update({ filter: (from, to, mark) => tr.state.sliceDoc(from, to) === `@${mark.spec.name}` }) : next;
  },
});

/**
 * The extension: `choices(query)` are the buddies @`query` offers
 * ([{ id, name, kind, group, tagline? }]); the menu is put in `stage`.
 */
export function asking({ stage, choices, onAsk }) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.decorations = Decoration.none;
      this.timer = 0;
      this.waiting = []; // the starts of the armed names off the caret's line: their wait is on, or paused
      this.left = ASK_MS; // of the wait
      this.since = 0; // when it last went on; 0 while paused
      this.waits = 0; // how many times the wait changed: each draws its chips again, so their countdown runs from where it is
      this.composing = false;
      this.at = null; // the @ the menu is open for
      this.dismissed = null; // the @ whose menu Escape closed
      this.offered = [];
      this.selected = 0;
      this.menu = document.createElement('ul');
      this.menu.className = 'pj-mentions pj-mentions-caret';
      this.menu.setAttribute('role', 'listbox');
      this.menu.hidden = true;
      stage.append(this.menu);
    }

    update(update) {
      const { view } = update;
      // The person's own keys and moves, not what others' edits change.
      const mine = (tr) => tr.docChanged && tr.annotation(Transaction.addToHistory) !== false;
      const key = update.transactions.some((tr) => mine(tr) || (tr.selection && !tr.isUserEvent('select.pointer')) || tr.effects.some((e) => e.is(arm)));
      const acted = key || update.focusChanged || this.composing !== view.composing || update.transactions.some((tr) => tr.selection || tr.effects.some((e) => e.is(disarm)));
      this.composing = view.composing;
      if (acted) this.wait(key);
      else if (update.docChanged) this.draw();
      if (acted) this.offer(update.transactions.some(mine));
    }

    // The armed names off the caret's line (`all`: every one).
    due(all = false) {
      const { state } = this.view;
      const found = [];
      const caret = state.doc.lineAt(state.selection.main.head).number;
      state.field(armedField).between(0, state.doc.length, (from, to, mark) => {
        const line = state.doc.lineAt(from);
        if (all || line.number !== caret) found.push({ from, to, line, name: mark.spec.name });
      });
      return found;
    }

    // The wait as it is now; `over`: a key came, so it starts over.
    wait(over) {
      clearTimeout(this.timer);
      if (this.since) this.left -= Date.now() - this.since;
      this.waiting = this.due().map((d) => d.from);
      if (over || this.waiting.length === 0) this.left = ASK_MS;
      this.since = this.waiting.length > 0 && this.view.hasFocus && !this.view.composing ? Date.now() : 0;
      if (this.since) this.timer = setTimeout(() => this.send(), this.left);
      this.waits += 1;
      this.draw();
    }

    draw() {
      const { state } = this.view;
      const ranges = [];
      state.field(armedField).between(0, state.doc.length, (from, to, mark) => {
        const waiting = this.waiting.includes(from);
        ranges.push(Decoration.mark({
          class: `pj-at pj-at-agent pj-ask${waiting ? (this.since ? ' pj-ask-counting' : ' pj-ask-paused') : ''}`,
          attributes: { style: `--buddy: ${buddyColor(mark.spec.id)}; --ask: ${this.left}ms; --ask-left: ${(100 * this.left) / ASK_MS}%`, ...(waiting ? { 'data-wait': String(this.waits) } : {}) },
        }).range(from, to));
      });
      this.decorations = Decoration.set(ranges);
    }

    // Ask each line with an armed name due (`all`: every one), once.
    send(all = false) {
      clearTimeout(this.timer);
      const asks = new Map();
      const due = this.due(all);
      for (const { line, name } of due) {
        const from = line.from + line.text.length - line.text.trimStart().length;
        const ask = asks.get(line.from) ?? { from, to: line.from + line.text.trimEnd().length, names: [] };
        if (!ask.names.includes(name)) ask.names.push(name);
        asks.set(line.from, ask);
      }
      if (due.length === 0) return false;
      this.view.dispatch({ effects: disarm.of(due.map((d) => d.from)) });
      for (const ask of asks.values()) onAsk(ask);
      return true;
    }

    // The menu for the @name being typed before the caret; `typed`: a key
    // opened it, a move of the caret only keeps it.
    offer(typed) {
      const { state } = this.view;
      const { head, empty } = state.selection.main;
      const line = state.doc.lineAt(head);
      const match = empty && this.view.hasFocus && (typed || this.at !== null) && line.text.slice(0, head - line.from).match(MENTION_BEFORE_CARET);
      const at = match ? head - match[2].length - 1 : null;
      if (at !== this.dismissed) this.dismissed = null;
      this.offered = at === null || at === this.dismissed ? [] : choices(match[2]);
      this.at = this.offered.length > 0 ? at : null;
      this.selected = 0;
      this.fill();
      if (this.at !== null) {
        this.view.requestMeasure({
          read: (view) => ({ caret: view.coordsAtPos(this.at), box: stage.getBoundingClientRect() }),
          write: ({ caret, box }) => {
            if (!caret) return;
            this.menu.style.left = `${caret.left - box.left}px`;
            this.menu.style.top = `${caret.bottom - box.top}px`;
          },
        });
      }
    }

    fill() {
      fillMentionMenu(this.menu, this.offered, this.selected, (choice) => this.pick(choice));
    }

    step(by) {
      this.selected = (this.selected + by + this.offered.length) % this.offered.length;
      this.fill();
    }

    pick({ id, name } = this.offered[this.selected]) {
      const from = this.at;
      const insert = `@${name} `;
      this.view.dispatch({
        changes: { from, to: this.view.state.selection.main.head, insert },
        selection: { anchor: from + insert.length },
        effects: arm.of({ from, to: from + insert.length - 1, id, name }),
        userEvent: 'input.complete',
      });
      this.view.focus();
    }

    // Escape: the menu first, then the armed names.
    cancel() {
      if (this.at !== null) {
        this.dismissed = this.at;
        this.offer(false);
        return true;
      }
      if (this.view.state.field(armedField).size === 0) return false;
      this.view.dispatch({ effects: disarm.of(null) });
      return true;
    }

    destroy() {
      clearTimeout(this.timer);
      this.menu.remove();
    }
  }, { decorations: (instance) => instance.decorations });

  const open = (run) => (view) => {
    const instance = view.plugin(plugin);
    if (instance.at === null) return false;
    run(instance);
    return true;
  };
  return [
    armedField, plugin,
    Prec.highest(keymap.of([
      { key: 'ArrowDown', run: open((instance) => instance.step(1)) },
      { key: 'ArrowUp', run: open((instance) => instance.step(-1)) },
      { key: 'Enter', run: open((instance) => instance.pick()) },
      { key: 'Tab', run: open((instance) => instance.pick()) },
      { key: 'Escape', run: (view) => view.plugin(plugin).cancel() },
      { key: 'Mod-Enter', run: (view) => view.plugin(plugin).send(true) },
    ])),
  ];
}
