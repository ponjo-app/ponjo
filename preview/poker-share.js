// A game's table shared with friends through the relay (relay/worker.js,
// at share.ponjo.app), the poker page's and the spy page's: the host's page
// holds the table and runs the rules and the AI players; each friend's page
// joins its room by a link, sends what its player does and draws what the
// host sends it. The room is the SHA-256 of a secret only the host's page
// knows; the link names the room.
// A line that drops is made again, after 2 seconds and twice as long each
// time up to 30; the relay answers `ping` with `pong`, so a page can tell.

/* global location */

const RELAY = 'wss://share.ponjo.app';
const PING_MS = 5000;
const RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;
const HOST_AWAY = 4000; // the relay: no host in the room
const TURNED_AWAY = 4001; // the host, with its reason

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// A line that is made again when it drops: `open` makes the socket and says
// who it is; `heard(ws, text)` gets every message but `pong`; `ended(code,
// reason)`, when the line drops: true to stop trying.
function line(url, { open, heard, ended }) {
  let retry = RETRY_MS;
  let stopped = false;
  let ws = null;
  function connect() {
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
      if (data !== 'pong') heard(ws, data);
    });
    ws.addEventListener('close', ({ code, reason }) => {
      clearInterval(beat);
      if (stopped || ended(code, reason)) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    });
  }
  connect();
  return {
    send: (text) => ws.readyState === WebSocket.OPEN && ws.send(text),
    stop() {
      stopped = true;
      ws.close();
    },
  };
}

// How long a friend whose page went has to come back (a reload) before the host takes them as gone.
export const RECONNECT_MS = 15_000;

/**
 * Who a friend's page plays as in `room`: kept for this tab, so a friend
 * who reloads the page is back as the same player, in their seat; another
 * tab is another friend. Where the tab keeps nothing, a new one each time.
 */
export function guestId(room) {
  const key = `ponjo-guest:${room}`;
  const made = `f${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
  try {
    return sessionStorage.getItem(key) ?? (sessionStorage.setItem(key, made), made);
  } catch {
    return made;
  }
}

/**
 * Hosts a room. `joined(peer, hello)` when a friend's page opens with its
 * first message; `heard(peer, message)` for each message after it, parsed;
 * `left(peer)` when it goes. Returns { link, send(peer, message), turnAway(peer, reason) }.
 */
export async function host({ joined, heard, left }) {
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const room = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  const relay = line(`${RELAY}/rooms/${room}?host`, {
    open: (ws) => ws.send(JSON.stringify({ secret })),
    heard(ws, text) {
      const frame = JSON.parse(text);
      if (frame.open) joined(frame.peer, frame.open);
      else if (frame.close) left(frame.peer);
      else if ('data' in frame) {
        try {
          heard(frame.peer, JSON.parse(frame.data));
        } catch {} // not ours
      }
    },
    ended: () => false,
  });
  const link = new URL(location.href);
  link.hash = `join=${room}`;
  return {
    link: link.href,
    send: (peer, message) => relay.send(JSON.stringify({ peer, data: JSON.stringify(message) })),
    turnAway: (peer, reason) => relay.send(JSON.stringify({ peer, close: reason })),
  };
}

/**
 * Joins `room` as `hello` says who it is. `heard(message)` for each of the
 * host's; `away(reason)` when the line is down: 'host' (no host in the room,
 * tried again), or the host's reason for turning the page away (not).
 * Returns { send(message) }.
 */
export function join(room, hello, { heard, away }) {
  const relay = line(`${RELAY}/rooms/${room}`, {
    open: (ws) => ws.send(JSON.stringify(hello)),
    heard: (ws, text) => heard(JSON.parse(text)),
    ended(code, reason) {
      away(code === TURNED_AWAY ? reason : code === HOST_AWAY ? 'host' : 'line');
      return code === TURNED_AWAY;
    },
  });
  return { send: (message) => relay.send(JSON.stringify(message)) };
}
