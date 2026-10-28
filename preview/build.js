// The app's pages as a static site for a plain browser, in dist/preview:
// the doc window (web/index.html, the doc host played by
// preview/doc-stub.js), the start window (desktop/start.html,
// the app played by preview/start-stub.js). The doc window opens the repo's
// own docs (REPO). Run after `npm run build`:
// node preview/build.js
import { build } from 'esbuild';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'dist', 'web');
const out = join(root, 'dist', 'preview');
await rm(out, { recursive: true, force: true });
await cp(web, out, { recursive: true });

for (const file of ['team.html', '.assetsignore']) await rm(join(out, file)); // the relay's (scripts/build.js)
const page = await readFile(join(web, 'index.html'), 'utf8');
const doc = page
  .replace('<script type="module" src="app.js" blocking="render"></script>', '<script type="module" src="doc-stub.js"></script>\n  <script type="module" src="app.js" blocking="render"></script>')
  .replace("default-src 'none';", "default-src 'none'; connect-src https://infer.ponjo.app;"); // the buddies' model (doc-stub.js)
if (!doc.includes('doc-stub.js') || !doc.includes('connect-src')) throw new Error('web/index.html changed: update preview/build.js');
await writeFile(join(out, 'index.html'), doc);
// README.md, docs/ and spec/, by their paths in the repo: the preview's docs (doc-stub.js).
const REPO = {};
for (const dir of ['docs', 'spec']) {
  for (const file of (await readdir(join(root, dir))).filter((f) => f.endsWith('.md'))) REPO[`${dir}/${file}`] = await readFile(join(root, dir, file), 'utf8');
}
REPO['README.md'] = await readFile(join(root, 'README.md'), 'utf8');

const stub = (name, format) => build({
  entryPoints: [join(root, 'preview', name)],
  outfile: join(out, name),
  bundle: true,
  format,
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
  define: { REPO: JSON.stringify(REPO) },
});
await stub('doc-stub.js', 'esm');

const start = (await readFile(join(root, 'desktop', 'start.html'), 'utf8'))
  .replaceAll('../dist/web/', '')
  .replace('<script src="start.js" defer></script>', '<script src="start-stub.js"></script>\n  <script src="start.js" defer></script>');
if (start.includes('../') || !start.includes('start-stub.js')) throw new Error('desktop/start.html changed: update preview/build.js');
await writeFile(join(out, 'start.html'), start);
await stub('start-stub.js', 'iife'); // a classic script, run before start.js
console.log(`preview: ${join(out, 'index.html')}`);
