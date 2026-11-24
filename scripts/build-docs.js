// The repo's docs (docs/**/*.md) as the site's pages, in dist/docs, laid out
// as on https://ponjo.app/docs/: each doc in the site's header (site/index.html's),
// set as the Markdown view sets a doc (site/site.css, .doc-page), and
// docs/index.html listing them. A link to another doc goes to its page, a link
// to anything else in the repo to it on GitHub. Diagrams draw in the browser
// (preview/docs.js). .github/workflows/pages.yml publishes it.
// node scripts/build-docs.js [version], the version for ?v= (pages.yml's).
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const out = join(root, 'dist', 'docs');
const v = process.argv[2] ? `?v=${process.argv[2]}` : '';
const GITHUB = 'https://github.com/ponjo-app/ponjo';

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A heading's id as GitHub makes it, so links to #a-heading work here too.
const slug = (html) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, '').toLowerCase().trim()
  .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

// `href` in the doc at `path` (relative to the repo): a doc's page, a file in
// docs/ as it is, anything else in the repo on GitHub.
function link(href, path) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [file, hash = ''] = href.split(/(?=#)/);
  const target = posix.normalize(posix.join(posix.dirname(path), file));
  if (!target.startsWith('docs/')) return `${GITHUB}/${file.endsWith('/') ? 'tree' : 'blob'}/main/${target}${hash}`;
  return file.replace(/\.md$/, '.html') + hash;
}

function render(markdown, path) {
  const ids = new Map();
  const marked = new Marked({
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') token.href = link(token.href, path);
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const base = slug(html);
        const n = ids.get(base) ?? 0;
        ids.set(base, n + 1);
        return `<h${depth} id="${n ? `${base}-${n}` : base}">${html}</h${depth}>\n`;
      },
      code({ text, lang }) {
        return lang === 'mermaid' ? `<pre class="doc-diagram">${escape(text)}</pre>\n` : false;
      },
    },
  });
  return marked.parse(markdown);
}

// The site's header, for a page `up` from the site's root, Docs marked as open.
const siteHeader = (await readFile(join(root, 'site', 'index.html'), 'utf8')).match(/<header class="site-header">[\s\S]*?<\/header>/)[0];
if (!siteHeader.includes('href="../dist/docs/"')) throw new Error('site/index.html changed: update scripts/build-docs.js');
const header = (up) => siteHeader
  .replace(/ aria-current="[^"]*"/g, '')
  .replace(/href="(?!https?:)([^"]*)"/g, (_, href) => `href="${up}${href.replace(/^\.\.\/dist\//, '')}"`) // ../dist/preview/ is preview/ there
  .replace(`href="${up}docs/"`, `href="${up}docs/" aria-current="page"`);

const page = ({ title, up, body, diagrams }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title.replaceAll('`', ''))}</title>
<link rel="icon" href="${up}build/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${up}dist/web/app.css${v}">
<link rel="stylesheet" href="${up}site.css${v}">
</head>
<body>
${header(up)}
<main class="doc-page">
${body}</main>
<script type="module" src="${up}site.js${v}"></script>
${diagrams ? `<script type="module" src="${up}preview/docs.js${v}"></script>\n` : ''}</body>
</html>
`;

await rm(out, { recursive: true, force: true });
await cp(docs, out, { recursive: true, filter: (file) => !file.endsWith('.md') }); // their images
const groups = { 'docs/app': 'The app', 'docs/app/worlds': 'Worlds', 'docs/runtime': 'The runtime' };
const listed = Object.fromEntries(Object.keys(groups).map((dir) => [dir, []]));
const files = (await readdir(docs, { recursive: true })).filter((file) => file.endsWith('.md')).sort();
for (const file of files) {
  const path = `docs/${file.split(sep).join('/')}`;
  const markdown = await readFile(join(root, path), 'utf8');
  const title = markdown.match(/^# (.+)$/m)?.[1] ?? posix.basename(path, '.md');
  const up = '../'.repeat(path.split('/').length - 1);
  const href = file.split(sep).join('/').replace(/\.md$/, '.html'); // from docs/
  await writeFile(join(out, href), page({ title, up, body: render(markdown, path), diagrams: /^```mermaid/m.test(markdown) }));
  const dir = posix.dirname(path);
  if (!listed[dir]) throw new Error(`${path}: give ${dir} a group in scripts/build-docs.js`);
  listed[dir][file.endsWith('README.md') ? 'unshift' : 'push']({ title: new Marked().parseInline(title), href, path });
}
const index = Object.entries(groups).map(([dir, name]) => `<h2>${name}</h2>\n<ul class="doc-list">\n${listed[dir]
  .map((doc) => `<li><a href="${doc.href}">${doc.title}</a> <code>${doc.path}</code></li>`).join('\n')}\n</ul>\n`).join('');
await writeFile(join(out, 'index.html'), page({ title: 'Ponjo docs', up: '../', body: `<h1>Docs</h1>\n${index}` }));
console.log(`docs: ${files.length} pages in ${out}`);
