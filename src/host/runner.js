// The Runner (docs/architecture.md, A run): keeps one run for each ask
// waiting on a buddy, and none for an ask that is gone. An ask whose run
// says it is not done yet (exit WAIT_CODE) stays open, and runs again
// (nextLook): soon after the doc or its comments change, and every few
// minutes until nothing has changed for a while. A run copies the doc and its sidecar
// into a new private folder, runs the agent script there with the prompt on
// stdin, and hands back the copies and the script's stdout when it exits. The agent knows
// nothing of Ponjo. Which runs are working lives only here, in memory; what
// each did goes to `log`, with its trace.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FORMAT_VERSION, newId } from '../core/comments.js';
import { buildPrompt } from '../core/prompt.js';
import { SIDECAR_SUFFIX, decodeText } from '../store/files.js';

const MAX_OUTPUT = 1024 * 1024;
const TAIL_LINES = 20;
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // no one can stop a run by hand: one that hangs fails
const TEST_TIMEOUT_MS = 2 * 60 * 1000;
const TEST_PROMPT = 'Ponjo is testing that you run. Edit no file and reply only: OK';
/** The exit code of a run whose ask is not done yet: EX_TEMPFAIL, "try again later". */
const WAIT_CODE = 75;
// An open ask runs again this long after a change.
const CHANGE_MS = 3000;

/**
 * When an open ask runs again, in ms from `now`: CHANGE_MS after a change
 * (`changed`), else `every` from now while that is no more than `quiet`
 * after the last change (`quietSince`); null once it is, until the next change.
 */
export function nextLook({ changed, quietSince, now, every, quiet }) {
  if (changed) return CHANGE_MS;
  return now + every - quietSince <= quiet ? every : null;
}

const keyOf = (threadId, id) => `${threadId}:${id}`;

export class Runner {
  /**
   * `asks()` resolves to the asks waiting now: [{ threadId, thread, buddy:
   * { id, name, about }, buddies, asker, redo }], `buddies` all those the doc
   * reaches, `asker` the id of whoever asked, `redo` null or, when its turn
   * collided with people's edits and runs once more, what the turn changed
   * and what people did ({ mine, theirs }, each [{ before, after }]). `doc()` to { path, text,
   * comments }, `path` the doc's in the project (`/`-separated; its name in
   * doc mode), where the run's folder holds its copy, and `comments` the
   * sidecar's text or null.
   * `agent()` resolves to the agent that runs every buddy: { script (its
   * path), settings ({ <key>: value }, each handed to the run as
   * PONJO_SETTING_<KEY>) }. `folder()` resolves to the project folder
   * the agent is given, or null, `human()` the user, { name, about },
   * `watch()` how an open ask keeps looking, { every, quiet } in ms (nextLook). `finish(result)` takes a run
   * that ended: { threadId, id, name, asker, base, seen, edited, comments, body, failed },
   * `seen` the `at` of the thread's last comment the run was given,
   * `edited` being the doc's copy at the end (null when the run failed) and
   * `comments` { before, after } the sidecar's copy at the start and end,
   * and resolves, while the doc is open, to what became of it: { reply (its
   * id, or null), landed (in words), waiting (true when it landed and its ask stays open) }.
   * A run that exits WAIT_CODE is finished with `waiting` true and no
   * `body`. `onChange()` runs when a run starts or ends, or an open ask
   * starts, stops or pauses looking. `log(entry, trace)` takes each run that ended: `entry` { run
   * (its id), buddy, thread, reply, at, ms, outcome: ok | waiting | failed | timedOut
   * | stopped, code }, and `trace` what it was given and did: { script,
   * prompt, steps (the lines the agent wrote to PONJO_TRACE), stdout,
   * stderr, base, edited, comments, landed }.
   */
  constructor({ asks, doc, agent, folder = async () => null, human = async () => null, watch, finish, onChange = () => {}, log = async () => {}, timeoutMs = RUN_TIMEOUT_MS }) {
    Object.assign(this, { asks, doc, agent, folder, human, watch, finish, onChange, log, timeoutMs });
    // keyOf(threadId, id) → { runId, threadId, id, name, asker, seen, quietSince,
    // open (its ask was open when it started), changed, waits, child, done, cancelled, ended }
    this.runs = new Map();
    // The open asks between runs: keyOf(threadId, id) → { threadId, id, name,
    // seen (the `at` of the thread's last comment its run was given),
    // quietSince (when the doc or its comments last changed), timer, due, paused }.
    this.waiting = new Map();
    this.stopped = false;
    this.checking = null;
    this.again = false;
  }

