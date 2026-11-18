// The Runner (docs/host-spec.md, Buddies): runs each buddy that
// a comment asks and it has not answered yet, or that watches the doc,
// one run at a time, and ends the run of a buddy nothing asks any more. It
// looks at the asks each time they may have changed (reconcile): a
// comment, the doc opening, a run ending, a watch turned on, people's
// edits pausing or another buddy's edit while a buddy watches; never on a
// clock, but for a step its watchers wait for. A run
// copies the doc and its sidecar into a new private folder, runs the agent
// script there with the prompt on stdin, and hands back the copies and the
// comments' groups of edits when it exits. The agent knows nothing of
// Ponjo. Which runs are working lives only here, in memory; what each did
// goes to `log`, with its trace.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FORMAT_VERSION, newId } from '../core/comments.js';
import { buildPrompt } from '../core/prompt.js';
import { runUsage } from '../core/usage.js';
import { SIDECAR_SUFFIX, decodeText } from '../store/files.js';

const MAX_OUTPUT = 1024 * 1024;
const TAIL_LINES = 20;
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // no one can stop a run by hand: one that hangs fails
const TEST_TIMEOUT_MS = 2 * 60 * 1000;
const TEST_PROMPT = 'Ponjo is testing that you run. Edit no file and reply only: OK';
// A look that could not read the asks (a sidecar locked or unreadable, a
// buddy file gone as it was read) is tried again this long after, twice as
// long each time, up to LOOK_AGAIN_MAX_MS: no event may come to try it.
const LOOK_AGAIN_MS = 1000;
const LOOK_AGAIN_MAX_MS = 30_000;

export class Runner {
  /**
   * `asks()` resolves to the buddies asked now, each with its inbox: [{
   * buddy: { id, name, about }, buddies, threads, askers, watch, due,
   * watchOnly, pay? }], `buddies` all those the doc reaches, `threads` those
   * that ask it and it has not answered (and its watch thread), `askers` the
   * ids of whoever asked, `watch` null or, when it watches the doc, { thread
   * (its watch thread's id, or null), changes (what changed since it last
   * looked, or null) }, `due` whether to run it now (a buddy watching the
   * doc is in, so its run on now goes on, though not due), `watchOnly`
   * whether only its watch has it run (interrupt ends such a run), and
   * `pay`, for a run another buddy's change wakes, to take a step for it:
   * false when none is left, and it does not start. `doc()` to { path,
   * text, comments }, `path` the doc's in the project (`/`-separated; its
   * name in doc mode), where the run's folder holds its copy, and `comments`
   * the sidecar's text or null. `agent()` resolves to the agent that runs
   * every buddy: { script (its path), settings ({ <key>: value }, each
   * handed to the run as PONJO_SETTING_<KEY>) }. `folder()` resolves to the
   * project folder the agent is given, or null, and `human()` the user, {
   * name, about }. `finish(result)` takes a run that ended: { id, name,
   * threadIds, askers, seen, from, watched, base, edited, comments, groups,
   * failed, body }, `seen` the `at` of each of its threads' last comment it
   * was given, by thread, `from` when it started (performance.now(), a
   * clock that never goes back), `watched` whether it watched the doc,
   * `edited` the doc's copy at the end (null when the run failed),
   * `comments` { before, after } the sidecar's copy at the start and end,
   * `groups` the lines it wrote to PONJO_GROUPS, parsed, and `body` why a
   * failed run failed; it resolves, while the doc is open, to what became
   * of it: { comments (the ids it posted), landed (in words) }. `onChange()`
   * runs when a run starts or ends. `log(entry, trace)` takes each run that
   * ended: `entry` { run (its id), buddy, threads, watched? (true for a
   * watcher's), comments, at, ms, outcome: ok | failed | timedOut |
   * stopped, code, usage? (runUsage: its Claude API tokens, when its agent
   * wrote them to its trace) }, and `trace` what it was given and did: {
   * script, prompt, steps (the lines the agent wrote to PONJO_TRACE),
   * stdout, stderr, base, edited, comments, landed }.
   */
  constructor({ asks, doc, agent, folder = async () => null, human = async () => null, finish, onChange = () => {}, log = async () => {}, timeoutMs = RUN_TIMEOUT_MS }) {
    Object.assign(this, { asks, doc, agent, folder, human, finish, onChange, log, timeoutMs });
    // buddy id → { runId, id, name, threadIds, askers, watch, watchOnly, out, child, done, cancelled, ended, answered, over }.
    // A run that is `over` stays until the next look into the asks, so a
    // look that read them before its answer was posted does not run it again.
    this.runs = new Map();
    this.stopped = false;
    this.checking = null;
    this.again = false;
    this.lookAgain = { ms: LOOK_AGAIN_MS, timer: null }; // after a look that could not read the asks
  }

