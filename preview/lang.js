// The game pages' language (site/poker.html, site/werewolf.html,
// site/spy.html): English or Chinese, the visitor's pick in the header,
// kept in this browser, or else the browser's own language. A page's
// fixed words are its markup's, in English, each with its Chinese in
// `data-zh` (the element's first text) or `data-zh-<attribute>`; the rest
// its script's, `L(english, chinese)`. A pick reloads the page, which
// draws again from the table's room. The host's page also tells the room
// (game-kit.js, `sit`), so the AI players speak it.

/* global document, location */

import { keep, load } from './game-kit.js';

const KEPT = 'ponjo-lang';
export const LANG = load(KEPT) ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
export const L = (en, zh) => (LANG === 'zh' ? zh : en);

// `names` as a list in a sentence: "a, b and c", or "a、b和c".
export const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(L(', ', '、'))}${L(' and ', '和')}${names.at(-1)}` : names.join(''));

if (LANG === 'zh') {
  document.documentElement.lang = 'zh-CN';
  for (const node of document.querySelectorAll('*')) {
    for (const { name, value } of [...node.attributes]) {
      if (name === 'data-zh') [...node.childNodes].find((n) => n.nodeType === 3 && n.data.trim()).data = value;
      else if (name.startsWith('data-zh-')) node.setAttribute(name.slice(8), value);
    }
  }
}

document.querySelector('.site-lang')?.addEventListener('click', () => {
  keep(L('zh', 'en'), KEPT);
  location.reload();
});
