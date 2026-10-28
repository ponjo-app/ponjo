// A stand-in for the doc host (src/host/doc-service.js) so the doc window
// opens in a plain browser (preview/build.js): the repo's product vision,
// or with `?folder` the repo's docs as a project and the app's side of its
// sidebar (window.ponjoDesktop), read with the same src/core as the app.
// Either opens on the product vision, with sample threads by you, a
// teammate and buddies, one of them a buddy's edit that undoes. Kept in
// sessionStorage, so switching docs (`?folder&doc=<path>`, a new page as
// in the app) and reloading keep it; a new tab starts over.
// A buddy asked runs the Ponjo agent's turn (agents/ponjo-core.mjs) here,
// on Nemotron through the preview's Worker (relay/worker.js, at INFER), and
// its edit lands as the app lands one: merged with what was typed
// meanwhile, its reply showing its edits, which undo; Settings' Agents
// say so, fixed (agents.js). No version history, no menus. A project's
// room is a sample: once opened, Noor and Sam are in it, and its link
// leads nowhere.

import { createAnchor, locate } from '../src/core/anchor.js';
import { apply, diffOps } from '../src/core/ot.js';
import { appendedComments, askedOf, movedAnchor, newComment, newId, peopleOf, serializeSidecar, threadsOf } from '../src/core/comments.js';
import { diffEdits, merge3 } from '../src/core/diff.js';
import { buildPrompt } from '../src/core/prompt.js';
import { INFER, apply as applyProposal, turn } from '../agents/ponjo-core.mjs';
import { buddiesHere, checkBuddyPatch } from '../src/core/buddies.js';
import { sameName } from '../src/core/mentions.js';
import { DEFAULT_SETTINGS, checkSettingsPatch, mergeSettings } from '../src/core/settings.js';
import { PICKED, SCRIPTS } from './agents.js';

const params = new URLSearchParams(location.search);
const inFolder = params.has('folder');
const KEY = `ponjo.preview.${inFolder ? 'folder' : 'doc'}`;

// The repo's README.md, docs/ and spec/ by path (preview/build.js).
/* global REPO */

// The doc each opens on: the product vision, alone or among the repo's docs.
const HOME = inFolder ? 'docs/product-vision.md' : 'product-vision.md';

// Threads as people and buddies leave them on HOME: a comment by you on
// `quote`, then the replies. A reply's `was` is what its buddy's edit
// rewrote into `quote`: undoing the edit brings it back. A thread whose
// quote the doc no longer has is left out.
const THREADS = [
  {
    quote: 'People and AI buddies work on the same doc at the same time, discussing in comments and each making their own edits, just like a team reviewing a proposal together.',
    comments: [
      { by: 'you', body: '@Editor this paragraph rambles. One sentence, and keep the team-review image.' },
      {
        by: 'Editor', body: 'Down to one sentence: same doc, same time, comments and edits, with the proposal review kept as the picture.',
        was: 'People and AI buddies can all work on the same doc, and they can do so at the same time as one another. They talk things over with each other in the comments, and each of them makes their own edits to the text, which, if you think about it, is really quite a lot like what happens when a team of people sits down together to review a proposal.',
      },
      { by: 'Noor', body: 'Much better. I was about to ask for the same.' },
    ],
  },
  {
    quote: 'Google Docs + Gemini, Notion AI, Word + Copilot',
    comments: [
      { by: 'you', body: '@Researcher are these still the main three? Anything missing?' },
      { by: 'Researcher', body: "Still the main three. Coda AI fits the same row, but it doesn't change the point: the AI is the vendor's and the doc lives in their cloud. I'd leave the row as it is." },
    ],
  },
  {
    quote: 'Many AI buddies, not just one',
    comments: [
      { by: 'you', body: '@Clippy can you give an example for this one?' },
      { by: 'Clippy', body: 'Say Editor tightens a paragraph while Researcher checks a number in it. Both see the same thread, so either can pick up where the other left off. Want me to add that as a sentence?' },
      { by: 'Editor', body: 'If it goes in, keep it short: every other principle is a sentence or two.' },
      { by: 'you', body: '@Clippy not now, the bullet reads fine without it.' },
      { by: 'Clippy', body: 'OK, leaving it as it is.' },
    ],
  },
  {
    quote: 'All communication happens in comments; no chat window',
    comments: [
      { by: 'you', body: "@Clippy why no chat window at all? Wouldn't one help with questions like this?" },
      { by: 'Clippy', body: "This thread is the answer: you asked next to the text it's about, and the reply landed here too. A chat window would pull the question away from the text, and you'd carry the answer back by hand." },
      { by: 'you', body: 'Fair enough.', resolved: true },
    ],
  },
];

