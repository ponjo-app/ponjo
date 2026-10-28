// The Ponjo agent (docs/ponjo-agent.md): a model reads and proposes, and
// this program checks the proposal and applies it to the copies. Run by
// `ponjo` (`ponjo.cmd` on Windows) next to it, on your own node, under
// the contract of docs/agent-config.md; its settings (ponjo.json) come
// as PONJO_SETTING_*. The turn itself is ponjo-core.mjs; this is its I/O.
// Plain fetch, no SDK: it runs from the config folder, with no
// node_modules. Yours to change.

import { appendFile, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { INFER, apply, turn } from './ponjo-core.mjs';

const MAX_TEXT_BYTES = 20 * 1024 * 1024; // the largest text file the app opens (src/store/files.js)

/**
 * A path the model wrote as the project names it: relative, `/` between
 * folders, '' for its top; null when absolute or out of the project.
 */
export function inProject(path) {
  const rel = typeof path === 'string' && !isAbsolute(path) ? relative('', path) : null;
  return rel === null || isAbsolute(rel) || rel.split(sep)[0] === '..' ? null : rel.split(sep).join('/');
}

/**
 * What the turn can see, by paths in the project: the copies (`doc` and
 * `sidecar`, their paths in the project, where they are in the working
 * folder), and the files of `project`, the project folder itself, or in
 * doc mode the working folder, which holds only the copies. Of those, as
 * the app shows them: resolved to their real path, inside the folder, no
 * name starting with `.`, and only text files (no NUL byte) of 20 MB or less.
 */
export function files({ doc, sidecar, project }) {
  // The real path of `rel` if the project shows it, else null.
  const shown = async (rel) => {
    const real = await realpath(join(project, rel)).catch(() => null);
    const inside = real && relative(await realpath(project), real);
    return inside === null || isAbsolute(inside) || [...rel.split('/'), ...inside.split(sep)].some((name) => name.startsWith('.')) ? null : real;
  };
  return async (path) => {
    const rel = inProject(path);
    if (rel === null) return null;
    if ([doc, sidecar].includes(rel)) return readFile(rel, 'utf8');
    const real = await shown(rel);
    if (!real) return null;
    const entries = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (entries) {
      // A link shows if where it goes does, as in the app: never one out of the project.
      const names = [];
      for (const e of entries) {
        if (e.isSymbolicLink() ? await shown(rel ? `${rel}/${e.name}` : e.name) : !e.name.startsWith('.')) names.push(e.name + (e.isDirectory() ? '/' : ''));
      }
      return names.sort();
    }
    if ((await stat(real)).size > MAX_TEXT_BYTES) return null;
    const bytes = await readFile(real).catch(() => null);
    return bytes && !bytes.includes(0) ? bytes.toString('utf8') : null;
  };
}

// The contract: the prompt on stdin, the copies' paths and the settings in
// the environment, the edits applied to the copies, the reply on stdout.
// Each message of the turn but the prompt goes to the trace, a line each, as
// it comes: the model's with how long it took and its usage.
async function main() {
  const { PONJO_DOC: docCopy, PONJO_COMMENTS: sidecarCopy, PONJO_PROJECT: project, PONJO_THREAD: thread, PONJO_TRACE: trace } = process.env;
  const { PONJO_SETTING_PROVIDER: provider, PONJO_SETTING_ENDPOINT: endpoint, PONJO_SETTING_EFFORT: effort } = process.env;
  // Each provider has its own model and key, kept when another is picked.
  const { [`PONJO_SETTING_${provider.toUpperCase()}_MODEL`]: model, [`PONJO_SETTING_${provider.toUpperCase()}_KEY`]: key } = process.env;
  const note = (lines) => trace && appendFile(trace, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  let messages = []; // the turn's, which it goes on adding to after each step
  let noted = 1; // those in the trace, the prompt counted: the app has it
  try {
    if (!key) throw new Error('No API key: set one in Settings > Agents > Ponjo agent.');
    // The copies by their paths in the project: where they are in the working
    // folder, both real paths, as a Mac's temp folder is not.
    const here = await realpath('.');
    const [doc, sidecar] = await Promise.all([docCopy, sidecarCopy].map(async (copy) => relative(here, await realpath(copy)).split(sep).join('/')));
    const readable = files({ doc, sidecar, project: project || '.' });
    const infer = INFER[provider]({ endpoint, model, key, effort });
    const step = async (sent, tools) => {
      await note((messages = sent).slice(noted));
      noted = messages.length;
      const at = Date.now();
      const answer = await infer(messages, tools);
      await note([{ role: 'assistant', calls: answer.calls, sent: answer.sent, ms: Date.now() - at, usage: answer.usage }]);
      noted += 1; // the answer, which turn adds next
      return answer;
    };
    const { edits, reply } = await turn({ prompt: await text(process.stdin), doc, sidecar, thread }, { infer: step, readFile: readable, resolve: inProject });
    const texts = apply(edits, { doc, sidecar }, { doc: await readable(doc), sidecar: await readable(sidecar) }, inProject);
    await writeFile(docCopy, texts.doc);
    await writeFile(sidecarCopy, texts.sidecar);
    process.stdout.write(reply);
  } catch (failure) {
    await note(messages.slice(noted)); // the last step's results
    process.stderr.write(`${failure.message}\n`);
    process.exitCode = 1;
  }
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main(); // run, not imported by a test