  /** The buddies at work: [{ id, name, threadIds }]. */
  statuses() {
    return [...this.runs.values()].filter((run) => !run.over).map(({ id, name, threadIds }) => ({ id, name, threadIds }));
  }

  /**
   * Make the runs the asks the files hold: end (without an answer) the run
   * of each buddy no comment asks any more, such as one whose threads were
   * resolved, or a deleted buddy, and start a run for each buddy asked
   * without one. Call on any change of the sidecar, the buddies, the
   * settings or who may ask. One look at a time: one asked for meanwhile
   * follows it. One that could not read the asks is tried again, later
   * each time (LOOK_AGAIN_MS), until one can.
   */
  reconcile() {
    if (this.stopped) return Promise.resolve();
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      let read;
      do {
        this.again = false;
        for (const [id, run] of this.runs) if (run.over) this.runs.delete(id);
        try {
          const asked = await this.asks();
          read = true;
          const wanted = new Set(asked.map((inbox) => inbox.buddy.id));
          for (const [id, run] of this.runs) if (!wanted.has(id) && !run.ended) this.#end(run);
          for (const inbox of asked) {
            if (inbox.due === false || this.runs.has(inbox.buddy.id) || this.stopped) continue;
            if (inbox.pay && !inbox.pay()) continue; // woken by another buddy, with no step left
            this.#start(inbox);
          }
        } catch (error) {
          read = false;
          console.error('Could not look for asks:', error);
        }
      } while (this.again && !this.stopped);
      clearTimeout(this.lookAgain.timer);
      if (read || this.stopped) {
        this.lookAgain.ms = LOOK_AGAIN_MS;
        return;
      }
      this.lookAgain.timer = setTimeout(() => this.reconcile(), this.lookAgain.ms);
      this.lookAgain.timer.unref?.();
      this.lookAgain.ms = Math.min(this.lookAgain.ms * 2, LOOK_AGAIN_MAX_MS);
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  // End a run without an answer.
  #end(run) {
    run.cancelled = true;
    killTree(run.child);
  }

  /**
   * People are editing again: end each run its watch alone started, with no
   * answer. It saw the doc as it was; it runs again once they pause.
   * Returns those ended, [{ id, from }], `from` when each started.
   */
  interrupt() {
    const ended = [...this.runs.values()].filter((run) => run.watchOnly && !run.ended && !run.over && !run.cancelled);
    for (const run of ended) this.#end(run);
    return ended.map((run) => ({ id: run.id, from: run.out.from }));
  }

  /** End every run without an answer (an open ask runs again next time) and start no more. */
  async stop() {
    this.stopped = true;
    await this.checking;
    clearTimeout(this.lookAgain.timer);
    const runs = [...this.runs.values()];
    for (const run of runs) killTree(run.child);
    await Promise.all(runs.map((r) => r.done));
  }

  /** Let runs start again after `stop`. */
  resume() {
    this.stopped = false;
    return this.reconcile();
  }

