// The Markdown view's live preview (docs/markdown-view.md, #358), checked in
// Electron: what each piece of Markdown shows with the selection away and on
// its lines; what each key and tool does to the text and the selection;
// where a click puts the caret; and invariants that hold under random
// editing. Selections are written into the text: ‸ the caret, « » a
// selection's anchor and head (test/views/page.js).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../scripts/devtools.js';
import { openViews } from './views/harness.js';

const MOD = process.platform === 'darwin' ? 4 : 2; // Meta : Ctrl
const ALT = 1;
const SHIFT = 8;

let app;
let page;
let run;

before(async () => {
  ({ app, page, run } = await openViews());
});

after(() => app?.quit());

const at = (marked, options = {}) => run(`contract.at(${JSON.stringify(marked)}, ${JSON.stringify(options)})`);
const marked = () => run('contract.marked()');
const place = (anchor, head = anchor) => run(`contract.place(${anchor}, ${head})`);
const errors = () => run('contract.errors');
// The editor draws as it takes each change; a moment for its events, then
// the measuring it does in an animation frame (lines' heights, for where a
// click lands), done now: the test's window is hidden, and gets a frame
// about once a second.
const settle = () => run('new Promise((done) => setTimeout(done, 20)).then(() => contract.editor()?.measure())');
const type = (text) => page.send('Input.insertText', { text });
async function press(key, modifiers = 0) {
  const codes = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  const code = codes[key] ?? key.toUpperCase().charCodeAt(0);
  const text = key === 'Enter' ? '\r' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, modifiers });
  if (text && !modifiers) await page.send('Input.dispatchKeyEvent', { type: 'char', key, text, unmodifiedText: text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, modifiers });
}
// A key with modifiers as a keyboard sends it: `key` what it types (`&` for
// Shift+7), `keyCode` the key's own.
async function chord(key, keyCode, modifiers) {
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: keyCode, modifiers });
}
const tool = (command) => run(`contract.tool(${JSON.stringify(command)})`);
// What the lines show, a line a string: [classes] {style} text.
async function shown() {
  await settle();
  return (await run('contract.lines()')).map(({ cls, style, text }) => `${cls ? `[${cls}] ` : ''}${style ? `{${style}} ` : ''}${text}`);
}

// ---- what each piece of Markdown shows ----

