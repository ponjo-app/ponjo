// The app's pages as a static site for a plain browser, in dist/preview:
// the doc window (web/index.html, the doc host played by
// preview/doc-stub.js), the start window (desktop/start.html,
// the app played by preview/start-stub.js); Folder mode's project is
// preview/demo. Run after `npm run build`:
// node preview/build.js
import { build } from 'esbuild';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
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

// preview/demo's files by path, for doc-stub.js as DEMO: its images as the
// doc host sends them (web/api.js `image`), the rest as text.
const IMAGES = { '.jpg': 'image/jpeg', '.png': 'image/png' };
const demo = join(root, 'preview', 'demo');
const DEMO = { files: {}, images: {} };
for (const entry of await readdir(demo, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = join(entry.parentPath, entry.name);
  const path = relative(demo, file).split(sep).join('/');
  const type = IMAGES[extname(path).toLowerCase()];
  if (type) DEMO.images[path] = { type, data: (await readFile(file)).toString('base64') };
  else DEMO.files[path] = await readFile(file, 'utf8');
}

const stub = (name, format, define) => build({
  entryPoints: [join(root, 'preview', name)],
  outfile: join(out, name),
  bundle: true,
  format,
  define,
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
await stub('doc-stub.js', 'esm', { DEMO: JSON.stringify(DEMO) });

const start = (await readFile(join(root, 'desktop', 'start.html'), 'utf8'))
  .replaceAll('../dist/web/', '')
  .replace('<script src="start.js" defer></script>', '<script src="start-stub.js"></script>\n  <script src="start.js" defer></script>');
if (start.includes('../') || !start.includes('start-stub.js')) throw new Error('desktop/start.html changed: update preview/build.js');
await writeFile(join(out, 'start.html'), start);
await stub('start-stub.js', 'iife'); // a classic script, run before start.js
console.log(`preview: ${join(out, 'index.html')}`);
