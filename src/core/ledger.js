// The answer ledger (docs/runtime/README.md, Answers): a pure wrapper round
// a world that keeps, in the state, how each task was answered, keyed by its
// seat and `given`, never by `rev`. A world gives `view`, `apply`, its
// `fallback(state, task, at)` (what the rules do for a turn no one played)
// and its limit of `tries`. The wrapped state is { world, answers }.
//
// A change that answers tasks (`answers`, their `given`s) is a run's:
//   accepted        each task answered
//   refused         a try, its why on the task in the seat's next view; at
//                   the world's limit, as failed
//   failed, or nothing (`body` null)
//                   a `turn` takes its fallback at once; any other task is answered
// A change that answers none (a person's, one of a member's own accord)
// lands nothing when refused: its member sees why at once.

const key = (task) => `${task.as} ${task.given}`;

/** `world` with the ledger: { view, apply, wrap(state) → the wrapped state to start from }. */
export function ledger(world) {
  return {
    wrap: (state) => ({ world: state, answers: {} }),

    view(state, member) {
      const v = world.view(state.world, member);
      const tasks = v.tasks.filter((t) => !state.answers[key(t)]?.done).map((t) => (state.answers[key(t)] ? { ...t, refused: state.answers[key(t)].why } : t));
      return { ...v, tasks };
    },

    apply(state, change) {
      const tasks = world.view(state.world, change.by).tasks.filter((t) => t.as === change.as && change.answers?.includes(t.given) && !state.answers[key(t)]?.done);
      const answers = { ...state.answers };
      let s = state.world;
      const done = (t) => {
        if (t.kind === 'turn') s = world.fallback(s, t, change.at);
        answers[key(t)] = { done: true };
      };
      if (change.failed || change.body === null) {
        if (!tasks.length) return { refused: 'None of these tasks is due.' };
        tasks.forEach(done);
        return { state: { world: s, answers }, effects: [] };
      }
      const out = world.apply(s, change);
      if (!out.refused) {
        for (const t of tasks) answers[key(t)] = { done: true };
        return { state: { world: out.state, answers }, effects: out.effects };
      }
      if (!tasks.length) return out;
      for (const t of tasks) {
        const tries = (answers[key(t)]?.tries ?? 0) + 1;
        if (tries < world.tries) answers[key(t)] = { tries, why: out.refused };
        else done(t);
      }
      return { state: { world: s, answers }, effects: [], refused: out.refused };
    },
  };
}
