// ProjectService: a project's files, the same for everyone. The owner's
// windows and a teammate's page read the project only through
// it, so all see the same tree. A path names a file or folder by its place
// in the project (`/` between folders, '' for the project itself); it is
// resolved to its real path, which must be inside the project, and no part
// of either may start with `.`. Anything else is as if it were not there.

import { spawn } from 'node:child_process';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_TEXT_BYTES, SIDECAR_SUFFIX } from '../store/files.js';

const notFound = (rel) => Object.assign(new Error(`${rel}: no such file in the project`), { code: 'not_found' });
const hidden = (part) => part.startsWith('.');
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// The images a doc shows, by extension, and how big one may be: it goes to
// a teammate's page in one message, base64, under the relay's limit.
const IMAGE_TYPES = {
  '.apng': 'image/apng', '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Where link `href` in doc `docPath` goes: from the doc's own place, or, in
 * project `root` (null for a single doc), from the project's top when it
 * starts with `/`, as GitHub resolves links in a repo.
 */
export function linkURL(href, docPath, root) {
  if (root && href.startsWith('/')) return new URL(`.${href}`, pathToFileURL(join(root, sep)));
  return new URL(href, pathToFileURL(docPath));
}

/**
 * The real path of `rel` in the project `root`; `not_found` when it is not
 * a name the project shows: not a string, an empty or dotted part, out of
 * the project once its links are followed, or not there.
 */
export async function resolve(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw notFound(rel);
  const parts = rel === '' ? [] : rel.split('/');
  if (parts.some((part) => !part || hidden(part) || (sep !== '/' && part.includes(sep)))) throw notFound(rel);
  try {
    const real = await realpath(join(root, ...parts));
    const inside = relative(await realpath(root), real);
    if (!isAbsolute(inside) && !inside.split(sep).some(hidden)) return real;
  } catch {
    // not there
  }
  throw notFound(rel);
}

// Whether git can be run here: false once a spawn found no git.
let gitInstalled = true;
// What git ignored in each folder, by real path: { key, ignored }, kept while
// `key` (signature()) is the same.
const ignoredCache = new Map();

/**
 * The git repository `dir` is in: { top, gitDir }, or null. Found by its
 * `.git` (a folder, or a file naming one, as in a worktree) in `dir` or a
 * folder above it, so a folder in no repository runs no git.
 */
async function repositoryOf(dir) {
  const above = [dir];
  while (dirname(above.at(-1)) !== above.at(-1)) above.push(dirname(above.at(-1)));
  const found = await Promise.all(above.map((at) => stat(join(at, '.git')).catch(() => null)));
  const at = found.findIndex(Boolean);
  if (at < 0) return null;
  const [top, dotGit] = [above[at], join(above[at], '.git')];
  if (found[at].isDirectory()) return { top, gitDir: dotGit };
  const named = (await readFile(dotGit, 'utf8').catch(() => '')).match(/^gitdir: (.+)$/m);
  return named ? { top, gitDir: resolvePath(top, named[1].trim()) } : null;
}

// What says which of `names` in `dir` git ignores, as text: the names, and
// the size and time of every .gitignore from `dir` up to the repository's
// top, its info/exclude and its index (what it tracks).
async function signature(dir, { top, gitDir }, names) {
  const files = [join(gitDir, 'info', 'exclude'), join(gitDir, 'index')];
  for (let at = dir; ; at = dirname(at)) {
    files.push(join(at, '.gitignore'));
    if (at === top || dirname(at) === at) break;
  }
  const stats = await Promise.all(files.map((file) => stat(file).then(({ size, mtimeMs }) => `${size}:${mtimeMs}`, () => '-')));
  return `${names.join('\0')}\n${stats.join(' ')}`;
}

/**
 * Which of `names` in folder `dir` git ignores (its .gitignore files and its
 * other rules; never a file it tracks): none when `dir` is not in a git
 * repository or git is not installed. Asked of git again only once the names
 * or what says what it ignores (signature()) change.
 */
async function ignoredIn(dir, names) {
  const repository = gitInstalled && (await repositoryOf(dir));
  if (!repository) return new Set();
  const key = await signature(dir, repository, names);
  const cached = ignoredCache.get(dir);
  if (cached?.key === key) return cached.ignored;
  const ignored = await checkIgnore(dir, names);
  if (ignored) ignoredCache.set(dir, { key, ignored });
  return ignored ?? new Set();
}

// git check-ignore on `names` in `dir`; null when git could not run.
function checkIgnore(dir, names) {
  return new Promise((done) => {
    const git = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    git.stdout.setEncoding('utf8').on('data', (chunk) => {
      out += chunk;
    });
    git.on('error', (error) => {
      if (error.code === 'ENOENT') gitInstalled = false;
      done(null);
    });
    git.on('close', () => done(new Set(out.split('\0'))));
    git.stdin.on('error', () => {}); // git is gone: `error` or `close` says so
    git.stdin.end(names.map((name) => `${name}\0`).join(''));
  });
}

/**
 * The file `rel`, opened: its handle and what it is. Checked again once
 * open, so a file swapped for a link out of the project meanwhile is
 * refused: what was opened must be what `rel` names now, its real path
 * not followed again (lstat), as a link put there since would be.
 */
async function openFile(root, rel) {
  const path = await resolve(root, rel);
  if (!(await stat(path)).isFile()) throw notFound(rel);
  const handle = await open(path, 'r');
  try {
    const [opened, named] = await Promise.all([handle.stat(), resolve(root, rel).then((now) => lstat(now))]);
    if (opened.dev !== named.dev || opened.ino !== named.ino || !opened.isFile()) throw notFound(rel);
    return { handle, path, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The project in folder `root` (a real path): what everyone may read of it. */
export function projectService(root) {
  return {
    /**
     * What the folder `rel` holds: its subfolders, then its files, both by
     * name. Left out: what the project does not show, and each file's
     * sidecar (`X.comments.jsonl` next to `X`); a sidecar whose file is gone
     * shows, so it can be found and fixed. An unreadable folder is empty.
     * `ignored`: git ignores it, as build output or installed packages.
     * @returns {Promise<{ name: string, folder: boolean, ignored: boolean }[]>}
     */
    async list(rel) {
      const dir = await resolve(root, rel);
      if (!(await stat(dir)).isDirectory()) throw notFound(rel);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const names = new Set(entries.map((entry) => entry.name));
      const shown = [];
      for (const entry of entries) {
        const { name } = entry;
        if (hidden(name) || (name.endsWith(SIDECAR_SUFFIX) && names.has(name.slice(0, -SIDECAR_SUFFIX.length)))) continue;
        let folder = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          const real = await resolve(root, rel ? `${rel}/${name}` : name).catch(() => null);
          if (!real) continue;
          folder = (await stat(real)).isDirectory();
        }
        shown.push({ name, folder });
      }
      const ignored = await ignoredIn(dir, shown.map((entry) => entry.name));
      for (const entry of shown) entry.ignored = ignored.has(entry.name);
      return shown.sort((a, b) => b.folder - a.folder || byName.compare(a.name, b.name));
    },

    /** The file `rel` to show read only: { text }, or { problem } when it is 'large' or 'binary'. */
    async read(rel) {
      const { handle, size } = await openFile(root, rel);
      try {
        if (size > MAX_TEXT_BYTES) return { problem: 'large' };
        const bytes = await handle.readFile();
        return bytes.includes(0) ? { problem: 'binary' } : { text: bytes.toString('utf8') };
      } finally {
        await handle.close();
      }
    },

    /** The image `rel`: { type, data } (base64), or { problem: 'large' }. */
    async image(rel) {
      const type = IMAGE_TYPES[extname(rel).toLowerCase()];
      if (!type) throw notFound(rel);
      const { handle, size } = await openFile(root, rel);
      try {
        return size > MAX_IMAGE_BYTES ? { problem: 'large' } : { type, data: (await handle.readFile()).toString('base64') };
      } finally {
        await handle.close();
      }
    },

    /** The file `rel` to open: { path }, its real path. */
    async open(rel) {
      const { handle, path } = await openFile(root, rel);
      await handle.close();
      return { path };
    },
  };
}
