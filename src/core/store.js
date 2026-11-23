// A store in memory (docs/runtime/README.md, Store): it alone holds the
// state, and lands one change at a time through the world's `apply`. Each
// member reaches it through its own client, which sets `by`, and reads only
// its view. The host keeps `{ rev, state }` by `save` after each change, and
// gives it back by `load`, so a refresh or a restart goes on where it was.
// Plain JavaScript: the same in a page, in Node and in a Worker.

/**
 * A store of `world` ({ view(state, member), apply(state, change) }).
 * `load()` gives { rev, state }; `save({ rev, state })` keeps them; `now()`
 * stamps each change's `at`; `heard()` is called when a presence changes.
 * Returns { client(member) }: { read, wait, commit, presence, present }, all as `member`.
 */
export function createStore(world, { load, save, now = Date.now, heard = () => {} }) {
  let { rev, state } = load();
  const prints = new Map(); // member → { rev, print }: its view as it last read it
  const waiting = new Set(); // { member, print, done }
  const presence = new Map(); // member → what it is doing now; kept nowhere
  const print = (member) => JSON.stringify(world.view(state, member));
  const wake = (w) => {
    if (print(w.member) === w.print) return;
    waiting.delete(w);
    w.done(rev);
  };

  return {
    client: (member) => ({
      /** { rev, view }: the state now, as `member` may see it. */
      read() {
        const view = world.view(state, member);
        prints.set(member, { rev, print: JSON.stringify(view) });
        return { rev, view };
      },
      /** Resolves once `member`'s view is no longer what it read at `since`; with nothing: read again. */
      wait(since) {
        const last = prints.get(member);
        return new Promise((done) => {
          const w = { member, print: last?.rev === since ? last.print : null, done };
          waiting.add(w);
          wake(w);
        });
      },
      /**
       * Lands `change` ({ as, base, answers, body } or { as, answers, failed })
       * by `member`, at now: { rev, effects, refused? } once it lands (a
       * refusal the world kept a record of lands too), or { refused } and nothing.
       */
      commit(change) {
        const out = world.apply(state, { ...change, by: member, at: now() });
        if (!out.state) return out;
        state = out.state;
        rev++;
        save({ rev, state });
        for (const w of waiting) wake(w);
        return { rev, effects: out.effects, ...(out.refused ? { refused: out.refused } : {}) };
      },
      /** What `member` is doing now (null: nothing), for whom its view's `seen` lets see it. */
      presence(what) {
        if (what === null) presence.delete(member);
        else presence.set(member, what);
        heard();
      },
      /** { member: what } of those `member` may see. */
      present() {
        const { seen } = world.view(state, member);
        return Object.fromEntries([...presence].filter(([m]) => seen.includes(m)));
      },
    }),
  };
}
