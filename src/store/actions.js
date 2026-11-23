// Actions (docs/runtime/README.md#outside-actions): what an agent may propose
// to do on the outside world, in the config folder's `actions/`: the
// program `<name>` (`<name>.cmd` on Windows) and its manifest `<name>.json`
// ({ name, about, input }), as an agent's. None ship: the owner installs
// them. And this machine's record of each action proposed here, in
// logs/actions.jsonl, a line per step: never in a shared file.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { programIn, programsIn } from './agents.js';
import { configDir } from './settings.js';

const actionsDir = (dir = configDir()) => join(dir, 'actions');

/** Where action `name`'s program is on this platform. */
export const actionScript = (name, dir = configDir(), platform = process.platform) => programIn(actionsDir(dir), name, platform);

/**
 * The actions on this platform: [{ id (its file name), name, about, input
 * (what it takes, in words) }]. One with no valid manifest is left out: an
 * agent could not know what it does.
 */
export async function listActions(dir = configDir(), platform = process.platform) {
  const found = await Promise.all((await programsIn(actionsDir(dir), platform)).map(async (id) => {
    const manifest = await readFile(join(actionsDir(dir), `${id}.json`), 'utf8').then(JSON.parse).catch(() => null);
    const { name, about, input } = manifest ?? {};
    return [name, about, input].every((v) => typeof v === 'string' && v.trim()) ? { id, name, about, input } : null;
  }));
  return found.filter(Boolean);
}

const recordPath = (dir) => join(dir, 'logs', 'actions.jsonl');

/** Add a step of action `entry.id` to the record: { id, state, at, ... }. */
export async function recordAction(dir, entry) {
  await mkdir(join(dir, 'logs'), { recursive: true });
  await appendFile(recordPath(dir), `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

/**
 * The actions recorded in config folder `dir`, oldest first, each its steps
 * folded into one: { id, state, ... } as its last step left it. A line cut
 * when the log was trimmed is left out.
 */
export async function readActions(dir = configDir()) {
  const byId = new Map();
  for (const line of (await readFile(recordPath(dir), 'utf8').catch(() => '')).split('\n')) {
    let step;
    try {
      step = line ? JSON.parse(line) : null;
    } catch {
      continue;
    }
    if (typeof step?.id === 'string') byId.set(step.id, { ...byId.get(step.id), ...step });
  }
  return [...byId.values()];
}