  #start({ buddy, buddies, threads, askers, watch = null, watchOnly = false }) {
    const run = { runId: newId('r'), id: buddy.id, name: buddy.name, threadIds: threads.map((t) => t.id), askers, child: null, done: null, cancelled: false, ended: false, answered: false, over: false };
    // What `finish` is told of it, whatever became of it.
    const seen = Object.fromEntries(threads.map((t) => [t.id, t.comments.at(-1).at]));
    run.out = { id: buddy.id, name: buddy.name, threadIds: run.threadIds, askers, seen, from: performance.now(), watched: Boolean(watch) };
    run.watch = watch;
    run.watchOnly = watchOnly;
    this.runs.set(buddy.id, run);
    run.done = this.#run(run, threads, buddy, buddies)
      .catch(async (error) => {
        console.error(`Run of ${buddy.name} failed to finish:`, error);
        // One that could not run, or whose end could not be taken, failed
        // too: not run again until it is asked again.
        if (run.answered || this.stopped || run.cancelled) return;
        await this.finish({ ...run.out, base: null, edited: null, failed: true, body: `Ponjo could not run ${buddy.name}: ${error.message}` })
          .catch((again) => console.error(`Run of ${buddy.name} failed to finish:`, again));
      })
      .finally(() => {
        run.over = true;
        this.onChange();
        this.reconcile(); // what was asked while it ran
      });
    this.onChange();
  }

  async #run(run, threads, buddy, buddies) {
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
      const groups = join(aside, 'groups.jsonl');
      const prompt = buildPrompt({ buddy, buddies, docName: docPath, sidecarName: docPath + SIDECAR_SUFFIX, threads, watch: run.watch, project: Boolean(folder), human: await this.human() });
      const at = Date.now();
      const result = await runScript(script, { cwd: dir, prompt, timeoutMs: this.timeoutMs, env: runEnv({ doc: copy, sidecar, folder, buddy: buddy.name, settings, trace: steps, groups }), onChild: (child) => {
        run.child = child;
        if (run.cancelled) killTree(child);
      } });
      const stopped = this.stopped || run.cancelled;
      const outcome = stopped ? 'stopped' : result.timedOut ? 'timedOut' : result.code === 0 ? 'ok' : 'failed';
      run.ended = true; // its comments are on their way
      const ms = Date.now() - at;
      const trace = { script, prompt, steps: await traceLines(steps), stdout: result.stdout, stderr: result.stderr, base, edited: null, comments: null, landed: 'Ended without an answer' };
      const usage = runUsage(trace.steps); // its Claude API tokens, when its agent said
      let answered = null; // what finish made of it
      try {
        if (stopped) return; // ended by stop or cancel: no answer
        const out = { ...run.out, base };
        if (result.code === 0) {
          const bytes = await readFile(copy).catch(() => null);
          trace.edited = (bytes && decodeText(bytes)?.text) ?? base; // as text, like the doc
          trace.comments = { before, after: await readFile(sidecar, 'utf8').catch(() => before) };
          answered = await this.finish({ ...out, edited: trace.edited, comments: trace.comments, groups: (await traceLines(groups)).filter((g) => typeof g === 'object'), failed: false });
        } else {
          answered = await this.finish({ ...out, edited: null, body: failure(script, result), failed: true });
        }
        run.answered = true;
      } finally {
        if (answered) trace.landed = answered.landed;
        await this.log({ run: run.runId, buddy: buddy.name, threads: run.threadIds, ...(run.watch ? { watched: true } : {}), comments: answered?.comments ?? [], at: new Date(at).toISOString(), ms, outcome, code: result.code, ...(usage ? { usage } : {}) }, trace);
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
// buddy, where it may write its trace and its comments' groups of edits,
// and the agent's settings.
const runEnv = ({ doc, sidecar, folder, buddy, settings, trace = '', groups = '' }) => ({
  PONJO_DOC: doc,
  PONJO_COMMENTS: sidecar,
  PONJO_PROJECT: folder ?? '',
  PONJO_BUDDY: buddy,
  PONJO_TRACE: trace,
  PONJO_GROUPS: groups,
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
