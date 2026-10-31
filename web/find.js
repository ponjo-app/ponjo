// Find and replace, the same in every view: a bar at the top of the page
// (Mod+F; Mod+Alt+F with Replace), every match marked and the current one
// stronger. The view finds in what a reader sees and does the replacing, as
// the person's own edit (web/views/: each view makes its bar). Match case,
// Whole word and Regular expression (src/core/search.js) are one choice for
// every find bar and the sidebar's search (web/files.js), kept in this browser.

import { expand, searchPattern } from '../src/core/search.js';
import { hydrateIcons } from './icons.js';

const BAR = `
  <div class="pj-find" hidden>
    <div class="pj-find-box" role="search" aria-label="Find">
      <div class="pj-find-row">
        <input class="pj-find-input" type="text" autocomplete="off" spellcheck="false" aria-label="Find" placeholder="Find">
        <span class="pj-find-options"></span>
        <span class="pj-count pj-find-count" aria-live="polite"></span>
        <button type="button" class="pj-icon-btn" data-action="previous" data-icon="up" data-tip="Previous" data-keys="Mod+Shift+G" aria-label="Previous"></button>
        <button type="button" class="pj-icon-btn" data-action="next" data-icon="chevron" data-tip="Next" data-keys="Mod+G" aria-label="Next"></button>
        <button type="button" class="pj-icon-btn" data-action="close" data-icon="close" data-tip="Close" data-keys="Esc" aria-label="Close"></button>
      </div>
      <div class="pj-find-row" data-replace hidden>
        <input class="pj-find-input" type="text" autocomplete="off" spellcheck="false" aria-label="Replace with" placeholder="Replace with">
        <button type="button" class="pj-secondary" data-action="replace">Replace</button>
        <button type="button" class="pj-secondary" data-action="all">Replace all</button>
      </div>
    </div>
  </div>`;

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

const OPTIONS_KEY = 'ponjo.findOptions';
const OPTIONS = [['matchCase', 'Aa', 'Match case'], ['wholeWord', 'ab', 'Whole word'], ['regex', '.*', 'Regular expression']];
let options = { matchCase: false, wholeWord: false, regex: false };
try {
  const kept = JSON.parse(localStorage.getItem(OPTIONS_KEY)) ?? {};
  for (const [key] of OPTIONS) options[key] = kept[key] === true;
} catch {
  // no storage, or nothing kept: all off
}
const optionListeners = new Set();

/** Match case, Whole word and Regular expression, as now chosen: { matchCase, wholeWord, regex }. */
export const findOptions = () => options;

/** Choose some of the find options; every bar and the sidebar's search follow. */
export function setFindOptions(patch) {
  for (const [key] of OPTIONS) if (typeof patch?.[key] === 'boolean') options = { ...options, [key]: patch[key] };
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // no storage: chosen for this page
  }
  for (const listener of optionListeners) listener();
}

/**
 * The three option toggles into `box`, pressed as chosen; `onChange()`
 * hears every change of choice. Returns a function that takes them away.
 */
export function optionToggles(box, onChange) {
  const buttons = OPTIONS.map(([key, glyph, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pj-find-option';
    button.dataset.option = key;
    button.dataset.tip = label;
    button.setAttribute('aria-label', label);
    button.textContent = glyph;
    button.addEventListener('mousedown', (event) => event.preventDefault()); // the field keeps the focus
    button.addEventListener('click', () => setFindOptions({ [key]: !options[key] }));
    return button;
  });
  const paint = () => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(options[button.dataset.option]));
  };
  const listener = () => {
    paint();
    onChange();
  };
  paint();
  box.replaceChildren(...buttons);
  optionListeners.add(listener);
  return () => optionListeners.delete(listener);
}

/**
 * A find bar for a view, over its `host` (the view's `.pj-editor`).
 * `search` is the view's: `find(pattern)` marks every match of `pattern`
 * (src/core/search.js: matches; null finds nothing) and answers
 * `{ count, current }` (current: which one is selected, from 1; 0 for none),
 * `step(back)` selects the next or previous one, `reveal(at)` the first at or
 * after text offset `at`, `replace(textFor, all)` puts `textFor(match)` for
 * the selected match (then selects the next) or for every one, all four
 * answering as `find` does; `selected()` is the selected text, and `focus()`
 * gives the text the focus back. A view that cannot be edited (`editable`
 * false) has no Replace.
 */
export function createFind(search, { host, editable }) {
  const template = document.createElement('template');
  template.innerHTML = BAR;
  hydrateIcons(template.content);
  const bar = template.content.firstElementChild;
  host.before(bar);
  const [input, replacement] = bar.querySelectorAll('input');
  const row = bar.querySelector('[data-replace]');
  const count = bar.querySelector('.pj-find-count');

  const show = ({ count: n, current }) => {
    count.textContent = !input.value || input.hasAttribute('aria-invalid') ? '' : n === 0 ? 'No results' : current ? `${current} of ${n}` : `${n} found`;
  };
  const find = () => {
    const pattern = searchPattern(input.value, findOptions());
    input.toggleAttribute('aria-invalid', Boolean(input.value) && !pattern);
    show(search.find(pattern));
  };
  const replace = (all) => {
    const text = replacement.value;
    show(search.replace((match) => (findOptions().regex ? expand(text, match) : text), all));
  };
  const stopOptions = optionToggles(bar.querySelector('.pj-find-options'), () => {
    if (!bar.hidden) find();
  });

  function open(replacing) {
    const selected = search.selected();
    if (selected && !selected.includes('\n')) input.value = selected;
    bar.hidden = false;
    row.hidden = !(editable && (replacing || !row.hidden));
    find();
    input.select();
    (replacing && editable ? replacement : input).focus();
  }

  function close() {
    bar.hidden = true;
    search.find(null);
    search.focus();
  }

  bar.addEventListener('input', (event) => {
    if (event.target === input) find();
  });
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      show(search.step(event.shiftKey));
    } else if (event.key === 'Enter' && event.target === replacement) {
      event.preventDefault();
      replace(mac ? event.metaKey : event.ctrlKey);
    }
  });
  // Mod+F (Mod+Alt+F: with Replace), Mod+G and Mod+Shift+G (the next and
  // previous match), in the text or the bar; in a view that cannot be edited
  // the text never has the focus, only the selection.
  const done = new AbortController();
  document.addEventListener('keydown', (event) => {
    const here = [document.activeElement, getSelection()?.anchorNode].some((node) => host.contains(node) || bar.contains(node));
    if (!here || !(mac ? event.metaKey : event.ctrlKey) || !['KeyF', 'KeyG'].includes(event.code) || (event.code === 'KeyF' && event.shiftKey)) return;
    event.preventDefault();
    if (event.code === 'KeyF') open(event.altKey);
    else if (bar.hidden) open(false);
    else show(search.step(event.shiftKey));
  }, { capture: true, signal: done.signal });
  // The buttons act without taking the focus from the field.
  bar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });
  bar.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'close') close();
    else if (action === 'next' || action === 'previous') show(search.step(action === 'previous'));
    else if (action === 'replace' || action === 'all') replace(action === 'all');
  });

  return {
    /** The text changed: find again, while the bar is open. */
    changed() {
      if (!bar.hidden && input.value) find();
    },
    /** Open the bar on `query` and select its first match at or after text offset `at`. */
    open(query, at) {
      input.value = query;
      bar.hidden = false;
      find();
      show(search.reveal(at));
      input.focus();
    },
    destroy() {
      done.abort();
      stopOptions();
      bar.remove();
    },
  };
}
