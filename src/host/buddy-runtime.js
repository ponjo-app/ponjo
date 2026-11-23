// The agent runtime of one open doc (docs/runtime/README.md): the loop
// (src/core/runtime.js) on this machine. What only the doc host can do is
// here: a run is the agent program once on its view (execute, runner.js),
// what the loop does and why is written to this machine's agent log
// (logLoop) and its runs' log (logRun), and the windows hear the buddies'
// statuses with their asks as threads. Nothing of it is written to a shared file.

import { basename } from 'node:path';
import { createRuntime } from '../core/runtime.js';
import { pickedAgent } from '../store/agents.js';
import { noteWatching, readWatching } from '../store/history.js';
import { logLoop, logRun } from '../store/runs.js';
import { readSettings } from '../store/settings.js';
import { DocError } from './door.js';
import { execute, killTree, testAgent } from './runner.js';

// A time as the agent log writes it, on this machine's clock: 2026-11-18 21:40:12.203.
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;

// What the doc host keeps of what its runtime did, for the owner's runtime
// panel (web/runtime-panel.js): the newest events, each when it came, a
// run's end without the world's content (its view, what it made): what
// it was given and did is its trace's.
const RECENT = 500;
const kept = (event) => (event.type !== 'run.end' ? event : {
  type: event.type, run: event.run,
  task: { agent: { id: event.task.agent.id, name: event.task.agent.name }, asks: event.task.asks.map(({ id, from, at }) => ({ id, from, at })), depth: event.task.depth },
  result: { at: event.result.at, ms: event.result.ms, outcome: event.result.outcome, code: event.result.code, usage: event.result.usage, body: event.result.body },
  answered: event.answered && { landed: event.answered.landed, comments: event.answered.comments },
});

// The agent log's lines for each event the runtime traces but a run's end
// (runtime.js, Event): names, revs and ids, never the world's content.
const LINES = {
  look({ why, verdicts }) {
    const width = Math.max(...verdicts.map((v) => v.name.length));
    return [`look · ${why || 'asked to'}`, ...verdicts.map((v) => `${v.name.padEnd(width)}  ${v.reason}${v.run ? ` · started ${v.run}` : ''}`)];
  },
  'look.failed': ({ error, againMs }) => [`look failed: ${error}; again in ${againMs / 1000} s`],
  'watches.paused': ({ runs, within }) => [`watches paused: ${runs} runs in ${within} min`],
};

// The runtime's statuses as the windows read them: a buddy at work and the
// threads it was given. A failed ask is answered in its thread (doc-world.js, failed).
const forWindows = (statuses) => statuses.map(({ asks, failed, ...s }) => ({ ...s, state: asks.length ? 'running' : 'ready', threadIds: asks }));

/**
 * The buddies' statuses as someone at `level` sees them: why a watch run
 * failed is the owner's machine's, so only the owner hears it.
 */
export function agentsFor(level, agents) {
  if (level === 'owner') return agents;
  return agents.map((a) => ({ ...a, watchFailed: a.watchFailed && { at: a.watchFailed.at } }));
}

/**
 * The buddies of one open doc. `world` is the doc's (doc-world.js), the
 * five calls it reaches the doc by; `docPath()` names the doc in the logs
 * and notes. `emit` tells every window (`agents`, `watches`). `timeoutMs`
 * ends a run that hangs.
 */
