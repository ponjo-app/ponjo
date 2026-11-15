// Asking a buddy from the doc's text (docs/user-experience.md, Who asks
// whom): typing @ offers the buddies, as a comment box does, and one picked
// is armed, a chip. Once the caret has been off its line for ASK_MS, the
// line is asked: `onAsk({ from, to, names })`, the line without the space
// around it and the buddies armed on it. Each line waits on its own: typing
// elsewhere leaves its wait alone, the caret back on it ends it, and it is
// paused, to go on from where it was, while a composition is open or the
// editor has no focus (another app, a dialog, a comment box). A chip asked
// pulses until `onAsk`'s promise settles, the buddy done. Escape disarms
// those not asked yet; Mod+Enter asks them at once.
// Only a name picked is armed: one typed out, pasted or already there is text.

import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, ViewPlugin, keymap } from '@codemirror/view';
import { buddyColor } from '../faces.js';
import { MENTION_BEFORE_CARET, fillMentionMenu } from '../threads.js';

const ASK_MS = 3000;
const arm = StateEffect.define(); // { from, to, id, name }, in the doc after the change
const disarm = StateEffect.define(); // the keys of those to disarm

// The armed names, each from its @ to its end, with a `key` of its own; one typed over is armed no more.
const armedField = StateField.define({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(arm)) next = next.update({ add: [Decoration.mark({ id: effect.value.id, name: effect.value.name, key: {} }).range(effect.value.from, effect.value.to)] });
      if (effect.is(disarm)) next = next.update({ filter: (_from, _to, mark) => !effect.value.includes(mark.spec.key) });
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
      this.waits = new Map(); // an armed name's key → { left: of its wait, since: when it last went on (0: not running), off: the caret is off its line, sent }
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
      const mine = update.transactions.some((tr) => tr.docChanged && tr.annotation(Transaction.addToHistory) !== false);
      const acted = update.transactions.length > 0 || update.focusChanged || this.composing !== update.view.composing;
      this.composing = update.view.composing;
      if (!acted) return;
      this.wait();
      if (mine || update.selectionSet || update.focusChanged) this.offer(mine);
    }

    // The armed names, where they are now.
    armed() {
      const { state } = this.view;
      const found = [];
      state.field(armedField).between(0, state.doc.length, (from, to, { spec }) => {
        found.push({ from, to, line: state.doc.lineAt(from), ...spec });
      });
      return found;
    }

    // Each wait as it is now; those that ran out are asked.
    wait() {
      clearTimeout(this.timer);
      const now = Date.now();
      const armed = this.armed();
      const running = this.view.hasFocus && !this.view.composing;
      const caret = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
      for (const key of this.waits.keys()) if (!armed.some((a) => a.key === key)) this.waits.delete(key);
      for (const { key, line } of armed) {
        const wait = this.waits.get(key) ?? { left: ASK_MS, since: 0, off: false, sent: false };
        this.waits.set(key, wait);
        if (wait.sent) continue;
        if (wait.since) wait.left -= now - wait.since;
        wait.off = line.number !== caret;
        if (!wait.off) wait.left = ASK_MS;
        wait.since = wait.off && running ? now : 0;
      }
      const due = (a) => this.waits.get(a.key).since && this.waits.get(a.key).left <= 0;
      this.send(armed.filter((a) => armed.some((other) => due(other) && other.line.from === a.line.from)));
      const next = Math.min(...[...this.waits.values()].filter((wait) => wait.since).map((wait) => wait.left));
      if (next < Infinity) this.timer = setTimeout(() => this.again(), next);
      this.draw(armed);
    }

    // From outside an update: the chips are drawn again.
    again() {
      this.wait();
      this.view.dispatch({});
    }

    draw(armed) {
      this.decorations = Decoration.set(armed.map(({ from, to, id, key }) => {
        const { left, since, off, sent } = this.waits.get(key);
        return Decoration.mark({
          class: `pj-at pj-at-agent pj-ask${sent ? ' pj-ask-sent' : off ? (since ? ' pj-ask-counting' : ' pj-ask-paused') : ''}`,
          attributes: { style: `--buddy: ${buddyColor(id)}; --ask: ${left}ms; --ask-left: ${(100 * left) / ASK_MS}%` },
        }).range(from, to);
      }));
    }

    // Ask the lines of `names` (armed names) not asked yet, each once; their chips stay until the buddies are done.
    send(names) {
      const asks = new Map();
      for (const { line, name, key } of names.filter((a) => !this.waits.get(a.key).sent)) {
        Object.assign(this.waits.get(key), { sent: true, since: 0 });
        const from = line.from + line.text.length - line.text.trimStart().length;
        const ask = asks.get(line.from) ?? { from, to: line.from + line.text.trimEnd().length, names: [], keys: [] };
        if (!ask.names.includes(name)) ask.names.push(name);
        ask.keys.push(key);
        asks.set(line.from, ask);
      }
      for (const { keys, ...ask } of asks.values()) {
        Promise.resolve().then(() => onAsk(ask)).catch(() => {}).then(() => this.view.dispatch({ effects: disarm.of(keys) }));
      }
      return asks.size > 0;
    }

    // Mod+Enter: every one not asked yet, now.
    sendAll() {
      const sent = this.send(this.armed());
      if (sent) this.again();
      return sent;
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

    // Escape: the menu first, then the armed names not asked yet.
    cancel() {
      if (this.at !== null) {
        this.dismissed = this.at;
        this.offer(false);
        return true;
      }
      const keys = this.armed().filter((a) => !this.waits.get(a.key).sent).map((a) => a.key);
      if (keys.length > 0) this.view.dispatch({ effects: disarm.of(keys) });
      return keys.length > 0;
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
      { key: 'Mod-Enter', run: (view) => view.plugin(plugin).sendAll() },
    ])),
  ];
}
