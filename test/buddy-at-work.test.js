// A buddy at work shows on the threads it works on (docs/user-experience.md,
// Seeing teammates work): their text underlined in its colour, the open
// card saying so, and the status bar's loop going there; it has no cursor.
// The desktop app on a folder with the fake agent, so it needs the page
// built (npm run build).

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
  const folder = join(await mkdtemp(join(tmpdir(), 'ponjo-buddy-at-work-')), 'project');
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

// Type `text` right after `quote`, as the person does.
const typeAfter = async (quote, text) => {
  await select(quote, quote.length, quote.length);
  await page.send('Input.insertText', { text });
};

// The text of each thread a buddy is at work on, underlined in the doc.
const busyText = () => page.evaluate(`[...document.querySelectorAll('.pj-hl-busy')].map((n) => n.textContent).join('|')`);
// What the open card says of a buddy at work on its thread, or null.
const busyLine = () => page.evaluate(`document.querySelector('.pj-card-active .pj-busy')?.textContent ?? null`);

test('a buddy at work shows on its thread, not by a cursor: its text underlined, its card saying so, until it is done', { timeout: 60_000 }, async () => {
  await ask('beta cohort', 'hold');
  await waitFor(async () => (await busyText()) === 'beta cohort', 30_000, 'the thread underlined');
  assert.equal(await busyLine(), 'Ada is working…', 'by its name, not its id');
  await typeAfter('week one', ',');
  assert.equal(await page.evaluate(`document.querySelector('.pj-cursor')`), null, 'no cursor of its own, while the person types');

  await writeFile(join(config, 'release-Ada'), '');
  await waitFor(async () => (await busyText()) === '', 30_000, 'Ada done');
  assert.equal(await busyLine(), null);
});

test('only the thread waiting for its answer shows it at work; the status bar\'s "is working…" goes there', { timeout: 60_000 }, async () => {
  await ask('extra load', 'wait');
  await waitFor(async () => (await busyText()) === 'extra load', 30_000, 'the new ask underlined, not the thread Ada answered already');
  await page.evaluate(`[...document.querySelectorAll('.pj-card')].find((c) => c.textContent.includes('hold')).click()`);
  await waitFor(async () => (await busyLine()) === null, 10_000, 'the other thread open');
  await page.evaluate(`document.querySelector('.pj-loop').click()`);
  await waitFor(busyLine, 10_000, 'back on the thread Ada works on');
  await writeFile(join(config, 'release-Ada'), '');
  await waitFor(async () => (await busyText()) === '', 30_000, 'Ada done');
});
