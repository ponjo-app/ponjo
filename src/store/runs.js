// The config folder's logs/runs.jsonl, a line per buddy run
// (src/host/doc-service.js, logRun), read back: for a doc's Runs, and for
// Settings > Usage (src/core/usage.js).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeUsage } from '../core/usage.js';

/** The runs logged in config folder `dir`, oldest first; a line cut when the log was trimmed is left out. */
export async function readRuns(dir) {
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
