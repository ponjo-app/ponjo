// The Ponjo agent (docs/ponjo-agent.md): `turn` with a fake `infer`;
// each provider's `infer` on a fake server of its API; and the shipped
// script once, with its settings and its trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { INFER, turn } from '../agents/ponjo-core.mjs';
import { files, inProject } from '../agents/ponjo.mjs';
import { projectService } from '../src/host/project-service.js';
import { agentScript, installAgents } from '../src/store/agents.js';
import { MAX_TEXT_BYTES } from '../src/store/files.js';
import { SAMPLE } from './helpers.js';

const HEADER = '{"comments":1}\n';

/**
 * A run's working folder, made the current one, holding copies of a doc and
 * its sidecar at `doc`, its path in the project: { dir, doc, sidecar }.
 */
async function copies(content = SAMPLE, doc = 'plan.md') {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-agent-'));
  const sidecar = `${doc}.comments.jsonl`;
  process.chdir(dir);
  await mkdir(dirname(doc), { recursive: true });
  await writeFile(doc, content);
  await writeFile(sidecar, HEADER);
  return { dir, doc, sidecar };
}

/** What the turn sees of the copies `doc` and `sidecar`, and of `project` (left out: doc mode, the working folder). */
const seen = ({ doc, sidecar }, project = '.') => files({ doc, sidecar, project });

let calls = 0;
/** What `infer` resolves to when the model calls the tools `[name, args]`. */
const calling = (...uses) => ({ calls: uses.map(([name, args]) => ({ id: `call_${++calls}`, name, args: JSON.stringify(args) })), sent: 'as the API sent it' });

/** A fake `infer` answering with `replies` in turn, then reading forever; `messages` is what it was last sent. */
function fake(...replies) {
  const infer = async (messages, tools) => {
    infer.messages = messages;
    infer.tools = tools;
    infer.steps = (infer.steps ?? 0) + 1;
    return replies.shift() ?? calling(['read', { path: 'plan.md' }]);
  };
  return infer;
}

const results = (messages) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('a turn reads the doc by line number and proposes an edit and a comment', async () => {
  const { doc, sidecar } = await copies();
  const edits = [{ path: doc, old: 'extra load', new: 'extra peak load' }, { path: sidecar, old: '', new: '{"body":"Is week one too soon?"}' }];
  const infer = fake(calling(['read', { path: doc, lines: [8, 8] }]), calling(['propose', { edits, reply: 'Peak load is the risk.' }]));
  assert.deepEqual(await turn({ prompt: 'the prompt', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }) }), { edits, reply: 'Peak load is the risk.' });
  assert.deepEqual(infer.messages[0], { role: 'user', content: 'the prompt' }, 'the first message is the prompt as is');
  assert.deepEqual(infer.tools.map((t) => t.name), ['read', 'find', 'grep', 'propose']);
  assert.deepEqual([infer.messages[1].role, infer.messages[1].sent], ['assistant', 'as the API sent it'], 'the model\'s message, kept as its API sent it');
  assert.deepEqual(infer.messages[2], { role: 'tool', id: infer.messages[1].calls[0].id, content: '8\tThe main risk is that the `sync` service cannot handle the extra load.' });
});

test('a bad proposal goes back saying what to fix', async () => {
  const { doc, sidecar } = await copies();
  const bad = [
    [{ path: doc, old: 'the', new: 'a' }, /more than once/],
    [{ path: doc, old: 'all seven features', new: 'x' }, /not in the doc/],
    [{ path: doc, old: '', new: 'x' }, /is empty/],
    [{ path: 'other.md', old: '', new: 'x' }, /other\.md cannot change: only plan\.md and plan\.md\.comments\.jsonl can/],
    [{ path: join(process.cwd(), doc), old: 'week one', new: 'x' }, /cannot change/],
    [{ path: sidecar, old: HEADER, new: '' }, /old must be empty/],
    [{ path: sidecar, old: '', new: '{"body":"ok"}\n{"anchor":"week one","body":"no"}' }, /not a comment line: {"anchor":"week one"/],
    [{ path: sidecar, old: '', new: '{"body":"ok","resolved":true}' }, /not a comment line/],
  ];
  const overlapping = [{ path: doc, old: 'ship all six', new: 'x' }, { path: doc, old: 'all six features', new: 'y' }];
  const good = [{ path: doc, old: 'week one', new: 'week two' }, { path: sidecar, old: '', new: '{"thread":"c_1","body":"Moved."}\n' }];
  const infer = fake(...bad.map(([edit]) => calling(['propose', { edits: [good[0], edit], reply: '' }])), calling(['propose', { edits: overlapping, reply: '' }]), calling(['propose', { edits: good }]));
  assert.deepEqual(await turn({ prompt: 'p', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }), resolve: inProject }), { edits: good, reply: '' });
  const said = results(infer.messages);
  bad.forEach(([, why], i) => assert.match(said[i], new RegExp(`^Nothing was changed\\. Edit 2: .*${why.source}`)));
  assert.match(said.at(-1), /Edit 2 overlaps another edit/);
});

