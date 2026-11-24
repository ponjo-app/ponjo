// The game tables' rooms on the relay (relay/table.js, the hackathon env in
// relay/wrangler.toml; docs/app/worlds/rooms.md), run locally by wrangler
// (`npm ci --prefix relay` first) in front of a fake Anthropic API, with
// pages as Node WebSockets that keep every frame they are sent.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as get } from 'node:http';
import { createServer as listen } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { startRelay } from './relay/harness.js';
import { until } from './helpers.js';

const PONJO_KEY = 'sk-ant-ponjo-secret-test';
const VISITOR_KEY = 'sk-ant-visitor-secret-test';

// The fake model: each request kept; `answer(request)` its reply, by
// default as an AI player would play spy or poker; a reply of null never comes.
const api = { requests: [], answer: null };
function play(situation) {
  const vote = situation.match(/action vote, with the target's seat number, one of (\d+)/);
  if (vote) return { thinking: 'secret thought', action: { type: 'vote', target: Number(vote[1]) } };
  if (/action clue/.test(situation)) return { thinking: 'secret thought', action: { type: 'clue' }, say: 'Something round.' };
  if (/It is your turn/.test(situation)) return { thinking: 'secret thought', action: { type: /You may: fold, check/.test(situation) ? 'check' : 'call' } };
  return { thinking: 'secret thought', action: { type: 'say' }, say: '' };
}
const reply = (input) => ({ content: [{ type: 'text', text: input.thinking }, { type: 'tool_use', id: 't', name: 'decide', input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
let model;
const relays = [];
before(async () => {
  model = createServer(async (req, res) => {
    const request = { url: req.url, headers: req.headers, body: JSON.parse(await text(req)) };
    api.requests.push(request);
    const out = api.answer ? api.answer(request) : { status: 200, body: reply(play(request.body.messages.at(-1).content.at(-1).text)) };
    if (out) res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
});
after(async () => {
  for (const relay of relays) await relay.stop();
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
});

// The tables' relay, with Ponjo's key and the fake model, `vars` over the
// config's, stopped once test `t` is done, so its AI players call no more,
// and the fake model as it was.
async function tables(t, { persist, ...vars } = {}) {
  const value = (v) => ({ type: 'plain_text', value: v });
  const relay = await startRelay({
    env: 'hackathon', persist,
    bindings: { ANTHROPIC_ENDPOINT: value(`http://127.0.0.1:${model.address().port}/v1`), ANTHROPIC_API_KEY: value(PONJO_KEY), TOKEN_FACTORY_KEY: value('tf'), ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, value(v)])) },
  });
  relays.push(relay);
  t.after(() => {
    api.answer = null;
    return stop(relay);
  });
  return relay;
}
const stop = async (relay) => relays.includes(relay) && relays.splice(relays.indexOf(relay), 1)[0].stop();

const newRoom = () => {
  const secret = randomBytes(32).toString('hex');
  return { secret, room: createHash('sha256').update(secret).digest('hex') };
};

// A person's page at `room`: says `hello`, keeps each frame, and acts;
// `playAlong()` gives its seat's clue, vote or pass in spy, once due.
function page(relay, room, hello) {
  const ws = new WebSocket(`${relay.url}/tables/${room}`);
  const p = {
    frames: [], closed: null,
    send: (message) => ws.send(JSON.stringify(message)),
    act: (body, base = p.view()?.content.moment ?? '') => p.send({ type: 'act', base, body }),
    view: () => p.frames.findLast((f) => f.type === 'state')?.view,
    me: () => p.frames.find((f) => f.type === 'hello')?.me,
    close: () => ws.close(),
    playAlong() {
      const view = p.view();
      if (!view || p.played === view.content.moment) return;
      const g = view.content.game;
      if (view.actions.includes('clue')) p.act({ type: 'clue', text: 'Something you hold.' });
      else if (view.actions.includes('vote')) p.act({ type: 'vote', target: g.due.targets[0] });
      else if (view.actions.includes('pass')) p.act({ type: 'pass' });
      else return;
      p.played = view.content.moment;
    },
  };
  ws.onopen = () => p.send(hello);
  ws.onmessage = ({ data }) => data !== 'pong' && p.frames.push(JSON.parse(data));
  ws.onclose = ({ code, reason }) => {
    p.closed = { code, reason };
  };
  return p;
}

test('a table is kept in its room: with no page open its clock goes on, and after the relay restarts each page is back in its seat', async (t) => {
  const persist = await mkdtemp(join(tmpdir(), 'ponjo-tables-'));
  let relay = await tables(t, { persist });
  const { secret, room } = newRoom();
  const host = page(relay, room, { game: 'spy', secret });
  await until(() => host.view(), 'the host\'s first view');
  assert.equal(host.me(), 'you');
  const friend = page(relay, room, { game: 'spy' });
  await until(() => friend.me(), 'the friend\'s hello');
  const { me: id, token } = friend.frames[0];
  assert.match(id, /^f[0-9a-f]{8}$/);
  friend.act({ type: 'join', name: 'Ann' });
  await until(() => host.view().content.people.includes(id), 'the friend at the table');
  host.act({ type: 'start', size: 5 });
  await until(() => host.view().content.greeting, 'the hellos');

  // The hellos and the first clue are the clock's deadlines, which the room's alarm keeps with no page open.
  host.close();
  friend.close();
  await new Promise((r) => setTimeout(r, 15_000));
  const back = page(relay, room, { game: 'spy', secret });
  await until(() => back.view(), 'the host back');
  const { greeting, hellos, game } = back.view().content;
  assert.equal(greeting, false, 'the game began with no page open');
  assert.equal(hellos.length, 3, 'each AI player\'s hello');
  assert.ok(game.log.some((e) => e.type === 'round'), 'the first round began');
  back.close();

  // A restart of the relay: the room is read again from its storage.
  const before = back.view();
  await stop(relay);
  relay = await tables(t, { persist });
  const again = page(relay, room, { game: 'spy', secret });
  await until(() => again.view(), 'the host after the restart');
  assert.equal(again.me(), 'you');
  assert.equal(again.view().content.gameNo, before.content.gameNo);
  assert.ok(again.view().content.game.log.length >= before.content.game.log.length, 'nothing was lost');
  assert.equal(again.view().content.game.word, before.content.game.word, 'the same seat, the same word');
  const friendAgain = page(relay, room, { game: 'spy', token });
  await until(() => friendAgain.me(), 'the friend after the restart');
  assert.equal(friendAgain.me(), id, 'the friend\'s token is their seat');
  assert.ok(!friendAgain.frames[0].token, 'no new token');
  const stranger = page(relay, room, { game: 'spy', token: 'f'.repeat(64) });
  await until(() => stranger.me(), 'a page with a token never given');
  assert.notEqual(stranger.me(), id);
  for (const p of [again, friendAgain, stranger]) p.close();
});

test('each page is sent only its own seat\'s view, acts only as its own member, and never sees a key', async (t) => {
  const relay = await tables(t);
  const { secret, room } = newRoom();
  const host = page(relay, room, { game: 'spy', secret });
  await until(() => host.view(), 'the host\'s first view');
  // The host's own key, which the AI players run on; the provider's first answer echoes it.
  let echoed = false;
  api.answer = (request) => {
    if (echoed || request.headers['x-api-key'] !== VISITOR_KEY) return { status: 200, body: reply(play(request.body.messages.at(-1).content.at(-1).text)) };
    echoed = true;
    return { status: 401, body: { error: { message: `invalid x-api-key ${request.headers['x-api-key']}` } } };
  };
  host.send({ type: 'key', key: { provider: 'anthropic', key: VISITOR_KEY, model: 'claude-haiku-5-5' } });
  const friend = page(relay, room, { game: 'spy' });
  await until(() => friend.me(), 'the friend\'s hello');
  const id = friend.me();
  friend.act({ type: 'join', name: 'Ann' });
  await until(() => host.view().content.people.includes(id), 'the friend at the table');

  // A friend cannot do what only the host may, nor what another member does.
  friend.act({ type: 'start', size: 5 });
  await until(() => friend.frames.some((f) => f.type === 'rejected'), 'the start refused');
  assert.equal(friend.frames.find((f) => f.type === 'rejected').why, 'Only the host starts a game.');
  friend.send({ type: 'key', key: { provider: 'anthropic', key: 'sk-ant-friend', model: 'm' } });
  friend.send({ type: 'away', id: 'you' });
  const calls = api.requests.length;
  host.act({ type: 'start', size: 5 });
  await until(() => host.view().content.game && !host.view().content.greeting, 'the first round', 30_000);
  const seats = host.view().content.players;
  const ai = seats.find((p) => !['you', id].includes(p));
  friend.send({ type: 'act', by: ai, as: ai, base: friend.view().content.moment, body: { type: 'clue', text: 'as another' }, answers: [`turn:${friend.view().content.moment}`] });
  await until(() => {
    host.playAlong();
    friend.playAlong();
    return host.view().content.game.round > 1 || host.view().content.game.phase === 'over';
  }, 'a round played', 120_000);

  for (const [p, mine] of [[host, 'you'], [friend, id]]) {
    const states = p.frames.filter((f) => f.type === 'state');
    assert.ok(states.length > 5);
    for (const { view } of states) {
      const g = view.content.game;
      assert.equal(JSON.stringify(view).includes('secret thought'), Boolean(g?.phase === 'over'), 'no AI player\'s thinking before the game is over');
      if (!g || g.phase === 'over') continue;
      assert.equal(g.seat, view.content.players.indexOf(mine), 'its own seat');
      g.seats.forEach((s, i) => assert.equal(s.word, null, `seat ${i}'s word`));
      g.seats.forEach((s, i) => assert.ok(!s.alive || s.role === null, `seat ${i}'s side`));
    }
    const all = JSON.stringify(p.frames);
    for (const key of [VISITOR_KEY, PONJO_KEY, 'sk-ant-friend']) assert.ok(!all.includes(key), `${key} reached a page`);
  }
  const theirs = host.view().content.players.indexOf(id);
  assert.ok(host.view().content.game.log.every((e) => e.text !== 'as another' || e.seat === theirs), 'no clue was given as another seat');
  const words = [host, friend].map((p) => p.view().content.game.word);
  const playing = friend.frames.filter((f) => f.type === 'state' && f.view.content.game?.phase !== 'over');
  if (words[0] !== words[1]) assert.ok(!JSON.stringify(playing).includes(`"${words[0]}"`), 'the host\'s word never reached the friend before the game was over');
  assert.ok(host.frames.some((f) => f.presence && Object.values(f.presence).some((x) => x.failed === 'Your model\'s provider answered 401.')), 'a failed call is told by its status');
  const sent = api.requests.slice(calls);
  assert.ok(sent.every((r) => r.headers['x-api-key'] === VISITOR_KEY), 'the AI players ran on the host\'s key, not the friend\'s or Ponjo\'s');
  assert.equal(host.view().content.people.length, 2, 'the friend could not send the host away');
  host.close();
  friend.close();
});

test('a table calls the model at most its budget a clock hour; past it, the AI players\' turns take the fallback', async (t) => {
  const relay = await tables(t, { RUNS_AN_HOUR: '3' });
  const { secret, room } = newRoom();
  const host = page(relay, room, { game: 'spy', secret });
  await until(() => host.view(), 'the host\'s first view');
  const calls = api.requests.length;
  host.act({ type: 'start', size: 5 });
  await until(() => {
    host.playAlong();
    return host.view().content.game?.log.filter((e) => e.type === 'clue').length >= 5;
  }, 'every clue', 60_000);
  const clues = host.view().content.game.log.filter((e) => e.type === 'clue');
  assert.equal(api.requests.length - calls, 3, 'three calls, then none');
  assert.equal(clues.filter((e) => e.silent).length, 1, 'the fourth AI player gave no clue');
  const { until: when } = host.frames.findLast((f) => f.type === 'state').ai;
  assert.ok(when > Date.now() && when <= Date.now() + 3_600_000, 'the pages are told until when');
  host.close();
});

test('the room\'s alarm keeps a turn\'s deadline: an AI player whose model never answers is checked or folded for', async (t) => {
  const relay = await tables(t);
  const { secret, room } = newRoom();
  api.answer = () => null; // never
  const host = page(relay, room, { game: 'poker', secret });
  await until(() => host.view(), 'the host\'s first view');
  host.act({ type: 'sit', buyIn: 500 });
  let acted = '';
  const forced = await until(() => {
    const { hand, legal, moment } = host.view().content;
    if (legal && acted !== moment) {
      acted = moment;
      host.act({ action: { type: legal.check ? 'check' : 'call' } });
    }
    return hand?.actions.find((a) => ['check', 'fold'].includes(a.type) && hand.seats[a.seat].id !== 'you');
  }, 'an AI player\'s turn past its deadline', 90_000);
  assert.ok(forced);
  for (const { view } of host.frames.filter((f) => f.type === 'state' && f.view.content.hand?.street !== 'done' && f.view.content.hand)) {
    view.content.hand.seats.forEach((seat) => assert.equal(seat.hole === null, seat.id !== 'you', `${seat.id}'s cards, to the host`));
  }
  assert.ok(api.requests.length > 0 && api.requests.every((r) => r.headers['x-api-key'] === PONJO_KEY || r.headers['x-api-key'] === VISITOR_KEY));
  host.close();
});

test('a page is let in only from Ponjo\'s pages, to a table that is there, as the host only with its secret', async (t) => {
  const relay = await tables(t);
  const { secret, room } = newRoom();
  const refused = await new Promise((resolve, reject) => get(`${relay.origin}/tables/${room}`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), origin: 'https://evil.example' } })
    .on('response', resolve).on('upgrade', () => reject(new Error('let in'))).on('error', reject).end());
  assert.equal(refused.statusCode, 403);
  const nobody = page(relay, room, { game: 'spy' });
  await until(() => nobody.closed, 'a link to no table');
  assert.equal(nobody.closed.code, 4004);
  const host = page(relay, room, { game: 'spy', secret });
  await until(() => host.view(), 'the host\'s first view');
  const impostor = page(relay, room, { game: 'spy', secret: 'not it' });
  await until(() => impostor.closed, 'a wrong secret');
  assert.equal(impostor.closed.code, 4003);
  const other = page(relay, room, { game: 'poker' });
  await until(() => other.closed, 'another game');
  assert.equal(other.closed.code, 4004);
  host.close();
});

test('the host closes a table: every page on it closes, and its link opens nothing', async (t) => {
  const relay = await tables(t);
  const { secret, room } = newRoom();
  const host = page(relay, room, { game: 'spy', secret });
  await until(() => host.view(), 'the host\'s first view');
  const friend = page(relay, room, { game: 'spy' });
  await until(() => friend.me(), 'the friend\'s hello');
  friend.send({ type: 'close' });
  friend.act({ type: 'join', name: 'Ann' });
  await until(() => host.view().content.people.includes(friend.me()), 'the friend could not close it');
  host.send({ type: 'close' });
  await until(() => host.closed && friend.closed, 'both pages closed');
  assert.deepEqual([host.closed.code, friend.closed.code], [4004, 4004]);
  assert.equal(friend.closed.reason, 'The host closed this table. Ask for a new link.');
  const back = page(relay, room, { game: 'spy', token: friend.frames[0].token });
  await until(() => back.closed, 'the old link');
  assert.equal(back.closed.code, 4004);
});

test('a visitor\'s OpenAI-compatible key is taken only for a known provider\'s host: any other is refused and never called', async (t) => {
  const relay = await tables(t);
  // A host the relay may not call: any line opened to it is counted.
  let lines = 0;
  const elsewhere = listen((socket) => {
    lines++;
    socket.destroy();
  });
  await new Promise((r) => elsewhere.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => elsewhere.close(r)));
  const { secret, room } = newRoom();
  const host = page(relay, room, { game: 'spy', secret });
  await until(() => host.view(), 'the host\'s first view');
  const refusals = () => host.frames.filter((f) => f.type === 'rejected');
  for (const endpoint of [`https://localhost:${elsewhere.address().port}/v1`, 'https://evil.example/v1', 'http://api.openai.com/v1', 'https://api.openai.com.evil.example/v1', 'https://user:pass@api.openai.com/v1']) {
    host.send({ type: 'key', key: { provider: 'openai', key: VISITOR_KEY, model: 'm', endpoint } });
  }
  await until(() => refusals().length === 5, 'each base URL refused');
  assert.ok(refusals().every((f) => /not supported.*api\.openai\.com, openrouter\.ai/.test(f.why)), 'the page is told which hosts are');
  assert.ok(!JSON.stringify(host.frames).includes(VISITOR_KEY));
  // A known provider's host is taken: no game is on, so nothing calls it; then back to Ponjo's key.
  host.send({ type: 'key', key: { provider: 'openai', key: VISITOR_KEY, model: 'm', endpoint: 'https://api.groq.com/openai/v1' } });
  host.send({ type: 'key', key: null });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(refusals().length, 5, 'taken');
  // Nothing else changed: the AI players run on Ponjo's key, and none calls the host refused.
  const calls = api.requests.length;
  host.act({ type: 'start', size: 5 });
  await until(() => {
    host.playAlong();
    return api.requests.length > calls + 1;
  }, 'the AI players at work', 60_000);
  assert.ok(api.requests.slice(calls).every((r) => r.headers['x-api-key'] === PONJO_KEY));
  assert.equal(lines, 0, 'the refused host was never called');
  host.close();
});
