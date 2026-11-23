// A game table's room (docs/app/worlds/rooms.md): one Durable Object per
// table of poker, werewolf or Who's the Spy, which is the table's store.
// It keeps `{ rev, state }` in its storage and lands each change through
// the game's world (preview/game-tables.js, the worlds the pages draw
// with), so a reload, a closed page or the opener leaving loses nothing.
// It sends each page only its own seat's view; the AI players, the dealer
// and the clock run here, beside the store, so no page is handed another
// seat's view, the deck or a key.
//
// A page connects with a WebSocket to /tables/<room>, the room the hex
// SHA-256 of a secret the opener's page keeps. Its first message says who it is:
//   { game, secret }   the opener, the game's host; the first one opens the table
//   { game, token? }   anyone with the link: the member its token was given
//                      to, or a new one, given a token
// and the room answers { type: 'hello', me, token? }, then { type: 'state',
// view, presence, ai } each time what that page may see changes (`ai`
// says whether the AI players wait for the host's key, or `until` when
// this table may call the model again). After it:
//   { type: 'act', base, body }   a change by this page's member: `by` is
//                                 the member its token is, never what it says;
//                                 refused, answered { type: 'rejected', why, body }
//   { type: 'key', key }          the host: the AI players run on this key,
//                                 { provider, key, model, endpoint? }, or on Ponjo's (null)
//   { type: 'away', id }          the host asks member `id` to leave
// A page is closed with 4003 when its secret is wrong, 4004 when there is
// no table at a link, and 4001 with the reason when it is turned away.
// `ping` is answered `pong` without waking the room.
//
// Keys. Ponjo's (the ANTHROPIC_API_KEY secret) never leaves the Worker. A
// visitor's is held in memory only, for the AI players of the table they
// opened, and sent to no page: a failed call is told by its status alone.
// An OpenAI-compatible one is called only at a known provider's host
// (OPENAI_HOSTS): the relay is no proxy to anywhere else.
// Nothing keeps it at rest; that needs a master secret the owner sets.
// When the room is evicted it forgets the key: the AI players wait until
// the host's page gives it again (the room asks it when it wakes), and
// their turns take the rules' fallback at their deadlines meanwhile.
//
// Spending. A table calls the model at most RUNS_AN_HOUR times a clock
// hour on Ponjo's key, and OWN_RUNS_AN_HOUR on a visitor's (wrangler.toml);
// past that, the AI players' turns take the fallback until the next hour.
// Each call on Ponjo's key also counts against the INFER rate of the
// address that opened the table, 60 a minute, as /infer's calls do.
//
// Time. The room's alarm is the clock: it wakes the room at the next
// deadline of the clock's or the dealer's tasks, when a person whose page
// went has been gone RECONNECT_MS (then they `leave`), every AWAKE_MS while
// an AI player has a task (so a room evicted mid-run starts it again), and
// once no page has been in it for IDLE_MS, when the table is deleted.

/* global WebSocketPair, WebSocketRequestResponsePair */

import { INFER } from '../agents/ponjo-core.mjs';
import { control, limits } from '../src/core/controller.js';
import { ledger } from '../src/core/ledger.js';
import { createStore } from '../src/core/store.js';
import { agent } from '../preview/game-kit.js';
import { GAMES, RECONNECT_MS } from '../preview/game-tables.js';

const HOUR = 3_600_000;
const IDLE_MS = 24 * HOUR;
const AWAKE_MS = 30_000;
const MAX_PAGES = 20; // open at once
const MAX_MEMBERS = 50; // tokens a table gives
const MAX_MESSAGE = 16_000; // characters of a page's message
const MAX_TOKENS = 4000; // of an answer on Ponjo's key: one turn's tool call
// The hosts a visitor's OpenAI-compatible base URL may name: providers that
// speak Chat Completions with tool calls. The relay calls no other, so it is
// no proxy to anywhere a key's owner names.
const OPENAI_HOSTS = ['api.openai.com', 'openrouter.ai', 'api.groq.com', 'api.together.xyz', 'api.deepseek.com', 'api.mistral.ai', 'api.fireworks.ai', 'generativelanguage.googleapis.com', 'api.tokenfactory.nebius.com'];
const KEPT = ['game', 'table', 'members', 'own', 'spent', 'gone', 'touched', 'opener'];