test('an answer without a tool call is the reply, with no edits', async () => {
  const { doc, sidecar } = await copies();
  const infer = fake(calling(['read', { path: doc, lines: [1, 1] }]), { calls: [], text: '\nTry "co-authoring".', sent: 'as the API sent it' });
  assert.deepEqual(await turn({ prompt: 'p', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }) }), { edits: [], reply: 'Try "co-authoring".' });
  assert.equal(infer.steps, 2);
});

test('every call is answered, and twenty steps fail', async () => {
  const { doc, sidecar } = await copies();
  const infer = fake(calling(['read', { path: doc, lines: [1, 1] }], ['read', { path: sidecar }]), {
    calls: [{ id: 'bad', name: 'read', args: '{"path":' }], sent: null,
  });
  await assert.rejects(turn({ prompt: 'p', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }) }), /No proposal in 20 steps/);
  assert.equal(infer.steps, 20);
  const [, step, first, second, , notJson] = infer.messages;
  assert.deepEqual([first.content, second.content], ['1\t# Q4 Launch Plan', 'Not run: one tool per step.']);
  assert.deepEqual([first.id, second.id], step.calls.map((c) => c.id), 'each call id gets a result');
  assert.equal(notJson.content, 'The arguments are not JSON: {"path":');
});

test('a long file reads as its outline, and in parts by line number', async () => {
  const section = (title) => `## ${title}\n\n${'Some text that goes on. '.repeat(40)}\n\n`;
  const { doc, sidecar } = await copies(`# Plan\n\n${section('One')}\`\`\`sh\n# not a heading\n\`\`\`\n\n${Array.from({ length: 22 }, (_, i) => section(`S${i}`)).join('')}`);
  const infer = fake(calling(['read', { path: doc }]), calling(['read', { path: doc, lines: [3, 4] }]), calling(['read', { path: 'nowhere.md' }]), calling(['propose', { edits: [], reply: '' }]));
  await turn({ prompt: 'p', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }) });
  const [outline, part, missing] = results(infer.messages);
  assert.deepEqual(outline.split('\n').slice(0, 5), [`${doc} has 98 lines, too many to read at once: read it in parts.`, 'Its headings, with their lines:', '1-2\t# Plan', '3-10\t## One', '11-14\t## S0']);
  assert.equal(part, `3\t## One\n4\t`);
  assert.equal(missing, 'nowhere.md: no such file, or not one you can read.');
});

/**
 * A project (its real path) as the app shows it, and a folder outside it:
 * `notes/` with a doc and its sidecar, installed packages, hidden files, a
 * binary, a file over 20 MB, and links in, out, and hidden.
 */
