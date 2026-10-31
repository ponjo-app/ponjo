// Opening a file from a folder window's sidebar (desktop/windows.js,
// web/files.js): the next page draws the sidebar from what the last page's
// folders held, then reads them again, so files that came or went meanwhile
// show. The desktop app on a folder, so it needs the page built (npm run
// build).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../scripts/devtools.js';

const root = fileURLToPath(new URL('..', import.meta.url));

let app;
let folder;

before(async () => {
  const work = await mkdtemp(join(tmpdir(), 'ponjo-sidebar-'));
  folder = join(work, 'project');
  await mkdir(join(folder, 'notes'), { recursive: true });
  await mkdir(join(work, 'config'));
  for (const name of ['a.md', 'b.md', 'notes/c.md']) await writeFile(join(folder, name), `# ${name}\n`);
  const env = { ...process.env, PONJO_CONFIG_DIR: join(work, 'config') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : []; // CI's Electron cannot sandbox on Linux
  app = await launchElectron(electron, [join(root, 'desktop', 'main.js'), ...sandbox, `--user-data-dir=${join(work, 'profile')}`, folder], { env });
});

after(() => app?.quit());

const rows = (page) => page.evaluate(`[...document.querySelectorAll('.pj-files-row[data-path]')].map((row) => row.dataset.path)`);

test('the next page draws the sidebar the last one left, then shows the files that came or went meanwhile', { timeout: 120_000 }, async () => {
  const first = await app.page('a.md', 60_000);
  await waitFor(() => first.evaluate(`Boolean(document.querySelector('.ProseMirror') && document.querySelector('.pj-files-folder[data-path="notes"]'))`), 30_000, 'the doc and its sidebar');
  await first.evaluate(`document.querySelector('.pj-files-folder[data-path="notes"]').click()`);
  await waitFor(async () => (await rows(first)).includes('notes/c.md'), 10_000, 'the subfolder open');
  await waitFor(() => first.evaluate('window.ponjoReady.then(() => true)'), 10_000, 'the page ready');

  // Changed just before the click, before the last page can hear of it.
  await writeFile(join(folder, 'new.md'), '');
  await rm(join(folder, 'notes', 'c.md'));
  await first.evaluate(`document.querySelector('.pj-files-file[data-path="b.md"]').click()`);

  const next = await app.page('b.md', 30_000);
  await waitFor(() => next.evaluate('window.ponjoReady.then(() => true)'), 10_000, 'the next page ready');
  const { carry } = await next.evaluate('window.ponjoDesktop.folder()');
  assert.deepEqual(carry.lists.map(([path]) => path).sort(), ['', 'notes'], 'the last page\'s folders, the open subfolder too');
  assert.ok(carry.lists.find(([path]) => path === '')[1].some(({ name }) => name === 'b.md'));
  assert.equal(await next.evaluate(`document.querySelector('[aria-current="page"]')?.dataset.path`), 'b.md');
  await waitFor(async () => {
    const now = await rows(next);
    return now.includes('new.md') && !now.includes('notes/c.md') && now.includes('notes');
  }, 10_000, 'the sidebar read again: new.md there, notes/c.md gone');
});

test('Mod+Shift+F searches the files\' text; a hit in another doc opens it with the find bar at the match', { timeout: 120_000 }, async () => {
  await writeFile(join(folder, 'notes', 'd.md'), `${'A line.\n\n'.repeat(40)}The needle is here.\n`);
  const page = await app.page('b.md', 30_000);
  await waitFor(() => page.evaluate('window.ponjoReady.then(() => true)'), 10_000, 'the page ready');
  const key = { key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: (process.platform === 'darwin' ? 4 : 2) | 8 };
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, ...key });
  assert.ok(await page.evaluate(`document.activeElement.matches('.pj-files-filter') && document.querySelector('.pj-files-mode').getAttribute('aria-pressed') === 'true'`), 'the field searches');
  await page.send('Input.insertText', { text: 'needle' });
  await waitFor(() => page.evaluate(`Boolean(document.querySelector('.pj-files-hit[data-path="notes/d.md"]'))`), 10_000, 'the hit in notes/d.md');
  assert.equal(await page.evaluate(`document.querySelector('.pj-files-hit mark').textContent`), 'needle');
  await page.evaluate(`document.querySelector('.pj-files-hit[data-path="notes/d.md"]').click()`);

  const next = await app.page('d.md', 30_000);
  await waitFor(() => next.evaluate(`document.querySelector('.pj-find-count')?.textContent === '1 of 1'`), 10_000, 'the find bar at the match');
  assert.equal(await next.evaluate(`document.querySelector('.pj-find-input').value`), 'needle');
  assert.equal(await next.evaluate(`document.querySelector('.pj-found-current')?.textContent`), 'needle', 'the match selected');
  assert.equal(await next.evaluate(`document.querySelector('.pj-files-filter').value`), 'needle', 'the search stays in the sidebar');
});

test('printing a doc prints its text alone, every line of a long plain text file', { timeout: 120_000 }, async () => {
  await writeFile(join(folder, 'long.txt'), Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'));
  const page = await app.page('d.md', 30_000);
  await page.evaluate(`document.querySelector('.pj-files-mode').click()`); // back to the tree's filter
  await page.evaluate(`(() => { const f = document.querySelector('.pj-files-filter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
  await waitFor(() => page.evaluate(`Boolean(document.querySelector('.pj-files-file[data-path="long.txt"]'))`), 10_000, 'long.txt in the tree');
  await page.evaluate(`document.querySelector('.pj-files-file[data-path="long.txt"]').click()`);
  const long = await app.page('long.txt', 30_000);
  await waitFor(() => long.evaluate(`Boolean(document.querySelector('.cm-content'))`), 10_000, 'the plain view');
  await long.send('Emulation.setEmulatedMedia', { media: 'print' });
  // Printing turns the page to print media: CodeMirror then draws every line, not only those on screen, for a moment.
  const drawn = `new Promise((done) => { const until = Date.now() + 400; (function count() { const n = document.querySelectorAll('.cm-line').length; if (n === 400 || Date.now() > until) done(n); else setTimeout(count, 10); })(); })`;
  assert.equal(await long.evaluate(drawn), 400);
  assert.deepEqual(await long.evaluate(`['.pj-header', '.pj-files', '.pj-toolbar', '.pj-margin', '.cm-gutters'].map((s) => getComputedStyle(document.querySelector(s)).display)`), ['none', 'none', 'none', 'none', 'none']);
  await long.send('Emulation.setEmulatedMedia', { media: '' });
});