const CLIPPY = { id: 'Clippy', name: 'Clippy', about: 'A general writing assistant that helps draft and edit docs' };
const TEAM = [{ id: 'Editor', name: 'Editor', about: 'Tightens prose and keeps the tone even' }, { id: 'Researcher', name: 'Researcher', about: 'Finds sources and checks the facts' }];

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function seed() {
  const settings = { ...DEFAULT_SETTINGS, ...PICKED, id: 'u_preview', name: 'you' };
  const me = { id: settings.id, name: settings.name, kind: 'human' };
  const who = (by) => (by === 'you' ? me : by === 'Noor' ? { id: 'p_noor', name: 'Noor', kind: 'human' } : { id: by, name: by, kind: 'ai' });
  const files = inFolder ? { ...REPO } : { [HOME]: REPO['docs/product-vision.md'] };
  const text = files[HOME];
  const comments = { [HOME]: [] };
  const versions = { [HOME]: [] };
  THREADS.filter((t) => text.includes(t.quote)).forEach((t, i) => {
    const start = text.indexOf(t.quote);
    const thread = newId('c');
    t.comments.forEach(({ by, body, was, resolved }, j) => {
      const id = j === 0 ? thread : newId('c');
      const on = j === 0 ? { anchor: createAnchor(text, start, start + t.quote.length) } : { thread };
      comments[HOME].push({ id, ...on, by: who(by), at: ago(60 - 12 * i - j), body, ...(resolved ? { resolved } : {}) });
      if (was) {
        const before = text.replace(t.quote, was);
        versions[HOME].push({ id, by, before, text, changes: diffEdits(before, text).length, undone: false });
      }
    });
  });
  return {
    settings, files, comments,
    mine: inFolder ? [CLIPPY] : [CLIPPY, ...TEAM],
    buddies: inFolder ? TEAM : [],
    expanded: [], sidebar: true, carry: null,
    room: null,
    versions, // by doc: the buddies' edits, { id: its reply, by, before, text, changes, undone }
  };
}

let s;
try {
  s = JSON.parse(sessionStorage.getItem(KEY)) ?? seed();
} catch {
  s = seed();
}
function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: kept until the page goes
  }
}
save();

const DOC = /\.(md|markdown)$/i;
const docs = () => Object.keys(s.files).filter((path) => DOC.test(path)).sort();
let current = s.files[params.get('doc')] !== undefined && DOC.test(params.get('doc')) ? params.get('doc') : s.files[HOME] !== undefined ? HOME : docs()[0];
const name = (path) => path.split('/').pop();
const me = () => ({ id: s.settings.id, name: s.settings.name, kind: 'human' });
const comments = () => (s.comments[current] ??= []);
const buddies = () => buddiesHere(s.buddies, s.mine);
const versions = () => ((s.versions ??= {})[current] ??= []);

// Every edit is on the latest rev of this page load: the page's own, and the buddies'.
const epoch = newId('e');
let rev = 0;

const running = new Map(); // buddy id → thread ids
const agents = () => buddies().map((b) => ({ ...b, state: running.has(b.id) ? 'running' : 'ready', threadIds: running.get(b.id) ?? [] }));

function view() {
  const text = s.files[current];
  const threads = threadsOf(comments(), buddies().map(({ id, name }) => ({ id, name }))).map((thread) => {
    if (!thread.anchor) return { ...thread, detached: false };
    const found = locate(text, thread.anchor);
    return { ...thread, anchor: found ? createAnchor(text, found.start, found.end) : thread.anchor, detached: !found };
  });
  const edits = Object.fromEntries(versions().map((v) => [v.id, { state: v.undone ? 'undone' : 'edited', by: v.by, changes: v.changes, version: v.id, conflict: false }]));
  return { threads, people: peopleOf(comments()), edits, readOnly: null, notice: null };
}

