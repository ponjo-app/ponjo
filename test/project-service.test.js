// ProjectService (src/host/project-service.js) on real files: what a project
// shows, and every way out of it refused.

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MAX_TEXT_BYTES } from '../src/store/files.js';
import { projectService, resolve } from '../src/host/project-service.js';

const fsp = createRequire(import.meta.url)('node:fs/promises');
const childProcess = createRequire(import.meta.url)('node:child_process');
const isWindows = process.platform === 'win32';
const notFound = (error) => error.code === 'not_found';

// A project (its real path) holding `files` ({ path: text }), and a folder outside it.
async function project(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-outside-')));
  await writeFile(join(outside, 'secret.md'), 'outside\n');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return { root, outside, service: projectService(root) };
}

test('list: every file and folder the project shows, folders first, without dot names or a file\'s sidecar', async () => {
  const { root, outside, service } = await project({
    'b.md': '', 'b.md.comments.jsonl': '', 'gone.md.comments.jsonl': '', 'a 10.txt': '', 'a 2.txt': '', '.env': '', '.DS_Store': '',
    '.git/HEAD': '', '.github/ci.yml': '', 'node_modules/pkg/index.js': '', 'src/main.js': '', 'empty/.keep': '',
  });
  await symlink(join(root, 'src'), join(root, 'linked'), 'junction'); // a junction on Windows, which needs no admin rights
  await symlink(outside, join(root, 'out'), 'junction');
  await symlink(join(root, '.github'), join(root, 'ci'), 'junction');
  assert.deepEqual((await service.list('')).map(({ name, folder }) => ({ name, folder })), [
    { name: 'empty', folder: true }, { name: 'linked', folder: true }, { name: 'node_modules', folder: true }, { name: 'src', folder: true },
    { name: 'a 2.txt', folder: false }, { name: 'a 10.txt', folder: false }, { name: 'b.md', folder: false },
    { name: 'gone.md.comments.jsonl', folder: false },
  ]);
  assert.deepEqual(await service.list('empty'), []);
  assert.deepEqual(await service.list('linked'), [{ name: 'main.js', folder: false, ignored: false }], 'a link that stays in the project');
});

test('list: what git ignores is marked, but not a file it tracks; outside a git repository nothing is', async () => {
  const { root, service } = await project({
    '.gitignore': 'dist/\n*.log\n!keep.log\n', 'dist/sub/a.md': '', 'debug.log': '', 'keep.log': '', 'tracked.log': '', 'notes/b.md': '',
  });
  const ignored = async (rel) => (await service.list(rel)).filter((e) => e.ignored).map((e) => e.name);
  assert.deepEqual(await ignored(''), [], 'not a git repository');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-f', 'tracked.log'], { cwd: root });
  assert.deepEqual(await ignored(''), ['dist', 'debug.log']);
  assert.deepEqual(await ignored('dist'), ['sub'], 'inside an ignored folder');
  assert.deepEqual(await ignored('notes'), []);
  for (const rel of ['out', 'ci', '.github', 'missing', 'b.md']) await assert.rejects(service.list(rel), notFound, rel);
});

// The git commands run during `fn`, by their first argument.
async function gitRuns(fn) {
  const runs = [];
  const real = childProcess.spawn;
  childProcess.spawn = (command, args, ...rest) => {
    if (command === 'git') runs.push(args[0]);
    return real(command, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    childProcess.spawn = real;
    syncBuiltinESMExports();
  }
  return runs;
}

test('list: outside a git repository it runs no git; in one, git is asked again only when a folder\'s names or what git ignores change', async () => {
  const { root, service } = await project({ 'a.md': '', 'debug.log': '', 'notes/b.md': '', 'notes/c.log': '' });
  const ignored = async (rel) => (await service.list(rel)).filter((e) => e.ignored).map((e) => e.name);
  assert.deepEqual(await gitRuns(() => Promise.all([service.list(''), service.list('notes'), service.list('')])), [], 'not a git repository');
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, '.gitignore'), '*.log\n');
  assert.deepEqual(await gitRuns(async () => {
    assert.deepEqual(await ignored(''), ['debug.log']);
    assert.deepEqual(await ignored('notes'), ['c.log']);
  }), ['check-ignore', 'check-ignore'], 'a repository now: each folder asked once');
  assert.deepEqual(await gitRuns(async () => {
    assert.deepEqual(await ignored(''), ['debug.log']);
    assert.deepEqual(await ignored('notes'), ['c.log']);
  }), [], 'nothing changed: nothing asked');
  await writeFile(join(root, 'notes', 'd.log'), '');
  assert.deepEqual(await gitRuns(async () => assert.deepEqual(await ignored('notes'), ['c.log', 'd.log'])), ['check-ignore'], 'a file came');
  await writeFile(join(root, '.gitignore'), '*.log\n!c.log\n');
  assert.deepEqual(await gitRuns(async () => assert.deepEqual(await ignored('notes'), ['d.log'])), ['check-ignore'], 'the .gitignore above changed');
  await writeFile(join(root, 'notes', '.gitignore'), 'b.md\n');
  assert.deepEqual(await gitRuns(async () => assert.deepEqual(await ignored('notes'), ['b.md', 'd.log'])), ['check-ignore'], 'a .gitignore of its own');
  await writeFile(join(root, '.git', 'info', 'exclude'), 'a.md\n');
  assert.deepEqual(await gitRuns(async () => assert.deepEqual(await ignored(''), ['a.md', 'debug.log'])), ['check-ignore'], 'info/exclude changed');
  execFileSync('git', ['add', '-f', 'debug.log'], { cwd: root });
  assert.deepEqual(await gitRuns(async () => assert.deepEqual(await ignored(''), ['a.md'])), ['check-ignore'], 'a file git now tracks');
});