export class Table {
  #sent = new WeakMap(); // a page → the last state sent to it
  #pushing = false;
  #alarm = null; // when the alarm is set for
  #stuck = -1; // the rev at which a system member's due change was refused: none is tried again until another lands

  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.key = null; // the host's own key, in memory only
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const kept = await ctx.storage.get(KEPT);
      this.#alarm = await ctx.storage.getAlarm();
      if (kept.get('game')) this.#open(Object.fromEntries(kept));
    });
  }

  async fetch(request) {
    const [client, socket] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(socket);
    if (this.#pages().length > MAX_PAGES) close(socket, 4001, 'The table is full.');
    else socket.serializeAttachment({ room: new URL(request.url).pathname.split('/').pop(), ip: request.headers.get('CF-Connecting-IP') ?? '' });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return close(socket, 1009, 'Message too big');
    let message;
    try {
      message = JSON.parse(data);
    } catch {} // checked below
    const what = socket.deserializeAttachment();
    if (message === null || typeof message !== 'object' || !what) return close(socket, 1008, 'Not a message');
    if (!what.id) return this.#hello(socket, what, message);
    if (message.type === 'act') return this.#act(socket, what.id, message);
    if (what.id !== this.game.host) return;
    if (message.type === 'key') return this.#useKey(socket, message.key);
    if (message.type === 'away') return this.#sendAway(String(message.id));
  }

  webSocketClose(socket) {
    const id = socket.deserializeAttachment()?.id;
    socket.serializeAttachment(null);
    if (!id) return;
    this.#touch();
    if (id !== this.game.host && !this.#online(id)) {
      this.gone[id] = Date.now() + RECONNECT_MS;
      this.ctx.storage.put('gone', this.gone);
    }
    this.#schedule();
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }

  async alarm() {
    this.#alarm = null;
    if (!this.game) return;
    const now = Date.now();
    if (!this.#seated().length && now >= this.touched + IDLE_MS) return this.#delete();
    for (const [id, at] of Object.entries(this.gone)) {
      if (at > now) continue;
      delete this.gone[id];
      if (!this.#online(id)) this.store.client(id).commit({ body: { type: 'leave' } });
    }
    this.ctx.storage.put('gone', this.gone);
    this.#settle();
  }

  // ---- the table ----

  // The table in `kept` (as storage holds it): its store, its AI players, the clock.
  #open(kept) {
    this.game = GAMES[kept.game];
    this.world = ledger(this.game.world);
    ({ rev: this.rev, state: this.state } = kept.table);
    this.members = kept.members; // a token's hash → its member
    this.own = kept.own; // whether the AI players run on the host's own key
    this.spent = kept.spent; // { hour, ponjo, own }: model calls this clock hour
    this.gone = kept.gone; // a member whose page went → when they leave
    this.touched = kept.touched; // when a page last came or went
    this.opener = kept.opener; // the hash of the opener's address, the key of its INFER rate
    this.store = createStore(this.world, {
      load: () => kept.table,
      save: (table) => {
        ({ rev: this.rev, state: this.state } = table);
        this.ctx.storage.put('table', table);
        this.#push();
      },
      heard: () => this.#push(),
    });
    const owner = limits();
    this.wallet = {
      allow: (tasks) => (this.#spend(0) ? owner.allow(tasks) : []),
      charge: (tasks) => {
        owner.charge(tasks);
        this.#spend(1);
      },
      acted: owner.acted,
    };
    // Pages gone while the room was away: they leave unless they come back.
    for (const id of new Set(Object.values(this.members))) if (!this.#online(id)) this.gone[id] ??= Date.now() + RECONNECT_MS;
    if (this.own) for (const page of this.#pagesOf(this.game.host)) page.send(JSON.stringify({ type: 'key?' }));
    this.#seat();
    this.#push();
  }

  #create(game, ip) {
    const first = { rev: 0, state: ledger(GAMES[game].world).wrap(GAMES[game].first()) };
    const kept = { game, table: first, members: {}, own: false, spent: { hour: 0, ponjo: 0, own: 0 }, gone: {}, touched: Date.now(), opener: ip };
    this.ctx.storage.put(kept);
    this.#open(kept);
  }

  async #delete() {
    for (const c of this.ais ?? []) c.stop();
    this.ais = null;
    this.game = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  // ---- members ----

  async #hello(socket, { room, ip }, { game, secret, token }) {
    if (!GAMES[game]) return close(socket, 1008, 'No such game');
    let id;
    let given;
    if (typeof secret === 'string') {
      if (await sha256(secret) !== room) return close(socket, 4003, 'Forbidden');
      const address = await sha256(ip);
      if (!this.game) this.#create(game, address);
      else if (this.game !== GAMES[game]) return close(socket, 4003, 'Forbidden');
      else if (this.opener !== address) this.ctx.storage.put('opener', this.opener = address);
      id = this.game.host;
    } else {
      if (this.game !== GAMES[game]) return close(socket, 4004, 'This table is gone. Ask for a new link.');
      id = typeof token === 'string' ? this.members[await sha256(token)] : undefined;
      if (!id) {
        if (Object.keys(this.members).length >= MAX_MEMBERS) return close(socket, 4001, 'The table is full.');
        given = hex(crypto.getRandomValues(new Uint8Array(32)));
        id = `f${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
        this.members[await sha256(given)] = id;
        this.ctx.storage.put('members', this.members);
      }
    }
    socket.serializeAttachment({ id });
    if (this.gone[id]) {
      delete this.gone[id];
      this.ctx.storage.put('gone', this.gone);
    }
    this.#touch();
    socket.send(JSON.stringify({ type: 'hello', me: id, ...(given ? { token: given } : {}) }));
    this.#send(socket);
    this.#schedule();
  }

  // What a page's member does: landed as theirs, or refused, and they are told why, with what they sent.
  #act(socket, id, { base, body }) {
    const sent = body && typeof body === 'object' ? body : {};
    const made = this.game.body(sent, this.state.world);
    const out = made.refused ? made : this.store.client(id).commit({ base: String(base ?? ''), body: made });
    if (out.refused) socket.send(JSON.stringify({ type: 'rejected', why: out.refused, body: sent }));
    else this.wallet.acted();
  }

  // The host asks `id` to leave: their pages go and their token is no more; they leave the table.
  #sendAway(id) {
    if (id === this.game.host) return;
    for (const [hash, member] of Object.entries(this.members)) if (member === id) delete this.members[hash];
    this.ctx.storage.put('members', this.members);
    for (const page of this.#pagesOf(id)) {
      page.serializeAttachment(null);
      close(page, 4001, 'The host asked you to leave the table.');
    }
    this.store.client(id).commit({ body: { type: 'leave' } });
  }

  #pages = () => this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
  #seated = () => this.#pages().filter((s) => s.deserializeAttachment()?.id);
  #pagesOf = (id) => this.#pages().filter((s) => s.deserializeAttachment()?.id === id);
  #online = (id) => this.#pagesOf(id).length > 0;

  #touch() {
    this.ctx.storage.put('touched', this.touched = Date.now());
  }

  // ---- what each page is sent ----

  // Once what has landed settles: the system members' due tasks, then each page its state, if it changed.
  #push() {
    if (this.#pushing) return;
    this.#pushing = true;
    queueMicrotask(() => {
      this.#pushing = false;
      if (!this.game) return;
      this.#settle();
      for (const page of this.#pages()) this.#send(page);
    });
  }

  #send(page) {
    const id = page.deserializeAttachment()?.id;
    if (!id) return;
    const client = this.store.client(id);
    const frame = JSON.stringify({ type: 'state', view: client.read().view, presence: client.present(), ai: this.#ai() });
    if (this.#sent.get(page) === frame) return;
    this.#sent.set(page, frame);
    page.send(frame);
  }

  // What the pages are told of the AI players: waiting for the host's key, or out of calls `until`.
  #ai() {
    if (this.own && !this.key) return { waiting: true };
    return this.#spend(0) ? {} : { until: (this.spent.hour + 1) * HOUR };
  }

  // ---- the system members and the clock ----

  // The clock's and the dealer's tasks that are due land now: they act at once.
  #settle() {
    for (let n = 0; n < 100 && this.#stuck !== this.rev; n++) {
      const now = Date.now();
      const due = this.game.system.flatMap((m) => this.world.view(this.state, m).tasks.filter((t) => (t.at ?? 0) <= now).map((t) => [m, t]))[0];
      if (!due) break;
      const [m, task] = due;
      const body = m === this.game.dealer ? this.game.deal(this.world.view(this.state, m)) : {};
      if (!this.store.client(m).commit({ as: task.as, answers: [task.given], body }).rev) this.#stuck = this.rev;
    }
    this.#schedule();
  }

  // The alarm at the next thing due, if any.
  #schedule() {
    if (!this.game) return;
    const now = Date.now();
    const at = Object.values(this.gone);
    if (!this.#seated().length) at.push(this.touched + IDLE_MS);
    if (this.#stuck !== this.rev) for (const m of this.game.system) for (const t of this.world.view(this.state, m).tasks) at.push(t.at ?? now);
    if (this.ais && this.game.ais.some((id) => this.world.view(this.state, id).tasks.length)) at.push(now + AWAKE_MS);
    const next = at.length ? Math.max(now, Math.min(...at)) : null;
    if (next === this.#alarm) return;
    this.#alarm = next;
    if (next === null) this.ctx.storage.deleteAlarm();
    else this.ctx.storage.setAlarm(next);
  }

  // ---- the AI players and their wallet ----

  // The AI players run while there is a key to run them on: Ponjo's, or the host's own, once given.
  #seat() {
    const can = !this.own || Boolean(this.key);
    if (can && !this.ais) {
      this.ais = this.game.ais.map((id) => control(this.store.client(id), {
        program: agent({ client: this.store.client(id), id, infer: (messages, tools) => this.#call(messages, tools), pace: (tasks, view) => this.game.pace(id, tasks, view), ...this.game.seat(id) }),
        wallet: this.wallet,
      }));
    } else if (!can && this.ais) {
      for (const c of this.ais) c.stop();
      this.ais = null;
    }
  }

  // The host's own key, or null for Ponjo's. One that cannot be used is
  // refused, and nothing changes: an OpenAI-compatible one only at OPENAI_HOSTS.
  #useKey(socket, key) {
    const refuse = (why) => socket.send(JSON.stringify({ type: 'rejected', why, body: {} }));
    const ok = key === null || (typeof key === 'object' && ['anthropic', 'openai'].includes(key.provider) && [key.key, key.model].every((v) => typeof v === 'string' && v && v.length <= 500));
    if (!ok) return refuse('Your model\'s settings cannot be used: they take a key and a model.');
    if (key?.provider === 'openai' && !supported(key.endpoint)) return refuse(`Your base URL's host is not supported. Use https:// at one of ${OPENAI_HOSTS.join(', ')}.`);
    this.key = key && { provider: key.provider, key: key.key, model: key.model, ...(key.provider === 'openai' ? { endpoint: key.endpoint } : {}) };
    if (this.own !== Boolean(this.key)) this.ctx.storage.put('own', this.own = Boolean(this.key));
    this.#seat();
    this.#push();
  }

  // Whether the table may call the model once more this hour, on the key in use; counts `n` calls.
  #spend(n) {
    const hour = Math.floor(Date.now() / HOUR);
    if (this.spent.hour !== hour) this.spent = { hour, ponjo: 0, own: 0 };
    const on = this.key ? 'own' : 'ponjo';
    if (this.spent[on] >= Number(on === 'own' ? this.env.OWN_RUNS_AN_HOUR : this.env.RUNS_AN_HOUR)) return false;
    if (n) {
      this.spent[on] += n;
      this.ctx.storage.put('spent', this.spent);
    }
    return true;
  }

  // One call of the model: on the host's own key, or on Ponjo's, within the opener's rate.
  async #call(messages, tools) {
    const own = this.key;
    if (!own) {
      if (!(await this.env.INFER.limit({ key: `table ${this.opener}` })).success) throw new Error('Too many calls of the model from this table\'s address: wait a minute.');
      return claude(messages, tools, this.env);
    }
    try {
      const infer = own.provider === 'openai' ? INFER.openai({ endpoint: own.endpoint, model: own.model, key: own.key }) : INFER.anthropic({ model: own.model, key: own.key, effort: 'low' }, this.env.ANTHROPIC_ENDPOINT);
      return await infer(messages, tools);
    } catch (error) {
      // What a provider answers may hold the key: only its status is told.
      const status = String(error.message).match(/: (\d{3}) /)?.[1];
      throw new Error(status ? `Your model's provider answered ${status}.` : 'Your model\'s provider could not be reached.');
    }
  }
}

// A call of Claude on Ponjo's key, as /infer/chat/completions calls its
// model: the model, its effort and a cap on tokens are the Worker's.
async function claude(messages, tools, env) {
  const answer = await fetch(`${env.ANTHROPIC_ENDPOINT}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL, max_tokens: MAX_TOKENS, output_config: { effort: 'low' }, tool_choice: { type: 'auto' },
      tools: tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })),
      messages: messages.map((m) => ({ role: 'user', content: [{ type: 'text', text: m.content, ...(m.cache ? { cache_control: { type: 'ephemeral' } } : {}) }] })),
    }),
  });
  if (!answer.ok) throw new Error(`The model answered ${answer.status}.`);
  const { content } = await answer.json();
  return {
    calls: content.filter((b) => b.type === 'tool_use').map(({ id, name, input }) => ({ id, name, args: JSON.stringify(input) })),
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
  };
}

// Whether `endpoint` is https:// at one of OPENAI_HOSTS, on its usual port, with no name or password in it.
function supported(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && OPENAI_HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password;
}

function close(socket, code, reason) {
  try {
    socket.close(code, reason);
  } catch {} // closed already
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
