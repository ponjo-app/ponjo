// Where a buddy's cursor stands in the doc (web/main.js): at the passage it
// was asked about while it works, with no name, and gone once it is done;
// its edit glows, with no name over it. The desktop app
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
  await writeFile(join(folder, '.ponjo', 'buddies', 'Ada.md'), '---\nid: b_ada\n---\n'); // an id that is not its name
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
const select = (quote, from, to) => page.evaluate(`(async () => {
  const editor = document.querySelector('.cm-content');
  editor.focus();
  await new Promise((done) => setTimeout(done, 30)); // the line the caret is on is drawn as its source
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(${JSON.stringify(quote)});
    if (at === -1) continue;
    getSelection().setBaseAndExtent(node, at + ${from}, node, at + ${to});
    return new Promise((done) => setTimeout(done, 30)); // the editor takes the selection in as it changes
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
// the view draws in it (cursors) left out.
const cursorAfter = () => page.evaluate(`(() => {
  const cursor = document.querySelector('.pj-cursor');
  if (!cursor) return null;
  const range = document.createRange();
  range.setStart(document.querySelector('.cm-content'), 0);
  range.setEndBefore(cursor);
  const text = range.cloneContents();
  for (const drawn of text.querySelectorAll('[contenteditable="false"], .cm-widgetBuffer')) drawn.remove();
  return text.textContent;
})()`);

// Type `text` right after `quote`, as the person does.
const typeAfter = async (quote, text) => {
  await select(quote, quote.length, quote.length);
  await page.send('Input.insertText', { text });
};

test('a buddy at work keeps its cursor, unnamed, at the passage while the person types; once it is done, the cursor goes', { timeout: 60_000 }, async () => {
  await ask('beta cohort', 'hold');
  await waitFor(async () => (await cursorAfter())?.endsWith('beta cohort'), 30_000, 'Ada at the passage');
  await typeAfter('week one', ',');
  await new Promise((resolve) => setTimeout(resolve, 600)); // past the view's pause after typing
  assert.ok((await cursorAfter())?.endsWith('beta cohort'), 'still there while Ada works');
  assert.equal(await page.evaluate(`document.querySelectorAll('.pj-cursor').length`), 1, 'one cursor');
  assert.equal(await page.evaluate(`document.querySelector('.pj-cursor').textContent`), '', 'no name');

  await writeFile(join(config, 'release-Ada'), '');
  await waitFor(async () => (await cursorAfter()) === null, 30_000, 'the cursor gone once Ada is done');
});

test('a buddy\'s edit glows with no name over it, and its cursor goes when its run ends', { timeout: 60_000 }, async () => {
  await ask('extra load', 'replace "extra load" with "extra peak load"');
  await waitFor(() => page.evaluate(`[...document.querySelectorAll('.pj-flash')].some((node) => node.textContent.includes('peak'))`), 30_000, 'its edit glowing');
  await waitFor(async () => (await cursorAfter()) === null, 30_000, 'the cursor gone once Ada is done');
});