test('list: in a worktree, whose .git is a file naming the repository, what git ignores is marked and follows its .gitignore', async () => {
  const { root } = await project({ 'main.md': '' });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const tree = join(dirname(root), `${basename(root)}-tree`);
  git('worktree', 'add', '-q', tree);
  await writeFile(join(tree, 'a.log'), '');
  await writeFile(join(tree, '.gitignore'), '*.log\n');
  const service = projectService(await realpath(tree));
  assert.deepEqual((await service.list('')).filter((e) => e.ignored).map((e) => e.name), ['a.log']);
  await writeFile(join(tree, '.gitignore'), 'none\n');
  assert.deepEqual((await service.list('')).filter((e) => e.ignored).map((e) => e.name), []);
});

test('resolve: the real path of what the project shows; any other path is not found', async () => {
  const { root, outside } = await project({ 'notes/a.md': '', '.env': '', 'docs/.secret': '', '.github/x.md': '', '.ponjo/buddies/x.md': '' });
  await symlink(outside, join(root, 'out'), 'junction');
  await symlink(tmpdir(), join(root, 'tmp'), 'junction');
  await symlink(join(root, 'notes'), join(root, 'in'), 'junction');
  assert.equal(await resolve(root, ''), root);
  assert.equal(await resolve(root, 'notes/a.md'), join(root, 'notes', 'a.md'));
  assert.equal(await resolve(root, 'in/a.md'), join(root, 'notes', 'a.md'), 'a link inside, as its real path');
  const refused = [
    '..', '../x', 'notes/../../x', 'notes/../a.md', './notes/a.md', 'notes//a.md', 'notes/', '/etc/passwd', join(root, 'notes', 'a.md'),
    '.env', 'docs/.secret', '.github/x.md', '.ponjo/buddies/x.md', 'out/secret.md', 'tmp', 'missing.md', 'a\0b',
  ];
  for (const rel of refused) await assert.rejects(resolve(root, rel), notFound, rel);
  for (const rel of [null, undefined, 42, ['a.md'], { path: 'a.md' }]) await assert.rejects(resolve(root, rel), notFound, String(rel));
});

test('links to files: one that stays in the project and leads to what it shows is its file; any other is not found', { skip: isWindows && 'linking files needs admin rights on Windows' }, async () => {
  const { root, outside, service } = await project({ 'a.md': 'inside\n', '.env': 'KEY=1\n', 'notes/.draft.md': '' });
  await symlink(join(root, 'a.md'), join(root, 'same.md'));
  await symlink(join(root, '.env'), join(root, 'env.txt'));
  await symlink(join(root, 'notes', '.draft.md'), join(root, 'draft.md'));
  await symlink(join(outside, 'secret.md'), join(root, 'secret.md'));
  await symlink('../' + outside.split('/').at(-1) + '/secret.md', join(root, 'relative.md'));
  assert.deepEqual((await service.list('')).map((e) => e.name), ['notes', 'a.md', 'same.md']);
  assert.deepEqual(await service.read('same.md'), { text: 'inside\n' });
  assert.deepEqual(await service.open('same.md'), { path: join(root, 'a.md') });
  for (const rel of ['env.txt', 'draft.md', 'secret.md', 'relative.md']) {
    await assert.rejects(service.read(rel), notFound, rel);
    await assert.rejects(service.open(rel), notFound, rel);
  }
});

test('read: a file\'s text, but not a large or binary one, nor a folder', async () => {
  const { service } = await project({ 'a.js': 'let x = 1;\n', 'pic.png': Buffer.from([0x89, 0x50, 0x00, 0x47]), 'big.log': 'x'.repeat(MAX_TEXT_BYTES + 1), 'src/x.js': '' });
  assert.deepEqual(await service.read('a.js'), { text: 'let x = 1;\n' });
  assert.deepEqual(await service.read('pic.png'), { problem: 'binary' });
  assert.deepEqual(await service.read('big.log'), { problem: 'large' });
  await assert.rejects(service.read('src'), notFound);
  await assert.rejects(service.open('src'), notFound);
  await assert.rejects(service.read(''), notFound);
});

