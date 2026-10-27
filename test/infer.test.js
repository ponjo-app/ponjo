// The preview's buddies' model (relay/worker.js, the hackathon env in
// relay/wrangler.toml), run locally by wrangler (`npm ci --prefix relay`
// first) in front of a fake Chat Completions API.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://ponjo.app';
const ANSWER = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"Welcome.md"}' } }] } }] };

let api;
let worker;
let url;
before(async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(await text(req)) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ANSWER));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = { requests, close: () => new Promise((r) => server.close(r)) };
  const wrangler = createRequire(join(root, 'relay', 'package.json')).resolve('wrangler');
  process.env.WRANGLER_LOG ??= 'error';
  const { unstable_startWorker } = await import(pathToFileURL(wrangler).href);
  worker = await unstable_startWorker({
    config: join(root, 'relay', 'wrangler.toml'),
    env: 'hackathon',
    bindings: {
      ENDPOINT: { type: 'plain_text', value: `http://127.0.0.1:${server.address().port}/v1` },
      TOKEN_FACTORY_KEY: { type: 'plain_text', value: 'tf-secret-test' },
    },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false, persist: false },
  });
  url = `http://${(await worker.url).host}/infer/chat/completions`;
});
after(async () => {
  await worker?.dispose();
  await api?.close();
});

const ask = (body, { origin = ORIGIN, ip = '203.0.113.1', method = 'POST' } = {}) => fetch(url, {
  method,
  headers: { 'content-type': 'application/json', authorization: 'Bearer x', ...(origin && { origin }), 'cf-connecting-ip': ip },
  ...(method === 'POST' && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});

test('a step from the preview goes on with the key, the model and a cap of its own, and its answer comes back as is', async () => {
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
  const messages = [{ role: 'user', content: 'the prompt' }];
  const response = await ask({ model: 'gpt-5', reasoning_effort: 'high', max_tokens: 100_000, stream: true, tool_choice: 'auto', tools, messages });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(await response.json(), ANSWER);
  const [sent] = api.requests;
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer tf-secret-test', 'the key is the Worker\'s, not the page\'s');
  assert.deepEqual(sent.body, { model: 'nvidia/nemotron-3-super-120b-a12b', max_tokens: 4000, messages, tools, tool_choice: 'required' }, 'only the messages and tools are the page\'s, and every step calls a tool');
});

test('the preflight is answered for the preview\'s page only', async () => {
  const ok = await ask(null, { method: 'OPTIONS' });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.headers.get('access-control-allow-headers'), /content-type, authorization/);
  assert.equal((await ask(null, { method: 'OPTIONS', origin: 'https://evil.example' })).status, 403);
});

test('it is no free model: another origin, a request too big or not one, and an address over 60 a minute are turned away', async () => {
  const before = api.requests.length;
  const messages = [{ role: 'user', content: 'hi' }];
  assert.equal((await ask({ messages }, { origin: 'https://evil.example', ip: '203.0.113.2' })).status, 403);
  assert.equal((await ask({ messages }, { origin: null, ip: '203.0.113.2' })).status, 403);
  assert.equal((await ask({ messages: [{ role: 'user', content: 'x'.repeat(200_000) }] }, { ip: '203.0.113.3' })).status, 413);
  assert.equal((await ask('{"messages":', { ip: '203.0.113.4' })).status, 400);
  assert.equal((await ask({ prompt: 'hi' }, { ip: '203.0.113.4' })).status, 400);
  assert.equal(api.requests.length, before, 'none of them reached the model');
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await ask({ messages }, { ip: '203.0.113.5' })).status);
  assert.deepEqual(statuses, [...Array(60).fill(200), 429]);
});