async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-outside-')));
  await writeFile(join(outside, 'b.md'), 'secret');
  for (const [path, text] of Object.entries({
    'notes/a.md': 'A\n', 'notes/a.md.comments.jsonl': HEADER, 'node_modules/pkg/index.js': 'x\n', '.env': 'secret', '.git/config': 'secret',
    'pic.png': Buffer.from([0x89, 0x50, 0x00, 0x47]), 'big.log': 'x'.repeat(MAX_TEXT_BYTES + 1),
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await symlink(join(root, 'notes'), join(root, 'linked'), 'junction');
  await symlink(join(root, 'notes'), join(root, '.hidden'), 'junction');
  await symlink(join(root, '.git'), join(root, 'git'), 'junction');
  await symlink(outside, join(root, 'out'), 'junction');
  return { root, outside };
}

// Which paths of project() a buddy reads, the same as the app's ProjectService does.
const SHOWN = [
  ['notes/a.md', true],
  ['notes/a.md.comments.jsonl', true, 'sidecars included'],
  ['node_modules/pkg/index.js', true, 'what git ignores'],
  ['linked/a.md', true, 'a link that stays in the project'],
  ['.env', false],
  ['.git/config', false],
  ['notes/../.env', false],
  ['.hidden/a.md', false, 'a hidden link'],
  ['git/config', false, 'a link to a hidden folder'],
  ['out/b.md', false, 'a link out of the project'],
  ['../b.md', false],
  ['pic.png', false, 'a binary file'],
  ['big.log', false, 'a file over 20 MB'],
  ['notes/none.md', false],
];

test('a buddy reads the project as the app shows it: one table of cases, run on both', async () => {
  const { root, outside } = await project();
  const agent = files({ doc: 'plan.md', sidecar: 'plan.md.comments.jsonl', project: root });
  const app = projectService(root);
  for (const [path, shown, why = path] of [...SHOWN, [join(root, 'notes', 'a.md'), false, 'an absolute path'], [join(outside, 'b.md'), false]]) {
    assert.equal(typeof (await agent(path)) === 'string', shown, `the agent: ${why}`);
    assert.equal(typeof (await app.read(path).catch(() => ({}))).text === 'string', shown, `ProjectService: ${why}`);
  }
});

test('the turn sees the copies and the project by their paths in the project, and in doc mode only the copies', async () => {
  const { root } = await project();
  const { doc, sidecar } = await copies(SAMPLE, 'notes/a.md');
  const readable = seen({ doc, sidecar }, root);
  assert.deepEqual(await readable(''), ['big.log', 'linked', 'node_modules/', 'notes/', 'pic.png'], 'a folder, its entries: no link out of the project or to a hidden folder');
  assert.deepEqual(await readable('./notes/'), ['a.md', 'a.md.comments.jsonl']);
  assert.equal(await readable('notes/a.md'), SAMPLE, 'the copy, not the project\'s doc');
  assert.equal(await readable('linked/a.md'), 'A\n');
  assert.equal(await readable(join(process.cwd(), doc)), null, 'never by an absolute path');
  assert.deepEqual(await seen({ doc, sidecar })(''), ['notes/']);
  assert.deepEqual(await seen({ doc, sidecar })('notes'), ['a.md', 'a.md.comments.jsonl'], 'in doc mode, the working folder');
});

test('find and grep: paths or lines that match a regular expression, smart case, at most 100', async () => {
  const { root } = await project();
  const { doc, sidecar } = await copies(SAMPLE, 'notes/a.md');
  for (let i = 0; i < 101; i++) await writeFile(join(root, 'notes', `n${String(i).padStart(3, '0')}.txt`), `one\nRule ${i}\n`);
  await writeFile(join(root, 'rule.md'), `# Rules\n\n${'x'.repeat(600)} rule\n`);
  const uses = [
    ['find', { pattern: 'rule\\.md$' }],
    ['find', { pattern: '' }],
    ['find', { pattern: '^notes/a', path: './notes/' }],
    ['find', { pattern: 'n\\d', path: 'notes' }],
    ['find', { pattern: 'n1', path: 'out' }],
    ['find', { pattern: 'Rule' }],
    ['find', { pattern: '**/rule.md' }],
    ['grep', { pattern: 'rule' }],
    ['grep', { pattern: 'rules?$', path: 'rule.md' }],
    ['grep', { pattern: 'week', path: 'notes/a.md' }],
    ['grep', { pattern: 'Rule 1\\d$', path: 'notes' }],
    ['grep', { pattern: 'secret' }],
  ];
  const infer = fake(...uses.map((use) => calling(use)), calling(['propose', { edits: [], reply: '' }]));
  await turn({ prompt: 'p', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }, root), resolve: inProject });
  const [rule, all, notes, capped, out, cased, glob, grep, long, inDoc, inFolder, none] = results(infer.messages);
  assert.equal(rule, 'rule.md');
  assert.doesNotMatch(all, /^(out|git)$/m, 'no link out of the project or to a hidden folder');
  assert.equal(notes, 'notes/a.md\nnotes/a.md.comments.jsonl', 'from the project\'s top, whatever the path\'s form');
  assert.deepEqual(capped.split('\n').slice(-2), ['notes/n099.txt', '1 more: narrow the pattern or the path.']);
  assert.equal(capped.split('\n').length, 101);
  assert.equal(out, 'out: no such folder, or not one you can read.');
  assert.equal(cased, 'No path matches Rule.', 'a capital letter: case counts');
  assert.match(glob, /^Invalid regular expression: .*Nothing to repeat\. The pattern is a regular expression, not a glob/);
  assert.equal(grep.split('\n').slice(0, 3).join('\n'), 'notes/n000.txt\n2\tRule 0\nnotes/n001.txt', 'case ignored, each file\'s path then its lines');
  assert.deepEqual(grep.split('\n').slice(-3), ['notes/n099.txt', '2\tRule 99', '3 more: narrow the pattern or the path.']);
  assert.equal(grep.split('\n').filter((line) => /^\d+\t/.test(line)).length, 100);
  assert.equal(long, `rule.md\n1\t# Rules\n3\t${'x'.repeat(500)}…`, 'a long line cut');
  assert.equal(inDoc, 'notes/a.md\n3\tWe plan to **ship all six features** in week one, then gather feedback from the', 'a file: the copy');
  assert.equal(inFolder, Array.from({ length: 10 }, (_, i) => `notes/n0${10 + i}.txt\n2\tRule ${10 + i}`).join('\n'));
  assert.equal(none, 'No line matches secret.');
});

