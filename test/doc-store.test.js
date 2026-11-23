// The doc's store (src/host/doc-store.js) on a real door (doc-service.js):
// a run lands in one door call at one rev; `wait` wakes only the member
// whose view changed; the settle of people's typing is the clock's task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, control } from '../src/core/controller.js';
import { CLOCK, SETTLE_MS } from '../src/core/doc-world.js';
import { createDocStore } from '../src/host/doc-store.js';
import { openDocService } from '../src/host/doc-service.js';
import { diffOps } from '../src/core/ot.js';
import { fakeConfig, tempDoc, until } from './helpers.js';

const BUDDIES = [{ id: 'b_ada', name: 'Ada', about: '' }, { id: 'b_ben', name: 'Ben', about: '' }];
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

async function withStore(fn, content = 'One.\nTwo.\n') {
  const docPath = await tempDoc(content);
  const settingsDir = await fakeConfig();
  const events = [];
  const doc = await openDocService(docPath, { settingsDir, emit: (name, data) => events.push([name, data]) });
  const owner = await doc.owner();
  const store = await createDocStore({ door: doc.door, subscribe: doc.subscribe, docPath: doc.docPath, settingsDir, owner: async () => owner });
  store.members({ owner: { id: owner.id, name: owner.name }, people: [], buddies: BUDDIES });
  try {
    await fn({ doc, store, owner, events, call: (type, arg) => doc.call(type, arg, owner) });
  } finally {
    await doc.close();
  }
}

test('a run lands in one door call at one rev: its groups, each a version of its own, and its comments', async () => {
  await withStore(async ({ doc, store, call, events }) => {
    const { id } = await call('comment', { anchor: null, body: '@Ada number them' });
    const ada = store.client('b_ada');
    const { view } = ada.read();
    const base = view.content.text;
    const before = await call('state');
    const sidecar = '{"comments":3}\n';
    const comments = { before: sidecar, after: `${sidecar}{"thread":"${id}","body":"First."}\n{"body":"Second."}\n` };
    const groups = [{ comment: 0, doc: base.replace('One.', '1.') }, { comment: 1, doc: base.replace('One.', '1.').replace('Two.', '2.') }];
    const out = await ada.commit({ as: 'b_ada', answers: view.tasks.map((t) => t.given), body: { base, made: { text: groups[1].doc, comments, groups, output: '' }, tasks: view.tasks } });
    assert.deepEqual([out.landed, out.comments.length], ['Posted', 2]);
    const after = await call('state');
    assert.equal(after.rev, before.rev + 1, 'one rev');
    const landed = events.filter(([name, e]) => name === 'ops' && e.by.kind === 'buddy').map(([, e]) => e);
    assert.equal(landed.length, 1, 'one event');
    assert.deepEqual([landed[0].comments, landed[0].reply, after.text], [true, out.comments[1], '1.\n2.\n']);
    assert.deepEqual(Object.keys(after.edits).sort(), [...out.comments].sort(), 'each group a version of its own, hung on its comment');
    assert.deepEqual(ada.read().view.tasks, [], 'its ask answered by its comment');
    assert.equal(doc.door.text(), '1.\n2.\n');
  });
});

test('wait wakes only the member whose view changed: a settle wakes the watcher it moves, not another buddy', async () => {
  await withStore(async ({ store, call, owner }) => {
    await store.client(owner.id).commit({ body: { type: 'watch', buddy: 'b_ada', on: true } });
    const ada = store.client('b_ada');
    const ben = store.client('b_ben');
    const first = ada.read();
    await ada.commit({ as: 'b_ada', answers: first.view.tasks.map((t) => t.given), body: { base: first.view.content.text, made: { text: first.view.content.text, comments: { before: '', after: '' }, groups: [], output: '' }, tasks: first.view.tasks } });
    const state = await call('state');
    await call('submit', { ops: diffOps(state.text, `${state.text}Three.\n`), rev: state.rev, epoch: state.epoch, id: 't.1' });
    const woke = { ada: false, ben: false };
    ada.wait(ada.read().rev).then(() => (woke.ada = true));
    ben.wait(ben.read().rev).then(() => (woke.ben = true));
    const [task] = store.client(CLOCK).read().view.tasks;
    await store.client(CLOCK).commit({ as: CLOCK, answers: [task.given], body: {} });
    await settled();
    assert.deepEqual(woke, { ada: true, ben: false }, 'the settle lists Ada\'s watch; Ben\'s view is as it was');
    assert.deepEqual(ada.read().view.tasks.map((t) => t.kind), ['watch']);
  });
});

test('the settle is the clock\'s task: due SETTLE_MS after people last typed, and only then is a watch listed', async () => {
  await withStore(async ({ store, call, owner }) => {
    await store.client(owner.id).commit({ body: { type: 'watch', buddy: 'b_ada', on: true } });
    const ada = store.client('b_ada');
    const { view } = ada.read();
    await ada.commit({ as: 'b_ada', answers: view.tasks.map((t) => t.given), body: { base: view.content.text, made: { text: view.content.text, comments: { before: '', after: '' }, groups: [], output: '' }, tasks: view.tasks } });
    const at = Date.now();
    const state = await call('state');
    await call('submit', { ops: diffOps(state.text, `${state.text}Three.\n`), rev: state.rev, epoch: state.epoch, id: 't.1' });
    const [task] = store.client(CLOCK).read().view.tasks;
    assert.deepEqual([task.kind, task.as], ['turn', CLOCK]);
    assert.ok(task.at >= at + SETTLE_MS && task.at <= Date.now() + SETTLE_MS, 'due SETTLE_MS after the typing');
    assert.deepEqual(ada.read().view.tasks, [], 'no watch while people type');
    const timer = control(store.client(CLOCK), clock());
    try {
      const listed = await until(() => ada.read().view.tasks.length > 0, 'the watch, once people paused', SETTLE_MS + 3000);
      assert.ok(listed && Date.now() - at >= SETTLE_MS - 50, 'not before');
      assert.equal(ada.read().view.tasks[0].kind, 'watch');
    } finally {
      await timer.stop();
    }
  });
});
