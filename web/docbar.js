// The doc's status bar, under the page for every view: on the left what the
// view says (the plain view's caret place) and the doc's word count, on the
// right which buddies are at work, or else which watch the doc, and while
// some watch it the steps they have left to wake each other, then the
// view's own buttons. The view fills its parts in (web/views/plain/status.js).

import { avatar } from './threads.js';

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

/** How many words `text` holds, in any script. */
export function wordCount(text) {
  let count = 0;
  for (const part of words.segment(text)) if (part.isWordLike) count++;
  return count;
}

const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

/**
 * The bar `bar` (index.html's `.pj-docbar`). `setWords(text, selection)`
 * counts the doc's words, and the selection's ({ from, to }) when there is
 * one, or with `text` null shows none (a view of code or plain text);
 * `setAgents(statuses)` shows the buddies at work, or else those watching;
 * `setSteps({ left, cap, next })` the steps they have left (doc-service.js,
 * stepsView). `onRefill()` refills them, and `canRefill()` says whether this
 * window may.
 */
export function createDocBar(bar, { onRefill = () => {}, canRefill = () => false } = {}) {
  const count = bar.querySelector('.pj-status-words');
  const workingPart = bar.querySelector('.pj-working');
  const workingText = workingPart.querySelector('.pj-working-text');
  const watchingPart = bar.querySelector('.pj-watching');
  const stepsPart = bar.querySelector('.pj-steps');
  let total = null; // the doc's words, null when none are counted
  let watchers = 0;
  let steps = { left: 0, cap: 0, next: null };
  let ticking = null;

  // The steps, while some buddy watches: how many are left, or, with none,
  // when the next comes, and Refill.
  function paintSteps() {
    clearInterval(ticking);
    stepsPart.hidden = watchers === 0;
    if (!watchers) return;
    if (steps.left > 0) {
      stepsPart.replaceChildren(`· ${steps.left} ${steps.left === 1 ? 'step' : 'steps'}`);
      return;
    }
    const text = document.createTextNode('');
    const tick = () => {
      const s = steps.next === null ? null : Math.max(0, Math.ceil((steps.next - Date.now()) / 1000));
      text.textContent = s === null ? '· Out of steps' : `· Out of steps · next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    if (steps.next !== null) ticking = setInterval(tick, 1000);
    const refill = document.createElement('button');
    refill.type = 'button';
    refill.textContent = 'Refill';
    refill.hidden = !canRefill();
    refill.addEventListener('click', () => onRefill());
    stepsPart.replaceChildren(text, refill);
  }

  return {
    setWords(text, selection) {
      total = text === null ? null : wordCount(text);
      this.setSelection(text, selection);
    },
    /** Only the selection moved: the doc's count stands. */
    setSelection(text, selection) {
      count.hidden = total === null;
      if (total === null) return;
      const of = (n) => `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
      const picked = selection && selection.from !== selection.to ? wordCount(text.slice(Math.min(selection.from, selection.to), Math.max(selection.from, selection.to))) : null;
      count.textContent = picked === null ? of(total) : `${picked.toLocaleString()} of ${of(total)}`;
    },
    setAgents(agents) {
      const working = (agents ?? []).filter((a) => a.threadIds.length > 0);
      const watching = (agents ?? []).filter((a) => a.watching);
      workingPart.hidden = working.length === 0;
      workingText.textContent = working.length ? `${listed(working.map((a) => a.name))} ${working.length === 1 ? 'is' : 'are'} working…` : '';
      watchingPart.hidden = working.length > 0 || watching.length === 0;
      watchingPart.replaceChildren(...watching.slice(0, 1).map((a) => avatar(a.name, 'agent', true, a.id)), `${listed(watching.map((a) => a.name))} ${watching.length === 1 ? 'is' : 'are'} watching`);
      watchers = watching.length;
      paintSteps();
    },
    setSteps(next) {
      steps = next ?? steps;
      paintSteps();
    },
  };
}
