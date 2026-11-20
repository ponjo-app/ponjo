// The executor (docs/agent-runtime.md, A run): runs the agent once as a
// buddy, on copies of a doc in a new private folder, with the prompt on
// stdin, and hands back the copies and the comments' groups of edits when
// it exits. The agent knows nothing of Ponjo; nothing here knows the doc.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FORMAT_VERSION } from '../core/comments.js';
import { buildPrompt } from '../core/prompt.js';
import { runUsage } from '../core/usage.js';
import { SIDECAR_SUFFIX, decodeText } from '../store/files.js';

const MAX_OUTPUT = 1024 * 1024;
const TAIL_LINES = 20;
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // no one can stop a run by hand: one that hangs fails
const TEST_TIMEOUT_MS = 2 * 60 * 1000;
const TEST_PROMPT = 'Ponjo is testing that you run. Edit no file and reply only: OK';

/**
 * Run `agent` ({ script, settings }) once as `task.buddy` ({ id, name,
 * about }), on `copies` of the doc ({ path: its path in the project,
 * `/`-separated, text, comments: the sidecar's text or null }), given
 * `task.threads` and `task.watch` and told of `task.buddies`, `folder` the
 * project's (or null) and `human` the user ({ name, about }). `onChild(child)`
 * hears the program started, to end it (killTree). Resolves to { script,
 * prompt, at, ms, outcome ('ok', 'failed' or 'timedOut'), code, stdout,
 * stderr, steps (the lines it wrote to PONJO_TRACE), usage, edited and
 * comments ({ before, after }), the copies at the end when it exited 0,
 * groups (the lines it wrote to PONJO_GROUPS), wake (the lines of the doc
 * it named in PONJO_WAKE), body (why it failed) }.
 */
export async function execute({ task, copies, agent, folder = null, human = null, onChild = () => {}, timeoutMs = RUN_TIMEOUT_MS }) {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-run-'));
  const aside = await mkdtemp(join(tmpdir(), 'ponjo-trace-')); // its trace, out of its sight
  try {
    const copy = join(dir, ...copies.path.split('/'));
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(copy, copies.text);
    const sidecar = copy + SIDECAR_SUFFIX;
    const before = copies.comments ?? `${JSON.stringify({ comments: FORMAT_VERSION })}\n`;
    await writeFile(sidecar, before);
    const { script, settings } = agent;
    const trace = join(aside, 'trace.jsonl');
    const groups = join(aside, 'groups.jsonl');
    const wake = join(aside, 'wake.jsonl');
    const prompt = buildPrompt({ buddy: task.buddy, buddies: task.buddies, docName: copies.path, sidecarName: copies.path + SIDECAR_SUFFIX, threads: task.threads, watch: task.watch, project: Boolean(folder), human });
    const at = Date.now();
    const result = await runScript(script, { cwd: dir, prompt, timeoutMs, env: runEnv({ doc: copy, sidecar, folder, buddy: task.buddy.name, settings, trace, groups, wake }), onChild });
    const steps = await traceLines(trace);
    const ran = { script, prompt, at, ms: Date.now() - at, code: result.code, stdout: result.stdout, stderr: result.stderr, steps, usage: runUsage(steps) };
    if (result.code !== 0) return { ...ran, outcome: result.timedOut ? 'timedOut' : 'failed', body: failure(script, result) };
    const bytes = await readFile(copy).catch(() => null);
    return {
      ...ran,
      outcome: 'ok',
      edited: (bytes && decodeText(bytes)?.text) ?? copies.text, // as text, like the doc
      comments: { before, after: await readFile(sidecar, 'utf8').catch(() => before) },
      groups: (await traceLines(groups)).filter((g) => typeof g === 'object'),
      wake: (await traceLines(wake)).filter((w) => typeof w?.line === 'string').map((w) => w.line),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(aside, { recursive: true, force: true });
  }
}

/**
 * Test of `agent` ({ script, settings }, as `execute` takes it): one
 * run on an empty doc, asked only to answer. Resolves to { ok, ms, out },
 * `out` its reply, or when it failed the end of its output and why.
 */
export async function testAgent({ script, settings }, timeoutMs = TEST_TIMEOUT_MS) {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-test-'));
  try {
    const doc = join(dir, 'test.md');
    await writeFile(doc, '');
    const sidecar = doc + SIDECAR_SUFFIX;
    await writeFile(sidecar, `${JSON.stringify({ comments: FORMAT_VERSION })}\n`);
    const at = Date.now();
    const result = await runScript(script, { cwd: dir, prompt: TEST_PROMPT, timeoutMs, env: runEnv({ doc, sidecar, folder: null, buddy: 'Test', settings }) });
    const ms = Date.now() - at;
    return result.code === 0 ? { ok: true, ms, out: result.stdout.trim() } : { ok: false, ms, out: failure(script, result) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A run's environment (docs/agent-config.md): its copies, the project, the
// buddy, where it may write its trace, its comments' groups of edits and
// the lines that wake it next, and the agent's settings.
const runEnv = ({ doc, sidecar, folder, buddy, settings, trace = '', groups = '', wake = '' }) => ({
  PONJO_DOC: doc,
  PONJO_COMMENTS: sidecar,
  PONJO_PROJECT: folder ?? '',
  PONJO_BUDDY: buddy,
  PONJO_TRACE: trace,
  PONJO_GROUPS: groups,
  PONJO_WAKE: wake,
  ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [`PONJO_SETTING_${key.toUpperCase()}`, String(value ?? '')])),
});

// The lines an agent wrote to a file (its trace, its groups), each parsed, or as text if it is not JSON.
async function traceLines(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return line;
    }
  });
}

// What a failed run says: the end of its output, then the script and why.
function failure(script, result) {
  const why = result.error ?? (result.timedOut ? 'timed out' : `exit code ${result.code}`);
  const tail = lastLines(`${result.stderr}\n${result.stdout}`);
  return `${tail ? `${tail}\n\n` : ''}${script} (${why})`;
}

/**
 * Run `script` in `cwd` with `prompt` on stdin: { code, stdout, stderr,
 * timedOut, error } once it and its output end. `onChild` gets the process.
 */
function runScript(script, { cwd, prompt, env, timeoutMs = RUN_TIMEOUT_MS, onChild = () => {} }) {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    // A .cmd runs only through the shell; its path is quoted for spaces.
    const child = spawn(windows ? `"${script}"` : script, [], {
      cwd,
      env: { ...agentEnv(process.env), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: windows,
      detached: !windows, // its own process group, so killTree reaches its children
      windowsHide: true,
    });
    onChild(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error = null;
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.stdin.on('error', () => {}); // a script may not read its stdin
    child.stdin.end(prompt);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (failure) => {
      error = failure.code === 'ENOENT' ? 'no such agent script' : failure.message;
      if (child.pid === undefined) finish(null);
    });
    child.on('close', (code) => finish(code));
    let over = false;
    function finish(code) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      resolve({ code: error || timedOut ? null : code, stdout, stderr, timedOut, error });
    }
  });
}

/**
 * The environment a script runs in. Inside a Claude Code session its
 * variables would make the agent use that session's auth, so they go.
 */
function agentEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDECODE' || key === 'ANTHROPIC_BASE_URL' || key === 'ELECTRON_RUN_AS_NODE' || /^CLAUDE_(CODE|AGENT_SDK|PID|PREVIEW)/.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/** End `child` and everything it started. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 5000).unref();
}

// The end of a program's output, without terminal colours.
function lastLines(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').trim().split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES).join('\n').slice(-2000);
}
