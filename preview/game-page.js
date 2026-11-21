// What the game pages (site/poker.html, site/werewolf.html) share: the
// model their AI players run on, with the card for the visitor's own key;
// and the log's messages, as a chat app shows them. Their markup and
// styles are poker.css's .pk-setup and .pk-feed.

/* global document */

import { INFER } from '../agents/ponjo-core.mjs';

export const $ = (selector, root = document) => root.querySelector(selector);
export const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

// What the visitor keeps in this browser, or null.
export function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? null;
  } catch {
    return null;
  }
}
export function store(value, key) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
}

// ---- the model ----

const SAVED = 'ponjo-poker'; // the visitor's own provider, key and model, for every game page (poker's name, from before there were others)
const HOSTED = 'https://infer.ponjo.app/infer/anthropic'; // Ponjo's key and model, for ponjo.app's pages only

/**
 * The model the AI players run on: Claude Haiku through infer.ponjo.app
 * (relay/worker.js), which holds Ponjo's key; or, with a visitor's own key,
 * kept in this browser and sent only to their model's provider, on the
 * model they pick. Wires the page's .pk-setup card, and calls `onUse` once
 * the visitor picks. Returns { infer, open, draw }: `infer()` is the model
 * now, as INFER (agents/ponjo-core.mjs) gives it; `open` shows the card;
 * `draw` says in .pk-model what the players run on.
 */
export function models(onUse) {
  const setup = $('.pk-setup');
  let settings = load(SAVED); // or null for Ponjo's
  let provider = settings?.provider ?? 'anthropic';
  let model = settings?.provider === 'anthropic' ? settings.model : 'claude-haiku-5-5';
  const forget = el('button', 'pj-link-button pk-forget', 'Forget my key and play on Ponjo\'s');
  forget.type = 'button';

  const pick = (attr, value) => {
    for (const b of setup.querySelectorAll(`[${attr}]`)) b.setAttribute('aria-checked', String(b.getAttribute(attr) === value));
  };
  function drawSetup() {
    pick('data-provider', provider);
    pick('data-model', model);
    for (const f of setup.querySelectorAll('[data-for]')) f.hidden = f.dataset.for !== provider;
    const endpoint = setup.elements.endpoint.value || setup.elements.endpoint.placeholder;
    let host = 'api.anthropic.com';
    if (provider === 'openai') try { host = new URL(endpoint).host; } catch { host = 'the base URL above'; }
    $('[data-host]', setup).textContent = host;
    const key = setup.elements.key;
    key.required = !(settings && settings.provider === provider);
    key.placeholder = settings?.provider === provider ? `••••••••${settings.key.slice(-4)}` : provider === 'anthropic' ? 'sk-ant-…' : '';
  }
  function open() {
    if (settings?.provider) provider = settings.provider;
    if (settings?.provider === 'openai') {
      setup.elements.endpoint.value = settings.endpoint;
      setup.elements.model.value = settings.model;
    }
    setup.elements.key.value = '';
    $('.pk-error', setup).hidden = true;
    forget.hidden = !settings;
    drawSetup();
    setup.hidden = false;
    document.body.classList.add('pk-setting-up');
    setup.elements.key.focus();
  }
  const close = () => {
    setup.hidden = true;
    document.body.classList.remove('pk-setting-up');
  };
  function draw() {
    $('.pk-model').textContent = !settings ? 'The players run on Claude Haiku 5.5.' : `The players run on ${settings.provider === 'anthropic' ? `Claude ${$(`[data-model="${settings.model}"]`, setup).textContent}` : settings.model}, with your key.`;
    $('[data-action="key"]').textContent = settings ? 'Change' : 'Use your own key';
  }
  // From now on the players run on `next`, the visitor's own, or null for Ponjo's.
  function use(next) {
    settings = next;
    store(settings, SAVED);
    close();
    draw();
    onUse();
  }

  setup.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="cancel"]')) return close();
    const b = event.target.closest('[data-provider], [data-model]');
    if (!b) return;
    if (b.dataset.provider) provider = b.dataset.provider;
    if (b.dataset.model) model = b.dataset.model;
    drawSetup();
  });
  setup.elements.endpoint.addEventListener('input', drawSetup);
  setup.addEventListener('submit', (event) => {
    event.preventDefault();
    const f = setup.elements;
    const key = f.key.value.trim() || (settings?.provider === provider ? settings.key : '');
    const error = $('.pk-error', setup);
    if (!key) {
      error.textContent = 'Paste an API key.';
      error.hidden = false;
      return;
    }
    use(provider === 'openai'
      ? { provider, key, endpoint: f.endpoint.value.trim() || f.endpoint.placeholder, model: f.model.value.trim() || f.model.placeholder }
      : { provider, key, model });
  });
  forget.addEventListener('click', () => use(null));
  $('.pk-error', setup).after(forget);

  const infer = () => (!settings ? INFER.anthropic({ model: 'claude-haiku-5-5', key: 'ponjo' }, HOSTED) // the Worker sets the key, model and effort
    : settings.provider === 'openai' ? INFER.openai({ endpoint: settings.endpoint, model: settings.model, key: settings.key })
      : INFER.anthropic({ model: settings.model, key: settings.key, effort: 'low' }));
  return { infer, open, draw };
}

// ---- the log ----

/**
 * A message: the page's own player's on the right (`mine`); others' on the
 * left with their `face` and, first in a run of theirs (not `more`), their
 * `name`. A `note` after the name says to whom or what it is ("last words").
 * A name or a note is text, or nodes (a page's own marks beside the words).
 */
export function message({ face, name, text, note = '', mine = false, more = false }) {
  const item = el('li', 'pk-msg');
  if (more) item.dataset.more = '';
  const col = el('div', 'pk-msg-col');
  if (mine) item.dataset.mine = '';
  else item.append(face);
  if (!more && (!mine || note)) {
    const head = el('span', 'pk-msg-name');
    if (!mine) head.append(...[name].flat());
    if (note) {
      const small = el('small');
      small.append(...[note].flat());
      head.append(small);
    }
    col.append(head);
  }
  col.append(el('div', 'pk-msg-text', text));
  item.append(col);
  return item;
}

// A player typing: a message of three dots.
export function typingMessage(face, name) {
  const row = message({ face, name, text: '' });
  row.classList.add('pk-typing');
  const dots = $('.pk-msg-text', row);
  dots.append(el('i'), el('i'), el('i'));
  dots.setAttribute('aria-label', `${name} is typing`);
  return row;
}

// A line from the game itself, not a player: a dealer's, a game master's.
export const notice = (text) => el('li', 'pk-dealer', text);
