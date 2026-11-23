// What the game pages (site/poker.html, site/werewolf.html, site/spy.html)
// share: the model their AI players run on in the table's room, with the
// card for the visitor's own key; the log's messages, as a chat app shows them; and the
// votes round a table, as arrows. Their markup and styles are poker.css's
// .pk-setup and .pk-feed, and werewolf.css's .ww-votes.

/* global document */

import { keep, load } from './game-kit.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

// ---- the model ----

const SAVED = 'ponjo-poker'; // the visitor's own provider, key and model, for every game page (poker's name, from before there were others)

/**
 * The model the AI players run on, in the table's room (relay/table.js):
 * Claude Haiku on Ponjo's key, which never leaves the relay; or, with a
 * visitor's own key, kept in this browser and given to the room of a table
 * they opened, which holds it in memory only and calls their model's
 * provider with it, on the model they pick. Wires the page's .pk-setup
 * card, and calls `onUse` once the visitor picks. Returns { key, open,
 * draw }: `key()` is the visitor's settings, or null for Ponjo's; `open`
 * shows the card; `draw(ai)` says in .pk-model what the players run on (on
 * a `friend`'s page, the host's), and what the room says of them (`aiNote`).
 */
export function models(onUse, friend) {
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
  function draw(ai) {
    $('.pk-model').textContent = [friend ? 'You joined a friend\'s table: the AI players run on their key, or on Ponjo\'s.' : !settings ? 'The players run on Claude Haiku 5.5.' : `The players run on ${settings.provider === 'anthropic' ? `Claude ${$(`[data-model="${settings.model}"]`, setup).textContent}` : settings.model}, with your key.`, aiNote(ai)].join(' ').trim();
    $('[data-action="key"]').textContent = settings ? 'Change' : 'Use your own key';
  }
  // From now on the players run on `next`, the visitor's own, or null for Ponjo's.
  function use(next) {
    settings = next;
    keep(settings, SAVED);
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
    const endpoint = f.endpoint.value.trim() || f.endpoint.placeholder;
    const error = $('.pk-error', setup);
    const wrong = !key ? 'Paste an API key.' : provider === 'openai' && !endpoint.startsWith('https://') ? 'The base URL starts with https://.' : '';
    if (wrong) {
      error.textContent = wrong;
      error.hidden = false;
      return;
    }
    use(provider === 'openai'
      ? { provider, key, endpoint, model: f.model.value.trim() || f.model.placeholder }
      : { provider, key, model });
  });
  forget.addEventListener('click', () => use(null));
  $('.pk-error', setup).after(forget);

  return { key: () => settings, open, draw };
}

/**
 * What the table's room says of its AI players (`ai` in its state, or
 * none): waiting for the host's key, which their page gives it again when
 * it comes back; or past this table's model calls for the hour.
 */
export function aiNote(ai) {
  if (ai?.waiting) return 'The AI players wait for the host\'s key: on their turns, they pass when time is up.';
  if (ai?.until) return `This table has used its model calls for the hour: the AI players pass until ${new Date(ai.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  return '';
}

// The line a page shows while it has no line to the table's room, or `why` it was turned away.
export const unreached = (why, shown) => (why !== 'line' ? why : shown ? 'Reconnecting…' : 'Cannot reach the table yet. Trying again…');

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

// ---- the votes ----

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Arrows in `svg` from face to face, who voted for whom: `pairs` [from, to,
 * kind] by seat, `faceOf(seat)` the face's node; drawn in one by one when
 * `animate`. The same arrows stay as they are, so one drawing in is not cut
 * short. Returns ms until the last lands, or null when nothing changed.
 */
export function arrows(svg, pairs, faceOf, animate) {
  const box = svg.getBoundingClientRect();
  const drawn = JSON.stringify([pairs, box.width, box.height]);
  if (svg.dataset.drawn === drawn) return null;
  svg.dataset.drawn = drawn;
  for (const line of svg.querySelectorAll('line')) line.remove();
  if (!pairs.length) return 0;
  const at = (i) => {
    const r = faceOf(i).getBoundingClientRect();
    return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
  };
  const gap = faceOf(pairs[0][0]).offsetWidth / 2 + 6;
  pairs.forEach(([from, to, kind], k) => {
    const [x1, y1] = at(from);
    const [x2, y2] = at(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
    const side = from < to ? 3 : -3; // two who voted for each other: side by side
    const line = document.createElementNS(SVG, 'line');
    const set = { x1: x1 + ux * gap - uy * side, y1: y1 + uy * gap + ux * side, x2: x2 - ux * gap - uy * side, y2: y2 - uy * gap + ux * side, 'marker-end': 'url(#ww-head)' };
    for (const [key, value] of Object.entries(set)) line.setAttribute(key, value);
    if (kind) line.dataset.kind = kind;
    svg.append(line);
    if (animate) {
      const length = len - 2 * gap;
      line.animate([{ strokeDasharray: length, strokeDashoffset: length, opacity: 1 }, { strokeDasharray: length, strokeDashoffset: 0, opacity: 1 }], { duration: 420, delay: k * 260, easing: 'ease-out', fill: 'backwards' });
    }
  });
  return animate ? pairs.length * 260 + 300 : 0;
}
