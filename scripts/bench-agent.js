// The Ponjo agent's benchmark: each case of scripts/bench-cases.js run a few
// times on a real model, under the contract the app runs it on
// (docs/agent-config.md), and what each run left checked. On your own key,
// not in CI: it costs tokens, and a model answers differently each time.
//
//   npm run bench:agent -- --env .env.nemotron --runs 3 --only question
//
// The settings are the agent's (PONJO_SETTING_*: PROVIDER, ENDPOINT, EFFORT,
// and the provider's own <PROVIDER>_MODEL and <PROVIDER>_KEY), from the
// environment or the file `--env` names, a line each
// (PONJO_SETTING_NEBIUS_MODEL=...): .env files are gitignored, keys and all.
// A run that fails on the API (unreachable, 429, 5xx) is an
// error, neither a pass nor a fail. Each failed run's folder is kept, with
// its trace, for a person to read: a model's mistake, or a check's.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createAnchor } from '../src/core/anchor.js';
import { serializeSidecar } from '../src/core/comments.js';
import { buildPrompt } from '../src/core/prompt.js';
import { CASES } from './bench-cases.js';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'ponjo.mjs');
const BUDDY = { id: 'Clippy', name: 'Clippy', about: 'A general writing assistant that helps draft and edit docs' };
const HUMAN = { id: 'fanzhangg', name: 'fanzhangg', about: '' };
const AT = '2026-10-27T12:00:00.000Z';
const TIMEOUT_MS = 5 * 60_000;
const API_ERROR = /^Cannot reach |: (429|5\d\d) /;

const { values: { runs, only, jobs, env } } = parseArgs({ options: { runs: { type: 'string', default: '3' }, only: { type: 'string', default: '' }, jobs: { type: 'string', default: '4' }, env: { type: 'string' } } });
if (env) process.loadEnvFile(env);
const PROVIDER = process.env.PONJO_SETTING_PROVIDER?.toUpperCase();
const { [`PONJO_SETTING_${PROVIDER}_MODEL`]: model, [`PONJO_SETTING_${PROVIDER}_KEY`]: key } = process.env;
if (!key) throw new Error('Set the agent\'s settings: PONJO_SETTING_PROVIDER, PONJO_SETTING_<PROVIDER>_MODEL, PONJO_SETTING_<PROVIDER>_KEY (and ENDPOINT, EFFORT as it needs).');

/** The sidecar holding `c`'s thread, by its members. */
function sidecar(c) {
  const by = (name) => (name === BUDDY.name ? { id: BUDDY.id, name, kind: 'ai' } : { id: name, name, kind: 'human' });
  const start = c.doc.indexOf(c.quote);
  const anchor = c.quote ? createAnchor(c.doc, start, start + c.quote.length) : null;
  return serializeSidecar(c.thread.map(([name, body], i) => ({
    comment: { id: i ? `${c.id}${i}` : c.id, ...(i ? { thread: c.id } : { anchor }), by: by(name), at: AT, body },
  })));
}

