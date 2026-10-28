// Where a buddy's cursor stands in the doc (web/main.js): at the passage it
// was asked about while it works, after its last edit when its run lands,
// and gone once the person types while it is not at work. The desktop app
// on a folder with the fake agent, so it needs the page built (npm run
// build).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../scripts/devtools.js';
import { SAMPLE, fakeConfig } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const MOD = process.platform === 'darwin' ? 4 : 2; // Meta : Ctrl

let app;
let page;
let config;

before(async () => {
  const folder = join(await mkdtemp(join(tmpdir(), 'ponjo-buddy-cursor-')), 'project');
  await mkdir(join(folder, '.ponjo', 'buddies'), { recursive: true });
  await writeFile(join(folder, 'plan.md'), SAMPLE);
  await writeFile(join(folder, '.ponjo', 'buddies', 'Ada.md'), '\n');
  config = await fakeConfig();
  const env = { ...process.env, PONJO_CONFIG_DIR: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : []; // CI's Electron cannot sandbox on Linux
  app = await launchElectron(electron, [join(root, 'desktop', 'main.js'), ...sandbox, `--user-data-dir=${join(config, 'profile')}`, folder], { env });
  page = await app.page('plan.md', 60_000);
  await waitFor(() => page.evaluate('window.ponjoReady.then(() => true)'), 30_000, 'the page ready');
});

after(() => app?.quit());

// Select `[from, to)` of the first `quote` in the doc, in the editor.
const select = (quote, from, to) => page.evaluate(`(() => {
  const editor = document.querySelector('.ProseMirror');
  editor.focus();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(${JSON.stringify(quote)});
    if (at !== -1) return getSelection().setBaseAndExtent(node, at + ${from}, node, at + ${to});
  }
  throw new Error('not in the doc: ' + ${JSON.stringify(quote)});
})()`);

// Ask Ada in a comment on `quote`, as the person does: select it, press
// Ctrl+Alt+M (Cmd on a Mac), write and press Comment.
const ask = async (quote, body) => {
  await select(quote, 0, quote.length);
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'm', code: 'KeyM', modifiers: MOD | 1, windowsVirtualKeyCode: 77 });
  await waitFor(() => page.evaluate(`Boolean(document.querySelector('.pj-card-draft textarea'))`), 10_000, 'the draft');
  await page.evaluate(`(() => {
    const draft = document.querySelector('.pj-card-draft');
    const box = draft.querySelector('textarea');
    box.value = ${JSON.stringify(`@Ada ${body}`)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    draft.querySelector('.pj-primary').click();
  })()`);
};

// The doc's text just before Ada's cursor, or null when it has none; what
// the view draws in it (names, cursors) left out.
const cursorAfter = () => page.evaluate(`(() => {
  const cursor = document.querySelector('.pj-cursor');
  if (!cursor) return null;
  const range = document.createRange();
  range.setStart(document.querySelector('.ProseMirror'), 0);
  range.setEndBefore(cursor);
  const text = range.cloneContents();
  for (const drawn of text.querySelectorAll('.ProseMirror-widget')) drawn.remove();
  return text.textContent;
})()`);

// Type `text` right after `quote`, as the person does.
const typeAfter = async (quote, text) => {
  await select(quote, quote.length, quote.length);
  await page.send('Input.insertText', { text });
};

test('a buddy at work keeps its cursor at the passage while the person types; once it is done, typing takes it away', { timeout: 60_000 }, async () => {
  await ask('beta cohort', 'hold');
  await waitFor(async () => (await cursorAfter())?.endsWith('beta cohort'), 30_000, 'Ada at the passage');
  await typeAfter('week one', ',');
  await new Promise((resolve) => setTimeout(resolve, 600)); // past the view's pause after typing
  assert.ok((await cursorAfter())?.endsWith('beta cohort'), 'still there while Ada works');

  await writeFile(join(config, 'release-Ada'), '');
  await waitFor(() => page.evaluate(`!document.querySelector('.pj-cursor-working')`), 30_000, 'Ada done');
  assert.ok((await cursorAfter())?.endsWith('beta cohort'), 'still there once done, until the person types');
  await typeAfter('week one,', ' then');
  await waitFor(async () => (await cursorAfter()) === null, 10_000, 'the cursor gone');
});

test('a buddy\'s cursor stands after its last edit when its run lands, and goes when the person types there', { timeout: 60_000 }, async () => {
  await ask('extra load', 'replace "extra load" with "extra peak load"');
  await waitFor(async () => (await cursorAfter())?.endsWith('extra peak '), 30_000, 'Ada after its edit, the "peak " it put in');
  await typeAfter('peak ', 'hour ');
  await waitFor(async () => (await cursorAfter()) === null, 10_000, 'the cursor gone, not left inside the typing');
});
