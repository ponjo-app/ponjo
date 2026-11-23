// The comment margin (web/threads.js): threads not open are folded; the open
// one sits at its text however many cards stack above it; the threads with
// no place in the text are one comment icon at the top, opened in place and
// closed by a click in the doc; a failed run's answer has Retry. The desktop
// app on a folder, so it needs the page built (npm run build).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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
  // A thread whose buddy's run failed (src/host/doc-store.js, land).
  { id: 'c_failed01', anchor: on('for details'), by: fan, at: at(30), body: '@Clippy fail' },
  { id: 'c_failreply', thread: 'c_failed01', by: clippy, at: at(31), body: 'Could not finish.' },
];

let app;
let page;
let folder;

before(async () => {
  folder = join(await mkdtemp(join(tmpdir(), 'ponjo-margin-')), 'project');
  await mkdir(folder);
  await writeFile(join(folder, 'plan.md'), SAMPLE);
  await writeFile(join(folder, 'plan.md.comments.jsonl'), [{ comments: 3 }, ...COMMENTS].map((line) => JSON.stringify(line)).join('\n') + '\n');
  const config = await fakeConfig();
  // An action Clippy's reply proposed, waiting for the owner (src/host/doc-actions.js).
  await mkdir(join(config, 'actions'));
  await mkdir(join(config, 'logs'));
  await writeFile(join(config, 'actions', 'post'), '#!/bin/sh\necho "posted to #ops"\n', { mode: 0o755 });
  await writeFile(join(config, 'actions', 'post.cmd'), '@echo posted to #ops\r\n');
  await writeFile(join(config, 'actions', 'post.json'), JSON.stringify({ name: 'Post', about: 'Posts a message.', input: '{ "text": "…" }' }));
  await writeFile(join(config, 'logs', 'actions.jsonl'), `${JSON.stringify({ id: 'a_post0001', state: 'proposed', doc: await realpath(join(folder, 'plan.md')), comment: 'c_capreply', thread: 'c_capacity', action: 'post', name: 'Post', input: { text: 'The doc is current.' }, buddy: { id: 'Clippy', name: 'Clippy' }, for: [], depth: 0, at: at(11) })}\n`);
  const env = { ...process.env, PONJO_CONFIG_DIR: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : []; // CI's Electron cannot sandbox on Linux
  app = await launchElectron(electron, [join(root, 'desktop', 'main.js'), ...sandbox, `--user-data-dir=${join(config, 'profile')}`, folder], { env });
  page = await app.page('plan.md', 60_000);
  await waitFor(() => page.evaluate('window.ponjoReady.then(() => true)'), 30_000, 'the page ready');
  await waitFor(() => page.evaluate(`document.querySelectorAll('.pj-margin .pj-card').length === 7`), 10_000, 'the cards');
});

after(() => app?.quit());

const margin = () => page.evaluate(`(() => {
  const card = (id) => document.querySelector('.pj-margin [data-thread="' + id + '"]');
  const button = document.querySelector('.pj-unplaced');
  return {
    folded: document.querySelectorAll('.pj-card-folded').length,
    latest: card('c_capacity')?.querySelector('.pj-folded-reply .pj-body')?.textContent,
    between: card('c_capacity')?.querySelector('.pj-folded-more')?.textContent,
    status: card('c_capacity')?.querySelector('.pj-foot, .pj-typing') ?? null,
    replies: card('c_capacity')?.querySelectorAll('.pj-msg').length ?? 0,
    // How far the capacity card sits below its text, in pixels.
    drift: Math.round(card('c_capacity').getBoundingClientRect().top - document.querySelector('.pj-page [data-thread="c_capacity"]').getBoundingClientRect().top),
    button: button && { count: button.textContent, title: button.title, expanded: button.getAttribute('aria-expanded') },
    aside: [...document.querySelectorAll('.pj-card-aside')].map((c) => c.dataset.thread),
  };
})()`);

test('threads not open are folded to their first comment and their latest reply, with no status line; the open one is whole, at its text, though five cards stack above it', { timeout: 60_000 }, async () => {
  const folded = await margin();
  assert.equal(folded.folded, 7);
  assert.equal(folded.latest, 'Thanks.', 'the latest reply');
  assert.equal(folded.between, '1 more reply', 'and how many it leaves out');
  assert.equal(folded.status, null, 'no line on who is at work or how many replied');
  assert.equal(folded.replies, 0, 'no message rows when folded');
  assert.ok(folded.drift > 100, `the stacked cards push the folded one down (${folded.drift}px)`);

  await page.evaluate(`document.querySelector('.pj-margin [data-thread="c_capacity"]').click()`);
  await waitFor(async () => (await margin()).replies === 3, 10_000, 'the thread open');
  const open = await margin();
  assert.equal(open.folded, 6);
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

test('an action a reply proposed shows under it, its input in full; the owner approves it, and it is done', { timeout: 60_000 }, async () => {
  await page.evaluate(`document.querySelector('.pj-margin [data-thread="c_capacity"]').click()`);
  const action = () => page.evaluate(`(() => {
    const box = document.querySelector('.pj-margin [data-thread="c_capacity"] .pj-action');
    return box && { tag: box.querySelector('.pj-version-tag').textContent, input: box.querySelector('.pj-trace-text').textContent, buttons: [...box.querySelectorAll('button')].map((b) => b.textContent), foot: box.querySelector('.pj-action-foot > span').textContent };
  })()`);
  const waiting = await waitFor(action, 10_000, 'the action');
  assert.equal(waiting.tag, 'Waiting');
  assert.deepEqual(JSON.parse(waiting.input), { text: 'The doc is current.' });
  assert.deepEqual(waiting.buttons, ['Decline', 'Approve'], 'the owner decides');
  await page.evaluate(`[...document.querySelectorAll('.pj-margin .pj-action button')].find((b) => b.textContent === 'Approve').click()`);
  await waitFor(async () => (await action())?.tag === 'Done', 20_000, 'done');
  const done = await action();
  assert.deepEqual(done.buttons, [], 'nothing left to decide');
  assert.match(done.foot, /^Approved by .+\. posted to #ops$/);
});

test('a buddy\'s "Could not finish." shows failed, with Retry: Retry asks the buddy again as the person, and it runs', { timeout: 60_000 }, async () => {
  await page.evaluate(`document.querySelector('.pj-margin [data-thread="c_failed01"]').click()`);
  const rows = () => page.evaluate(`[...document.querySelectorAll('.pj-margin [data-thread="c_failed01"] .pj-msg')].map((row) => ({
    body: row.querySelector('.pj-body')?.textContent, failed: row.classList.contains('pj-msg-failed'), buttons: [...row.querySelectorAll('.pj-msg-note button')].map((b) => b.textContent),
  }))`);
  await waitFor(async () => (await rows()).length === 2, 10_000, 'the thread open');
  assert.deepEqual((await rows())[1], { body: 'Could not finish.', failed: true, buttons: ['Retry'] });
  await page.evaluate(`[...document.querySelectorAll('.pj-margin [data-thread="c_failed01"] .pj-msg-note button')].find((b) => b.textContent === 'Retry').click()`);
  const sidecar = async () => (await readFile(join(folder, 'plan.md.comments.jsonl'), 'utf8')).trim().split('\n').slice(1).map((l) => JSON.parse(l)).filter((c) => c.thread === 'c_failed01');
  await waitFor(async () => (await sidecar()).length === 3, 20_000, 'the person\'s reply, then the buddy\'s run');
  assert.deepEqual((await sidecar()).slice(1).map((c) => [c.by.name, c.body]), [['fzhan', '@Clippy try again.'], ['Clippy', 'Nothing to change.']]);
  await waitFor(async () => (await rows()).length === 4, 10_000, 'the replies shown');
  assert.deepEqual((await rows())[1].buttons, [], 'Retry only on the latest');
});