/** One run of `c`: { c, outcome: 'pass' | 'fail' | 'error', failed (checks' names), out, why, steps, tokens, ms, dir }. */
// The run's folder is the project, the copies in it where the doc is: in
// doc mode, it holds only them. The trace's name starts with a dot, which
// keeps it out of the run's sight.
async function run(c) {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-bench-'));
  const doc = c.path ?? 'plan.md';
  const comments = `${doc}.comments.jsonl`;
  const before = sidecar(c);
  for (const [path, text] of Object.entries({ ...c.files, [doc]: c.doc, [comments]: before })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const thread = { id: c.id, anchor: c.quote && { exact: c.quote }, comments: c.thread.map(([name, body]) => ({ by: { name }, body })) };
  const prompt = buildPrompt({ buddy: BUDDY, docName: doc, sidecarName: comments, thread, project: Boolean(c.files), human: HUMAN });
  const env = { ...process.env, PONJO_DOC: join(dir, doc), PONJO_COMMENTS: join(dir, comments), PONJO_PROJECT: c.files ? dir : '', PONJO_THREAD: c.id, PONJO_BUDDY: BUDDY.name, PONJO_TRACE: join(dir, '.trace.jsonl') };
  const at = Date.now();
  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = execFile(process.execPath, [AGENT], { cwd: dir, env, timeout: TIMEOUT_MS }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end(prompt);
  });
  const trace = (await readFile(env.PONJO_TRACE, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const answers = trace.filter((m) => m.role === 'assistant');
  // Chat Completions' prompt_tokens count the cached ones; Anthropic's input_tokens do not.
  const counted = ['prompt_tokens', 'completion_tokens', 'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
  const tokens = answers.reduce((sum, { usage = {} }) => sum + counted.reduce((n, key) => n + (usage[key] ?? 0), 0), 0);
  const result = { c, steps: answers.length, tokens, ms: Date.now() - at, dir };
  if (code !== 0) return { ...result, outcome: API_ERROR.test(stderr) ? 'error' : 'fail', failed: ['the run fails'], why: stderr.trim() };
  const after = await readFile(join(dir, comments), 'utf8');
  const out = { reply: stdout, doc: await readFile(join(dir, doc), 'utf8'), comments: after.slice(before.length).split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
  const failed = Object.entries(c.checks).filter(([, check]) => !check(out, c)).map(([name]) => name);
  return { ...result, outcome: failed.length ? 'fail' : 'pass', failed, out };
}

// The runs, `jobs` at a time.
const named = (c) => `${c.kind}: ${c.name}`;
const queue = CASES.filter((c) => named(c).includes(only)).flatMap((c) => Array(Number(runs)).fill(c));
const results = [];
await Promise.all(Array.from({ length: Number(jobs) }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const r = await run(c);
    results.push(r);
    process.stderr.write(r.outcome === 'pass' ? '.' : r.outcome === 'fail' ? 'F' : 'E');
    if (r.outcome === 'pass') await rm(r.dir, { recursive: true, force: true });
  }
}));

const { PONJO_SETTING_PROVIDER: provider, PONJO_SETTING_EFFORT: effort } = process.env;
console.log(`\n\n${provider} ${model}${effort ? ` (${effort})` : ''}, ${runs} runs a case\n`);
const mean = (list, key) => Math.round(list.reduce((sum, r) => sum + r[key], 0) / list.length);
// "passed/counted" of `list`, API errors not counted.
const score = (list) => {
  const errors = list.filter((r) => r.outcome === 'error').length;
  return `${list.filter((r) => r.outcome === 'pass').length}/${list.length - errors}${errors ? ` (${errors} errors)` : ''}`;
};
for (const kind of new Set(CASES.map((c) => c.kind))) {
  const theirs = results.filter((r) => r.c.kind === kind);
  if (!theirs.length) continue;
  console.log(`${kind}: ${score(theirs)}`);
  for (const c of CASES.filter((c) => c.kind === kind)) {
    const mine = theirs.filter((r) => r.c === c);
    if (mine.length) console.log(`  ${score(mine)}  ${c.name}  (${mean(mine, 'steps')} steps, ${mean(mine, 'tokens')} tokens, ${(mean(mine, 'ms') / 1000).toFixed(0)} s)`);
  }
}
console.log(`\nall: ${score(results)}`);

// The doc's change: the text taken out and put in, without what they share.
function change(was, is) {
  let start = 0;
  while (start < was.length && was[start] === is[start]) start++;
  let end = 0;
  while (end < was.length - start && end < is.length - start && was.at(-1 - end) === is.at(-1 - end)) end++;
  return `${JSON.stringify(was.slice(start, was.length - end))} → ${JSON.stringify(is.slice(start, is.length - end))}`;
}

for (const r of results.filter((r) => r.outcome !== 'pass')) {
  console.log(`\n${r.outcome === 'fail' ? 'FAIL' : 'ERROR'}  ${named(r.c)}: ${r.failed.join(', ')}\n  folder: ${r.dir}`);
  if (r.why) console.log(`  ${r.why.split('\n')[0]}`);
  if (r.out) {
    console.log(`  reply: ${JSON.stringify(r.out.reply)}`);
    if (r.out.doc !== r.c.doc) console.log(`  doc: ${change(r.c.doc, r.out.doc)}`);
    for (const m of r.out.comments) console.log(`  comment: ${JSON.stringify(m)}`);
  }
}
