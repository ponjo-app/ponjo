// The rules (docs/runtime/README.md, How the plan decides): what a world's
// agents should be doing now, from its asks and what this machine noted,
// with no clock or file of its own: a look at any time finds the same.

/** Who made a change that is no member's, the world's own (in a doc: another program's), in `changedAt`. */
export const WORLD = Symbol('world');

/**
 * What to start and stop now. `agents` those here ({ id, name }); `asks`
 * the world's ({ id, agent, at, from, for, depth, until }); `askers` the
 * members the world says may ask (mayAsk): an ask is for those of its
 * people (`for`, an agent's ask; else `from`) who still may; `notes` agent →
 * { seen (ask id → its `until` when a run was last given it), lookedAt
 * (the version its last run started at, or null: look at once), print (its view's fingerprint then, or
 * null: not known), wake (what its last run said wakes it, or null: any
 * change), watch ({ by }, who turned it on, or null) }; `prints` agent →
 * its view's fingerprint now; `woken` the ids of the agents whose view
 * holds what wakes them; `changedAt` who
 * last changed the world → { rev, at (when, on the clock of `now`), depth
 * (an agent's: its run's) }, people as one (null), the world itself as
 * WORLD; `running` the ids of the agents running; `limit` the world's
 * depth limit; `settleMs` how long people's changes pause before they
 * count; `paused` whether its watches are paused (the breaker).
 *
 * Returns { start ([{ agent, asks, askers, watch (whether it watches),
 * watchOnly, depth }]), stop (ids), wakeAt (when to look again, or null),
 * asking (a Set of `${agent} ${ask}`, each ask, looked at or not), why
 * (agent id → why it starts or not, in words: the agent log's) }.
 *
 * An ask is due until a run was given it, while one of its people may ask:
 * the world says who, and the runtime starts work only for them.
 * A watcher, while whoever turned it on may ask and the watches are not
 * paused, is due once turned on, and on another member's change since its
 * last run started: people's once they pause `settleMs`, the world's own
 * at once, an agent's once its run ended (so the watcher sees all it did). Its own never counts, nor a
 * change its view no longer shows: one whose view is as it was when its
 * last run started is not due. One whose last run named what wakes it is
 * due only while its view holds that.
 *
 * A run's depth: 0 when a person or the world asked or woke it; when only
 * an agent's ask or change did, one more than that. Past `limit`, nothing
 * starts: agents waking each other come to rest.
 */
export function plan({ agents, asks, askers, notes, changedAt, running, prints, woken, limit, settleMs, paused, now }) {
  const noteOf = (id) => notes.get(id) ?? { seen: new Map(), lookedAt: null, print: null, wake: null, watch: null };
  const tasks = new Map(); // agent id → { asks, askers, asked, relayed, depth, watch }
  const taskOf = (id) => tasks.get(id) ?? tasks.set(id, { asks: [], askers: new Set(), asked: false, relayed: false, depth: Infinity, watch: null }).get(id);
  const asking = new Set();
  const why = new Map();
  const nameOf = (by) => (by === null ? 'people' : by === WORLD ? 'the world' : agents.find((b) => b.id === by)?.name ?? by);
  let wakeAt = null;
  const soonest = (at) => { wakeAt = wakeAt === null ? at : Math.min(wakeAt, at); };
  for (const ask of asks) {
    const via = (ask.for ?? [ask.from]).filter((p) => askers.includes(p));
    if (!via.length) continue; // none of its people may ask
    asking.add(`${ask.agent} ${ask.id}`);
    if (Date.parse(ask.at) <= (noteOf(ask.agent).seen.get(ask.id) ?? -Infinity)) continue;
    const task = taskOf(ask.agent);
    task.asks.push(ask);
    for (const p of via) task.askers.add(p);
    if (ask.for) task.relayed = true;
    else task.asked = true;
    task.depth = Math.min(task.depth, ask.for ? (ask.depth ?? 0) + 1 : 0);
  }
  for (const [id, note] of notes) {
    if (!note.watch || !agents.some((b) => b.id === id)) continue;
    if (!askers.includes(note.watch.by)) {
      why.set(id, 'not due: whoever turned on its watch may not ask');
      continue;
    }
    const task = taskOf(id);
    task.askers.add(note.watch.by);
    let byPeople = note.lookedAt === null;
    let byAgent = false;
    let depth = Infinity; // of the agents' changes that wake it
    const changed = [];
    for (const [by, { rev, at, depth: of = 0 }] of changedAt) {
      if (note.lookedAt !== null && rev <= note.lookedAt) continue;
      if (by === id) {
        changed.push(`itself at rev ${rev}, which does not count`);
        continue;
      }
      const agent = by !== null && by !== WORLD;
      // An agent's counts once its run has landed, all it did.
      if (by === WORLD) byPeople = true;
      else if (agent && !running.has(by)) {
        byAgent = true;
        depth = Math.min(depth, of + 1);
      }
      else if (by === null && now - at >= settleMs) byPeople = true;
      else if (by === null) soonest(at + settleMs); // people still typing: look once they pause
      changed.push(`${nameOf(by)} at rev ${rev}${by === null && now - at < settleMs ? ', still typing' : ''}${agent && running.has(by) ? ', still landing' : ''}`);
    }
    let since = note.lookedAt === null ? 'its first look' : changed.length ? `changed by ${changed.join(', ')}, after its look at rev ${note.lookedAt}` : `no change since its look at rev ${note.lookedAt}`;
    // Its last run said what wakes it: not before its view holds that.
    if (note.lookedAt !== null && note.wake && !woken.has(id)) {
      if (byPeople || byAgent) since += ', but its view holds nothing that wakes it';
      byPeople = false;
      byAgent = false;
    }
    // Its view is as it was when its last run started: nothing to see.
    if (note.lookedAt !== null && note.print != null && prints.get(id) === note.print && (byPeople || byAgent)) {
      since += ', but its view is as it was';
      byPeople = false;
      byAgent = false;
    }
    if (paused && (byPeople || byAgent)) {
      since += ', but watches are paused';
      byPeople = false;
      byAgent = false;
    }
    task.watch = { due: byPeople || byAgent, depth: byPeople ? 0 : depth, since };
  }
  const start = [];
  for (const [id, task] of tasks) {
    const agent = agents.find((b) => b.id === id); // the agent an ask names may be gone
    if (!agent) continue;
    const asked = task.asked || task.relayed;
    const reason = asked ? `asked in ${task.asks.map((a) => a.id).join(', ')}${task.asked ? '' : ' by an agent'}` : task.watch.since;
    if (running.has(id)) {
      why.set(id, `not due: already running (${reason})`);
      continue;
    }
    if (!(asked || task.watch.due)) {
      why.set(id, `not due: ${reason}`);
      continue;
    }
    const depth = Math.min(task.depth, task.watch?.due ? task.watch.depth : Infinity);
    if (depth > limit) {
      why.set(id, `not due: ${reason}, but at the depth limit (${limit})`);
      continue;
    }
    why.set(id, `due: ${reason}${depth ? ` · depth ${depth}` : ''}`);
    start.push({ agent, asks: task.asks, askers: [...task.askers], watch: task.watch !== null, watchOnly: !asked && task.watch !== null, depth });
  }
  const wanted = new Set([...tasks.keys()].filter((id) => agents.some((b) => b.id === id)));
  const stop = [...running].filter((id) => !wanted.has(id));
  for (const id of stop) why.set(id, 'stopped: nothing asks it now');
  for (const b of agents) if (!why.has(b.id)) why.set(b.id, 'not due: no ask, not watching');
  return { start, stop, wakeAt, asking, why };
}
