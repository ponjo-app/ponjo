// The runtime's core (docs/runtime/README.md, Part 1 and the wallet's
// limits): the store (src/core/store.js), the answer ledger
// (src/core/ledger.js), and the controllers and the clock
// (src/core/controller.js), on a toy world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, control, limits } from '../src/core/controller.js';
import { ledger } from '../src/core/ledger.js';
import { createStore } from '../src/core/store.js';
import { until } from './helpers.js';

// A toy world: each member has a number, and while it is odd, a task to
// make it even. A change adds `add` (1 by default) to its member's; one
// that adds 2 is refused. The fallback adds 1. `kind`, `depth`
// and `at` are the tasks'. The log is who changed it, and when.
const toy = {
  view: (s, member) => ({
    content: s.n[member] ?? 0,
    actions: [],
    tasks: (s.n[member] ?? 0) % 2 ? [{ given: `odd:${s.n[member]}`, as: member, kind: s.kind, from: [], depth: s.depth, at: s.at, why: 'odd' }] : [],
    seen: Object.keys(s.n),
    rules: '',
  }),
  apply(s, change) {
    if (change.body.add === 2) return { refused: 'Not 2.' };
    const n = (s.n[change.by] ?? 0) + (change.body.add ?? 1);
    return { state: { ...s, n: { ...s.n, [change.by]: n }, log: [...s.log, `${change.by}@${change.at}`] }, effects: [] };
  },
  fallback: (s, task) => ({ ...s, n: { ...s.n, [task.as]: s.n[task.as] + 1 }, log: [...s.log, `${task.as} fell back`] }),
  tries: 2,
};
const world = ledger(toy);
const start = (n, more = {}) => ({ rev: 0, state: world.wrap({ n, log: [], kind: 'turn', depth: 0, at: 0, ...more }) });
function open(kept, now = () => 7) {
  const box = { kept };
  const store = createStore(world, { load: () => box.kept, save: (k) => (box.kept = k), now });
  return { box, a: store.client('a'), b: store.client('b'), state: () => box.kept.state.world };
}
// A run's change: it answers the tasks its member is given now.
const answer = (client, body) => client.commit({ as: client.read().view.tasks[0].as, answers: client.read().view.tasks.map((t) => t.given), ...body });
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the store: each member reads its own view; commit sets who and when; a wait wakes only the member whose view changed', async () => {
  const t = open(start({ a: 1, b: 0 }));
  assert.deepEqual(t.a.read(), { rev: 0, view: toy.view(t.state(), 'a') });
  assert.equal(t.b.read().view.content, 0);
  let woke = false;
  const waiting = t.a.wait(0).then((rev) => (woke = rev));
  assert.equal(t.b.commit({ body: { add: 4 } }).rev, 1);
  await settled();
  assert.equal(woke, false, 'b\'s change leaves a\'s view as it was');
  assert.deepEqual(t.state().log, ['b@7'], 'the store set by and at, not the change');
  t.a.commit({ body: { add: 1 } });
  assert.equal(await waiting, 2);
  assert.equal(await t.b.wait(0), 2, 'b\'s view changed since it read it: at once');
  assert.deepEqual(t.a.commit({ body: { add: 2 } }), { refused: 'Not 2.' }, 'refused, it lands nothing');
  assert.equal(t.box.kept.rev, 2);
});

test('the store reloaded from what it saved goes on where it was, as after a refresh', () => {
  const t = open(start({ a: 1, b: 1 }));
  t.a.commit({ body: {} });
  answer(t.b, { body: { add: 2 } }); // a try
  const again = open(JSON.parse(JSON.stringify(t.box.kept)));
  assert.equal(again.a.read().rev, 2);
  assert.deepEqual(again.a.read().view.tasks, []);
  assert.equal(again.b.read().view.tasks[0].refused, 'Not 2.', 'the ledger is in the state');
  assert.equal(again.b.commit({ body: {} }).rev, 3);
});

