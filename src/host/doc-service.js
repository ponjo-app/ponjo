// DocService (docs/host-spec.md, The doc): orders every edit to one doc, as text
// operations on a revision, and writes the doc and its sidecar, one at a
// time; changes made outside the app; versions. It runs the buddies
// @mentioned in the doc's comments (runner.js) and lands what each run
// changed when it ends. It lives in the doc host; windows call it over a
// message port (desktop/doc-host.js) and hear its events (ops, sidecar,
// agents, settings, history, renamed, missing, room). In project mode its
// project's files are read through ProjectService, and its room run
// through Room (room.js), at the same door.

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnchor, locate } from '../core/anchor.js';
import { COMMENT_ID, newComment, newId, parseSidecar, peopleOf, serializeSidecar, threadsOf, validAnchor } from '../core/comments.js';
import { sameName } from '../core/mentions.js';
import { DEFAULT_SETTINGS, SettingsError } from '../core/settings.js';
import { merge3 } from '../core/diff.js';
import { apply, diffOps, mapOffset, transform } from '../core/ot.js';
import { PROTOCOL } from '../core/protocol.js';
import { StoreError, formFor, hashText, moveDoc, readDoc, readSidecarText, sidecarPath, writeDoc, writeSidecar } from '../store/files.js';
import { VERSION_ID, moveHistory, noteTaken, noteWritten, readHistory, readVersion, recordVersion, writtenEdits } from '../store/history.js';
import { configDir, defaultName, ownerOf, readSettings, updateSettings, watchSettings } from '../store/settings.js';
import { buddiesFor, firstBuddies } from '../store/buddies.js';
import { secretTails } from '../store/secrets.js';
import { readTrace, readUsage, tracedRuns } from '../store/runs.js';
import { watchDoc } from '../store/watch.js';
import { agentsDir, installAgents, listAgents, SHIPPED_AGENTS } from '../store/agents.js';
import { linkURL, pathInProject, projectService, saveImage } from './project-service.js';
import { DocError, LEVELS, can } from './door.js';
import { RoomError } from './room.js';


// A comment's `by`: who wrote it.
const byOf = ({ id, name, kind }) => ({ id, name, kind });
// A change's author in the log: a person or a buddy by id; outside, a file changed by another program.
const authorOf = (who) => ({ id: who.id, kind: who.kind === 'ai' ? 'buddy' : 'person' });
const OUTSIDE = { id: null, kind: 'outside' };

/**
 * Open the doc at `docPath`. Its buddies are the user's and, in project
 * mode, the project folder's (src/store/buddies.js). One @mentioned in a
 * comment of this user's answers it, in a run of the agent script picked in
 * Settings (src/store/agents.js). `settingsDir` is the user's config folder
 * (default: the per-user one): settings, buddies and agent scripts.
 * `folder` is the project folder the doc was opened from (null in doc
 * mode), which runs get as PONJO_PROJECT; `room`,
 * its Room (room.js).
 * `secrets()` gives the agents' secrets, decrypted ({ <agent>: { <key>:
 * value } }, src/store/secrets.js), handed to runs with the other settings.
 * `emit(event, data)` hears what changed. `call(type, arg, who)` runs a request of `who`'s (see
 * `calls`), `owner()` being the `who` of this machine's user;
 * `moveTo(newPath, move)` renames the doc while it is open (`move` defaults
 * to moveDoc and may return the final path).
 * @returns {Promise<{ call: (type: string, arg: object | undefined, who: object) => Promise<object>, owner: () => Promise<object>, leave: (id: string) => void, hello: () => object, running: () => string[], docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, setFolder: (folder: string | null, room: object | null) => void, close: () => Promise<void> }>}
 */
