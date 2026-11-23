// What the three games' tables (site/spy.html, site/werewolf.html,
// site/poker.html) share on the runtime's core (src/core/). In their
// worlds: the lines said at a table, the clock's tasks, a seat's thoughts.
// On their pages: the store kept in the browser, the AI players' program,
// a fresh line typed out, and friends who join by a link.
//
// A line is { id (its place in the list, from 1), by, text, to (the
// players it names), depth, from (the people who set it off) } and the
// world's own marks. A person's line sets off depth 0, from them; an AI
// player's is one deeper than the tasks its run answered, for whoever set
// those off. A line this deep (DEPTH) asks no one.

import { control, limits } from '../src/core/controller.js';
import { ledger } from '../src/core/ledger.js';
import { createStore } from '../src/core/store.js';
import { RECONNECT_MS, host } from './poker-share.js';

export const DEPTH = 2; // nobody replies to a reply forever
export const MAX_LINE = 240; // characters of a line of chat
const THOUGHTS_SHOWN = 8; // a player's own latest thinking its view has

// ---- in a world ----

// The players of `ids` that `text` names, by the name each goes by (`nameOf`; a person with no name by none).
export const named = (ids, nameOf, text) => ids.filter((id) => nameOf(id) && new RegExp(`\\b${nameOf(id).replace(/\W/g, '\\$&')}\\b`, 'i').test(text));

/**
 * The line `by` says, `text` naming `to`, next in `lines`: a person's
 * (`person`), or an AI player's answering the tasks `asked`; with `marks`.
 */
export function line(lines, { by, text, to, person, asked = [], ...marks }) {
  return {
    id: lines.length + 1, by, text, to: to.filter((id) => id !== by),
    depth: person ? 0 : 1 + Math.max(0, ...asked.map((t) => t.depth)), from: person ? [by] : [...new Set(asked.flatMap((t) => t.from))],
    ...marks,
  };
}

// The first of `players` after `by` in seat order (from the first seat, if `by` has none) that `ok` takes.
export const after = (players, by, ok) => [...players.keys()].map((k) => players[(players.indexOf(by) + 1 + k) % players.length]).find((p) => p !== by && ok(p));

// One of the clock's tasks: due at `at`, as `as` (the clock, or the seat it speaks for).
export const deadline = (given, as, at, why) => ({ given, as, kind: 'turn', from: [], depth: 0, at, why });

// `thoughts` with `by`'s `thought` added; and the latest a seat's view has.
export const think = (thoughts, by, thought) => ({ ...thoughts, [by]: [...(thoughts[by] ?? []), thought] });
export const latest = (thoughts, id) => (thoughts[id] ?? []).slice(-THOUGHTS_SHOWN);

// ---- on a page ----

// What the visitor keeps in this browser, or null.
export function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? null;
  } catch {
    return null;
  }
}
export function keep(value, key) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
}

/**
 * The table of `world` in this page: a store with the answer ledger, kept
 * in the browser at `key` on each change, so a refresh goes on with it; a
 * new one is `first()`. `heard()` when a presence changes. Returns
 * { client(id), wallet, commit(id, change) }: `wallet` the page's limits on
 * its AI players' runs; `commit`, a person's change, which lands or says why not.
 */