test('the ledger: an answer is gone; a refused run is a try, told why, and at the limit takes the fallback; a person\'s refusal lands nothing', () => {
  const t = open(start({ a: 1, b: 1 }));
  const out = answer(t.a, { body: { add: 2 } });
  assert.deepEqual([out.rev, out.refused], [1, 'Not 2.'], 'the try lands: a rev');
  assert.deepEqual(t.a.read().view.tasks.map((task) => task.refused), ['Not 2.']);
  assert.equal(t.b.read().view.tasks[0].refused, undefined, 'only that seat\'s view');
  answer(t.a, { body: { add: 2 } });
  assert.deepEqual([t.state().n.a, t.state().log], [2, ['a fell back']], 'two tries: its fallback');
  assert.deepEqual(t.a.read().view.tasks, []);
  assert.deepEqual(t.b.commit({ body: { add: 2 } }), { refused: 'Not 2.' }, 'no answers: lands nothing');
  answer(t.b, { body: {} });
  assert.deepEqual(t.b.read().view.tasks, [], 'answered');
});

test('the ledger: a failed run, or one that made nothing, takes a turn\'s fallback at once, and answers an ask', () => {
  const turn = open(start({ a: 1, b: 1 }));
  answer(turn.a, { failed: 'No model' });
  answer(turn.b, { body: null });
  assert.deepEqual(turn.state().log, ['a fell back', 'b fell back']);
  assert.deepEqual(turn.a.commit({ as: 'a', answers: ['odd:1'], failed: 'late' }), { refused: 'None of these tasks is due.' });
  const ask = open(start({ a: 1, b: 1 }, { kind: 'ask' }));
  answer(ask.a, { failed: 'No model' });
  answer(ask.b, { body: null });
  assert.deepEqual([ask.state().n, ask.state().log], [{ a: 1, b: 1 }, []], 'nothing changed but the ledger');
  assert.deepEqual([ask.a.read().view.tasks, ask.b.read().view.tasks], [[], []], 'gone');
});

test('a controller hands its tasks to a run and commits its answer; a run whose tasks are gone is stopped and commits nothing', async () => {
  const t = open(start({ a: 1, b: 1 }));
  const runs = [];
  let release;
  const a = control(t.a, {
    program: (tasks, view, signal) => {
      runs.push(tasks.map((task) => task.given));
      return runs.length === 1 ? new Promise((resolve) => (release = () => resolve({ body: { add: 3 } }))) : { body: {} };
    },
  });
  await until(() => release, 'the run to start');
  answer(t.a, { body: {} }); // another writer makes a's number even: the run's task is gone
  t.a.commit({ body: { add: 1 } }); // odd again: a new task
  await until(() => runs.length === 2, 'a new run on the new task');
  release();
  await until(() => !t.a.read().view.tasks.length, 'the second run to land');
  await settled();
  assert.deepEqual(runs, [['odd:1'], ['odd:3']]);
  assert.equal(t.state().n.a, 4, 'the stopped run committed nothing');
  a.stop();
});

test('the wallet: past the depth limit, or N runs on asks since a person acted, a task is not started and takes its fallback', async () => {
  const deep = open(start({ a: 1, b: 0 }, { depth: 11 }));
  const ran = [];
  const a = control(deep.a, { program: () => ran.push('a') && { body: {} }, wallet: limits() });
  await until(() => deep.state().log.length, 'the task answered');
  assert.deepEqual([deep.state().log, ran], [['a fell back'], []]);
  a.stop();
  const asks = open(start({ a: 1, b: 0 }, { kind: 'ask' }));
  const wallet = limits({ runs: 1 });
  const b = control(asks.a, { program: () => ({ body: {} }), wallet });
  await until(() => asks.state().n.a === 2, 'the first run');
  asks.a.commit({ body: { add: 1 } }); // odd again
  await until(() => !asks.a.read().view.tasks.length, 'the second, not started');
  assert.equal(asks.state().n.a, 3, 'not started: the ask is answered, nothing done');
  wallet.acted();
  asks.a.commit({ body: { add: 4 } });
  await until(() => asks.state().n.a === 8, 'a person acted: it runs again');
  b.stop();
});

test('the clock is a member whose program waits until its task is due', async () => {
  const t = open(start({ a: 1, b: 0 }, { at: Date.now() + 80 }), Date.now);
  const from = Date.now();
  const a = control(t.a, clock());
  await until(() => t.state().n.a === 2, 'the clock\'s change');
  assert.ok(Date.now() - from >= 70, 'not before its at');
  a.stop();
});
