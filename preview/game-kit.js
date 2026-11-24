// What the three games' tables (site/spy.html, site/werewolf.html,
// site/poker.html) share on the runtime's core (src/core/). In their
// worlds: the lines said at a table, the clock's tasks, a seat's thoughts.
// In the table's room on the relay (relay/table.js): the AI players'
// program. On their pages: what the visitor keeps in the browser, a fresh
// line typed out, and the page's seat at the table, in its room.
//
// A line is { id (its place in the list, from 1), by, text, to (the
// players it names), depth, from (the people who set it off) } and the
// world's own marks. A person's line sets off depth 0, from them; an AI
// player's is one deeper than the tasks its run answered, for whoever set
// those off. A line this deep (DEPTH) asks no one.

/* global location */

export const DEPTH = 2; // nobody replies to a reply forever
export const MAX_LINE = 240; // characters of a line of chat
const THOUGHTS_SHOWN = 8; // a player's own latest thinking its view has
export const LANGS = ['en', 'zh']; // a table's languages: what its AI players speak, the host's page's (lang.js)

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

// What a table's `lang` adds to its AI players' rules.
export const speak = (lang) => (lang === 'zh' ? '\n\nThis table plays in Chinese: write everything, your thinking included, in Simplified Chinese (简体中文). Players\' names stay as they are.' : '');

// ---- on a page ----

// What the visitor keeps in this browser (or this tab, `sessionStorage`), or null.
export function load(key, storage = localStorage) {
  try {
    return JSON.parse(storage.getItem(key)) ?? null;
  } catch {
    return null;
  }
}
export function keep(value, key, storage = localStorage) {
  try {
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
  } catch {}
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * AI player `id`'s program, for its controller, in the table's room: a run
 * is one call of the model, `infer(messages, tools)`, on what its seat
 * sees, `prompt(view, id)` → { rules, situation }, answered with `tool`;
 * then the player's own time to think, `pace(tasks, view)` ms from the
 * call's start; then, for what it says, `typing(body)` ms told as
 * presence. `decide(args, view)` makes the answer a change's body (null:
 * nothing), which lands at once, on the moment it saw. Its seat is at
 * work, or its run failed, as presence.
 */
export const agent = ({ client, id, infer, tool, prompt, decide, pace, typing = () => 0 }) => async (tasks, view, signal) => {
  const started = performance.now();
  const { rules, situation } = prompt(view, id);
  client.presence({ working: true });
  try {
    const { calls, text } = await infer([{ role: 'user', content: rules, cache: true }, { role: 'user', content: situation }], [tool]);
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
    client.presence(null);
    return body && { base: view.content.moment, body };
  } catch (error) {
    const why = String(error.message).split('\n')[0];
    client.presence({ failed: why });
    throw new Error(why);
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

// ---- a page's seat at the table, in its room on the relay ----

// The rooms are at infer.ponjo.app (relay/table.js). A page served from
// this machine may name another with ?relay= (a relay run locally by
// wrangler); a page on ponjo.app never does, so no link can send a
// visitor's key elsewhere.
const relay = () => (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('relay')) || 'wss://infer.ponjo.app';
const PING_MS = 5000;
const RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;
const TURNED_AWAY = [4001, 4003, 4004]; // the room's: turned away, not the host, no table here

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * This page's seat at a table of `game` in its room (docs/app/worlds/rooms.md).
 * The page that opened the table keeps its secret in this browser
 * (`ponjo-<game>-room`), plays as `host` and gives the room `key()`, the
 * visitor's own key for the AI players (or null for Ponjo's), each time it
 * comes in and whenever the room asks for it again, and its `lang`, the
 * table's language, each time it comes in; a friend's page,
 * opened at `#join=<room>`, keeps the token the room gave it for this tab,
 * so a reload is back in its seat. `hello(me)` once the room says who the
 * page plays as; `heard(message)` for each of the room's messages; `away(why)`
 * when the line is down: 'line' while it is tried again (a relay not yet
 * deployed, a dropped line), or the room's reason for turning the page away.
 * Returns { joined (the room a friend's page joins, or null), link() → the
 * link friends join by, act(base, body), send(message), giveKey() once
 * the visitor changed their key, close() the host's: the room closes the
 * table, and the page opens a new one, with a new secret and a new link }.
 */
export function sit(game, host, { key, lang, hello, heard, away }) {
  const joined = new URLSearchParams(location.hash.slice(1)).get('join');
  const kept = joined ? `ponjo-seat:${joined}` : `ponjo-${game}-room`;
  let mine = joined ? load(kept, sessionStorage) : load(kept) ?? { secret: hex(crypto.getRandomValues(new Uint8Array(32))) };
  if (!joined) keep(mine, kept);
  const room = joined ? Promise.resolve(joined) : crypto.subtle.digest('SHA-256', new TextEncoder().encode(mine.secret)).then(hex);
  let line = null;
  let closing = false;
  const send = (message) => line?.send(JSON.stringify(message));
  const giveKey = () => send({ type: 'key', key: key() });
  room.then((r) => {
    line = connect(`${relay()}/tables/${r}`, {
      open: (ws) => ws.send(JSON.stringify({ game, ...(joined ? { token: mine?.token } : { secret: mine.secret, lang }) })),
      heard(text) {
        const message = JSON.parse(text);
        if (message.type === 'hello') {
          if (message.token) {
            mine = { token: message.token };
            keep(mine, kept, sessionStorage);
          }
          if (!joined) giveKey();
          return hello(message.me);
        }
        if (message.type === 'key?') return giveKey();
        heard(message);
      },
      ended(code, reason) {
        if (closing) {
          location.reload();
          return true;
        }
        const final = TURNED_AWAY.includes(code);
        away(final ? reason : 'line');
        return final;
      },
    });
  });
  if (!joined) hello(host);
  return {
    joined,
    async link() {
      const url = new URL(location.href);
      url.hash = `join=${await room}`;
      return url.href;
    },
    act: (base, body) => send({ type: 'act', base, body }),
    send,
    giveKey,
    // The old table goes once the room has closed it; a room not reached is deleted when idle.
    close() {
      keep({ secret: hex(crypto.getRandomValues(new Uint8Array(32))) }, kept);
      closing = true;
      if (!send({ type: 'close' })) location.reload();
    },
  };
}

// A line that is made again when it drops, after 2 seconds and twice as
// long each time up to 30: `open` says who it is; `heard(text)` gets every
// message but `pong` (the relay answers `ping` with it, so a page can tell
// its line is up); `ended(code, reason)`, when the line drops: true to stop trying.
function connect(url, { open, heard, ended }) {
  let retry = RETRY_MS;
  let ws = null;
  function again() {
    ws = new WebSocket(url);
    let pinged = 0;
    let answered = 0;
    ws.addEventListener('open', () => open(ws));
    const beat = setInterval(() => {
      if (pinged > answered) ws.close(); // half-open
      else if (ws.readyState === WebSocket.OPEN) {
        pinged = Date.now();
        ws.send('ping');
      }
    }, PING_MS);
    ws.addEventListener('message', ({ data }) => {
      answered = Date.now();
      retry = RETRY_MS;
      if (data !== 'pong') heard(data);
    });
    ws.addEventListener('close', ({ code, reason }) => {
      clearInterval(beat);
      if (ended(code, reason)) return;
      setTimeout(again, retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    });
  }
  again();
  return { send: (text) => ws.readyState === WebSocket.OPEN && (ws.send(text), true) };
}
