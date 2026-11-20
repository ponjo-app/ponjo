// Golden agent logs (docs/agent-runtime.md, Agent log): fixed scenarios run
// on a fake clock against a real doc and the fake agent
// (test/fixtures/fake-agent.js), and the agent log each writes is compared
// line by line with the one recorded in test/fixtures/golden/. A change to
// the runtime that is meant to keep its behaviour keeps these logs.
// GOLDEN=record writes them anew.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readdirSync, rmSync, writeFileSync } from 'node:fs';
import fsp, { mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopLogPath } from '../src/store/runs.js';
import { fakeConfig, openTestDoc, tempDoc } from './helpers.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden');
const START = Date.parse('2026-11-18T10:00:00.000Z');

// ---- the fake clock ----

// Timers, Date and performance.now move only as a scenario says (advance),
// or by a short timer something it waits on needs (during); each timer
// fires in turn, and what it set off settles before the next.
const realNow = performance.now.bind(performance);
const RealDate = Date;
const clock = { now: START, timers: new Map(), count: 0 };
function schedule(fn, ms, args, repeat) {
  const every = Math.max(1, Number(ms) || 0);
  const timer = { id: ++clock.count, at: clock.now + every, every, fn, args, repeat };
  clock.timers.set(timer.id, timer);
  return { timer, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { timer.at = clock.now + every; return this; }, [Symbol.toPrimitive]: () => timer.id };
}
globalThis.setTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
globalThis.setInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
globalThis.clearTimeout = (handle) => { if (handle) clock.timers.delete(handle.timer?.id ?? handle); };
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock.now);
  }

  static now() { return clock.now; }
};
performance.now = () => clock.now - START + 1_000_000;
// Ids from a seeded sequence (seed), so two comments at one time sort the
// same way each time (src/core/comments.js, byTime).
let seed = 1;
globalThis.crypto.getRandomValues = (bytes) => {
  for (let i = 0; i < bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    bytes[i] = seed >> 16;
  }
  return bytes;
};
// No file watch events, which come when they will: the watches' stat poll,
// on the clock, finds each change (src/store/watch.js).
fs.watch = () => ({ on() { return this; }, close() {} });

// File operations one at a time, each one's callers going on before the
// next begins, and what they ask for next before what was asked earlier: a
// chain of reads and writes runs to its end before another goes on, as on
// a fast disk, and of those asked for together a look's first (the runtime
// reads the world as soon as it hears of a change). Two things reading and
// writing at once then go in the same order each time, however many
// operations each takes.
Error.stackTraceLimit = 100;
let queue = [];
let fresh = null; // what the callers of the operation just done ask for
let pumping = false;
const oneAtATime = (fn) => function (...args) {
  return new Promise((resolve, reject) => {
    (fresh ?? queue).push({ run: () => fn.apply(this, args), resolve, reject, look: /\blookOnce\b/.test(new Error().stack) });
    pump();
  });
};
async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    fresh = [];
    try {
      job.resolve(await job.run());
    } catch (error) {
      job.reject(error);
    }
    await new Promise((resolve) => setImmediate(resolve));
    queue = [...fresh.filter((job) => job.look), ...fresh.filter((job) => !job.look), ...queue];
    fresh = null;
  }
  pumping = false;
}
for (const [name, fn] of Object.entries(fsp)) if (typeof fn === 'function' && name !== 'watch') fsp[name] = oneAtATime(fn);
const handle = await fsp.open(fileURLToPath(import.meta.url));
const FileHandle = Object.getPrototypeOf(handle);
await handle.close();
for (const name of ['close', 'read', 'write', 'readFile', 'writeFile', 'stat', 'truncate', 'sync', 'datasync', 'appendFile', 'chmod']) FileHandle[name] = oneAtATime(FileHandle[name]);
syncBuiltinESMExports();

// Fire the timer due first, if one is due by `until`: whether one was.
function fireNext(until) {
  let next = null;
  for (const t of clock.timers.values()) if (t.at <= until && (!next || t.at < next.at)) next = t;
  if (!next) return false;
  clock.now = Math.max(clock.now, next.at);
  if (next.repeat) next.at += next.every;
  else clock.timers.delete(next.id);
  next.fn(...next.args);
  return true;
}

