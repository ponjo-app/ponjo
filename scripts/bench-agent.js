// Benchmark: does a buddy read the file a comment means? The Ponjo agent's
// turn (agents/ponjo-core.mjs), on a real model, answers comments in a
// sample project that name files in different ways: by title, after a
// wrong answer, by a path, by what the file says, or the doc itself. A run
// passes when the turn read every file it should, none it should not, and
// its reply says what it should. Nothing is written: the turn only proposes.
//
//   PONJO_SETTING_KEY=... node scripts/bench-agent.js [runs a case, 3] [part of a case's name]
//
// The model is set as the agent's (PONJO_SETTING_PROVIDER, _MODEL, _EFFORT),
// Nemotron 3 Super on Nebius Token Factory if left out; PONJO_SETTING_ENDPOINT,
// if set, is the API's address for any provider.

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INFER, turn } from '../agents/ponjo-core.mjs';
import { files, inProject } from '../agents/ponjo.mjs';
import { buildPrompt } from '../src/core/prompt.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'nvidia-hackthon/nvidia-hackthon.md';
const VISION = 'ponjo-docs/product-vision.md';
const UX = 'ponjo-docs/user-experience.md';
const ARCHITECTURE = 'ponjo-docs/architecture.md';
const NOTES = 'notes/2026-10-01-sync.md';

const HACKATHON = `# Ponjo

Co-write with AI agents powered by NVIDIA Nemotron just like you do with your teammates

## About the project

Today, most AI agents write documents in a delegate mode: you prompt the agent, it returns a draft, and you review it and send feedback as more prompts. This loop is slow and opaque. In my open-source text editor, Ponjo, I redesigned the co-writing agent's UX and runtime around a "peer" mode. In the UX, you and multiple personalized agents work in the same doc in real time, using a familiar writing and editing interface. In the runtime, each agent sees the same context as the human and edits through the same read and write APIs, so it sees and acts just like a remote collaborator.

## Built during the hackathon

I built an agent runtime that runs on Nemotron. It rests on two principles:

1. **Same context, same tools.** The agent sees what a human user sees and acts only through the same tools: read, find, grep, and propose.
2. **Stateless runs.** An agent run is a pure function of the document and its comment thread.
`;

const MEETING = `# Sync, 1 October

- Demo: we show the online preview, not the desktop app, so judges need nothing to install.
- Nebius Token Factory is the default provider for the demo buddies.
- Open: whether buddies may read files outside the project. Not for now.
`;

// The sample project: the doc, the repo's own design docs, and notes.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ponjo-bench-'));
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write(DOC, HACKATHON);
  write(`${DOC}.comments.jsonl`, '{"comments":1}\n');
  write(NOTES, MEETING);
  for (const path of [VISION, UX, ARCHITECTURE]) cpSync(join(root, 'docs', path.split('/')[1]), join(dir, path));
  return dir;
}

const me = 'fanzhangg';
const WRONG = [
  [me, 'What are the main themes of the product vision doc? @Iris'],
  ['Iris', 'The main theme is enabling real-time peer-mode collaboration with AI agents: agents share the same document context and tools as humans.'],
  [me, 'which doc are you reading?'],
  ['Iris', `I'm referring to the product vision document we're discussing: ${DOC}.`],
];

// Each case: the thread (who said what, oldest first) and what a run must do.
const CASES = [
  { name: 'named by its title', thread: [WRONG[0]], reads: [VISION] },
  { name: 'after a wrong answer', thread: [...WRONG, [me, 'no not this one']], reads: [VISION] },
  { name: 'asked again by name', thread: [...WRONG, [me, 'i am asking about the product vision doc']], reads: [VISION] },
  { name: 'this doc', thread: [[me, '@Iris summarize this doc in one sentence']], reads: [DOC], avoid: [VISION, UX, ARCHITECTURE] },
  { name: 'a passage and another doc', anchor: 'About the project', thread: [[me, '@Iris does this section say the same as our user experience doc?']], reads: [DOC, UX] },
  { name: 'a path from the doc\'s folder', thread: [[me, '@Iris is the runtime here the one ../ponjo-docs/architecture.md describes?']], reads: [ARCHITECTURE] },
  { name: 'a file name elsewhere', thread: [[me, '@Iris what does architecture.md call a buddy\'s turn?']], reads: [ARCHITECTURE] },
  { name: 'by what it says', thread: [[me, '@Iris what did we decide about the demo at our October meeting?']], reads: [NOTES], says: /preview/i },
  { name: 'which file says it', thread: [[me, '@Iris which of our docs compares sequential and real-time collaboration?']], says: /product-vision/ },
];

// One run of a case: the files the turn read, its reply, its steps, and
// whether it passed; or the error it failed with.
async function run({ anchor, thread, reads = [], avoid = [], says }, infer) {
  const comments = thread.map(([name, body]) => ({ by: { name }, body }));
  const sidecar = `${DOC}.comments.jsonl`;
  const prompt = buildPrompt({ buddy: { id: 'b_iris', name: 'Iris', about: '' }, docName: DOC, sidecarName: sidecar, thread: { id: 'c_bench', anchor: anchor ? { exact: anchor } : null, comments }, project: true, human: { name: me, about: '' } });
  const read = new Set();
  let steps = 0;
  const step = async (messages, tools) => {
    const answer = await infer(messages, tools);
    steps += 1;
    const [call] = answer.calls; // turn runs the first only
    if (call?.name === 'read') read.add(inProject(JSON.parse(call.args || '{}').path ?? ''));
    return answer;
  };
  try {
    const { reply } = await turn({ prompt, doc: DOC, sidecar }, { infer: step, readFile: files({ doc: DOC, sidecar, project: '.' }), resolve: inProject });
    const pass = reads.every((path) => read.has(path)) && !avoid.some((path) => read.has(path)) && (!says || says.test(reply));
    return { pass, read: [...read], reply, steps };
  } catch (error) {
    return { pass: false, read: [...read], error: error.message, steps };
  }
}

const env = (key, fallback) => process.env[`PONJO_SETTING_${key}`] || fallback;
const settings = { model: env('MODEL', 'nvidia/nemotron-3-super-120b-a12b'), key: env('KEY'), effort: env('EFFORT', 'low'), endpoint: env('ENDPOINT') };
const provider = env('PROVIDER', 'nebius');
if (!settings.key) throw new Error('No API key: set PONJO_SETTING_KEY.');
const infer = INFER[provider](settings, settings.endpoint);
const runs = Number(process.argv[2] ?? 3);
const cases = CASES.filter((c) => c.name.includes(process.argv[3] ?? ''));

process.chdir(project());
console.log(`${provider} ${settings.model}, ${runs} runs a case\n`);
let passed = 0;
for (const c of cases) {
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await run(c, infer));
  const ok = results.filter((r) => r.pass).length;
  passed += ok;
  const steps = results.reduce((sum, r) => sum + r.steps, 0) / runs;
  console.log(`${`${ok}/${runs}`.padEnd(6)}${c.name.padEnd(30)}${steps.toFixed(1)} steps`);
  for (const r of results.filter((r) => !r.pass)) console.log(`        read ${r.read.join(', ') || 'nothing'}: ${(r.error ?? r.reply).replace(/\s+/g, ' ').slice(0, 160)}`);
}
console.log(`\n${passed}/${cases.length * runs} passed`);
