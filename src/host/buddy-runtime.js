// The buddies of one open doc (docs/runtime/README.md, Controllers): a
// controller per buddy (src/core/controller.js) on the doc's store, and the
// clock's, which settles people's typing. What only the doc host can do is
// here: a buddy's program is its agent once on its view (execute,
// runner.js), the wallet's limits are the owner's settings, what each
// controller does and why is written to this machine's agent log and its
// runs' log, and the windows hear the buddies' statuses with their asks as
// threads. Nothing of it is written to a shared file.

import { basename } from 'node:path';
import { newId, serializeSidecar, threadsOf } from '../core/comments.js';
import { clock, control, limits } from '../core/controller.js';
import { CLOCK } from '../core/doc-world.js';
import { buildPrompt, newSince } from '../core/prompt.js';
import { listActions } from '../store/actions.js';
import { pickedAgent } from '../store/agents.js';
import { SIDECAR_SUFFIX } from '../store/files.js';
import { logLoop, logRun } from '../store/runs.js';
import { readSettings, settingsWithId } from '../store/settings.js';
import { DocError } from './door.js';
import { execute, killTree, testAgent } from './runner.js';

/** How deep buddies may wake each other: high, so two buddies can play a long game. */
const DEPTH_LIMIT = 1000;

// A time as the agent log writes it, on this machine's clock: 2026-11-18 21:40:12.203.
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;

// What the doc host keeps of what its controllers did, for the owner's
// runtime panel (web/runtime-panel.js): the newest events, each when it
// came, a run's end without the world's content (its view, what it made):
// what it was given and did is its trace's.
const RECENT = 500;
const kept = (event) => (event.type !== 'run.end' ? event : {
  type: event.type, run: event.run,
  task: { agent: { id: event.task.agent.id, name: event.task.agent.name }, asks: event.task.asks.map(({ id, from, at }) => ({ id, from, at })), depth: event.task.depth },
  result: { at: event.result.at, ms: event.result.ms, outcome: event.result.outcome, code: event.result.code, usage: event.result.usage, body: event.result.body },
  answered: event.answered && { landed: event.answered.landed, comments: event.answered.comments },
});

// The agent log's lines for each event but a run's end: names, revs and
// ids, never the world's content. A look is what a buddy's controller did
// once its view changed: a run started, stopped, or not started.
const LINES = {
  look({ why, verdicts }) {
    const width = Math.max(...verdicts.map((v) => v.name.length));
    return [`look · ${why}`, ...verdicts.map((v) => `${v.name.padEnd(width)}  ${v.reason}${v.run ? ` · started ${v.run}` : ''}`)];
  },
  'watches.paused': ({ runs, within }) => [`watches paused: ${runs} runs in ${within} min`],
};

/**
 * The buddies' statuses as someone at `level` sees them: why a watch run
 * failed is the owner's machine's, so only the owner hears it.
 */
export function agentsFor(level, agents) {
  if (level === 'owner') return agents;
  return agents.map((a) => ({ ...a, watchFailed: a.watchFailed && { at: a.watchFailed.at } }));
}

/**
 * The buddies of the doc whose store is `store` (doc-store.js). `place()`
 * is { docPath, folder, room } as they are now, `pathInProject()` the doc's
 * path in its project, `buddies()` the buddies it reaches and `me()` the
 * owner. `emit` tells every window (`agents`, `watches`, `runtime`).
 * `timeoutMs` ends a run that hangs.
 */