export async function openDocService(docPath, { folder = null, room = null, settingsDir = configDir(), secrets = () => ({}), emit = () => {} } = {}) {
  const opened = await readDoc(docPath); // fail early on a missing doc
  // Who hears every change as it lands (subscribe): the doc's buddies.
  const listeners = new Set();
  const tell = (event) => { for (const fn of listeners) fn(event); };
  let lastSidecarHash = null;
  let lastSettings = null;
  let missing = false; // the doc was moved or deleted on disk while open
  // Writes to the doc and its sidecar, and the edits landing, run one at a
  // time, so a rename never lands in the middle of a save; none once closed
  // (a write tried again, a change seen, while it closed).
  let writes = Promise.resolve();
  let closed = false;
  const serial = (fn) => {
    const run = writes.then(() => (closed ? undefined : fn()));
    writes = run.catch(() => {});
    return run;
  };
  let chronicle = Promise.resolve(); // the queue that keeps versions in order (src/store/history.js)

  // ---- the doc: every edit is operations on a revision ----

  // The doc's text, as edits have landed on it; `rev` counts them since
  // this service started, `epoch` names that start (a window that sees a
  // new one takes the text again). `log` holds the latest landed edits, the
  // one that made rev `logStart + k + 1` at k, to move a window's edit from
  // an older rev, to know a window's edit sent again, and to tell a window
  // what it missed: { ops, id, event }.
  // `written` is the text the file holds as last written or read,
  // `writtenHash` its hash: a file that is not that changed outside.
  // `writtenStat` is the file's stat as this service last wrote it: a file
  // that still has it is not read again (a doc of millions of characters
  // takes tens of milliseconds), `form` how its lines end.
  let text = opened.text;
  let rev = 0;
  const epoch = newId('e');
  const log = [];
  let logStart = 0;
  let written = text;
  let writtenHash = opened.hash;
  let writtenStat = null;
  let form = opened.form;
  // Whether the file, as `now` (a stat, or null) says, is still as this service wrote it.
  const ours = (now) => sameStat(now, writtenStat);
  let told = []; // landed edits not yet written and told to windows, as `ops` events
  // Where each person has their cursor: id → { id, name, at },
  // `at` an offset in the text at `toldRev`, the last rev windows were told
  // of, so a window places it on its own text; told to every window as
  // `cursors`, with `by`, whose cursor moved. Never queued behind writes.
  const cursors = new Map();
  let toldRev = 0;
  const tellCursors = (by = null) => emit('cursors', { epoch, rev: toldRev, cursors: [...cursors.values()], by });
  // The cursors on the text at `rev`.
  const cursorsNow = () => [...cursors.values()].map((cursor) => ({
    ...cursor, at: log.slice(toldRev - logStart, rev - logStart).reduce((at, landed) => mapOffset(at, landed.ops), cursor.at),
  }));
  // Windows' edits the file holds that a service before this one may not
  // have told them of (noteWritten), kept in each note after.
  const landedBefore = await writtenEdits(docPath, settingsDir, opened.hash);
  const noteIds = () => [...landedBefore, ...log.map((landed) => landed.id).filter(Boolean)].slice(-LOG_SIZE);
  let writtenIds = landedBefore; // the ids noted for the file as last written
  const landedRevs = new Map(); // every window's edit landed here: its id → the rev it made
  let retry = null; // a write that failed, tried again, `retryMs` after it
  let retryMs = RETRY_MS;
  let notSaved = null; // why the file does not hold the doc as windows were told, or null

  // Edit `ops` lands on the text, from a window (`id`, the window's name for
  // it) or from here, merged already (merge3): a buddy's turn (buddy `by`,
  // and its `reply`), an outside change, an undo.
  function land(ops, meta) {
    const event = { epoch, rev: rev + 1, ops, id: meta.id ?? null, by: meta.by, ...(meta.reply ? { reply: meta.reply } : {}) };
    log.push({ ops, id: meta.id, event });
    if (meta.id) landedRevs.set(meta.id, rev + 1);
    if (log.length > LOG_SIZE) {
      log.shift();
      logStart++;
    }
    text = apply(text, ops);
    rev++;
    told.push(event);
    tell(event);
  }
  // The comments changed, by `by`: a change in the log too, with no
  // operations on the text, told to every window as the next commit tells
  // its edits.
  function changedComments(by) {
    const event = { epoch, rev: rev + 1, ops: [], id: null, by, comments: true };
    log.push({ ops: [], event });
    if (log.length > LOG_SIZE) {
      log.shift();
      logStart++;
    }
    rev++;
    told.push(event);
    tell(event);
  }

  // Write what landed, then tell every window: what a window has heard of is
  // in the file. A file changed outside since it was last written is merged
  // first, and one changed while it was being written, just before it took
  // the file's place, too, then written again. A missing doc is not
  // written; its edits are still told. A write that fails is tried again,
  // twice as long after each time, until it is written, nothing told
  // meanwhile; every window hears why it is not saved (`saved`), and when
  // it is. Run in `serial`.
  async function commit() {
    clearTimeout(retry);
    let wroteAny = false; // its note says only that it is about to be
    try {
      while (!missing && text !== written) {
        const before = await stat(docPath).catch(() => null);
        if (!ours(before)) {
          let disk;
          try {
            disk = await readOutside();
          } catch (error) {
            if (error.code !== 'no_doc') throw error;
            break;
          }
          form = disk.form;
          if (disk.hash !== writtenHash) await takeOutside(disk);
          if (text === written) break;
        }
        // A window told nothing yet, should this service stop now, learns from it its edit is in;
        // if the write fails, the note is again of what the file holds.
        const hash = hashText(text);
        const ids = noteIds();
        await noteWritten(docPath, settingsDir, hash, ids, writtenIds);
        form = formFor(text, form);
        const wrote = await writeDoc(docPath, text, form, async () => sameStat(await stat(docPath).catch(() => null), before)).catch(async (error) => {
          await noteWritten(docPath, settingsDir, writtenHash, writtenIds);
          throw error;
        });
        if (!wrote) continue;
        writtenHash = hash;
        writtenIds = ids;
        writtenStat = wrote;
        written = text;
        wroteAny = true;
      }
    } catch (error) {
      retry = setTimeout(() => serial(commit).catch(() => {}), retryMs);
      retryMs = Math.min(2 * retryMs, MAX_RETRY_MS);
      tellSaved(unsavedReason(error));
      throw error;
    }
    retryMs = RETRY_MS;
    tellSaved(null);
    for (const event of told.splice(0)) {
      for (const cursor of cursors.values()) cursor.at = mapOffset(cursor.at, event.ops);
      toldRev = event.rev;
      emit('ops', event);
    }
    // Written now, so landed even if the file changes outside before the next write.
    if (wroteAny) await noteWritten(docPath, settingsDir, writtenHash, writtenIds).catch(() => {});
  }

  // The file as changed outside, once it holds still: another program may be
  // half way through writing it, emptied with the rest to come.
  async function readOutside() {
    for (let tries = 1; ; tries++) {
      const was = await stat(docPath).catch(() => null);
      const disk = await readDoc(docPath);
      await new Promise((done) => setTimeout(done, STILL_MS));
      if (tries === STILL_TRIES || sameStat(await stat(docPath).catch(() => null), was)) return disk;
    }
  }

  // Commit an edit that has landed whatever the file does: a write that
  // fails is tried again (commit), and resolves to the `not_saved` error to
  // give whoever asked once all else the edit needs is done; else null.
  const committed = () => commit().then(() => null, (error) => new DocError('not_saved', unsavedReason(error)));

  // Every window hears whether the file holds the doc as they were told
  // (`error` null), or why not, as that changes.
  function tellSaved(error) {
    if (error === notSaved) return;
    notSaved = error;
    emit('saved', { error });
  }

  // A change made outside (another program, git pull), found on disk as
  // `disk`: it is in history first, then merged with what landed since the
  // file was last written (merge3). Where both changed the same lines, what
  // landed here stays and the outside version is only in history. Run in
  // `serial`.
  async function takeOutside(disk) {
    if (typing !== null) { // the typing the file held, a version before the outside one
      clearTimeout(typing);
      typing = null;
      await noteVersion(written, await typingChange());
    }
    await noteVersion(disk.text, { kind: 'external', author: null });
    const merged = merge3(written, text, disk.text).text;
    written = disk.text;
    writtenHash = disk.hash;
    await noteWritten(docPath, settingsDir, writtenHash, writtenIds); // the edits written so far: landed, though the file now holds another's
    land(diffOps(text, merged), { by: OUTSIDE });
    if (text !== disk.text) await noteVersion(text, { kind: 'edit', author: await me() });
  }

  // Typing is a version once everyone typing has paused (src/store/history.js
  // joins a burst of it into one), and before any edit that is not theirs:
  // one version, by each person who typed in it.
  let typing = null;
  let typists = []; // who typed since the last version, as comments name them
  function typed(who) {
    if (!typists.some((t) => t.id === who.id)) typists.push(byOf(who));
    clearTimeout(typing);
    typing = setTimeout(() => serial(flushTyping), SAVE_DELAY_MS);
  }
  // The version's change for the typing so far; the next typing is a new burst.
  async function typingChange() {
    const [author = await me(), ...more] = typists.splice(0);
    return { kind: 'edit', author, ...(more.length > 0 ? { authors: [author, ...more] } : {}) };
  }
  async function flushTyping() {
    if (typing === null) return;
    clearTimeout(typing);
    typing = null;
    await noteVersion(text, await typingChange());
  }

  // An edit: operations `ops` on rev `rev` of epoch `epoch`, moved over what
  // landed since, by character. `id` names it in the `ops` event that tells
  // it; one sent again once it landed lands no more, and is answered as it
  // was. An epoch or rev this service no longer has is `stale`: the window
  // takes the text again (state) and sends its edit on that. An edit with
  // `reply` is a group: the edits a comment carries (a buddy's), a version of
  // its own hung on that comment in `thread`, `conflict` when people's lines
  // stayed where it collided; else it is typing.
  async function submit({ ops, rev: at, epoch: from, id, reply, thread, conflict = false } = {}, who) {
    if (!validOps(ops) || !Number.isInteger(at) || typeof id !== 'string') throw new DocError('bad_input', 'expected { ops, rev, epoch, id }');
    if (reply !== undefined && !(COMMENT_ID.test(reply) && COMMENT_ID.test(thread))) throw new DocError('bad_input', 'expected the comment and thread of a group');
    return serial(async () => {
      const landedAt = from === epoch && landedRevs.get(id);
      if (landedAt) {
        const failed = await committed();
        if (failed) throw failed;
        return { rev: landedAt };
      }
      if (from !== epoch || at < logStart || at > rev) throw new DocError('stale', 'the doc has moved on: take it again');
      for (const landed of log.slice(at - logStart)) ops = transform(ops, landed.ops);
      if (ops.length > 0 && ops.at(-1).to > text.length) throw new DocError('bad_input', 'operations past the end of the doc');
      if (reply === undefined) {
        land(ops, { id, by: authorOf(who) });
        typed(who);
      } else {
        await flushTyping();
        land(ops, { id, by: authorOf(who), reply });
        await noteVersion(text, { kind: 'edit', author: { ...byOf(who), kind: who.kind === 'ai' ? 'agent' : who.kind }, thread, reply, ...(conflict ? { conflict: true } : {}) });
      }
      const failed = await committed();
      if (failed) throw failed;
      return { rev };
    });
  }

  // A missing doc written back as it is here, by `who`.
  async function recreate(who) {
    if (!missing) return {};
    await mkdir(dirname(docPath), { recursive: true });
    const ids = noteIds();
    await noteWritten(docPath, settingsDir, hashText(text), ids, writtenIds);
    writtenStat = await writeDoc(docPath, text, form);
    writtenHash = hashText(text);
    writtenIds = ids;
    written = text;
    await noteVersion(text, { kind: 'edit', author: byOf(who) });
    return {};
  }

  // `who`'s cursor is at offset `at` of the text at rev `rev` of `epoch`;
  // one from a rev windows are not all told of yet, or this service no
  // longer has, is dropped (the next comes).
  function cursor({ at, rev: from, epoch: of } = {}, who) {
    if (!Number.isInteger(at) || at < 0 || !Number.isInteger(from)) throw new DocError('bad_input', 'expected { at, rev, epoch }');
    if (of !== epoch || from < logStart || from > toldRev) return {};
    const now = log.slice(from - logStart, toldRev - logStart).reduce((offset, landed) => mapOffset(offset, landed.ops), at);
    cursors.set(who.id, { id: who.id, name: who.name, at: now });
    tellCursors(who.id);
    return {};
  }

  // Put the doc back the way it was in an earlier version, as `who`'s
  // edit: a new version, so the restore can itself be undone. Comments
  // stay; readers find their anchors in the restored text.
  async function restoreVersion(body, who) {
    const found = await readVersion(docPath, settingsDir, versionId(body?.id));
    if (!found) throw new DocError('not_found', 'no such version');
    await flushTyping();
    land(diffOps(text, found.text), { by: authorOf(who) });
    await committed(); // landed: windows hear if it is not saved
    await noteVersion(text, { kind: 'restore', author: byOf(who), restoredFrom: body.id });
    return {};
  }

  // The doc as `who` sees it, and their `level`. The owner's settings and
  // name are theirs alone: anyone else gets the default settings, and is
  // `me` themselves. A window that has the text at `since` ({ epoch, rev })
  // gets the `events` it missed since, as told, while the log holds them.
  async function state({ since } = {}, who) {
    const owner = can(who, 'owner');
    const caught = since?.epoch === epoch && Number.isInteger(since.rev) && since.rev >= logStart && since.rev <= toldRev;
    return {
      doc: basename(docPath),
      text,
      epoch,
      rev,
      ...(caught ? { events: log.slice(since.rev - logStart, toldRev - logStart).map((landed) => landed.event) } : {}),
      landed: landedBefore,
      notSaved,
      ...(await commentsView(text)),
      settings: owner ? (await readSettings(settingsDir)).settings : DEFAULT_SETTINGS,
      defaultName: owner ? defaultName() : who.name,
      me: owner ? await me() : byOf(who),
      level: who.level,
      owner: (await me()).id, // whose face wears the crown
      cursors: cursorsNow(),
      project: folder !== null, // whether the doc was opened from a project
      // The project's name and the doc's path in it, for a teammate's sidebar.
      place: folder && { name: basename(folder), path: await pathInProject(folder, docPath) },
    };
  }

  // ---- comments (spec/SPEC.md) ----

  // The sidecar as it is on disk: its lines, the lines it could not read,
  // and the `problem` that makes it read-only (parseSidecar).
  async function readComments() {
    const text = await readSidecarText(docPath);
    return text === null ? { lines: [], bad: [], problem: null } : parseSidecar(text);
  }

  // The threads as a window shows them: each anchor where it is now in the
  // doc's `text` (it is never rewritten in the file), or `detached`; who
  // wrote in them; why they are read-only (`readOnly`, parseSidecar's
  // problem); and a notice about lines of the sidecar that cannot be read.
  async function commentsView(text) {
    const { lines, bad, problem } = await readComments();
    const comments = lines.map((l) => l.comment).filter(Boolean);
    const threads = threadsOf(comments, (await buddies()).map(({ id, name }) => ({ id, name })), text).map((thread) => {
      if (!thread.anchor) return { ...thread, detached: false };
      const found = locate(text, thread.anchor);
      return { ...thread, anchor: found ? createAnchor(text, found.start, found.end) : thread.anchor, detached: !found };
    });
    const file = basename(sidecarPath(docPath));
    const notice = bad.length > 0 && !problem ? `${bad.length === 1 ? 'A line' : `${bad.length} lines`} of ${file} could not be read; ${bad.length === 1 ? 'it is' : 'they are'} kept as written.` : null;
    return { threads, people: peopleOf(comments), edits: await replyEdits(), readOnly: problem, notice };
  }

  // Add or remove lines of the sidecar, written whole, as `by`. Run in
  // `serial`. The comments as `change` makes them, a change in the log;
  // then the buddies look at what is asked.
  async function changeComments(change, by) {
    const current = await readComments();
    if (current.problem) throw new DocError('read_only', `${basename(sidecarPath(docPath))} is read-only here, so it is not changed`);
    const next = await change(current.lines);
    if (next === current.lines) return;
    await writeSidecar(docPath, serializeSidecar(next));
    lastSidecarHash = await fileHash(sidecarPath(docPath)); // this service's own write
    changedComments(by);
    await commit().catch(() => {}); // the doc not saved holds the telling; it is tried again
  }

  // A comment by `who`: a first comment (`anchor` on the doc's text, or
  // null for the whole doc), or a reply in `thread` (with `anchor`: the text
  // its edits moved the thread to, SPEC §3). Resolving is an empty reply with
  // `resolved`, reopening an empty reply; neither asks anyone. A reply comes
  // after every comment in its thread, or, with `after` (a time), just after
  // that: a buddy's reply to what it was given comes before what was written
  // meanwhile, still to answer. With `id`, one sent again is answered, not
  // added twice. Only a comment taken here asks (asks): it is noted before it
  // is written.
  async function comment({ id, thread, anchor = null, body, resolved, after } = {}, who) {
    if (typeof body !== 'string' || (body.trim() === '' && thread === undefined)) throw new DocError('bad_input', 'a comment needs text');
    if (anchor !== null && !validAnchor(anchor)) throw new DocError('bad_input', 'invalid anchor');
    if (resolved === true && thread === undefined) throw new DocError('bad_input', 'only a reply can resolve');
    if ((id !== undefined && !COMMENT_ID.test(id)) || (after !== undefined && (thread === undefined || Number.isNaN(Date.parse(after))))) throw new DocError('bad_input', 'expected { id?, thread, after? }');
    let added;
    await serial(() => changeComments(async (lines) => {
      added = id !== undefined && lines.find((l) => l.comment?.id === id)?.comment;
      if (added) return lines;
      if (thread !== undefined && !lines.some((l) => l.comment?.id === thread && l.comment.thread === undefined)) throw new DocError('not_found', 'no such thread');
      // A reply is after every comment in its thread, though written in the
      // same millisecond: a thread is ordered by `at` (SPEC §4).
      const at = thread === undefined ? Date.now() : after !== undefined ? Date.parse(after) + 1 : lines.reduce((last, { comment: c }) => (
        c && (c.id === thread || c.thread === thread) ? Math.max(last, Date.parse(c.at) + 1) : last), Date.now());
      added = { ...newComment({ thread, anchor, body, resolved }, { by: byOf(who), at: new Date(at).toISOString() }), ...(id !== undefined ? { id } : {}), ...(thread !== undefined && anchor !== null ? { anchor } : {}) };
      if (body.trim() !== '') await noteTaken(docPath, settingsDir, added, lines.map((l) => l.comment?.id));
      return [...lines, { comment: added }];
    }, authorOf(who)));
    return { ...(await commentsView(text)), id: added.id, at: added.at };
  }

  // ---- the doc's buddies ----

  // The user's buddies and, in a project, the project's.
  const buddies = () => buddiesFor(folder, settingsDir);
  // The names of the teammates in the project's room.
  const teammateNames = () => room?.names() ?? [];

  // ---- undo ----

  // Undo version `id` (docs/host-spec.md, Versions and undo), or every
  // version from `from` to it: the change from the parent of `from` to `id`
  // taken back, merged with everything landed since (merge3), so lines
  // anyone changed since stay. On the machine that has the versions; by
  // `who`.
  async function undo({ id, from = id } = {}, who) {
    await chronicle;
    const [after, first] = await Promise.all([id, from].map((v) => readVersion(docPath, settingsDir, versionId(v))));
    if (!after || first?.before == null) throw new DocError('not_found', 'that change is not in this machine\'s history');
    await flushTyping();
    land(diffOps(text, merge3(after.text, text, first.before).text), { by: authorOf(who) });
    await committed(); // landed: windows hear if it is not saved
    await noteVersion(text, { kind: 'undo', author: byOf(who), undid: id });
    return commentsView(text);
  }

  // The runs that edited the doc on this machine, by their reply: { [replyId]:
  // { state: 'edited' | 'undone', by, changes, version, undo, conflict } },
  // `changes` how many places the run changed, `version` the version that
  // holds the doc right after it, `undo` (while undone) the version of its
  // last undo, whose undo redoes it, and `conflict` whether people's lines
  // stayed where it collided with them.
  async function replyEdits() {
    await chronicle; // a run's version is in before the page reads the doc it wrote
    const edits = {};
    const versions = await readHistory(docPath, settingsDir);
    const lastUndo = new Map(versions.filter((v) => v.undid).map((v) => [v.undid, v.id]));
    for (const v of versions) {
      const undo = lastUndo.get(v.id);
      const undone = Boolean(undo) && !lastUndo.has(undo);
      if (v.reply) edits[v.reply] = { state: undone ? 'undone' : 'edited', by: v.author?.id ?? v.author?.name ?? null, changes: v.changes ?? 0, version: v.id, ...(undone ? { undo } : {}), conflict: Boolean(v.conflict) };
    }
    return edits;
  }

  // ---- buddy files ----

  // Add the doc as it now reads to its history (one version at a time, in
  // order); a failure is logged and never stops a save.
  function noteVersion(text, change) {
    const run = chronicle.then(async () => {
      const version = await recordVersion(docPath, settingsDir, text, change);
      if (version) emit('history', { id: version.id });
    });
    chronicle = run.catch((error) => console.error('Could not record a version:', error));
    return chronicle;
  }

  // This user, as their comments name them.
  function me() {
    return ownerOf(settingsDir);
  }

  // Watch both files and tell the page what changed, including the doc
  // going missing (moved or deleted outside the app) and coming back.
  async function onFilesChanged() {
    try {
      if (!(await serial(onDocChanged))) return;
      const sidecarHash = await fileHash(sidecarPath(docPath));
      if (sidecarHash !== lastSidecarHash) {
        lastSidecarHash = sidecarHash;
        await serial(async () => {
          changedComments(OUTSIDE);
          await commit().catch(() => {});
        });
      }
    } catch (error) {
      if (!(error instanceof StoreError)) console.error(error);
    }
  }

  // The doc's part of onFilesChanged; false when it is missing. In `serial`,
  // so a write of this service's is all before the read or all after it:
  // a read from before it is never taken for someone else's change.
  async function onDocChanged() {
    if (!missing && ours(await stat(docPath).catch(() => null))) return true; // this service's own write
    let doc;
    try {
      doc = await readOutside();
    } catch (error) {
      // Made not text outside: the doc stays as it is here, not saved, until the file is text again.
      if (error.code === 'not_text') {
        tellSaved(unsavedReason(error));
        return true;
      }
      if (error.code !== 'no_doc') throw error;
      if (!missing) {
        missing = true;
        emit('missing', { missing: true, doc: basename(docPath) });
      }
      return false;
    }
    if (missing) {
      missing = false;
      emit('missing', { missing: false, doc: basename(docPath) });
    }
    const outside = doc.hash !== writtenHash; // not this service's write: a change made outside
    if (outside) await takeOutside(doc);
    if (outside || notSaved) await commit();
    return true;
  }

  // Settings are shared with every other window: pass on changes from any
  // of them.
  async function onSettingsChanged() {
    try {
      const { settings } = await readSettings(settingsDir);
      const json = JSON.stringify(settings);
      if (json === lastSettings) return;
      lastSettings = json;
      emit('settings', settings);
    } catch (error) {
      console.error(error);
    }
  }

  async function moveTo(newPath, move = moveDoc) {
    return serial(async () => {
      const target = (await move(docPath, newPath)) ?? newPath;
      stopWatching();
      await chronicle;
      await moveHistory(docPath, target, settingsDir).catch((error) => console.error('Could not move the history:', error));
      docPath = target;
      // A folder moved with the doc in it: the watch may have seen it go.
      if (missing) emit('missing', { missing: false, doc: basename(docPath) });
      missing = false;
      stopWatching = watchDoc(docPath, onFilesChanged);
      emit('renamed', { doc: basename(docPath) });
      return docPath;
    });
  }

  await installAgents(settingsDir).catch((error) => console.error('Could not write the agent scripts:', error));
  await firstBuddies(settingsDir).catch((error) => console.error('Could not write the first buddy:', error));
  await noteVersion(text, { kind: 'external', author: null }); // the doc as first seen, or as changed while it was not open
  lastSidecarHash = await fileHash(sidecarPath(docPath));
  lastSettings = JSON.stringify((await readSettings(settingsDir)).settings);
  let stopWatching = watchDoc(docPath, onFilesChanged);
  const stopWatchingSettings = watchSettings(onSettingsChanged, settingsDir);
  let project = folder ? projectService(folder) : null;
  const inProject = () => {
    if (!project) throw new DocError('bad_input', 'a doc on its own has no project');
    return project;
  };
  const inRoom = () => {
    if (!room) throw new DocError('bad_input', 'a doc on its own has no room');
    return room;
  };
  async function changeRoom(fn) {
    await fn(inRoom());
    return room.list();
  }
  // The owner's windows follow the room (desktop/doc-host.js sends `room` to
  // theirs alone).
  const followRoom = () => room?.onChange(() => emit('room', room.list())) ?? (() => {});
  let stopFollowingRoom = followRoom();

  // What a window may ask, by the level it needs (`can`). Each returns what
  // changed, for the window that asked.
  const calls = {
    read: {
      state,
      cursor,
      async history() {
        await serial(flushTyping); // typing not paused yet is a version too
        await chronicle;
        return { versions: await readHistory(docPath, settingsDir) };
      },
      async version(body) {
        const found = await readVersion(docPath, settingsDir, versionId(body?.id));
        if (!found) throw new DocError('not_found', 'no such version');
        return found;
      },
      // The project's files (project-service.js), `path` in the project.
      // Its real path is the owner's alone.
      list: (body) => inProject().list(body?.path),
      // An image the doc shows, `src` as written in it (linkURL): from the
      // project, or for a doc on its own, from its folder.
      image(body) {
        const root = folder ?? dirname(docPath);
        const url = linkURL(String(body?.src), docPath, folder);
        if (url.protocol !== 'file:') throw new DocError('not_found', 'not a file of the doc');
        return (project ?? projectService(root)).image(relative(root, fileURLToPath(url)).split(sep).join('/'));
      },
      read: (body) => inProject().read(body?.path),
      search: (body) => inProject().search(body?.query, body?.options),
      async open(body, who) {
        const opened = await inProject().open(body?.path);
        return can(who, 'owner') ? opened : { path: body.path };
      },
    },
    write: {
      submit,
      recreate: (body, who) => serial(() => recreate(who)),
      comment: (body, who) => comment({ id: body?.id, thread: body?.thread, anchor: body?.anchor ?? null, body: body?.body, resolved: body?.resolved, after: body?.after }, who),
      restoreVersion: (body, who) => serial(() => restoreVersion(body, who)),
      undo: (body, who) => serial(() => undo(body, who)),
    },
    owner: {
      async saveSettings(patch) {
        if (patch && Object.hasOwn(patch, 'id')) throw new DocError('bad_input', 'your id cannot be changed');
        // Your name is no buddy's or teammate's here, as theirs are not yours.
        if (typeof patch?.name === 'string' && [...(await buddies()).map((b) => b.name), ...teammateNames()].some((n) => sameName(n, patch.name))) throw new DocError('bad_input', `the name ${patch.name} is taken`);
        try {
          return { settings: await updateSettings(patch, settingsDir) };
        } catch (error) {
          if (error instanceof SettingsError) throw new DocError('bad_input', error.message);
          throw error;
        }
      },
      scripts: async () => ({ agents: await listAgents(settingsDir), shipped: SHIPPED_AGENTS, folder: agentsDir(settingsDir), secrets: secretTails(secrets()) }),
      // A shipped agent script, written again as it came.
      async resetScript(body) {
        if (!SHIPPED_AGENTS.includes(body?.name)) throw new DocError('bad_input', 'not a shipped agent');
        await installAgents(settingsDir, { reset: body.name });
        return { agents: await listAgents(settingsDir) };
      },
      // An image pasted or dropped into the doc: written beside it, the path to write in it.
      saveImage: async (body) => ({ src: await saveImage(dirname(docPath), body) }),
      runs: async () => ({ runs: await tracedRuns(settingsDir, docPath) }),
      // What buddies' runs used of the Claude API, for Settings > Usage.
      usage: () => readUsage(settingsDir),
      async trace(body) {
        const trace = await readTrace(settingsDir, body?.run);
        if (!trace) throw new DocError('not_found', 'no trace of that run');
        return { trace };
      },
      // The project's room (room.js), each call answered with the room as it is then.
      room: () => inRoom().list(),
      openRoom: () => changeRoom((r) => r.open()),
      closeRoom: () => changeRoom((r) => { r.close(); }),
      lockRoom: (body) => changeRoom((r) => r.lock(body?.locked)),
      setLevel: (body) => changeRoom((r) => r.setLevel(body?.id, body?.level)),
      kick: (body) => changeRoom((r) => r.kick(body?.id)),
    },
  };

  const api = {
    /**
     * The doc for a client in this process (the doc world): its text, rev,
     * epoch, whether it is missing, its comments as read (readComments),
     * and `submit` and `comment` through the door.
     */
    door: {
      text: () => text, rev: () => rev, epoch: () => epoch, missing: () => missing,
      readComments: () => readComments(),
      submit: (arg, who) => api.call('submit', arg, who),
      comment: (arg, who) => api.call('comment', arg, who),
    },
    /** `fn(change)` hears each change as it lands, its `ops` event (land); returns how to stop. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // The door: every call comes through here, once, as `who`.
    async call(type, arg, who) {
      const level = LEVELS.find((l) => Object.hasOwn(calls[l], type));
      if (!level) throw new DocError('bad_input', `unknown call: ${type}`);
      if (!can(who, level)) throw new DocError('forbidden', `${who?.name ?? 'no one'} may not ${type} here`);
      try {
        return await calls[level][type](arg, who);
      } catch (error) {
        if (error instanceof StoreError || error instanceof RoomError) throw new DocError(error.code, error.message);
        throw error;
      }
    },
    /** The owner of this machine, as a `who`. */
    owner: async () => ({ ...(await me()), level: 'owner' }),
    /** Person `id` has no window or page on the doc any more: their cursor goes. */
    leave(id) {
      if (!cursors.delete(id)) return;
      tellCursors();
    },
    /** What a window hears first: the version of the messages, whether the doc is missing, and who is at work. */
    hello: () => ({ protocol: PROTOCOL, missing }),
    docPath: () => docPath,
    moveTo,
    setFolder(next, nextRoom) {
      folder = next;
      project = folder ? projectService(folder) : null;
      stopFollowingRoom();
      room = nextRoom;
      stopFollowingRoom = followRoom();
    },
    // Closed even when its last write fails: what was not written is lost.
    async close() {
      try {
        await serial(async () => {
          try {
            await commit();
            await flushTyping();
          } finally {
            closed = true;
          }
        });
      } finally {
        clearTimeout(retry);
        stopWatching();
        stopWatchingSettings();
        stopFollowingRoom();
      }
    },
  };
  return api;
}