  /**
   * The buddies at work or keeping asks open: [{ id, name, threadIds,
   * watching }], the threads each runs on, and the open asks, [{ threadId,
   * paused }], `paused` once nothing changed for a while: two states apart,
   * as an open ask runs now and then.
   */
  statuses() {
    const byId = new Map();
    const of = ({ id, name }) => byId.get(id) ?? byId.set(id, { id, name, threadIds: [], watching: [] }).get(id);
    for (const run of this.runs.values()) {
      of(run).threadIds.push(run.threadId);
      if (run.open) of(run).watching.push({ threadId: run.threadId, paused: false });
    }
    for (const wait of this.waiting.values()) of(wait).watching.push({ threadId: wait.threadId, paused: wait.paused });
    return [...byId.values()];
  }

  /**
   * The doc or its comments changed, by buddy `by` (its id) or by anyone
   * else (null): each open ask of another buddy runs again CHANGE_MS from
   * now, and a run of another buddy that is on now, once it ends.
   */
  changed(by = null) {
    const now = Date.now();
    for (const run of this.runs.values()) if (run.id !== by) Object.assign(run, { changed: true, quietSince: now });
    for (const wait of this.waiting.values()) {
      if (wait.id === by) continue;
      wait.quietSince = now;
      this.#lookAgain(wait, CHANGE_MS);
    }
  }

