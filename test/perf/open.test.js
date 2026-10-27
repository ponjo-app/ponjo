// Opening a file from the sidebar (B8): the desktop app on a folder of
// docs, a file clicked in its sidebar, timed until its doc is drawn in the
// place of the one before, which then goes. The median of several clicks;
// a miss is measured up to twice more, as in latency.test.js. Needs the
// page built (npm run build). It prints the medians of the switch's steps
// and of the doc host's requests (PONJO_TIMING).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../../scripts/devtools.js';
import { LATENCY } from '../../web/views/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

let app;
let pages;
const timings = []; // the app's PONJO_TIMING lines, parsed

before(async () => {
  const work = await mkdtemp(join(tmpdir(), 'ponjo-open-'));
  const folder = join(work, 'project');
  await mkdir(folder);
  await mkdir(join(work, 'config'));
  const plan = await readFile(join(root, 'test', 'fixtures', 'plan.md'), 'utf8');
  for (const name of ['a.md', 'b.md']) await writeFile(join(folder, name), plan);
  const env = { ...process.env, PONJO_CONFIG_DIR: join(work, 'config'), PONJO_TIMING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  // Sandboxed as the installed app is, but on Linux, where CI's Electron cannot be.
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const onLine = (line) => {
    const found = line.match(/ponjo-timing (\{.*\})$/);
    if (found) timings.push(JSON.parse(found[1]));
  };
  app = await launchElectron(electron, [join(root, 'desktop', 'main.js'), ...sandbox, `--user-data-dir=${join(work, 'profile')}`, folder], { env, onLine });
  pages = async () => (await (await fetch(`http://127.0.0.1:${app.devtoolsPort}/json`)).json()).filter((t) => t.type === 'page').map((t) => t.id);
});

after(() => app?.quit());

const median = (ms) => [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)];

// The medians of `timings`: each step of a switch, in ms from its start, in
// order; each doc host request, its ms and how many each switch made.
function printTimings() {
  const switches = timings.filter((t) => t.switch);
  const names = new Set(switches.flatMap((t) => Object.keys(t.switch)));
  const steps = [...names].map((name) => [name, median(switches.map((t) => t.switch[name]).filter((ms) => ms !== undefined))]);
  console.log(`# switch steps, ms from its start: ${steps.sort((a, b) => a[1] - b[1]).map((step) => step.join(' ')).join(', ')}`);
  const requests = Map.groupBy(timings.filter((t) => !t.switch), (t) => `${t.app ? 'app' : 'page'} ${t.app ?? t.page}`);
  const each = [...requests].map(([name, all]) => `${name} ${median(all.map((t) => t.ms))} ×${(all.length / switches.length).toFixed(1)}`);
  console.log(`# doc host requests, ms, times a switch: ${each.join(', ')}`);
}

// Within 10 s, once one of the pages `ids` is gone.
async function gone(ids) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const now = await pages();
    if (ids.some((id) => !now.includes(id))) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('the page before stayed');
}

// The ms from a click on each of `names` in turn to the page before gone.
async function switches(names) {
  const ms = [];
  for (const name of names) {
    const page = await app.page(name === 'a.md' ? 'b.md' : 'a.md', 60_000);
    await waitFor(() => page.evaluate(`Boolean(document.querySelector('.ProseMirror') && document.querySelector('.pj-files-file[data-path="${name}"]'))`), 30_000, 'the doc and its sidebar');
    const shown = await pages();
    const start = performance.now();
    await page.evaluate(`document.querySelector('.pj-files-file[data-path="${name}"]').click()`);
    await gone(shown);
    ms.push(performance.now() - start);
  }
  return ms;
}

test('B8: a file clicked in the sidebar is drawn in the place of the doc before within its promise', { timeout: 300_000 }, async () => {
  await switches(['b.md']); // the first page loads what the others then find ready
  await new Promise((done) => setTimeout(done, 500)); // its last timing lines
  timings.length = 0;
  let got = median(await switches(['a.md', 'b.md', 'a.md', 'b.md', 'a.md']));
  for (let again = 0; again < 2 && got > LATENCY.switch; again++) got = median(await switches(['b.md', 'a.md', 'b.md', 'a.md', 'b.md']));
  console.log(`# switch: ${Math.round(got)} ms`);
  await new Promise((done) => setTimeout(done, 500));
  printTimings();
  assert.ok(got <= LATENCY.switch, `${Math.round(got)} ms; LATENCY.switch is ${LATENCY.switch} ms`);
});
