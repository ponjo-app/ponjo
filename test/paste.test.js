import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../web/views/markdown/paste.js';

test('pasted HTML becomes Markdown in the style the toolbar types', () => {
  const cases = [
    ['<h2>Plan</h2><p>Ship <b>this</b> <i>now</i>, <s>not</s> <code>later</code>.</p>', '## Plan\n\nShip **this** *now*, ~~not~~ `later`.'],
    ['<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>', '- one\n- two\n\n1. first'],
    ['<ol start="3"><li>three<ul><li>nested</li></ul></li></ol>', '3. three\n   - nested'],
    ['<blockquote><p>Said.</p></blockquote><hr><p><a href="https://ponjo.app">Ponjo</a></p>', '> Said.\n\n---\n\n[Ponjo](https://ponjo.app)'],
    ['<pre><code class="language-js">let a = 1;\n</code></pre>', '```js\nlet a = 1;\n```'],
    ['<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>', '| A | B |\n| --- | --- |\n| 1 | 2 |'],
  ];
  for (const [html, markdown] of cases) assert.equal(htmlToMarkdown(html), markdown, html);
});

test('pasted HTML leaves out images held in the page, and Google Docs\' wrapper that is not bold', () => {
  const html = `<b style="font-weight:normal" id="docs-internal-guid-1"><p>Look <img src="data:image/png;base64,${'A'.repeat(500)}"><img src="https://example.com/a.png" alt="pic"></p></b>`;
  assert.equal(htmlToMarkdown(html), 'Look ![pic](https://example.com/a.png)');
});