export function openTable(world, key, first, heard) {
  const kept = ledger(world);
  const store = createStore(kept, { load: () => load(key) ?? { rev: 0, state: kept.wrap(first()) }, save: (k) => keep(k, key), heard });
  const clients = new Map();
  const client = (id) => clients.get(id) ?? clients.set(id, store.client(id)).get(id);
  const wallet = limits();
  return {
    client, wallet,
    commit(id, change) {
      const out = client(id).commit(change);
      if (!out.refused) wallet.acted();
      return out;
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
let runs = 0;

/**
 * AI player `id`'s program, for its controller: a run is one call of the
 * model (`infer()`) on what its seat sees, `prompt(view, id)` → { rules,
 * situation }, answered with `tool`; then the player's own time to think,
 * `pace(tasks, view)` ms from the call's start; then, for what it says,
 * `typing(body)` ms told as presence. `decide(args, view)` makes the
 * answer a change's body (null: nothing), which lands at once, on the
 * moment it saw. Its seat is at work, or its run failed, as presence.
 * `panel` (web/runtime-panel.js), if any, gets each run.
 */
export const agent = ({ client, id, infer, tool, prompt, decide, pace, typing = () => 0, panel }) => async (tasks, view, signal) => {
  const started = performance.now();
  const run = `r${++runs}`;
  const { rules, situation } = prompt(view, id);
  let result;
  client.presence({ working: true });
  try {
    const { calls, text, usage } = await infer()([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [tool]);
    let args = {};
    try {
      args = JSON.parse(calls.find((c) => c.name === tool.name)?.args ?? '{}');
    } catch {}
    await wait(pace(tasks, view) - (performance.now() - started));
    const body = decide({ thinking: text, ...args }, view);
    const ms = body && !signal.aborted ? typing(body) : 0;
    if (ms) {
      client.presence({ typing: true });
      await wait(ms);
    }
    result = { outcome: signal.aborted ? 'stopped' : 'ok', usage, made: body };
    client.presence(null);
    return body && { base: view.content.moment, body };
  } catch (error) {
    const why = String(error.message).split('\n')[0];
    result = { outcome: 'failed', body: why };
    client.presence({ failed: why });
    throw new Error(why);
  } finally {
    panel?.add({ type: 'run.end', run, task: { agent: { id, name: id }, asks: tasks.map((t) => ({ id: t.given, from: t.from.join(', ') })), depth: tasks[0].depth }, view: { prompt: { rules, situation } }, result: { ms: performance.now() - started, ...result } });
  }
};

/**
 * A line that lands at once, typed out on screen first, one after another,
 * unless it was there when the page opened (`open()`). Each drawing calls
 * `clear()`, then `shows(key, id, text)` for each line: whether it shows
 * yet; if not, `id` is in `typing`. `draw` is called as each one shows.
 */
export function typer(draw, typeTime) {
  const shown = new Map(); // a line's key → when it shows
  const typing = new Set();
  let last = 0;
  let opened = false;
  return {
    typing,
    clear: () => typing.clear(),
    open() {
      opened = true;
    },
    shows(key, id, text) {
      if (!shown.has(key)) {
        const at = opened ? Math.max(Date.now() + typeTime(text), last + 400) : 0;
        if (at) {
          last = at;
          setTimeout(draw, at - Date.now() + 20);
        }
        shown.set(key, at);
      }
      if (shown.get(key) <= Date.now()) return true;
      typing.add(id);
      return false;
    },
  };
}

/**
 * Friends at the page's table (`table`, openTable) by a link, through the
 * relay (poker-share.js): each friend's page gets its seat's view, and the
 * presence it may see, each time its view changes (and on `shown()`, when
 * a presence did); what it sends is `heard(id, message)`. `joined(id)`
 * when a page of friend `id` opens, a reload too: a reason turns it away.
 * A friend whose page went, and is not back within RECONNECT_MS (`gone`),
 * leaves the table. Returns { link() → the room's link, made on the first
 * call; shown(); send(id, message); turnAway(id, why); gone(id) }.
 */
export function friends(table, { heard, joined = () => {} }) {
  const peers = new Map(); // a friend's page in the room → its player, and the controller sending it its view
  let room = null;
  const peerOf = (id) => [...peers].find(([, p]) => p.id === id)?.[0];
  const send = (peer, id) => room.send(peer, { type: 'state', view: table.client(id).read().view, presence: table.client(id).present() });
  function gone(id) {
    setTimeout(() => {
      if (![...peers.values()].some((p) => p.id === id)) table.client(id).commit({ body: { type: 'leave' } });
    }, RECONNECT_MS);
  }
  return {
    async link() {
      room ??= await host({
        joined(peer, hello) {
          const id = String(hello?.id);
          const why = /^f[0-9a-f]{8}$/.test(id) ? joined(id) : 'Not a player';
          if (why) return room.turnAway(peer, why);
          peers.set(peer, { id, ...control(table.client(id), { show: () => send(peer, id) }) });
        },
        heard: (peer, message) => peers.has(peer) && heard(peers.get(peer).id, message),
        left(peer) {
          const p = peers.get(peer);
          if (!p) return; // turned away
          peers.delete(peer);
          p.stop();
          gone(p.id);
        },
      });
      return room.link;
    },
    shown() {
      for (const [peer, { id }] of peers) send(peer, id);
    },
    send(id, message) {
      const peer = peerOf(id);
      if (peer !== undefined) room.send(peer, message);
    },
    turnAway(id, why) {
      const peer = peerOf(id);
      if (peer === undefined) return;
      peers.get(peer).stop();
      peers.delete(peer);
      room.turnAway(peer, why);
    },
    gone,
  };
}
