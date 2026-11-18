// The config folder's logs: runs.jsonl, a line per buddy run (logRun), and
// with Trace runs on each run's trace, written and read back: for a doc's
// Runs, and for Settings > Usage (src/core/usage.js); and agents.log, what
// the agent runtime did and why (logLoop), for people to read.

import { appendFile, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeUsage } from '../core/usage.js';
import { writeAtomic } from './files.js';
import { readSettings } from './settings.js';

// The runs logged in config folder `dir`, oldest first; a line cut when the log was trimmed is left out.
async function readRuns(dir) {
  const lines = (await readFile(join(dir, 'logs', 'runs.jsonl'), 'utf8').catch(() => '')).split('\n');
  return lines.flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

/** What the runs logged in config folder `dir` used, for Settings > Usage (summarizeUsage). */
export async function readUsage(dir) {
  return summarizeUsage(await readRuns(dir), Date.now());
}

// A line per run in the config folder's logs/runs.jsonl: what a slow or
// missing reply was. With Trace runs on, its trace too (runner.js), in
// logs/traces/<run>.json, the newest TRACES kept. Then each log there (an
// agent's too) past LOG_LIMIT keeps its newest half, from a line's start:
// old runs are worth less. Never fails a run.
const LOG_LIMIT = 10 * 1024 * 1024;
const LOOP_LOG = 'agents.log';
const TRACES = 200;
export async function logRun(dir, entry, trace) {
  const logs = join(dir, 'logs');
  try {
    await mkdir(logs, { recursive: true });
    await appendFile(join(logs, 'runs.jsonl'), `${JSON.stringify(entry)}\n`);
    if ((await readSettings(dir)).settings.trace) await keepTrace(join(logs, 'traces'), { ...entry, ...trace });
    for (const name of (await readdir(logs)).filter((n) => n.endsWith('.jsonl'))) await trim(join(logs, name));
  } catch (error) {
    console.error('Could not log a run:', error);
  }
}

// A log past LOG_LIMIT keeps its newest half, from a line's start.
async function trim(path) {
  const { size } = await stat(path);
  if (size <= LOG_LIMIT) return;
  const file = await open(path);
  const { buffer } = await file.read({ buffer: Buffer.alloc(LOG_LIMIT / 2), position: size - LOG_LIMIT / 2 }).finally(() => file.close());
  await writeAtomic(path, buffer.subarray(buffer.indexOf('\n') + 1));
}

/** Where config folder `dir` keeps the agent log. */
export const loopLogPath = (dir) => join(dir, 'logs', LOOP_LOG);

/**
 * Add `text` (whole lines) to the agent log of config folder `dir`
 * (src/host/buddy-runtime.js writes it), trimmed like the others. Never fails.
 */
export async function logLoop(dir, text) {
  try {
    await mkdir(join(dir, 'logs'), { recursive: true });
    await appendFile(loopLogPath(dir), text);
    await trim(loopLogPath(dir));
  } catch (error) {
    console.error('Could not write the agent log:', error);
  }
}

async function keepTrace(folder, trace) {
  await mkdir(folder, { recursive: true });
  await writeAtomic(join(folder, `${trace.run}.json`), JSON.stringify(trace)); // whole, for a window reading it meanwhile
  const names = (await readdir(folder)).filter((name) => name.endsWith('.json'));
  if (names.length <= TRACES) return;
  const kept = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(folder, name))).mtimeMs })));
  kept.sort((a, b) => b.at - a.at);
  await Promise.all(kept.slice(TRACES).map(({ name }) => rm(join(folder, name), { force: true })));
}

/** The runs of the doc at `docPath` that have a trace, as runs.jsonl has them, newest first. */
export async function tracedRuns(dir, docPath) {
  const traced = new Set(await readdir(join(dir, 'logs', 'traces')).catch(() => []));
  return (await readRuns(dir)).filter((entry) => entry.doc === docPath && traced.has(`${entry.run}.json`)).reverse();
}

/** Run `run`'s trace (logRun), or null. */
export async function readTrace(dir, run) {
  if (typeof run !== 'string' || !/^r_[a-z0-9]+$/.test(run)) return null;
  return JSON.parse(await readFile(join(dir, 'logs', 'traces', `${run}.json`), 'utf8').catch(() => 'null'));
}
