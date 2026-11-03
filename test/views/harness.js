// The page the view tests drive (test/views/page.js), in Electron, over the
// DevTools protocol: test/views.test.js (every view's contract) and
// test/markdown.test.js (the Markdown view's own behaviour).

import { build } from 'esbuild';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../../scripts/devtools.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The page, ready: { app, page, run(expression) }. */
export async function openViews() {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-views-'));
  await build({
    entryPoints: [join(root, 'test', 'views', 'page.js')], outfile: join(dir, 'page.js'),
    bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'error',
  });
  await copyFile(join(root, 'web', 'app.css'), join(dir, 'app.css'));
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>views</title><link rel="stylesheet" href="app.css">
<main class="pj-canvas"><div class="pj-stage"><article class="pj-page"><div class="pj-editor"></div></article></div></main>
<script src="page.js"></script>`);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, VIEWS_PAGE: join(dir, 'index.html') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron(electron, [join(root, 'test', 'views', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  const page = await app.page('views');
  await waitFor(() => page.evaluate('Boolean(window.contract)'), 30_000, 'the contract page');
  return { app, page, run: (expression) => page.evaluate(`(async () => ${expression})()`) };
}