/**
 * A fake API on 127.0.0.1: `answers` are [status, body] in turn; `requests`
 * what it was sent, { url, headers, body }. `url` is its address.
 */
async function fakeApi(answers) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(await text(req)) });
    const [status, body] = answers.shift() ?? [500, { error: 'no answer queued' }];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

test('Anthropic: the Messages API, the tools and the prompt cached, the model\'s content sent back as it came, a refusal fails', async () => {
  const { doc, sidecar } = await copies();
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' }; // must go back as it came
  const api = await fakeApi([
    [200, { stop_reason: 'tool_use', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: doc, lines: [1, 1] } }] }],
    [200, { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 'toolu_2', name: 'propose', input: { edits: [], reply: 'Fine as is.' } }] }],
    [200, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Not this.' }, content: [] }],
    [200, { stop_reason: 'end_turn', content: [thinking, { type: 'text', text: 'Fine ' }, { type: 'text', text: 'as is.' }] }],
  ]);
  try {
    const infer = INFER.anthropic({ model: 'claude-opus-5-5', key: 'sk-ant-test', effort: 'low' }, api.url);
    assert.deepEqual(await turn({ prompt: 'the prompt', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }) }), { edits: [], reply: 'Fine as is.' });
    const [first, second] = api.requests;
    assert.equal(first.url, '/v1/messages');
    assert.equal(first.body.messages.length, 1, 'the first step is the prompt alone');
    assert.equal(first.headers['x-api-key'], 'sk-ant-test');
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    const { tools, messages, ...rest } = second.body;
    assert.deepEqual(rest, { model: 'claude-opus-5-5', max_tokens: 16_000, output_config: { effort: 'low' }, tool_choice: { type: 'auto' } }, 'no thinking setting: the model thinks as it needs');
    assert.deepEqual(tools.map((t) => [t.name, Object.keys(t.input_schema.properties).join(), t.cache_control]), [['read', 'path,lines', undefined], ['find', 'pattern,path', undefined], ['grep', 'pattern,path', undefined], ['propose', 'edits,reply', { type: 'ephemeral' }]]);
    assert.deepEqual(messages, [
      { role: 'user', content: [{ type: 'text', text: 'the prompt', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: doc, lines: [1, 1] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\t# Q4 Launch Plan' }] },
    ]);
    await assert.rejects(infer(messages, []), /^Error: The model refused: Not this\.$/);
    assert.equal((await infer(messages, [])).text, 'Fine as is.', 'an answer without a call: its text blocks');
  } finally {
    await api.close();
  }
});

test('OpenAI-compatible: Chat Completions at the endpoint, with the key and the effort', async () => {
  const { doc, sidecar } = await copies();
  const read = { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: doc, lines: [1, 1] }) } }] };
  const propose = { role: 'assistant', content: null, tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'propose', arguments: '{"edits":[],"reply":"ok"}' } }] };
  const answer = { role: 'assistant', content: 'Fine as is.', tool_calls: null };
  const api = await fakeApi([[200, { choices: [{ message: read }] }], [200, { choices: [{ message: propose }] }], [200, { choices: [{ message: answer }] }]]);
  try {
    const infer = INFER.openai({ endpoint: `${api.url}/`, model: 'gpt-5', key: 'sk-test', effort: 'medium' });
    assert.deepEqual(await turn({ prompt: 'the prompt', doc, sidecar }, { infer, readFile: seen({ doc, sidecar }) }), { edits: [], reply: 'ok' });
    const [, { url, headers, body }] = api.requests;
    assert.equal(url, '/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.deepEqual([body.model, body.reasoning_effort, body.tool_choice], ['gpt-5', 'medium', 'auto']);
    assert.deepEqual(body.tools.map((t) => [t.type, t.function.name]), [['function', 'read'], ['function', 'find'], ['function', 'grep'], ['function', 'propose']]);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'the prompt' }, read, { role: 'tool', tool_call_id: 'call_a', content: '1\t# Q4 Launch Plan' }]);
    assert.equal((await infer(body.messages, [])).text, 'Fine as is.', 'an answer without a call: its content');
  } finally {
    await api.close();
  }
});