// [name, source, shown with the selection away (as a doc opens), shown with the caret at `on` (an offset)]
const DRAWN = [
  ['an ATX heading', '# Title\n', ['[h h1] Title', ''], 0, ['[h h1] ‹#› Title', '']],
  ['a level 6 heading', '###### Six\n', ['[h h6] Six', ''], 0, ['[h h6] ‹######› Six', '']],
  ['a setext heading', 'Title\n===\n', ['[h h1] Title', '‹===›', ''], 0, ['[h h1] Title', '‹===›', '']],
  ['an empty heading', '#\n', ['[h h1] ', ''], 0, ['[h h1] ‹#›', '']],
  ['bold, italic, strikethrough, code', '**b** *i* ~~s~~ ~t~ `c`\n', ['<b>b</b> <i>i</i> <s>s</s> <s>t</s> <c>c</c>', ''], 0,
    ['<b>‹**›b‹**›</b> <i>‹*›i‹*›</i> <s>‹~~›s‹~~›</s> <s>‹~›t‹~›</s> <c>‹`›c‹`›</c>', '']],
  ['underscores', '__b__ _i_\n', ['<b>b</b> <i>i</i>', ''], 0, ['<b>‹__›b‹__›</b> <i>‹_›i‹_›</i>', '']],
  ['an escape', '5 \\* 3\n', ['5 * 3', ''], 0, ['5 \\* 3', '']],
  ['entities', '&copy; &#8594;\n', ['⟨©⟩ ⟨→⟩', ''], 0, ['‹&copy;› ‹&#8594;›', '']],
  ['an inline link', 'See [the plan](plan.md "Plan").\n', ['See <a>the plan</a>.', ''], 0, ['See <a>‹[›the plan‹]›‹(›‹plan.md› ‹"Plan"›‹)›</a>.', '']],
  ['a reference link and its definition', '[docs][d] and [d]\n\n[d]: https://example.com\n', ['<a>docs</a> and <a>d</a>', '', '<m>[d]: https://example.com</m>', ''], null, null],
  ['a [text] no definition names', 'Just [text] here.\n', ['Just [text] here.', ''], null, null],
  ['autolinks', '<https://a.b> www.c.d e@f.gh\n', ['<a>https://a.b</a> <a>www.c.d</a> <a>e@f.gh</a>', ''], 0, ['<a>‹<›https://a.b‹>›</a> <a>www.c.d</a> <a>e@f.gh</a>', '']],
  ['an image', '![a cat](cat.png)\n', ['⟨img:a cat⟩', ''], 0, ['<m>![a cat](cat.png)</m>', '']],
  ['bullet lists, nested', '- a\n  - b\n* c\n', ['{padding-left: 1.5em; text-indent: -1.5em;} ⟨•⟩a', '{padding-left: 3em; text-indent: -1.5em;} ⟨•⟩b', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨•⟩c', ''], 0,
    ['- a', '{padding-left: 3em; text-indent: -1.5em;} ⟨•⟩b', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨•⟩c', '']],
  ['ordered lists', '1. a\n2. b\n\n7) c\n', ['{padding-left: 1.5em; text-indent: -1.5em;} ⟨1.⟩a', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨2.⟩b', '', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨7)⟩c', ''], null, null],
  ['a list item over two lines', '- one\n  more\n', ['{padding-left: 1.5em; text-indent: -1.5em;} ⟨•⟩one', '{padding-left: 1.5em; text-indent: 0em;} more', ''], null, null],
  ['task lists', '- [ ] a\n- [x] b\n', ['{padding-left: 1.5em; text-indent: -1.5em;} ⟨☐⟩a', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨☑⟩<d>b</d>', ''], 0,
    ['- ⟨☐⟩ a', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨☑⟩<d>b</d>', '']],
  ['quotes, nested', '> q\n>\n> > n\n', ['[quote quote-d1] q', '[quote quote-d1] ', '[quote quote-d1 quote-d2] n', ''], 0, ['[quote quote-d1] ‹>› q', '[quote quote-d1] ', '[quote quote-d1 quote-d2] n', '']],
  ['a quote in a list item', '- a\n  > q\n', ['{padding-left: 1.5em; text-indent: -1.5em;} ⟨•⟩a', '[quote quote-d1] {--pj-indent: 1.5em;} q', ''], null, null],
  ['a fenced code block', '```js\nlet a\n```\n', ['[codeblock codeblock-first fence] ', '[codeblock] let a', '[codeblock codeblock-last fence] ', ''], 6,
    ['[codeblock codeblock-first] ‹```›‹js›', '[codeblock] let a', '[codeblock codeblock-last] ‹```›', '']],
  ['a tilde fence', '~~~\nx\n~~~\n', ['[codeblock codeblock-first fence] ', '[codeblock] x', '[codeblock codeblock-last fence] ', ''], null, null],
  ['an unclosed fence', '```\nopen\n', ['[codeblock codeblock-first fence] ', '[codeblock codeblock-last] open', ''], null, null],
  ['an indented code block', 'a\n\n    code\n', ['a', '', '[codeblock codeblock-first codeblock-last]     code', ''], null, null],
  ['rules', 'a\n\n---\n\n***\n', ['a', '', '⟨—⟩', '', '⟨—⟩', ''], 3, ['a', '', '‹---›', '', '⟨—⟩', '']],
  ['a table', '| a | b |\n|---|:-:|\n| `x` |  |\n| y\\|z | **w** |\n', ['[block] [table a|b / x| / y|z|w]', ''], 2,
    ['[table-src] ‹|› a ‹|› b ‹|›', '[table-src] ‹|---|:-:|›', '[table-src] ‹|› <c>‹`›x‹`›</c> ‹|›  ‹|›', '[table-src] ‹|› y\\|z ‹|› <b>‹**›w‹**›</b> ‹|›', '']],
  ['a table without outer pipes', 'a | b\n--|--\n1 | 2\n', ['[block] [table a|b / 1|2]', ''], null, null],
  ['a table with an empty header row', '| | |\n|---|---|\n| 1 | 2 |\n', ['[block] [table 1|2]', ''], null, null],
  ['front matter', '---\ntitle: x\n---\n\n# H\n', ['[frontmatter] ---', '[frontmatter] title: x', '[frontmatter] ---', '', '[h h1] H', ''], null, null],
  ['footnotes, numbered by first use', 'a[^n] b[^m]\n\n[^m]: M\n[^n]: N\n', ['a⟨1⟩ b⟨2⟩', '', '[footnote] ⟨2.⟩M', '[footnote] ⟨1.⟩N', ''], 0, ['a‹[^n]› b‹[^m]›', '', '[footnote] ⟨2.⟩M', '[footnote] ⟨1.⟩N', '']],
  ['hard breaks', 'a\\\nb  \nc\n', ['a', 'b  ', 'c', ''], 0, ['a\\', 'b  ', 'c', '']],
  ['HTML', '<details>\nx\n</details>\n\nan <b>inline</b> tag\n', ['<m><details></m>', '<m>x</m>', '<m></details></m>', '', 'an <m><b></m>inline<m></b></m> tag', ''], null, null],
  ['a link holding emphasis', '[**b** c](u)\n', ['<a><b>b</b> c</a>', ''], null, null],
  ['an empty doc', '', [''], 0, ['']],
];

for (const [name, source, away, on, onShown] of DRAWN) {
  test(`drawn: ${name}, the selection away`, async () => {
    await at(source, { focus: false });
    assert.deepEqual(await shown(), away);
    assert.deepEqual(await errors(), []);
  });
  if (on === null) continue;
  test(`drawn: ${name}, the caret on it`, async () => {
    await at(source, { focus: false });
    await place(on);
    assert.deepEqual(await shown(), onShown);
    assert.equal(await run('view.getText()'), source, 'drawing changes no text');
    assert.deepEqual(await errors(), []);
  });
}

test('drawn: a table or a diagram is drawn again once the caret leaves it, and stays its source while the editor is out of focus', async () => {
  const source = 'Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n';
  await at(source, { focus: false });
  await place(source.indexOf('1 |'));
  assert.equal((await shown())[2], '[table-src] ‹|› a ‹|› b ‹|›');
  await run('document.activeElement.blur()');
  assert.equal((await shown())[2], '[table-src] ‹|› a ‹|› b ‹|›', 'out of focus, its source still');
  await run('contract.editor().focus()');
  assert.equal(await marked(), source.replace('1 |', '‸1 |'), 'the caret where it was');
  await place(0);
  assert.equal((await shown())[2], '[block] [table a|b / 1|2]');
});

// ---- what keys and tools do ----

// [name, before, what to do (a key, ['tool', name] or a string to type), after]
const EDITS = [
  ['Enter continues a bullet list', '- a‸', 'Enter', '- a\n- ‸'],
  ['Enter continues a numbered list, numbered', '1. a‸', 'Enter', '1. a\n2. ‸'],
  ['Enter continues a task list, unticked', '- [x] a‸', 'Enter', '- [x] a\n- [ ] ‸'],
  ['Enter continues a nested list at its level', '- a\n  - b‸', 'Enter', '- a\n  - b\n  - ‸'],
  ['Enter on an empty item ends the list with a blank line', '- a\n- ‸', 'Enter', '- a\n\n‸'],
  ['Enter on an empty numbered item ends the list', '1. a\n2. ‸', 'Enter', '1. a\n\n‸'],
  ['Enter continues a quote', '> a‸', 'Enter', '> a\n> ‸'],
  ['Enter on an empty quote line ends the quote', '> a\n> ‸', 'Enter', '> a\n\n‸'],
  ['Enter in a code block is a new line, not a list', '```\n- ‸\n```', 'Enter', '```\n- \n‸\n```'],
  ['Enter in a code block keeps the line\'s indent', '```\n  a‸\n```', 'Enter', '```\n  a\n  ‸\n```'],
  ['Enter in the middle of a list item splits it', '- ab‸cd', 'Enter', '- ab\n- ‸cd'],
  ['Enter in a heading splits it, a paragraph a blank line apart', '# Ti‸tle', 'Enter', '# Ti\n\n‸tle'],
  ['Enter after a heading starts a paragraph a blank line apart', '# Title‸', 'Enter', '# Title\n\n‸'],
  ['Enter in a paragraph starts a new one a blank line apart', 'a‸', 'Enter', 'a\n\n‸'],
  ['Enter in the middle of a paragraph splits it in two', 'ab‸cd', 'Enter', 'ab\n\n‸cd'],
  ['Shift+Enter in a paragraph is a new line in it', 'a‸', ['Enter', SHIFT], 'a\n‸'],
  ['Enter on a blank line is one more', 'a\n\n‸', 'Enter', 'a\n\n\n‸'],
  ['Enter in a setext heading is a new line', 'Ti‸tle\n===', 'Enter', 'Ti\n‸tle\n==='],
  ['Backspace after a list\'s marker takes it out, a paragraph apart from the list', '- a\n- ‸b', 'Backspace', '- a\n\n‸b'],
  ['Backspace after a nested item\'s marker moves it out a level', '- a\n  - ‸b', 'Backspace', '- a\n- ‸b'],
  ['Backspace after the first item\'s marker', '- ‸a\n- b', 'Backspace', '‸a\n- b'],
  ['Backspace in a list item\'s text deletes a character', '- ab‸', 'Backspace', '- a‸'],
  ['Backspace after a quote\'s marker under a quote line keeps it apart', '> a\n> ‸b', 'Backspace', '> a\n\n‸b'],
  ['Backspace after a quote\'s marker takes it out', '> ‸a', 'Backspace', '‸a'],
  ['Tab indents a list item by its marker', '- a\n- ‸b', 'Tab', '- a\n  - ‸b'],
  ['Tab indents a numbered item by its marker', '1. a\n2. ‸b', 'Tab', '1. a\n   2. ‸b'],
  ['Shift+Tab outdents a list item', '- a\n  - ‸b', ['Tab', SHIFT], '- a\n- ‸b'],
  ['Tab in a code block indents by its indent', '```\nif a:\n    ‸b\n```', 'Tab', '```\nif a:\n        ‸b\n```'],
  ['Tab in a table goes to the next cell', '| a‸ | b |\n|---|---|\n| 1 | 2 |', 'Tab', '| a | ‸b |\n|---|---|\n| 1 | 2 |'],
  ['Tab at a table row\'s end goes to the next row', '| a | b‸ |\n|---|---|\n| 1 | 2 |', 'Tab', '| a | b |\n|---|---|\n| ‸1 | 2 |'],
  ['Shift+Tab in a table goes to the cell before', '| a | b‸ |\n|---|---|', ['Tab', SHIFT], '| a‸ | b |\n|---|---|'],
  ['Tab in a paragraph does nothing', 'a‸b', 'Tab', 'a‸b'],
  ['bold wraps the selection', 'a «b» c', ['tool', 'bold'], 'a **«b»** c'],
  ['bold unwraps a bold selection', 'a **«b»** c', ['tool', 'bold'], 'a «b» c'],
  ['bold at a caret puts the marks around it', 'a‸b', ['tool', 'bold'], 'a**‸**b'],
  ['italic, strikethrough and code wrap', '«x»', ['tool', 'italic'], '*«x»*'],
  ['strikethrough wraps', '«x»', ['tool', 'strike'], '~~«x»~~'],
  ['inline code wraps', '«x»', ['tool', 'code'], '`«x»`'],
  ['a heading on a line', 'a‸\nb', ['tool', 'h1'], '# a‸\nb'],
  ['another level replaces the heading\'s', '# a‸', ['tool', 'h2'], '## a‸'],
  ['the same level takes the heading away', '## a‸', ['tool', 'h2'], 'a‸'],
  ['a heading drops the hard break that ended its line', 'a\\‸\nb', ['tool', 'h1'], '# a‸\nb'],
  ['a heading replaces a list item\'s marker', '- a‸', ['tool', 'h1'], '# a‸'],
  ['Normal text takes every prefix away', '> - a‸', ['tool', 'paragraph'], 'a‸'],
  ['Normal text takes a code block\'s fences away', '```\na‸\n```', ['tool', 'paragraph'], 'a‸'],
  ['a quote over the lines selected', '«a\nb»', ['tool', 'quote'], '> «a\n> b»'],
  ['a quote taken away', '> «a\n> b»', ['tool', 'quote'], '«a\nb»'],
  ['a quote over part of a paragraph is kept apart from the rest', 'a‸\nb', ['tool', 'quote'], '> a‸\n\nb'],
  ['bullets over the lines selected', '«a\nb»', ['tool', 'bullets'], '- «a\n- b»'],
  ['numbers over the lines selected', '«a\nb»', ['tool', 'numbers'], '1. «a\n2. b»'],
  ['tasks over the lines selected', '«a\nb»', ['tool', 'tasks'], '- [ ] «a\n- [ ] b»'],
  ['a bulleted list made numbered, whole', '- a\n- b‸\n- c', ['tool', 'numbers'], '1. a\n2. b‸\n3. c'],
  ['a nested list made numbered, only it', '- a\n  - b‸\n  - c\n- d', ['tool', 'numbers'], '- a\n  1. b‸\n  2. c\n- d'],
  ['bullets taken away', '- a‸', ['tool', 'bullets'], 'a‸'],
  ['a code block around the lines selected', '«a\nb»', ['tool', 'codeBlock'], '```\n«a\nb»\n```'],
  ['a code block taken away', '```\na‸\n```', ['tool', 'codeBlock'], 'a‸'],
  ['a divider after the line', 'a‸', ['tool', 'divider'], 'a\n\n---‸\n'],
  ['a table after the line', 'a‸', ['tool', 'table'], 'a\n\n| ‸ |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n'],
  ['a footnote at the caret, its note at the end', 'a‸ b\n', ['tool', 'footnote'], 'a[^1] b\n\n[^1]: ‸'],
  ['a second footnote is numbered after the first', 'a[^1] b‸\n\n[^1]: one\n', ['tool', 'footnote'], 'a[^1] b[^2]\n\n[^1]: one\n\n[^2]: ‸'],
  ['nothing formats front matter', '---\nti‸tle: x\n---\n', ['tool', 'bold'], '---\nti‸tle: x\n---\n'],
  ['nothing makes front matter a heading', '---\nti‸tle: x\n---\n', ['tool', 'h1'], '---\nti‸tle: x\n---\n'],
  ['typing a closing ** makes bold', 'a **b‸', '**', 'a **b**‸'],
];

// [name, before, [key, keyCode, modifiers], after]: the block styles' keys.
const KEYS = [
  ['Mod+Alt+1 makes a heading 1', 'a‸', ['1', 49, MOD | ALT], '# a‸'],
  ['Mod+Alt+3 makes a heading 3', 'a‸', ['3', 51, MOD | ALT], '### a‸'],
  ['Mod+Alt+0 makes normal text', '## a‸', ['0', 48, MOD | ALT], 'a‸'],
  ['Mod+Alt+Q makes a quote', 'a‸', ['q', 81, MOD | ALT], '> a‸'],
  ['Mod+Alt+C makes a code block', 'a‸', ['c', 67, MOD | ALT], '```\na‸\n```'],
  ['Mod+Shift+7 makes a numbered list', 'a‸', ['&', 55, MOD | SHIFT], '1. a‸'],
  ['Mod+Shift+8 makes a bulleted list', 'a‸', ['*', 56, MOD | SHIFT], '- a‸'],
  ['Mod+Shift+9 makes a task list', 'a‸', ['(', 57, MOD | SHIFT], '- [ ] a‸'],
];

for (const [name, before, keys, after] of KEYS) {
  test(`key: ${name}`, async () => {
    await at(before);
    await chord(...keys);
    assert.equal(await marked(), after);
  });
}

for (const [name, before, what, after] of EDITS) {
  test(`edit: ${name}`, async () => {
    await at(before);
    if (Array.isArray(what) && what[0] === 'tool') await tool(what[1]);
    else if (Array.isArray(what)) await press(...what);
    else if (/^[A-Z][a-z]+$/.test(what)) await press(what);
    else await type(what);
    assert.equal(await marked(), after);
    assert.deepEqual(await errors(), []);
  });
}

test('edit: Cmd+Z takes back each tool, a step each', async () => {
  await at('«a\nb»');
  for (const command of ['bullets', 'bold', 'quote']) await tool(command);
  assert.notEqual(await run('view.getText()'), 'a\nb');
  for (let i = 0; i < 3; i++) await press('z', MOD);
  assert.equal(await run('view.getText()'), 'a\nb');
});

// ---- where the caret goes ----

// Click the left edge of the `nth` character of the line's drawn text holding `quote`, at offset `k` into it.
async function clickOn(quote, k) {
  await settle(); // measured, as a window does in its first frames
  const { x, y } = await run(`(() => {
    const walker = document.createTreeWalker(document.querySelector('.cm-content'), NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.data.indexOf(${JSON.stringify(quote)});
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(node, i + ${k});
      range.setEnd(node, i + ${k} + 1);
      const box = range.getBoundingClientRect();
      return { x: box.left + 1, y: box.top + box.height / 2 };
    }
    throw new Error('not drawn: ' + ${JSON.stringify(quote)});
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await settle();
}

// [what, source, the drawn text to click in, the character in it to click before, where the caret lands]
const CLICKS = [
  ['in bold text', 'A **bold** word.\n', 'bold', 2, 'A **bo‸ld** word.\n'],
  ['in a link\'s text', 'See [the plan](plan.md) now.\n', 'the plan', 4, 'See [the ‸plan](plan.md) now.\n'],
  ['in a heading', '# Title\n', 'Title', 1, '# T‸itle\n'],
  ['in a list item', '- item\n', 'item', 0, '- ‸item\n'],
  ['in a nested list item', '- a\n  - item\n', 'item', 2, '- a\n  - it‸em\n'],
  ['in a task', '- [ ] task\n', 'task', 1, '- [ ] t‸ask\n'],
  ['in a quote', '> quoted\n', 'quoted', 3, '> quo‸ted\n'],
  ['after an escape', 'a \\* b\n', 'b', 0, 'a \\* ‸b\n'],
  ['in inline code', 'a `code` b\n', 'code', 2, 'a `co‸de` b\n'],
  ['after a footnote', 'a[^1] tail\n\n[^1]: n\n', 'tail', 0, 'a[^1] ‸tail\n\n[^1]: n\n'],
  // The press holds what is drawn: a block that takes another height as its source would move the text under it.
  ['in a code block not being edited', 'Before.\n\n```\nlet a\n```\n', 'let a', 4, 'Before.\n\n```\nlet ‸a\n```\n'],
  // A drawn block's height is all its own: the editor measures no margins.
  ['on a line under a drawn table', '| a |\n|---|\n| 1 |\n\nBelow it.\n', 'Below', 2, '| a |\n|---|\n| 1 |\n\nBe‸low it.\n'],
  ['on a line under an image', '![i](a.png)\n\nBelow it.\n', 'Below', 2, '![i](a.png)\n\nBe‸low it.\n'],
];

for (const [name, source, quote, k, after] of CLICKS) {
  test(`caret: a click ${name} puts the caret at that character`, async () => {
    await at(source, { focus: false });
    await clickOn(quote, k);
    assert.equal(await marked(), after);
  });
}

test('caret: it stays where it was through the editor losing and taking back the focus, wherever it is', async () => {
  const source = 'A **bold** [link](u) and `code`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx\n```\n';
  for (const offset of [3, 5, 12, 16, 27, source.indexOf('1 |') + 1, source.indexOf('x\n```')]) {
    await at(source);
    await place(offset);
    await run('document.activeElement.blur()');
    await settle();
    await run('contract.editor().focus()');
    await settle();
    assert.equal(await run('contract.editor().state.selection.main.head'), offset, `at ${offset}`);
  }
});

test('caret: the arrows move through hidden syntax a character at a time', async () => {
  await at('‸A **b** c\nNext [l](u) line\n');
  for (let i = 0; i < 4; i++) await press('ArrowRight');
  assert.equal(await marked(), 'A **‸b** c\nNext [l](u) line\n');
  await press('ArrowDown');
  assert.equal(await run('contract.editor().state.doc.lineAt(contract.editor().state.selection.main.head).number'), 2);
});

// ---- the toolbar says what is at the caret ----

// [the text and the caret, the tools pressed, the text style named]
const STATES = [
  ['A **bo‸ld** word', ['bold'], 'Normal text'],
  ['A ***bo‸th*** word', ['bold', 'italic'], 'Normal text'],
  ['A [li‸nk](u) and `co‸de`', ['link'], 'Normal text'],
  ['## Hea‸ding', [], 'Heading 2'],
  ['> quo‸ted', [], 'Quote'],
  ['```\nco‸de\n```', [], 'Code block'],
  ['- [ ] ta‸sk', ['tasks'], 'Normal text'],
  ['1. on‸e', ['numbers'], 'Normal text'],
  ['- a\n  1. ne‸sted', ['numbers'], 'Normal text'],
];

for (const [text, pressed, style] of STATES) {
  test(`toolbar: at ${JSON.stringify(text)}, ${pressed.join(', ') || 'nothing'} pressed, ${style}`, async () => {
    await at(text);
    // The toolbar follows in an animation frame.
    const state = () => run(`({ pressed: [...document.querySelectorAll('.pj-toolbar button[aria-pressed="true"]')].map((b) => b.dataset.command).sort(), style: document.querySelector('.pj-block-label').textContent })`);
    const expected = { pressed: [...pressed].sort(), style };
    await waitFor(async () => JSON.stringify(await state()) === JSON.stringify(expected), 5000, 'the toolbar').catch(() => {});
    assert.deepEqual(await state(), expected);
  });
}

// ---- others in the doc ----

test('others: their edits around hidden syntax and in a table keep my caret at its character', async () => {
  const text = 'A **bold** [link](u) here.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  for (const [mine, theirs] of [
    ['**bo‸ld**', (t) => t.replace('A ', 'Another ')],
    ['[li‸nk]', (t) => t.replace('(u)', '(https://u.v)')],
    ['| 1‸ |', (t) => t.replace('| a |', '| aa |').replace('| 2 |', '| 22 |')],
  ]) {
    const caret = text.indexOf(mine.replace('‸', '')) + mine.indexOf('‸');
    await at(`${text.slice(0, caret)}‸${text.slice(caret)}`);
    const next = theirs(text);
    await run(`view.applyText(${JSON.stringify(next)}, { by: 'Ana' })`);
    const expected = next.indexOf(mine.replace('‸', '')) + mine.indexOf('‸');
    assert.equal(await marked(), `${next.slice(0, expected)}‸${next.slice(expected)}`, mine);
  }
});

test('others: a comment on a link marks the text a reader sees', async () => {
  const text = 'See [the plan](plan.md) now.\n';
  await at(text, { focus: false });
  await run(`view.setMarks([{ kind: 'comment', id: 't1', from: ${text.indexOf('[')}, to: ${text.indexOf(')') + 1}, active: true }])`);
  await settle();
  assert.equal(await run(`contract.drawn('.pj-hl')`), 'the plan');
});

test('find: a match inside hidden syntax shows its line as source', async () => {
  const text = 'See [the plan](plan.md) now.\n';
  await at(text, { focus: false });
  await run(`view.find('plan.md', 0)`);
  assert.deepEqual(await shown(), ['See <a>‹[›the plan‹]›‹(›</a><a>‹plan.md›</a><a>‹)›</a> now.', ''], 'the match marked splits the link\'s span');
});

test('spelling: prose is checked; code, URLs, HTML and front matter are not', async () => {
  const words = (text) => run(`(async () => {
    await contract.at(${JSON.stringify(text)});
    await new Promise((done) => setTimeout(done, 20));
    const content = document.querySelector('.cm-content');
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const checked = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('[spellcheck]').spellcheck) checked.push(node.data);
    }
    return checked.join(' ').match(/[a-z]+/g) ?? [];
  })()`);
  const fm = '---\nfm: one\n---\n';
  const code = '\n```js\nblock\n```\n';
  assert.deepEqual(await words(`${fm}\n‸prose \`code\` [link](https://url.example) <https://auto.example> <kbd>key</kbd> ![alt](img.png)\n${code}`), ['prose', 'link', 'key']);
  assert.deepEqual(await words(`${fm}\nprose [link][ref]\n\n[ref]: https://url.example\n${code}‸`), ['prose', 'link']);
  assert.equal(await run(`(async () => { await contract.at('prose', { editable: false, toolbar: false }); return document.querySelector('.cm-content').spellcheck; })()`), false, 'an earlier version is not checked');
});

test('read-only: an earlier version is drawn whole wherever its selection is, and its boxes do not tick', async () => {
  const text = '# Title\n\n- [ ] task\n';
  await at(text, { editable: false, toolbar: false });
  await place(3);
  assert.deepEqual(await shown(), ['[h h1] Title', '', '{padding-left: 1.5em; text-indent: -1.5em;} ⟨☐⟩task', '']);
  await run(`document.querySelector('.pj-md-check').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  assert.equal(await run('view.getText()'), text);
});

test('text: lines ending in \\r\\n are drawn as any, and kept', async () => {
  const text = '# T\r\n\r\n**b** and [l](u)\r\n';
  await at(text, { focus: false });
  assert.deepEqual(await shown(), ['[h h1] T', '', '<b>b</b> and <a>l</a>', '']);
  await place(0);
  await type('x');
  assert.equal(await run('view.getText()'), `x${text}`);
});

test('text: emoji and other characters past one code unit beside hidden syntax', async () => {
  await at('**😀** [👍](u) 中**文**\n', { focus: false });
  assert.deepEqual(await shown(), ['<b>😀</b> <a>👍</a> 中<b>文</b>', '']);
  await clickOn('👍', 0);
  assert.equal(await marked(), '**😀** [‸👍](u) 中**文**\n');
});

// ---- invariants under random editing ----

const PIECES = ['# Head', '## Sub', 'Text with **bold** and *it*', '[link](u)', '- item', '  - nested', '1. one', '- [ ] task', '> quote', '> > deep',
  '```js', 'code()', '```', '| a | b |', '|---|---|', '| 1 | 2 |', '---', '![i](a.png)', 'x[^1]', '[^1]: note', '&amp;', 'a\\', '<b>h</b>', '~~s~~', '', ''];
const TYPED = ['a', ' ', '*', '`', '#', '>', '-', '|', '[', ']', '(', ')', '\n', '~', '!'];

test('invariant: random editing draws without errors, and the caret\'s line shows its source', async () => {
  let seed = 0;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let doc = 0; doc < 45; doc++) {
    if (doc % 15 === 0) seed = [7, 1009, 31337][doc / 15]; // three runs, each from its own seed
    const text = Array.from({ length: 6 + random(14) }, () => PIECES[random(PIECES.length)]).join('\n');
    await at(`‸${text}`); // in the editor from the start: the caret's line is source
    for (let step = 0; step < 40; step++) {
      const length = await run('view.getText().length');
      const choice = random(7);
      if (choice === 0) await place(random(length + 1));
      else if (choice === 6) {
        // A click on a character drawn in a line not being edited puts the caret before it.
        const target = await run(`(() => {
          const editor = contract.editor();
          const walker = document.createTreeWalker(editor.contentDOM, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('[contenteditable="false"], .pj-md-mark') || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
          const nodes = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
          if (nodes.length === 0) return null;
          const node = nodes[${random(1000)} % nodes.length];
          const i = ${random(1000)} % node.data.length;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const box = range.getClientRects()[0];
          if (!box || box.width < 3) return null;
          // Only text a click would reach: not under the comment bubble, say, which the toolbar's frame has yet to hide.
          const [x, y] = [box.left + 1, box.top + box.height / 2];
          if (!node.parentElement.contains(document.elementFromPoint(x, y))) return null;
          return { x, y, at: editor.posAtDOM(node, i), text: node.data };
        })()`);
        if (target) {
          for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
          await settle();
          assert.equal(await run('contract.editor().state.selection.main.head'), target.at, `a click lands at its character, doc ${doc} step ${step}: ${JSON.stringify(await marked())} ${target.text}`);
        }
      }
      else if (choice === 1) await type(TYPED[random(TYPED.length)]);
      else if (choice === 2) await press(['Enter', 'Backspace', 'Tab', 'ArrowDown', 'ArrowUp'][random(5)]);
      else if (choice === 3) await tool(['bold', 'h2', 'quote', 'bullets', 'numbers', 'codeBlock', 'paragraph', 'tasks'][random(8)]);
      else if (choice === 4) {
        const before = await run('view.getText()');
        await run('document.activeElement.blur()');
        await run('contract.editor().focus()');
        assert.equal(await run('view.getText()'), before, 'the focus changes no text');
      } else {
        const from = random(length + 1);
        await place(from, Math.min(length, from + random(12)));
      }
      await settle();
      assert.deepEqual(await errors(), [], `no error, doc ${doc} step ${step}`);
      // The caret's line, drawn, is its source: no syntax hidden there.
      const caretLine = await run(`(() => {
        const editor = contract.editor();
        const { head } = editor.state.selection.main;
        const line = editor.state.doc.lineAt(head);
        const lines = contract.lines();
        const element = editor.domAtPos(line.from).node;
        const el = (element.nodeType === 3 ? element.parentElement : element).closest('.cm-line');
        const index = [...document.querySelector('.cm-content').children].indexOf(el);
        return { source: line.text, drawn: index === -1 ? null : lines[index].text };
      })()`);
      if (caretLine.drawn === null) continue; // in a block drawn in its place: never the caret's
      // Formatting written as tags in `lines`, and syntax faded, are the same characters; the source may hold such tags too.
      const plain = (s) => s.replace(/<\/?[bisacmd]>|[‹›]/g, '').replace(/⟨☐⟩/g, '[ ]').replace(/⟨☑⟩/g, '[x]').toLowerCase();
      assert.equal(plain(caretLine.drawn), plain(caretLine.source), `the caret's line shows its source, doc ${doc} step ${step}`);
    }
  }
});