// ---- the fake agent's runs, one at a time ----

// Each run of the fake agent waits as it starts (FAKE_STEP) until let go,
// one at a time in its buddy's name order once all else has settled, unless
// the scenario holds that buddy's runs: so runs end in the same order each
// time. A run the runtime ended (killTree) waits no more.
process.env.FAKE_STEP = '1';
const realKill = process.kill.bind(process);
const killed = new Set();
process.kill = (pid, signal) => {
  killed.add(Math.abs(pid));
  return realKill(pid, signal);
};
const held = new Set();
function alive(pid) {
  try {
    realKill(pid, 0);
    return !killed.has(pid);
  } catch {
    return false;
  }
}
// The runs waiting to be let go: [{ buddy, pid, file }], in name order.
const waiting = (dir) => readdirSync(dir).filter((f) => f.startsWith('waiting-'))
  .map((file) => ({ file, buddy: file.slice('waiting-'.length, file.lastIndexOf('.')), pid: Number(file.split('.').at(-1)) }))
  .filter((w) => alive(w.pid)).sort((a, b) => a.buddy.localeCompare(b.buddy));

// What stays open while nothing goes on; anything else is at work. The
// pipes this process has of its own (a run has three more till it closes).
const LASTING = new Set(['PipeWrap', 'ProcessWrap', 'TTYWrap', 'Immediate', 'Timeout', 'SignalWrap']);
const PIPES = process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length;

// Wait until nothing goes on but runs waiting to be let go: no file being
// read or written, no other program running, for a while in a row; let the
// first run not held go on, and settle again.
async function settle(dir) {
  const deadline = realNow() + 20_000;
  for (let quiet = 0; ;) {
    await new Promise((resolve) => setImmediate(resolve));
    const active = process.getActiveResourcesInfo();
    const runs = waiting(dir);
    const count = (kind) => active.filter((r) => r === kind).length;
    const busy = pumping || active.some((r) => !LASTING.has(r)) || count('ProcessWrap') > runs.length || count('PipeWrap') > PIPES + 3 * runs.length;
    quiet = busy ? 0 : quiet + 1;
    if (realNow() > deadline) throw new Error(`the scenario did not settle: ${active.join(', ')}`);
    if (quiet < 20) continue;
    const next = runs.find((w) => !held.has(w.buddy));
    if (!next) return;
    rmSync(join(dir, next.file));
    writeFileSync(join(dir, `go-${next.pid}`), '');
    quiet = 0;
  }
}

// Move the clock on by `ms`, firing each timer as it comes due.
async function advance(dir, ms) {
  const until = clock.now + ms;
  await settle(dir);
  while (fireNext(until)) await settle(dir);
  clock.now = until;
  await settle(dir);
}

// Wait for `promise`, firing meanwhile the timers due within a second that
// it may wait on (a file held still, a lock tried again).
async function during(dir, promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (;;) {
    await settle(dir);
    if (done) return promise;
    if (!fireNext(clock.now + 1000)) throw new Error('the scenario waits on nothing');
  }
}

// The agent log as compared: times from the first line, ids by first appearance.
function normalized(log) {
  const ids = new Map();
  const first = log.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})/m)?.[1];
  const t0 = first ? Date.parse(first.replace(' ', 'T')) : 0;
  return log
    .replace(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})/gm, (stamp) => `+${((Date.parse(stamp.replace(' ', 'T')) - t0) / 1000).toFixed(3).padStart(8)}`)
    .replace(/\b([rcebu])_[a-z0-9]{6,}\b/g, (id, kind) => ids.get(id) ?? ids.set(id, `${kind}${[...ids.keys()].filter((k) => k.startsWith(kind)).length + 1}`).get(id));
}

/**
 * Run `scenario` on a doc holding `content`, with buddies Clippy, Ada and
 * Ben, and compare its agent log with test/fixtures/golden/`name`.log, its spaces as dashes.
 */