export async function createBuddyRuntime({ store, place, pathInProject, buddies, me, settingsDir, secrets, emit, timeoutMs }) {
  const docPath = () => place().docPath;
  // Lines for the agent log, one write after another, each the time and the
  // doc, then what happened: names, revs and thread ids, never the doc's text.
  let logged = Promise.resolve();
  function tell(...lines) {
    const head = `${stamp(new Date())}  ${basename(docPath())}  `;
    const text = lines.map((line, i) => (i ? `  ${line}` : head + line)).join('\n');
    logged = logged.then(() => logLoop(settingsDir, `${text}\n`));
  }
  // The newest events, each told to the owner's windows (`runtime`) as it
  // comes: a run's end once its trace is written, for the panel to read.
  const recent = [];
  async function trace(event) {
    if (event.type === 'run.end') await ended(event);
    else tell(...LINES[event.type](event));
    const shown = { at: Date.now(), ...kept(event) };
    recent.push(shown);
    if (recent.length > RECENT) recent.shift();
    emit('runtime', shown);
  }
  const look = (buddy, reason, run = null) => trace({ type: 'look', why: store.why(), verdicts: [{ agent: buddy.id, name: buddy.name, reason, run }] });

  // ---- the wallet: the owner's limits, on every buddy of the doc ----

  let breaker = null; // { pauseAfter, pauseWithin } the limits were made with
  let limit = null;
  let paused = false;
  // Whether the watches are paused changed: every window is told, and the agent log.
  function pausedNow() {
    if (limit.paused() === paused) return;
    paused = !paused;
    if (paused) trace({ type: 'watches.paused', runs: breaker.pauseAfter, within: breaker.pauseWithin });
    emit('watches', { paused });
  }
  async function readBreaker() {
    const { pauseAfter, pauseWithin } = (await readSettings(settingsDir)).settings;
    if (breaker?.pauseAfter === pauseAfter && breaker?.pauseWithin === pauseWithin) return;
    breaker = { pauseAfter, pauseWithin };
    limit = limits({ depth: DEPTH_LIMIT, runs: pauseAfter, within: pauseWithin * 60_000 });
    pausedNow();
  }
  const wallet = { allow: (tasks) => limit.allow(tasks), charge: (tasks) => limit.charge(tasks) };
  await readBreaker();

  // ---- the buddies' runs ----

  let shown = []; // the buddies here, as the windows were last told of them
  const buddyOf = (id) => shown.find((b) => b.id === id);
  const runs = new Map(); // buddy → its run going: { id, tasks, files, prompt, result, returned, stopped, committing, ended }
  const lastLook = new Map(); // a watcher → { text, heard } of its last run that went well: what is new since
  const watchFailed = new Map(); // a watcher → { at, why } of its last run, if that failed

  // Buddy `id`'s program: its agent once on its view, the copies its view
  // holds and its prompt; resolves to its answer's body, or null when
  // stopped, and throws when it failed (its why).
  const program = (id) => async (tasks, view, signal) => {
    const buddy = buddyOf(id);
    const run = { id: newId('r'), tasks, returned: false, stopped: false, committing: false, ended: false };
    runs.set(id, run);
    const depth = Math.min(...tasks.map((t) => t.depth));
    look(buddy, `due: ${tasks.map((t) => t.why).join(', ')}${depth ? ` · depth ${depth}` : ''}`, run.id);
    pausedNow(); // the limits counted it
    signal.addEventListener('abort', () => {
      if (run.committing || run.ended) return;
      run.stopped = true;
      look(buddy, closing ? 'stopped: the doc closed' : 'stopped: none of its tasks is due');
      broadcast();
      if (run.returned) end(buddy, run, { ...run.result, outcome: 'stopped' }, null);
    });
    broadcast();
    let result;
    try {
      const { folder } = place();
      const { text, lines, watch } = view.content;
      run.files = { path: folder ? await pathInProject() : basename(docPath()), text, comments: serializeSidecar(lines), project: folder };
      const all = await buddies();
      const threads = threadsOf(lines.map((l) => l.comment).filter(Boolean), all.map((b) => ({ id: b.id, name: b.name })), text);
      const given = new Set(tasks.filter((t) => t.kind === 'ask').map((t) => t.thread));
      const since = lastLook.get(id);
      run.prompt = buildPrompt({
        buddy, buddies: all, docName: run.files.path, sidecarName: run.files.path + SIDECAR_SUFFIX, project: Boolean(folder),
        threads: threads.filter((t) => given.has(t.id)),
        watch: watch ? newSince({ agent: id, base: since?.text ?? null, heard: since?.heard ?? null, text, threads }) : null,
        human: { name: (await me()).name, about: (await settingsWithId(settingsDir)).about.trim() },
        actions: await listActions(settingsDir),
      });
      const { settings } = await readSettings(settingsDir);
      result = await execute({
        buddy, files: run.files, prompt: run.prompt, timeoutMs,
        agent: await pickedAgent(settings, secrets()[settings.agent], settingsDir),
        onChild: (child) => {
          if (signal.aborted) killTree(child);
          else signal.addEventListener('abort', () => killTree(child));
        },
      });
    } catch (error) {
      console.error(`Run of ${buddy.name} failed to start:`, error);
      result = { at: Date.now(), ms: 0, outcome: 'failed', code: null, body: `Ponjo could not run ${buddy.name}: ${error.message}` };
    }
    run.result = result;
    run.returned = true;
    if (signal.aborted) {
      await end(buddy, run, { ...result, outcome: 'stopped' }, null);
      return null;
    }
    if (view.content.watch) {
      if (result.outcome === 'ok') watchFailed.delete(id);
      else watchFailed.set(id, { at: new Date().toISOString(), why: result.body });
    }
    if (result.outcome !== 'ok') throw new Error(result.body);
    if (view.content.watch) lastLook.set(id, { text: run.files.text, heard: new Set(view.content.lines.map((l) => l.comment?.id).filter(Boolean)) });
    const made = { text: result.edited, comments: result.comments, groups: result.groups, actions: result.actions, output: result.stdout, wake: result.wake };
    return { body: { base: run.files.text, made, tasks } };
  };

  // Buddy `id`'s client of the store, as its controller commits: a failed
  // run's answer is a body too, so that the doc answers its asks; a run's
  // end is written once what it came to is known.
  function clientOf(id) {
    const client = store.client(id);
    return {
      read: client.read,
      wait: client.wait,
      async commit({ as, answers, failed, body }) {
        const buddy = buddyOf(id) ?? { id, name: id };
        const run = runs.get(id);
        if (run) run.committing = true;
        else look(buddy, `not started: ${limit.paused() ? 'the watches are paused' : `past the depth limit (${DEPTH_LIMIT})`}`);
        const out = await client.commit({ as, answers, body: failed !== undefined ? { failed, base: run?.files?.text, tasks: run?.tasks } : body });
        if (run) await end(buddy, run, run.result, out);
        return out;
      },
    };
  }

  // A run's end: no longer going, in the agent log, and its line and trace in the runs' log.
  function end(buddy, run, result, answered) {
    if (run.ended) return undefined;
    run.ended = true;
    if (runs.get(buddy.id) === run) runs.delete(buddy.id);
    broadcast();
    const task = {
      agent: buddy, asks: run.tasks.filter((t) => t.kind === 'ask').map((t) => ({ id: t.thread, from: t.from.join(', '), at: t.at })),
      depth: Math.min(...run.tasks.map((t) => t.depth)), watch: run.tasks.some((t) => t.kind === 'watch'),
    };
    return trace({ type: 'run.end', run: run.id, task, view: run.files && { files: run.files, prompt: run.prompt }, result, answered });
  }
  async function ended({ run: id, task, view, result, answered }) {
    const trace = { script: result.script, prompt: result.prompt, steps: result.steps ?? [], stdout: result.stdout ?? '', stderr: result.stderr ?? '', base: view?.files.text ?? null, edited: result.edited ?? null, comments: result.comments ?? null, landed: answered?.landed ?? 'Ended without an answer' };
    const why = result.outcome === 'ok' || result.outcome === 'stopped' ? '' : `: ${String(result.body ?? '').split('\n')[0].slice(0, 200)}`;
    tell(`run ${id} of ${task.agent.name} ended: ${result.outcome}${why} in ${(result.ms / 1000).toFixed(1)} s · ${trace.landed}, ${answered?.comments?.length ?? 0} comments`);
    await logRun(settingsDir, { doc: docPath(), run: id, buddy: task.agent.name, threads: task.asks.map((a) => a.id), ...(task.watch ? { watched: true } : {}), comments: answered?.comments ?? [], at: new Date(result.at).toISOString(), ms: result.ms, outcome: result.outcome, code: result.code, ...(result.usage ? { usage: result.usage } : {}) }, trace);
  }

  // ---- the controllers ----

  const controllers = new Map(); // buddy → its controller
  const timer = control(store.client(CLOCK), clock());
  let closing = false;

  // Who is here changed (the buddies' files, the room, the owner): the store
  // is told, and each buddy here has a controller, a buddy gone none.
  async function sync() {
    const [all, owner] = await Promise.all([buddies(), me()]);
    shown = all;
    store.members({ owner: { id: owner.id, name: owner.name }, people: (place().room?.list()?.teammates ?? []).map(({ id, name, level }) => ({ id, name, level })), buddies: all.map(({ id, name, about }) => ({ id, name, about })) });
    for (const [id, c] of controllers) {
      if (all.some((b) => b.id === id)) continue;
      controllers.delete(id);
      await c.stop();
    }
    for (const b of all) if (!controllers.has(b.id)) controllers.set(b.id, control(clientOf(b.id), { program: program(b.id), wallet }));
    broadcast();
  }

  // ---- what the windows are told ----

  // The buddies here, each with whether it runs and the threads its run was
  // given, whether it watches the doc, and whether its last watch run failed.
  function statuses() {
    const watching = new Set(store.watching());
    return shown.map((b) => {
      const run = runs.get(b.id);
      const going = Boolean(run && !run.stopped);
      return { ...b, state: going ? 'running' : 'ready', threadIds: going ? run.tasks.filter((t) => t.kind === 'ask').map((t) => t.thread) : [], watching: watching.has(b.id), watchFailed: watchFailed.get(b.id) ?? null };
    });
  }
  const broadcast = () => emit('agents', statuses());

  // A person's change to the watches, as `who`.
  async function change(who, body) {
    const out = await store.client(who.id).commit({ body });
    broadcast();
    return out;
  }

  return {
    sync,
    /** A person acted: the limits count the runs afresh. */
    acted() {
      limit.acted();
      pausedNow();
    },
    /** The agent, its settings or its secrets changed: a failed watch runs again. */
    async agentChanged() {
      const failed = [...watchFailed.keys()];
      watchFailed.clear();
      if (failed.length) await change(await me(), { type: 'retry', buddies: failed });
    },
    /** The settings changed: the limits are made again if theirs did. */
    settingsChanged: () => readBreaker(),
    statuses,
    /** What the controllers did lately: their newest events, oldest first. */
    recent: () => [...recent],
    watches: () => ({ paused }),
    /** The names of the buddies at work. */
    running: () => shown.filter((b) => runs.get(b.id) && !runs.get(b.id).stopped).map((b) => b.name),
    testAgent: async () => {
      const { settings } = await readSettings(settingsDir);
      return testAgent(await pickedAgent(settings, secrets()[settings.agent], settingsDir));
    },
    calls: {
      // Buddy `buddy` watches the doc (`on`), or no longer, as `who` says.
      async watch({ buddy, on } = {}, who) {
        if (typeof buddy !== 'string' || typeof on !== 'boolean') throw new DocError('bad_input', 'expected { buddy, on }');
        if (!buddyOf(buddy)) throw new DocError('not_found', 'no such buddy here');
        if (!on) watchFailed.delete(buddy);
        const out = await change(who, { type: 'watch', buddy, on });
        if (out.refused) throw new DocError('forbidden', out.refused);
        return {};
      },
      async resume(body, who) {
        await change(who, { type: 'resume' });
        return {};
      },
      // Buddy `buddy`'s failed watch runs again.
      async retry(body, who) {
        if (typeof body?.buddy !== 'string') throw new DocError('bad_input', 'expected { buddy }');
        watchFailed.delete(body.buddy);
        await change(who, { type: 'retry', buddies: [body.buddy] });
        return {};
      },
    },
    /** End every run without an answer (an open ask runs again next time) and start no more. */
    async close() {
      closing = true;
      await Promise.all([timer, ...controllers.values()].map((c) => c.stop()));
      await logged;
    },
  };
}