  // Run open ask `wait` again in `delay`, or once something changes (null).
  #lookAgain(wait, delay) {
    clearTimeout(wait.timer);
    const paused = delay === null;
    const flips = wait.paused !== paused;
    Object.assign(wait, { due: false, paused, timer: null });
    if (!paused) {
      wait.timer = setTimeout(() => {
        wait.due = true;
        this.reconcile();
      }, delay);
      wait.timer.unref?.();
    }
    if (flips) this.onChange();
  }

  #stopWaiting(key) {
    clearTimeout(this.waiting.get(key)?.timer);
    this.waiting.delete(key);
  }

  /**
   * Make the runs the asks the files hold: start a run for each ask without
   * one, end (without an answer) each run whose ask is gone, such as a
   * resolved thread or a deleted buddy. Call on any change of the sidecar,
   * the buddies or the settings.
   */
  reconcile() {
    if (this.stopped) return Promise.resolve();
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.again = false;
        try {
          const asks = await this.asks();
          const wanted = new Set(asks.map((ask) => keyOf(ask.threadId, ask.buddy.id)));
          for (const [key, run] of this.runs) if (!wanted.has(key) && !run.ended) this.#end(run);
          let changes = false;
          for (const key of this.waiting.keys()) {
            if (!wanted.has(key)) {
              this.#stopWaiting(key);
              changes = true;
            }
          }
          for (const ask of asks) {
            const key = keyOf(ask.threadId, ask.buddy.id);
            const wait = this.waiting.get(key);
            const asked = wait && wait.seen !== ask.thread.comments.at(-1).at; // a new comment: a new ask, run now
            if (wait && !wait.due && !asked) continue;
            if (this.runs.has(key) || this.stopped) continue;
            this.#stopWaiting(key);
            this.#start(key, ask, asked ? null : wait);
          }
          if (changes) this.onChange();
        } catch (error) {
          console.error('Could not look for asks:', error);
        }
      } while (this.again && !this.stopped);
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  // End a run without an answer.
  #end(run) {
    run.cancelled = true;
    killTree(run.child);
  }

  /** End every run without an answer (an unanswered ask runs again next time) and start no more. */
  async stop() {
    this.stopped = true;
    for (const key of this.waiting.keys()) this.#stopWaiting(key);
    await this.checking;
    const runs = [...this.runs.values()];
    for (const run of runs) killTree(run.child);
    await Promise.all(runs.map((r) => r.done));
  }

  /** Let runs start again after `stop` (at the next `reconcile`). */
  resume() {
    this.stopped = false;
  }

  // Start a run for `ask`; `wait` is the open ask it runs again, or null.
  #start(key, { threadId, thread, buddy, buddies, asker, redo, mine }, wait) {
    const run = { runId: newId('r'), threadId, id: buddy.id, name: buddy.name, asker, seen: thread.comments.at(-1).at, quietSince: wait?.quietSince ?? Date.now(), open: Boolean(wait), changed: false, waits: false, child: null, done: null, cancelled: false, ended: false };
    this.runs.set(key, run);
    run.done = this.#run(run, thread, buddy, buddies, redo, mine)
      .catch((error) => console.error(`Run of ${buddy.name} failed to finish:`, error))
      .finally(() => {
        this.runs.delete(key);
        if (run.waits && !this.stopped) {
          const open = { threadId, id: buddy.id, name: buddy.name, seen: run.seen, quietSince: run.quietSince, timer: null, due: false, paused: false };
          this.waiting.set(key, open);
          this.#lookAgain(open, nextLook({ ...run.watch, changed: run.changed, quietSince: run.quietSince, now: Date.now() }));
        }
        this.onChange();
        this.reconcile(); // asked again meanwhile, or another ask waits
      });
    this.onChange();
  }

  async #run(run, thread, buddy, buddies, redo, mine) {
    const { path: docPath, text: base, comments } = await this.doc();
    const dir = await mkdtemp(join(tmpdir(), 'ponjo-run-'));
    let aside = null; // the folder its trace is in, out of its sight
    try {
      const copy = join(dir, ...docPath.split('/'));
      await mkdir(dirname(copy), { recursive: true });
      await writeFile(copy, base);
      const sidecar = copy + SIDECAR_SUFFIX;
      const before = comments ?? `${JSON.stringify({ comments: FORMAT_VERSION })}\n`;
      await writeFile(sidecar, before);
      const { script, settings } = await this.agent();
      const folder = await this.folder();
      aside = await mkdtemp(join(tmpdir(), 'ponjo-trace-'));
      const steps = join(aside, 'trace.jsonl');
      const prompt = buildPrompt({ buddy, buddies, docName: docPath, sidecarName: docPath + SIDECAR_SUFFIX, thread, project: Boolean(folder), human: await this.human(), redo, mine });
      const at = Date.now();
      const result = await runScript(script, { cwd: dir, prompt, timeoutMs: this.timeoutMs, env: runEnv({ doc: copy, sidecar, folder, thread: thread.id, buddy: buddy.name, settings, trace: steps }), onChild: (child) => {
        run.child = child;
        if (run.cancelled) killTree(child);
      } });
      const stopped = this.stopped || run.cancelled;
      const waits = result.code === WAIT_CODE;
      const outcome = stopped ? 'stopped' : result.timedOut ? 'timedOut' : result.code === 0 ? 'ok' : waits ? 'waiting' : 'failed';
      run.ended = true; // its reply is on its way: its ask going away is that reply
      const ms = Date.now() - at;
      const trace = { script, prompt, steps: await traceLines(steps), stdout: result.stdout, stderr: result.stderr, base, edited: null, comments: null, landed: 'Ended without an answer' };
      let answered = null; // what finish made of it
      try {
        if (stopped) return; // ended by stop or cancel: no answer
        const out = { threadId: run.threadId, id: buddy.id, name: buddy.name, asker: run.asker, base, seen: thread.comments.at(-1).at };
        if (result.code === 0 || waits) {
          const bytes = await readFile(copy).catch(() => null);
          trace.edited = (bytes && decodeText(bytes)?.text) ?? base; // as text, like the doc
          trace.comments = { before, after: await readFile(sidecar, 'utf8').catch(() => before) };
          answered = await this.finish({ ...out, edited: trace.edited, comments: trace.comments, body: waits ? null : result.stdout.trim(), failed: false, waiting: waits });
          run.waits = Boolean(answered?.waiting);
          if (run.waits) run.watch = await this.watch();
        } else {
          answered = await this.finish({ ...out, edited: null, body: failure(script, result), failed: true });
        }
      } finally {
        if (answered) trace.landed = answered.landed;
        await this.log({ run: run.runId, buddy: buddy.name, thread: run.threadId, reply: answered?.reply ?? null, at: new Date(at).toISOString(), ms, outcome, code: result.code }, trace);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (aside) await rm(aside, { recursive: true, force: true });
    }
  }
}

/**
 * Test of `agent` ({ script, settings }, as Runner's `agent()` gives it): one
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
// thread it answers, the buddy, where it may write its trace and the agent's settings.
const runEnv = ({ doc, sidecar, folder, thread = '', buddy, settings, trace = '' }) => ({
  PONJO_DOC: doc,
  PONJO_COMMENTS: sidecar,
  PONJO_PROJECT: folder ?? '',
  PONJO_THREAD: thread,
  PONJO_BUDDY: buddy,
  PONJO_TRACE: trace,
  ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [`PONJO_SETTING_${key.toUpperCase()}`, String(value ?? '')])),
});

// The lines an agent wrote to its trace, each parsed, or as text if it is not JSON.
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
function killTree(child) {
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
