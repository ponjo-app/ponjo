// The runtime (src/core/runtime.js) on a world that refuses
// (docs/agent-runtime.md, Refused and failed): a turn-based game, small.
// A refusal is the world's own change: it says why in the player's next
// view and asks again, a step deeper, or plays its fallback. The runtime
// knows nothing of it, and still comes to rest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/core/runtime.js';
import { until } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ME = 'u_person01';

/**
 * A game where it is agent A's turn, asked for by the person ME. A move
 * `good` lands; any other is refused. Refused `tries` times, the world
 * plays its fallback (none: it only asks again). `limit` its depth limit.
 */
function game({ tries = 3, limit = 1000 } = {}) {
  let rev = 0;
  let clock = Date.parse('2026-11-21T10:00:00.000Z');
  const stamp = () => new Date((clock += 1000)).toISOString();
  const log = [];
  const waiting = new Set();
  let turn = { id: 'turn', agent: 'b_a', from: ME, at: stamp(), until: new Date(clock).toISOString() };
  const state = { moves: [], refusals: 0, why: null, fallbacks: 0 };
  const commit = () => {
    log.push({ rev: ++rev, by: { id: null, kind: 'world' }, at: performance.now(), asks: true, stale: false });
    for (const done of waiting) done();
  };
  const world = {
    limits: { depth: limit },
    settleMs: 0,
    print: (files) => JSON.stringify(files),
    wakes: () => false,
    members: async () => [{ id: ME, name: 'Me', kind: 'person', mayAsk: true }, { id: 'b_a', name: 'A', kind: 'agent', mayAsk: false }],
    asks: async () => (turn ? [turn] : []),
    view: async () => ({ rev, files: { moves: [...state.moves], why: state.why }, prompt: state.why ? `Your last move was turned away: ${state.why}` : 'Your turn.' }),
    async wait(version, deadline) {
      for (;;) {
        const since = log.filter((c) => c.rev > version);
        if (since.length || performance.now() >= deadline) return { rev, log: since };
        await new Promise((resolve) => {
          const done = () => {
            waiting.delete(done);
            resolve();
          };
          waiting.add(done);
        });
      }
    },
    // The writer: a good move lands and ends the turn; any other is refused,
    // said why, and asked again a step deeper than the run, or, at `tries`,
    // the world's fallback ends the turn.
    async propose(agent, version, old, made) {
      if (made.move === 'good') {
        state.moves.push('good');
        Object.assign(state, { refusals: 0, why: null });
        turn = null;
        commit();
        return { landed: 'Moved' };
      }
      state.refusals += 1;
      state.why = `${made.move} is not a legal move`;
      if (state.refusals >= tries) {
        state.fallbacks += 1;
        state.moves.push('fallback');
        turn = null;
      } else {
        turn = { ...turn, at: stamp(), until: new Date(clock).toISOString(), for: agent.for, depth: agent.depth };
      }
      commit();
      return { landed: `Refused: ${state.why}` };
    },
  };
  return { world, state };
}

// The runtime on `world`, its agent making the moves `moves(view)` says.
async function withRuntime(world, moves, fn) {
  const views = [];
  const runtime = await createRuntime({
    world,
    async run(task, view) {
      views.push(view);
      return { at: Date.now(), ms: 0, outcome: 'ok', made: { move: moves(view) } };
    },
    breaker: async () => ({ pauseAfter: 100, pauseWithin: 10 }),
    watching: { read: async () => ({}), note: () => {} },
    log: () => {},
    ended: () => {},
    emit: () => {},
  });
  try {
    await runtime.sync();
    await fn({ runtime, views });
  } finally {
    await runtime.close();
  }
}

test('a refused move: the player is asked again, told why, and its next move lands', async () => {
  const { world, state } = game();
  await withRuntime(world, (view) => (view.files.why ? 'good' : 'bad'), async ({ runtime, views }) => {
    await until(() => state.moves.length === 1 && runtime.running().length === 0, 'its move to land');
    assert.deepEqual(views.map((v) => v.prompt), ['Your turn.', 'Your last move was turned away: bad is not a legal move']);
    assert.deepEqual(state.moves, ['good']);
    await sleep(200);
    assert.equal(views.length, 2, 'the turn is over: no more runs');
  });
});

test('refused again and again: the world plays its fallback, once, and the runs stop', async () => {
  const { world, state } = game({ tries: 3 });
  await withRuntime(world, () => 'bad', async ({ runtime, views }) => {
    await until(() => state.fallbacks === 1 && runtime.running().length === 0, 'the fallback');
    await sleep(200);
    assert.deepEqual([views.length, state.moves], [3, ['fallback']]);
  });
});

test('a world with no fallback still comes to rest: each ask again is a step deeper, up to the depth limit', async () => {
  const { world, state } = game({ tries: Infinity, limit: 2 });
  await withRuntime(world, () => 'bad', async ({ runtime, views }) => {
    await until(() => state.refusals === 3 && runtime.running().length === 0, 'three refusals');
    await sleep(200);
    assert.equal(views.length, 3, 'depths 0, 1 and 2; the ask at depth 3 runs no one');
    assert.equal((await world.asks()).length, 1, 'it still asks');
  });
});
