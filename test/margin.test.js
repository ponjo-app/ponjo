// The comment margin (web/threads.js): threads not open are folded; the open
// one sits at its text however many cards stack above it; the threads with
// no place in the text are one comment icon at the top, opened in place and
// closed by a click in the doc. The desktop app on a folder, so it needs the
// page built (npm run build).

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

// A comment line of the sidecar (spec/SPEC.md §2).
const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`;
const on = (exact) => {
  const start = SAMPLE.indexOf(exact);
  return { exact, prefix: SAMPLE.slice(Math.max(0, start - 32), start), suffix: SAMPLE.slice(start + exact.length, start + exact.length + 32), start };
};
const fan = { id: 'u_fan00001', name: 'fan', kind: 'human' };
const clippy = { id: 'Clippy', name: 'Clippy', kind: 'ai' };
const COMMENTS = [
  // Five threads on the title, whose cards stack above the last line's.
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `c_title00${n}`, anchor: on('Q4 Launch Plan'), by: fan, at: at(n), body: `Title note ${n}, long enough to take a second line in the margin.` })),
  { id: 'c_capacity', anchor: on('capacity doc'), by: fan, at: at(10), body: '@Clippy is this doc current?' },
  { id: 'c_capreply', thread: 'c_capacity', by: clippy, at: at(11), body: 'It is, as of last week.' },
  { id: 'c_capagain', thread: 'c_capacity', by: fan, at: at(12), body: 'Thanks.' },
  { id: 'c_wholedoc', anchor: null, by: fan, at: at(20), body: 'On the doc as a whole.' },
  { id: 'c_deleted1', anchor: { exact: 'a sentence no longer here', prefix: '', suffix: '', start: 0 }, by: fan, at: at(21), body: 'About deleted text.' },
];

let app;
let page;

before(async () => {
  const folder = join(await mkdtemp(join(tmpdir(), 'ponjo-margin-')), 'project');
  await mkdir(folder);
  await writeFile(join(folder, 'plan.md'), SAMPLE);
  await writeFile(join(folder, 'plan.md.comments.jsonl'), [{ comments: 3 }, ...COMMENTS].map((line) => JSON.stringify(line)).join('\n') + '\n');
  const config = await fakeConfig();
  const env = { ...process.env, PONJO_CONFIG_DIR: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : []; // CI's Electron cannot sandbox on Linux
  app = await launchElectron(electron, [join(root, 'desktop', 'main.js'), ...sandbox, `--user-data-dir=${join(config, 'profile')}`, folder], { env });
  page = await app.page('plan.md', 60_000);
  await waitFor(() => page.evaluate('window.ponjoReady.then(() => true)'), 30_000, 'the page ready');
  await waitFor(() => page.evaluate(`document.querySelectorAll('.pj-margin .pj-card').length === 6`), 10_000, 'the cards');
});

after(() => app?.quit());

const margin = () => page.evaluate(`(() => {
  const card = (id) => document.querySelector('.pj-margin [data-thread="' + id + '"]');
  const button = document.querySelector('.pj-unplaced');
  return {
    folded: document.querySelectorAll('.pj-card-folded').length,
    foot: card('c_capacity')?.querySelector('.pj-foot')?.textContent,
    replies: card('c_capacity')?.querySelectorAll('.pj-msg').length ?? 0,
    // How far the capacity card sits below its text, in pixels.
    drift: Math.round(card('c_capacity').getBoundingClientRect().top - document.querySelector('.pj-page [data-thread="c_capacity"]').getBoundingClientRect().top),
    button: button && { count: button.textContent, title: button.title, expanded: button.getAttribute('aria-expanded') },
    aside: [...document.querySelectorAll('.pj-card-aside')].map((c) => c.dataset.thread),
  };
})()`);

test('threads not open are folded to their first comment and a line on what followed; the open one is whole, at its text, though five cards stack above it', { timeout: 60_000 }, async () => {
  const folded = await margin();
  assert.equal(folded.folded, 6);
  assert.match(folded.foot, /^2 replies·/);
  assert.equal(folded.replies, 0, 'no message rows when folded');
  assert.ok(folded.drift > 100, `the stacked cards push the folded one down (${folded.drift}px)`);

  await page.evaluate(`document.querySelector('.pj-margin [data-thread="c_capacity"]').click()`);
  await waitFor(async () => (await margin()).replies === 3, 10_000, 'the thread open');
  const open = await margin();
  assert.equal(open.folded, 5);
  assert.ok(Math.abs(open.drift) < 16, `the open card at its text (${open.drift}px)`);
});

test('the threads with no place in the text are one comment icon at the top; it opens them in place, and a click in the doc closes them', { timeout: 60_000 }, async () => {
  assert.deepEqual((await margin()).button, { count: '2', title: '1 on the whole document, 1 whose text was deleted', expanded: 'false' });
  await page.evaluate(`document.querySelector('.pj-unplaced').click()`);
  await waitFor(async () => (await margin()).aside.length === 2, 10_000, 'the threads open');
  assert.deepEqual((await margin()).aside, ['c_wholedoc', 'c_deleted1']);
  assert.equal((await margin()).button.expanded, 'true');
  assert.equal(await page.evaluate(`document.querySelector('[data-thread="c_deleted1"] .pj-quote-gone')?.textContent`), 'a sentence no longer here');

  // Selecting one of them keeps them open, with its reply box.
  await page.evaluate(`document.querySelector('.pj-card-aside[data-thread="c_wholedoc"] .pj-body').click()`);
  await waitFor(() => page.evaluate(`Boolean(document.querySelector('.pj-card-aside[data-thread="c_wholedoc"] textarea'))`), 10_000, 'the reply box');
  assert.equal((await margin()).aside.length, 2);

  await page.evaluate(`document.querySelector('.pj-page').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await waitFor(async () => (await margin()).aside.length === 0, 10_000, 'the threads closed');
  assert.equal((await margin()).button.expanded, 'false');
});
