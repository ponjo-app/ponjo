// A member's controller (docs/runtime/README.md, Controllers): it reads its
// member's view, hands tasks to its program, commits what the program
// returns, and waits until its view changes. One loop for a person, an
// agent and the clock; only the program differs. Also the wallet's limits
// (Part 2, Wallet) and the clock's program (Time).

const same = (a, b) => a.as === b.as && a.given === b.given;

/**
 * Runs `client`'s member (a store's client) until stopped. Each time its
 * view changes, `show(view)` gets it (a person's screen draws it, every task
 * in it), and, with no run going, `pick(view)` the tasks of one run (by
 * default, those of the first task's seat, in the view's order). The
 * `wallet`, if given, says which may start; the rest are answered as not
 * started. A run is `program(tasks, view, signal)`, resolving to { base,
 * body }, or null for nothing; it throws when it fails. It goes on while
 * any of its tasks is still listed; stopped, it commits nothing. A store
 * whose commit is a promise is waited on: no run starts before it is in.
 * Returns { stop() }, which resolves once its run, if any, has ended.
 */
export function control(client, { program, pick = (view) => view.tasks.filter((t) => t.as === view.tasks[0].as), show = () => {}, wallet }) {
  let run = null;
  let stopped = false;

  function start(tasks, view) {
    const r = { tasks, stop: new AbortController() };
    wallet?.charge(tasks);
    r.done = (async () => {
      let made;
      try {
        made = (await program(tasks, view, r.stop.signal)) ?? { body: null };
      } catch (error) {
        made = { failed: error.message };
      }
      if (!r.stop.signal.aborted) await (r.landing = client.commit({ as: tasks[0].as, answers: tasks.map((t) => t.given), ...made }));
      if (run === r) run = null;
    })();
    return r;
  }

  (async () => {
    while (!stopped) {
      if (run?.landing) await run.done; // it lands: what it did is read next
      if (stopped) break;
      const { rev, view } = client.read();
      show(view);
      if (run && !run.tasks.some((t) => view.tasks.some((u) => same(t, u)))) {
        run.stop.abort();
        run = null;
      }
      if (!run && program && view.tasks.length) {
        const tasks = pick(view);
        const allowed = wallet ? wallet.allow(tasks) : tasks;
        if (allowed.length < tasks.length) await client.commit({ as: tasks[0].as, answers: tasks.filter((t) => !allowed.includes(t)).map((t) => t.given), failed: 'Not started: past the wallet\'s limits.' });
        else if (tasks.length) run = start(tasks, view);
      }
      await Promise.race([client.wait(rev), ...(run ? [run.done] : [])]);
    }
  })();

  return {
    stop() {
      stopped = true;
      run?.stop.abort();
      return run?.done;
    },
  };
}

/**
 * The owner's limits on an agent's runs: past `depth`, no task starts, so
 * agents waking each other come to rest; past `runs` runs on tasks other
 * than turns since a person last acted (`acted()`), and within `within`
 * ms, none of those starts (`paused()`).
 */
export function limits({ depth = 10, runs = 30, within = Infinity, now = Date.now } = {}) {
  let started = []; // when each counted run started
  const count = () => (started = started.filter((at) => at > now() - within)).length;
  return {
    allow: (tasks) => tasks.filter((t) => t.depth <= depth && (t.kind === 'turn' || count() < runs)),
    charge(tasks) {
      if (tasks.some((t) => t.kind !== 'turn')) started.push(now());
    },
    acted() {
      started = [];
    },
    paused: () => count() >= runs,
  };
}

/**
 * The clock as a member: its program waits until its first task's `at`
 * (ms since the epoch, by `now`) and answers it. The world says what that
 * does, and lands it only if it is still due. Pass to `control` as it is.
 */
export const clock = ({ now = Date.now } = {}) => ({
  pick: (view) => view.tasks.slice(0, 1),
  program: ([task], view, signal) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ body: {} }), task.at - now());
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(null);
    });
  }),
});