test('search: each text file the query is found in, in the tree\'s order, each hit\'s line and its offset in the text a doc reads', async () => {
  const { root, outside, service } = await project({
    'b.md': 'One cat.\r\nTwo Cats and a cat.\r\n', 'a.md': '﻿no match\n', 'notes/c.md': 'cat\n', 'notes/c.md.comments.jsonl': '{"body":"cat"}\n',
    '.hidden/cat.md': 'cat\n', 'pic.png': Buffer.from([0x63, 0x61, 0x74, 0x00]), 'big.txt': `cat${'x'.repeat(MAX_TEXT_BYTES)}`,
    '.gitignore': 'dist/\n', 'dist/cat.md': 'cat\n',
  });
  await symlink(outside, join(root, 'out'), 'junction');
  await writeFile(join(outside, 'cat.md'), 'cat\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { files, more } = await service.search('cat', {});
  assert.equal(more, false);
  assert.deepEqual(files.map((f) => f.path), ['notes/c.md', 'b.md'], 'folders first; not hidden, ignored, binary, large, a sidecar or out of the project');
  const text = 'One cat.\nTwo Cats and a cat.\n'; // as a doc reads b.md: its lines end in \n
  assert.deepEqual(files[1].hits, [
    { line: 1, at: text.indexOf('cat'), text: 'One cat.', start: 4, end: 7 },
    { line: 2, at: text.indexOf('Cat'), text: 'Two Cats and a cat.', start: 4, end: 7 },
    { line: 2, at: text.lastIndexOf('cat'), text: '… Cats and a cat.', start: 13, end: 16 }, // cut 12 characters before the match
  ]);
  assert.deepEqual((await service.search('Cat', { matchCase: true, wholeWord: false })).files.map((f) => f.hits.length), [1]);
  assert.deepEqual(await service.search('cat(', { regex: true }), { files: [], more: false }, 'not a regular expression: nothing');
  assert.deepEqual(await service.search('', {}), { files: [], more: false });
});

test('search: a long line is cut around its match; past 1000 hits the rest is left out, and said', async () => {
  const long = `${'a'.repeat(300)}needle${'b'.repeat(300)}`;
  const { service } = await project({ 'long.txt': `${long}\n`, 'many.txt': 'x '.repeat(1200) });
  const [hit] = (await service.search('needle', {})).files[0].hits;
  assert.ok(hit.text.length <= 162 && hit.text.startsWith('…') && hit.text.endsWith('…'), hit.text);
  assert.equal(hit.text.slice(hit.start, hit.end), 'needle');
  const many = await service.search('x', {});
  assert.equal(many.more, true);
  assert.equal(many.files.reduce((n, f) => n + f.hits.length, 0), 1000);
});

// Run each swap just before the nth call of an fs/promises function
// ({ name: [n, swap] }), in every module that imports it, during `fn`.
async function withSwaps(swaps, fn) {
  const real = {};
  for (const [name, [n, swap]] of Object.entries(swaps)) {
    real[name] = fsp[name];
    let calls = 0;
    fsp[name] = async (...args) => {
      if (++calls === n) await swap();
      return real[name](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    Object.assign(fsp, real);
    syncBuiltinESMExports();
  }
}

test('a file swapped for a link out of the project between the check and the open is refused', { skip: isWindows && 'linking files needs admin rights on Windows' }, async () => {
  const { root, outside, service } = await project({ 'a.md': 'inside\n' });
  const path = join(root, 'a.md');
  const toLink = async () => {
    await rename(path, join(root, 'kept.md'));
    await symlink(join(outside, 'secret.md'), path);
  };
  const toFile = async () => {
    await rm(path);
    await rename(join(root, 'kept.md'), path);
  };
  // Checked as a file, opened as the link.
  await withSwaps({ open: [1, toLink] }, () => assert.rejects(service.read('a.md'), notFound));
  await toFile();
  // Opened as the link, then a file again while it is checked, and the link
  // once more just before the check looks at what the path is.
  await withSwaps({ open: [1, toLink], realpath: [3, toFile], lstat: [1, toLink] }, () => assert.rejects(service.read('a.md'), notFound));
  await toFile();
  assert.deepEqual(await service.read('a.md'), { text: 'inside\n' });
});

test('names are compared as the disk does: on a disk that ignores case, either case finds the file and nothing outside', async () => {
  const { root, service } = await project({ 'README.md': 'hi\n' });
  const ignoresCase = await stat(join(root, 'readme.MD')).then(() => true, () => false);
  if (!ignoresCase) {
    await assert.rejects(service.read('readme.MD'), notFound, 'a disk that minds case');
    return;
  }
  assert.deepEqual(await service.read('readme.MD'), { text: 'hi\n' });
  assert.deepEqual(await projectService(root.toUpperCase()).read('README.md'), { text: 'hi\n' }, 'the project opened in another case');
});

// Last: it leaves this process without git.
test('list: once git is found not installed, it is not run again, and nothing is marked ignored', async () => {
  const { root, service } = await project({ '.gitignore': '*.log\n', 'debug.log': '' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const real = childProcess.spawn;
  childProcess.spawn = (command, ...rest) => real(command === 'git' ? join(root, 'no-such-git') : command, ...rest);
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await service.list('')).filter((e) => e.ignored), [], 'no git');
  } finally {
    childProcess.spawn = real;
    syncBuiltinESMExports();
  }
  await writeFile(join(root, 'more.log'), '');
  assert.deepEqual(await gitRuns(() => service.list('')), [], 'not looked for again');
});
