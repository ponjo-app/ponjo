// Outside actions (docs/agent-runtime.md#outside-actions): proposed with a
// comment, recorded on this machine, approved by the owner unless set to
// run without asking, carried out once, and never again on their own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPrompt } from '../src/core/prompt.js';
import { listActions, recordAction } from '../src/store/actions.js';
import { fakeConfig, openTestDoc, tempDoc, until } from './helpers.js';

const unix = { skip: process.platform === 'win32' ? 'the action is a shell script' : false, timeout: 30_000 };

// An action `post` that notes each time it is carried out, by its id and input, and says where it posted.
async function withActions(fn, settings = {}) {
  const settingsDir = await fakeConfig(settings);
  await mkdir(join(settingsDir, 'actions'));
  await writeFile(join(settingsDir, 'actions', 'post'), `#!/bin/sh\necho "$PONJO_ACTION_ID $(cat)" >> "${join(settingsDir, 'posted.log')}"\necho posting\necho "posted to #ops"\n`, { mode: 0o755 });
  await writeFile(join(settingsDir, 'actions', 'post.json'), JSON.stringify({ name: 'Post', about: 'Posts a message to a channel.', input: '{ "channel": "#…", "text": "…" }' }));
  const docPath = await tempDoc('# Plan\n');
  let opened = await openTestDoc(docPath, { settingsDir });
  const call = (type, arg) => opened.call(type, arg);
  const restart = async () => {
    await opened.doc.close();
    opened = await openTestDoc(docPath, { settingsDir });
  };
  const posted = async () => (await readFile(join(settingsDir, 'posted.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const actions = () => call('actions');
  const replies = async (thread) => (await call('state')).threads.find((t) => t.id === thread).comments.filter((c) => c.by.kind === 'ai').map((c) => c.body);
  try {
    await fn({ settingsDir, call, restart, posted, actions, replies });
  } finally {
    await opened.doc.close();
  }
}

test('an action is proposed with its comment and waits for the owner: approved, it is carried out once, with its id, and its result is a reply', unix, async () => {
  await withActions(async ({ call, posted, actions, replies }) => {
    const { id: thread } = await call('comment', { anchor: null, body: '@Clippy act post {"channel":"#ops","text":"hi"};; say Posting the plan.' });
    const [action] = await until(async () => (await actions()).length && actions(), 'the action');
    assert.equal(action.state, 'proposed');
    assert.equal(action.thread, thread);
    assert.deepEqual([action.action, action.name, action.input, action.buddy.name], ['post', 'Post', { channel: '#ops', text: 'hi' }, 'Clippy']);
    assert.deepEqual(await replies(thread), ['Posting the plan.'], 'its comment landed');
    assert.deepEqual(await posted(), [], 'not carried out before it is approved');

    await call('approveAction', { id: action.id });
    await until(async () => (await actions())[0].state === 'done', 'done');
    assert.deepEqual(await posted(), [`${action.id} {"channel":"#ops","text":"hi"}`], 'once, given its id');
    const done = (await actions())[0];
    assert.equal(done.result, 'posted to #ops');
    assert.equal(done.by.name, 'fzhan', 'who approved it');
    await until(async () => (await replies(thread)).length === 2, 'its result');
    assert.deepEqual(await replies(thread), ['Posting the plan.', 'Post: posted to #ops']);

    await assert.rejects(call('approveAction', { id: action.id }), { code: 'stale' }, 'approved once only');
    await assert.rejects(call('retryAction', { id: action.id }), { code: 'stale' }, 'a done action is not done again');
    assert.equal((await posted()).length, 1);
  });
});

test('a declined action is never carried out; one not installed, or from a failed run, is not proposed', unix, async () => {
  await withActions(async ({ call, posted, actions }) => {
    await call('comment', { anchor: null, body: '@Clippy act post {"text":"a"};; act deploy {"to":"prod"}' });
    const [action] = await until(async () => (await actions()).length && actions(), 'the action');
    assert.equal((await actions()).length, 1, 'deploy is not installed');
    await call('declineAction', { id: action.id });
    assert.equal((await actions())[0].state, 'declined');
    await assert.rejects(call('approveAction', { id: action.id }), { code: 'stale' });

    await call('comment', { anchor: null, body: '@Clippy fail act post {"text":"b"}' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await actions()).length, 1, 'a failed run lands nothing, so proposes nothing');
    assert.deepEqual(await posted(), []);
  });
});

test('set to run without asking, an action of the owner\'s run is carried out at once', unix, async () => {
  await withActions(async ({ call, posted, actions }) => {
    await call('comment', { anchor: null, body: '@Clippy act post {"text":"now"}' });
    await until(async () => (await actions())[0]?.state === 'done', 'done');
    assert.equal((await actions())[0].by, null, 'no one approved it: it was set to run without asking');
    assert.equal((await posted()).length, 1);
  }, { actions: { post: { ask: false } } });
});

test('an action that started and did not end, as the host stopped, may have run: it is not started again on its own; Retry carries it out', unix, async () => {
  await withActions(async ({ settingsDir, restart, call, posted, actions }) => {
    await call('comment', { anchor: null, body: '@Clippy act post {"text":"x"}' });
    const [action] = await until(async () => (await actions()).length && actions(), 'the action');
    await recordAction(settingsDir, { id: action.id, state: 'approved', by: { id: 'u_x', name: 'fzhan' } });
    await recordAction(settingsDir, { id: action.id, state: 'started' }); // and then the host stopped
    await restart();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await actions())[0].state, 'unknown', 'it may have run');
    assert.deepEqual(await posted(), [], 'not started again on its own');
    await assert.rejects(call('approveAction', { id: action.id }), { code: 'stale' });
    await call('retryAction', { id: action.id });
    await until(async () => (await actions())[0].state === 'done', 'done');
    assert.deepEqual(await posted(), [`${action.id} {"text":"x"}`], 'with the same id, so a service that takes one drops a second try');
  });
});

test('an action is listed only with a manifest that says what it does and takes; the prompt lists them and how to propose one', async () => {
  const settingsDir = await fakeConfig();
  await mkdir(join(settingsDir, 'actions'));
  for (const name of ['post', 'bare', 'vague']) await writeFile(join(settingsDir, 'actions', name), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(settingsDir, 'actions', 'post.json'), JSON.stringify({ name: 'Post', about: 'Posts a message.', input: '{ "text": "…" }' }));
  await writeFile(join(settingsDir, 'actions', 'vague.json'), JSON.stringify({ name: 'Vague' }));
  const actions = await listActions(settingsDir, 'linux');
  assert.deepEqual(actions, [{ id: 'post', name: 'Post', about: 'Posts a message.', input: '{ "text": "…" }' }]);
  const prompt = buildPrompt({ buddy: { id: 'b_a', name: 'Ada', about: '' }, docName: 'a.md', sidecarName: 'a.md.comments.jsonl', threads: [], human: { name: 'fzhan', about: '' }, actions });
  assert.match(prompt, /post: Posts a message\. Input: \{ "text": "…" \}/);
  assert.match(prompt, /PONJO_ACTIONS/);
  assert.match(prompt, /fzhan approves it/);
  assert.doesNotMatch(buildPrompt({ buddy: { id: 'b_a', name: 'Ada', about: '' }, docName: 'a.md', sidecarName: 'a.md.comments.jsonl', threads: [] }), /PONJO_ACTIONS/, 'with none, nothing about them');
});