test('the shipped script runs a turn under the contract, with its settings from the environment', { skip: process.platform === 'win32' }, async () => {
  const answers = [];
  const api = await fakeApi(answers);
  try {
    const config = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
    await installAgents(config, { platform: 'linux' });
    const { dir, doc, sidecar } = await copies();
    const folder = join(config, 'run'); // the working folder by a link, as a Mac's temp folder is
    await symlink(dir, folder, 'junction');
    const settings = { PROVIDER: 'openai', ENDPOINT: api.url, MODEL: 'gpt-5', KEY: 'sk-secret-test', EFFORT: 'low' };
    const trace = join(config, 'trace.jsonl');
    const run = (PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, own = settings) => new Promise((resolve) => {
      const env = { ...process.env, PATH, PONJO_DOC: join(folder, doc), PONJO_COMMENTS: join(folder, sidecar), PONJO_PROJECT: '', PONJO_BUDDY: 'Ada', PONJO_TRACE: trace };
      for (const [key, value] of Object.entries(own)) env[`PONJO_SETTING_${key}`] = value;
      const child = execFile(agentScript('ponjo', config, 'linux'), { cwd: folder, env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
      child.stdin.on('error', () => {}); // a run that fails early need not read its prompt
      child.stdin.end('the prompt');
    });

    const edits = [{ path: doc, old: 'week one', new: 'week two' }, { path: sidecar, old: '', new: '{"body":"Two weeks?"}' }];
    const usage = { prompt_tokens: 1200, completion_tokens: 40 };
    answers.push([200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose', arguments: JSON.stringify({ edits, reply: 'Moved it.' }) } }] } }], usage }]);
    assert.deepEqual(await run(), { code: 0, stdout: 'Moved it.', stderr: '' });
    assert.equal(await readFile(doc, 'utf8'), SAMPLE.replace('week one', 'week two'));
    assert.equal(await readFile(sidecar, 'utf8'), `${HEADER}{"body":"Two weeks?"}\n`);
    assert.deepEqual([api.requests[0].body.model, api.requests[0].headers.authorization], ['gpt-5', 'Bearer sk-secret-test']);

    // A failed run's reply says what failed, then what to change and where.
    answers.push([404, { error: 'model "gpt-5" not found' }]);
    const failed = await run();
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, `${api.url}/chat/completions: 404 {"error":"model \\"gpt-5\\" not found"}\nCheck the endpoint and the model.\nThe provider, endpoint, model and key are in Settings > Agents > Ponjo agent.\n`);
    assert.deepEqual(await run(undefined, { ...settings, KEY: '' }), { code: 1, stdout: '', stderr: 'No API key: set one in Settings > Agents > Ponjo agent.\n' });

    const traced = await readFile(trace, 'utf8');
    const [answer] = traced.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(traced.trim().split('\n').length, 1, 'the model\'s step: not the prompt, which the app has, and none for a step that failed');
    assert.deepEqual([answer.role, answer.calls.map((c) => c.name), answer.usage], ['assistant', ['propose'], usage]);
    assert.ok(Number.isInteger(answer.ms));
    assert.doesNotMatch(traced, /sk-secret-test/, 'never the key');
    assert.ok(!existsSync(join(config, 'logs')), 'no log of its own');

    // A CRLF doc reads without its \r, and an edit quoting more than a line keeps its line breaks.
    await writeFile(doc, SAMPLE.replace(/\n/g, '\r\n'));
    const quote = 'We plan to **ship all six features** in week one, then gather feedback from the\nbeta cohort';
    const step = (id, name, args) => [200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }];
    answers.push(step('c2', 'read', { path: doc, lines: [3, 4] }), step('c3', 'propose', { edits: [{ path: doc, old: quote, new: 'We ship\nin week two' }], reply: '' }));
    assert.equal((await run()).code, 0);
    assert.equal(api.requests.at(-1).body.messages.at(-1).content, '3\tWe plan to **ship all six features** in week one, then gather feedback from the\n4\tbeta cohort before the public release.');
    assert.equal(await readFile(doc, 'utf8'), SAMPLE.replace(quote, 'We ship\nin week two').replace(/\n/g, '\r\n'));

    await api.close();
    assert.match((await run()).stderr, new RegExp(`^Cannot reach ${api.url}/chat/completions \\(ECONNREFUSED\\)\\.\nThe provider, endpoint, model and key are in Settings > Agents > Ponjo agent\\.`));
    assert.deepEqual(await run('/nowhere'), { code: 1, stdout: '', stderr: 'The Ponjo agent runs on Node.js: install it from https://nodejs.org, with node on PATH.\n' });
  } finally {
    await api.close().catch(() => {});
  }
});