let listener = null;
const emit = (event, data) => listener?.(event, data);

// The preview's buddies' model: Chat Completions at the Worker, which
// picks the model (MODEL, as relay/wrangler.toml names it) and holds the key.
const infer = INFER.openai({ endpoint: 'https://infer.ponjo.app/infer', model: 'nemotron', key: 'preview' });

// The buddies this user's comments ask, as the runner would start them.
function answer() {
  for (const thread of threadsOf(comments(), buddies().map(({ id, name }) => ({ id, name })))) {
    for (const asked of askedOf(thread, [s.settings.id])) {
      if (running.get(asked)?.includes(thread.id)) continue;
      running.set(asked, [...(running.get(asked) ?? []), thread.id]);
      emit('agents', agents());
      run(asked, thread).finally(() => {
        const left = running.get(asked).filter((id) => id !== thread.id);
        if (left.length) running.set(asked, left);
        else running.delete(asked);
        emit('agents', agents());
      });
    }
  }
}

// A path as the turn's copies and the project's files are named here.
const plain = (path) => path.replace(/^\.?\//, '');

// Buddy `id`'s turn on `thread`, on copies of the doc and its comments as
// they are now; then, as the app does (src/host/doc-service.js, finishRun),
// its edit lands merged with what was typed meanwhile, and its comments
// and reply come after. Dropped if the thread was resolved or the doc
// renamed meanwhile. It never resolves the thread, even when its turn asks
// to: people resolve (docs/product-vision.md), and a resolved thread folds
// away its reply.
async function run(id, thread) {
  const doc = current;
  const sidecar = `${doc}.comments.jsonl`;
  const copies = { [doc]: s.files[doc], [sidecar]: serializeSidecar(comments().map((comment) => ({ comment }))) };
  const buddy = buddies().find((b) => b.id === id);
  const by = { id, name: buddy.name, kind: 'ai' };
  let texts = { doc: copies[doc], sidecar: copies[sidecar] };
  let body;
  let failed = false;
  try {
    const prompt = buildPrompt({ buddy, buddies: buddies(), docName: doc, sidecarName: sidecar, thread, project: inFolder, human: { name: s.settings.name, about: s.settings.about.trim() } });
    const { edits, reply } = await turn({ prompt, doc, sidecar }, { infer, readFile: (path) => read(plain(path), copies), resolve: plain });
    texts = applyProposal(edits, { doc, sidecar }, { doc: copies[doc], sidecar: copies[sidecar] }, plain);
    body = reply.trim();
  } catch (error) {
    body = error.message.split('\n')[0];
    failed = true;
  }
  if (doc !== current || threadsOf(comments()).find((t) => t.id === thread.id)?.resolved) return;
  const replyId = newId('c');
  let anchor = null;
  if (texts.doc !== copies[doc]) {
    const text = s.files[doc];
    const merged = merge3(copies[doc], text, texts.doc).text;
    s.files[doc] = merged;
    versions().push({ id: replyId, by: id, before: text, text: merged, changes: diffEdits(text, merged).length, undone: false });
    emit('ops', { epoch, rev: ++rev, ops: diffOps(text, merged), id: null, reply: replyId, by: id });
    anchor = movedAnchor(thread.anchor, copies[doc], texts.doc, merged);
  }
  const at = Date.now();
  const threads = new Set(comments().filter((c) => c.thread === undefined).map((c) => c.id));
  const added = appendedComments(copies[sidecar], texts.sidecar, { text: texts.doc, by, at: new Date(at).toISOString(), threads, own: thread.id });
  comments().push(...added.comments, {
    id: replyId, thread: thread.id, by, at: new Date(at + 1).toISOString(), body,
    ...(anchor ? { anchor } : {}), ...(failed ? { failed: true } : {}),
  });
  save();
  emit('sidecar', {});
}

// What a turn can read at `path`: its copies, and in a project its files
// and folders; else, as a run's working folder, only the copies.
function read(path, copies) {
  if (copies[path] !== undefined) return copies[path];
  if (!inFolder) return ['', '.'].includes(path) ? Object.keys(copies) : null;
  if (s.files[path] !== undefined) return s.files[path];
  const entries = calls.list({ path: path === '.' ? '' : path.replace(/\/$/, '') }).map((e) => e.name + (e.folder ? '/' : ''));
  return entries.length > 0 ? entries : null;
}

function add(comment) {
  comments().push(newComment(comment, { by: me(), at: new Date().toISOString() }));
  save();
  setTimeout(answer);
  return { ...view(), id: comments().at(-1).id };
}

const refuse = (message) => {
  throw Object.assign(new Error(message), { code: 'bad_input' });
};

function checkBuddy(fields, id = null) {
  checkBuddyPatch(fields);
  const taken = [...buddies().filter((b) => b.id !== id).map((b) => b.name), s.settings.name];
  if (fields.name !== undefined && taken.some((n) => sameName(fields.name, n))) refuse(`the name ${fields.name} is taken`);
}

function changeRoom(fn) {
  s.room = s.room && fn(s.room);
  save();
  emit('room', s.room);
  return s.room;
}

function changedBuddies() {
  save();
  emit('agents', agents());
  return { agents: agents() };
}

const calls = {
  state: () => ({ doc: name(current), text: s.files[current], epoch, rev, ...view(), settings: s.settings, defaultName: 'you', me: me(), level: 'owner', owner: me().id, agents: agents(), project: inFolder }),
  submit({ ops, rev: at, epoch: from, id }) {
    if (from !== epoch || at !== rev) throw Object.assign(new Error('the doc has moved on'), { code: 'stale' });
    s.files[current] = apply(s.files[current], ops);
    save();
    emit('ops', { epoch, rev: ++rev, ops, id });
    return { rev };
  },
  comment: ({ thread, anchor, body, resolved }) => add({ thread, anchor, body, resolved }),
  saveSettings(patch) {
    checkSettingsPatch(patch);
    s.settings = mergeSettings(s.settings, patch);
    save();
    emit('settings', s.settings);
    return { settings: s.settings };
  },
  scripts: () => SCRIPTS,
  createBuddy({ buddy }) {
    const fields = { about: '', ...buddy };
    checkBuddy(fields);
    if (!fields.name) refuse('a buddy needs a name');
    s[inFolder ? 'buddies' : 'mine'].push({ id: newId('b'), ...fields });
    return changedBuddies();
  },
  updateBuddy({ id, patch = {} }) {
    const found = buddies().find((b) => b.id === id) ?? refuse('no such buddy');
    checkBuddy(patch, id);
    const key = found.where === 'project' ? 'buddies' : 'mine';
    s[key] = s[key].map((b) => (b.id === id ? { ...b, ...patch } : b));
    return changedBuddies();
  },
  deleteBuddy({ id: gone }) {
    s.buddies = s.buddies.filter((b) => b.id !== gone);
    s.mine = s.mine.filter((b) => b.id !== gone);
    return changedBuddies();
  },
  room: () => s.room,
  openRoom() {
    s.room = { link: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}team.html?room=${newId('r')}`, locked: false, players: [{ id: 'p_noor', name: 'Noor', level: 'write' }, { id: 'p_sam', name: 'Sam', level: 'read' }] };
    return changeRoom((r) => r);
  },
  closeRoom: () => changeRoom(() => null),
  lockRoom: ({ locked }) => changeRoom((r) => ({ ...r, locked })),
  setLevel: ({ id, level }) => changeRoom((r) => ({ ...r, players: r.players.map((p) => (p.id === id ? { ...p, level } : p)) })),
  kick: ({ id }) => changeRoom((r) => ({ ...r, players: r.players.filter((p) => p.id !== id) })),
  history: () => ({ versions: [] }),
  version: ({ id }) => versions().find((v) => v.id === id) ?? refuse('no such version'),
  restoreVersion: () => refuse('no history in the preview'),
  // Undo a buddy's edit: taken back, merged with what landed since.
  undo({ id }) {
    const found = versions().find((v) => v.id === id && !v.undone) ?? refuse('no such edit');
    const text = s.files[current];
    s.files[current] = merge3(found.text, text, found.before).text;
    found.undone = true;
    save();
    emit('ops', { epoch, rev: ++rev, ops: diffOps(text, s.files[current]), id: null });
    return view();
  },
};

window.ponjoHost = {
  async call(type, arg) {
    try {
      return { result: structuredClone(await calls[type](arg ?? {})) };
    } catch (error) {
      return { error: { message: error.message, code: error.code ?? 'bad_input' } };
    }
  },
  onEvent(fn) {
    listener = fn;
    fn('hello', { missing: false, agents: agents() });
  },
};

// ---- the folder (desktop/main.js's side of the sidebar) ----

if (inFolder) {
  const inside = (path, base) => !base || path === base || path.startsWith(`${base}/`);
  const parents = (path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const exists = (path) => s.files[path] !== undefined || Object.keys(s.files).some((file) => parents(file).includes(path));
  let onChanged = () => {};
  s.expanded = [...new Set([...s.expanded, ...parents(current)])]; // the open doc shows in the tree
  save();

  // Show doc `path` here: as in the app, a new page, told how this one left things.
  async function open(path) {
    s.carry = await window.ponjoLeave();
    save();
    location.search = `?folder&doc=${encodeURIComponent(path)}`;
  }

  function changed() {
    save();
    onChanged();
  }

  // The doc's ProjectService.
  calls.list = ({ path }) => {
    const names = new Map();
    for (const file of Object.keys(s.files).filter((f) => inside(f, path) && f !== path)) {
      const [first, ...rest] = (path ? file.slice(path.length + 1) : file).split('/');
      names.set(first, rest.length > 0 || names.get(first) === true);
    }
    return [...names].map(([n, folder]) => ({ name: n, folder }))
      .sort((a, b) => (b.folder - a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  };
  calls.read = ({ path }) => ({ text: s.files[path] ?? '' });

  window.ponjoDesktop = {
    folder() {
      const carry = s.carry;
      s.carry = null;
      save();
      return Promise.resolve({ name: 'ponjo', current, expanded: s.expanded, sidebar: s.sidebar, carry });
    },
    openInFolder: (path) => open(path),
    folderRename(from, kind, to) {
      if (exists(to)) return Promise.resolve({ error: `${name(to)} is already here.` });
      const moved = (path) => to + path.slice(from.length);
      for (const map of [s.files, s.comments]) {
        for (const path of Object.keys(map).filter((p) => (kind === 'folder' ? inside(p, from) : p === from))) {
          map[moved(path)] = map[path];
          delete map[path];
        }
      }
      s.expanded = s.expanded.map((path) => (inside(path, from) ? moved(path) : path));
      if (kind === 'folder' ? inside(current, from) : current === from) {
        current = moved(current);
        history.replaceState(null, '', `?folder&doc=${encodeURIComponent(current)}`);
        emit('renamed', { doc: name(current) });
      }
      changed();
      return Promise.resolve({ rel: to });
    },
    async folderTrash(rel, kind) {
      if (!window.confirm(`Delete ${name(rel)}?`)) return { trashed: false };
      for (const map of [s.files, s.comments]) {
        for (const path of Object.keys(map).filter((p) => (kind === 'folder' ? inside(p, rel) : p === rel))) delete map[path];
      }
      changed();
      if (s.files[current] === undefined && docs().length > 0) await open(docs()[0]);
      return { trashed: true };
    },
    folderExpand(path, isOpen) {
      s.expanded = isOpen ? [...new Set([...s.expanded, path])] : s.expanded.filter((p) => p !== path);
      save();
      return Promise.resolve();
    },
    showSidebar(isOpen) {
      s.sidebar = isOpen;
      save();
      return Promise.resolve();
    },
    onFolderChanged: (fn) => {
      onChanged = fn;
    },
    // The app's menus (new file among them) and dialogs: none in a browser.
    folderMenu: () => Promise.resolve(),
    onFolderCommand: () => {},
    onCommand: () => {},
    openLink: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    revealSidecar: () => Promise.resolve(),
  };
}