function golden(name, scenario, { content = 'Intro.\n\nWe ship in week one.\n' } = {}) {
  test(`golden agent log: ${name}`, { timeout: 120_000 }, async () => {
    seed = 1;
    const docPath = await tempDoc(content);
    const settingsDir = await fakeConfig({ steps: 3, refillEvery: 0 });
    const buddies = { Clippy: 'Helps.\n', Ada: 'Plays.\n', Ben: 'Plays.\n' };
    const open = () => during(settingsDir, openTestDoc(docPath, { settingsDir, buddies }));
    let doc = await open();
    const ctx = {
      docPath,
      advance: (ms) => advance(settingsDir, ms),
      call: (type, arg) => during(settingsDir, doc.call(type, arg)),
      state: () => during(settingsDir, doc.state()),
      edit: async (next) => during(settingsDir, doc.edit(next, await during(settingsDir, doc.state()))),
      // The runs of `buddy` wait until released.
      hold: (buddy) => held.add(buddy),
      release: async (buddy) => {
        held.delete(buddy);
        await settle(settingsDir);
      },
      restart: async () => {
        await during(settingsDir, doc.doc.close());
        doc = await open();
      },
    };
    try {
      await scenario(ctx);
    } finally {
      held.clear();
      await during(settingsDir, doc.doc.close());
    }
    const log = normalized(await readFile(loopLogPath(settingsDir), 'utf8'));
    const path = join(GOLDEN, `${name.replaceAll(' ', '-')}.log`);
    if (process.env.GOLDEN === 'record') {
      await mkdir(GOLDEN, { recursive: true });
      await writeFile(path, log);
      return;
    }
    assert.deepEqual(log.split('\n'), (await readFile(path, 'utf8')).split('\n'));
  });
}

const comment = (call, body) => call('comment', { anchor: null, body }).then((r) => r.id);

golden('an ask answered', async ({ call, advance }) => {
  await comment(call, '@Clippy replace "week one" with "week 1"');
  await advance(1000);
});

golden('a watcher waiting while people type', async ({ call, state, edit, advance }) => {
  await call('watch', { buddy: 'Clippy', on: true });
  await advance(1000);
  await edit(`${(await state()).text}A person's line.\n`);
  await advance(2000);
  await edit(`${(await state()).text}And another.\n`);
  await advance(3000);
  await advance(4000);
});

golden('buddies waking each other until steps run out', async ({ call, state, edit, advance }) => {
  await call('watch', { buddy: 'Ada', on: true });
  await advance(1000);
  await call('watch', { buddy: 'Ben', on: true });
  await advance(3000);
  await edit(`${(await state()).text}A person's line.\n`);
  await advance(7000);
  await call('refillSteps', {});
  await advance(3000);
}, { content: 'ping-pong\n' });

golden('a buddy asks a buddy', async ({ call, advance }) => {
  await comment(call, '@Ada say @Ben your turn');
  await advance(2000);
});

golden('an outside change', async ({ call, docPath, advance }) => {
  await call('watch', { buddy: 'Clippy', on: true });
  await advance(1000);
  await writeFile(docPath, 'Intro.\n\nWe ship in week one.\nWritten outside.\n');
  await advance(2000);
});

golden('a failure and Retry', async ({ call, advance }) => {
  const id = await comment(call, '@Clippy fail');
  await advance(1000);
  await call('retry', { buddy: 'Clippy' });
  await advance(1000);
  await call('comment', { thread: id, body: '@Clippy say fine now' });
  await advance(1000);
});

golden('a watch run ended by typing', async ({ call, state, edit, advance, hold, release }) => {
  hold('Clippy');
  await call('watch', { buddy: 'Clippy', on: true });
  await advance(1000);
  await edit(`${(await state()).text}A person's line.\n`);
  await advance(6000);
  await release('Clippy');
  await advance(1000);
});

golden('a watcher woken only by its lines', async ({ call, state, edit, advance }) => {
  await call('watch', { buddy: 'Clippy', on: true });
  await advance(1000);
  await edit(`${(await state()).text}Not it.\n`);
  await advance(6000);
  await edit(`${(await state()).text}GO\n`);
  await advance(6000);
}, { content: 'wake-line GO\n' });

golden('a restart', async ({ call, advance, restart, hold, release }) => {
  hold('Clippy');
  await comment(call, '@Clippy say hello');
  await advance(1000);
  await restart();
  await advance(1000);
  await release('Clippy');
  await advance(1000);
});
