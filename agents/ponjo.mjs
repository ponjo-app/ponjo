// The Ponjo agent (docs/ponjo-agent.md): a model reads and proposes, and
// this program checks the proposal and applies it to the copies. Run by
// `ponjo` (`ponjo.cmd` on Windows) next to it, on your own node, under
// the contract of docs/agent-config.md; its settings (ponjo.json) come
// as PONJO_SETTING_*. The turn itself is ponjo-core.mjs; this is its I/O.
// Plain fetch, no SDK: it runs from the config folder, with no
// node_modules. Yours to change.

import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { INFER, apply, turn } from './ponjo-core.mjs';

// Each turn's messages, a line each, next to the app's own logs.
const LOG = fileURLToPath(new URL('../logs/ponjo.jsonl', import.meta.url));

/**
 * What the turn can see: the copies, and in project mode (`project` a
 * folder) its files, as the app's own: resolved to their real path, inside
 * the folder, and no name starting with `.`. A relative path is in the
 * project, but for the copies' names.
 */
export function files({ doc, sidecar, project }) {
  return async (path) => {
    if ([doc, sidecar].includes(resolve(path))) return readFile(path, 'utf8');
    if (!project) return null;
    const real = await realpath(resolve(project, path)).catch(() => null);
    const inside = real && relative(await realpath(project), real);
    if (inside === null || isAbsolute(inside) || inside.split(sep).some((name) => name.startsWith('.'))) return null;
    const entries = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!entries) return readFile(real, 'utf8').catch(() => null);
    return entries.filter((e) => !e.name.startsWith('.')).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort();
  };
}

// The contract: the prompt on stdin, the copies' paths and the settings in
// the environment, the edits applied to the copies, the reply on stdout.
// Then the log.
async function main() {
  const { PONJO_DOC: doc, PONJO_COMMENTS: sidecar, PONJO_PROJECT: project, PONJO_BUDDY: buddy } = process.env;
  const { PONJO_SETTING_PROVIDER: provider, PONJO_SETTING_ENDPOINT: endpoint, PONJO_SETTING_MODEL: model, PONJO_SETTING_KEY: key, PONJO_SETTING_EFFORT: effort } = process.env;
  const readable = files({ doc, sidecar, project });
  const at = new Date().toISOString();
  let messages = []; // the turn's, which it goes on adding to after each step
  let error = null;
  try {
    if (!key) throw new Error('No API key: set one in Settings > Agents > Ponjo agent.');
    const infer = INFER[provider]({ endpoint, model, key, effort });
    const step = (sent, tools) => infer((messages = sent), tools);
    const { edits, reply } = await turn({ prompt: await text(process.stdin), doc, sidecar }, { infer: step, readFile: readable, resolve });
    const texts = apply(edits, { doc, sidecar }, { doc: await readable(doc), sidecar: await readable(sidecar) }, resolve);
    await writeFile(doc, texts.doc);
    await writeFile(sidecar, texts.sidecar);
    process.stdout.write(reply);
  } catch (failure) {
    error = failure.message;
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  }
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, `${JSON.stringify({ at, buddy, error, messages })}\n`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main(); // run, not imported by a test