export async function createBuddyRuntime({ world, docPath, settingsDir, secrets, emit, timeoutMs }) {
  // Lines for the agent log, one write after another, each the time and the
  // doc, then what happened: names, revs and thread ids, never the doc's text.
  let logged = Promise.resolve();
  function tell(...lines) {
    const head = `${stamp(new Date())}  ${basename(docPath())}  `;
    const text = lines.map((line, i) => (i ? `  ${line}` : head + line)).join('\n');
    logged = logged.then(() => logLoop(settingsDir, `${text}\n`));
  }

  // The runtime's newest events, each told to the owner's windows (`runtime`)
  // as it comes: a run's end once its trace is written, for the panel to read.
  const recent = [];
  function keep(event) {
    const shown = { at: Date.now(), ...kept(event) };
    recent.push(shown);
    if (recent.length > RECENT) recent.shift();
    emit('runtime', shown);
  }

  const runtime = await createRuntime({
    world,
    emit: (type, payload) => emit(type, type === 'agents' ? forWindows(payload) : payload),
    async trace(event) {
      if (event.type === 'run.end') await ended(event);
      else tell(...LINES[event.type](event));
      keep(event);
    },
    breaker: async () => (await readSettings(settingsDir)).settings,
    watching: {
      read: () => readWatching(docPath(), settingsDir),
      note: (noted) => noteWatching(docPath(), settingsDir, noted).catch((error) => console.error('Could not note the buddies watching:', error)),
    },
    async run(task, view, signal) {
      const { settings } = await readSettings(settingsDir);
      const result = await execute({
        buddy: task.agent, files: view.files, prompt: view.prompt, timeoutMs,
        agent: await pickedAgent(settings, secrets()[settings.agent], settingsDir),
        onChild: (child) => {
          if (signal.aborted) killTree(child);
          else signal.addEventListener('abort', () => killTree(child));
        },
      });
      return { ...result, made: { text: result.edited, comments: result.comments, groups: result.groups, actions: result.actions, output: result.stdout } };
    },
  });

  // A run's end in the agent log, and its line and trace in the runs' log.
  async function ended({ run: id, task, view, result, answered }) {
    const trace = { script: result.script, prompt: result.prompt, steps: result.steps ?? [], stdout: result.stdout ?? '', stderr: result.stderr ?? '', base: view?.files.text ?? null, edited: result.edited ?? null, comments: result.comments ?? null, landed: answered?.landed ?? 'Ended without an answer' };
    const why = result.outcome === 'ok' || result.outcome === 'stopped' ? '' : `: ${String(result.body ?? '').split('\n')[0].slice(0, 200)}`;
    tell(`run ${id} of ${task.agent.name} ended: ${result.outcome}${why} in ${(result.ms / 1000).toFixed(1)} s · ${trace.landed}, ${answered?.comments?.length ?? 0} comments`);
    await logRun(settingsDir, { doc: docPath(), run: id, buddy: task.agent.name, threads: task.asks.map((a) => a.id), ...(task.watch ? { watched: true } : {}), comments: answered?.comments ?? [], at: new Date(result.at).toISOString(), ms: result.ms, outcome: result.outcome, code: result.code, ...(result.usage ? { usage: result.usage } : {}) }, trace);
  }

  return {
    look: runtime.look,
    sync: runtime.sync,
    /** The agent, its settings or its secrets changed: a failed watch runs again. */
    agentChanged: () => runtime.retry(),
    statuses: () => forWindows(runtime.statuses()),
    /** What the runtime did lately (keep): its newest events, oldest first. */
    recent: () => [...recent],
    watches: runtime.watches,
    running: runtime.running,
    testAgent: async () => {
      const { settings } = await readSettings(settingsDir);
      return testAgent(await pickedAgent(settings, secrets()[settings.agent], settingsDir));
    },
    calls: {
      // Buddy `buddy` watches the doc (`on`), or no longer, as `who` says.
      async watch({ buddy, on } = {}, who) {
        if (typeof buddy !== 'string' || typeof on !== 'boolean') throw new DocError('bad_input', 'expected { buddy, on }');
        if (!(await world.members()).some((b) => b.kind === 'agent' && b.id === buddy)) throw new DocError('not_found', 'no such buddy here');
        runtime.watch(buddy, on, who.id);
        return {};
      },
      resume: () => {
        runtime.resume();
        return {};
      },
      // Buddy `buddy`'s failed watch runs again.
      retry: (body) => {
        if (typeof body?.buddy !== 'string') throw new DocError('bad_input', 'expected { buddy }');
        runtime.retry(body.buddy);
        return {};
      },
    },
    /** End every run without an answer (an open ask runs again next time) and start no more. */
    async close() {
      await runtime.close();
      await logged;
    },
  };
}