// How many landed edits the log keeps: a window's edit from an older rev is stale.
const LOG_SIZE = 1000;
// A write that failed is tried again after this long.
const RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;
// Typing is a version once it pauses this long.
const SAVE_DELAY_MS = 800;
// A file changed outside is taken once it is unchanged this long, waiting at most STILL_TRIES times.
const STILL_MS = 50;
const STILL_TRIES = 20;

// Why a write failed, as a person reads it, and with no path: teammates hear it too.
function unsavedReason(error) {
  if (error.code === 'not_text') return 'the file was saved outside Ponjo as other than UTF-8 text';
  if (error.code === 'ENOSPC') return 'the disk is full';
  if (['EBUSY', 'ETXTBSY'].includes(error.code)) return 'another program is using the file';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return 'the file or its folder cannot be written';
  return 'the file cannot be written';
}

// Whether `ops` is an edit: { from, to, insert } in order, not overlapping.
function validOps(ops) {
  if (!Array.isArray(ops)) return false;
  let at = 0;
  for (const op of ops) {
    if (!Number.isInteger(op?.from) || !Number.isInteger(op.to) || typeof op.insert !== 'string' || op.from < at || op.to < op.from) return false;
    at = op.to;
  }
  return true;
}

// Whether stats `a` and `b` (or null) are of one file, unchanged.
const sameStat = (a, b) => Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino);

function versionId(id) {
  if (typeof id !== 'string' || !VERSION_ID.test(id)) throw new DocError('bad_input', 'invalid version id');
  return id;
}

async function fileHash(path) {
  try {
    return 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}
