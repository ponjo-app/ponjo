// The doc as a world (docs/agent-runtime.md, The world's five calls): who
// its members are, what is asked, what a member sees, and how what a run
// left behind lands. It reaches the doc only through its door, writing as
// the buddy, and knows nothing of runs.

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { asksIn, movedAnchor, newId, parseSidecar, threadsOf } from '../core/comments.js';
import { merge3 } from '../core/diff.js';
import { diffOps } from '../core/ot.js';
import { buildPrompt, newSince } from '../core/prompt.js';
import { toChanges } from '../core/translate.js';
import { listActions } from '../store/actions.js';
import { readTaken } from '../store/history.js';
import { SIDECAR_SUFFIX, readSidecarText } from '../store/files.js';
import { settingsWithId } from '../store/settings.js';
import { createDocActions } from './doc-actions.js';

const DEPTH_LIMIT = 1000;
/** How long people's edits pause before a buddy watching runs on them (ms). */
export const SETTLE_MS = 5000;
// Who made a change in the door's log, as the runtime names them.
const KINDS = { person: 'person', buddy: 'agent', outside: 'world' };

/**
 * The world of one open doc. `door` is how it reads the doc and lands a
 * change: { text(), rev(), epoch(), missing(), changes(since) (those after
 * rev `since`), readComments() (the sidecar's lines and problem),
 * submit(arg, who), comment(arg, who) }. `subscribe(fn)` calls `fn` as each
 * change lands (doc-service.js). `place()` is { docPath, folder, room } as they are now,
 * `pathInProject()` the doc's path in its project (`/`-separated);
 * `buddies()` the buddies the doc reaches and `me()` the owner.
 */
export function createDocWorld({ door, subscribe, place, pathInProject, buddies, me, settingsDir, emit = () => {} }) {
  // The comments a run here posted → { for (the people it was for), depth
  // (its run's) }: its @mentions ask.
  const posted = new Map();
  // Who waits for the next change: each is told as one lands, then reads
  // the door's log, so a change it was not told of is in it all the same.
  const waiting = new Set();
  subscribe(() => {
    for (const done of waiting) done();
  });
  // What runs here proposed to do outside the doc; each result is its buddy's reply, a step deeper.
  const actions = createDocActions({
    settingsDir, docPath: () => place().docPath, owner: me, changed: (list) => emit('actions', list),
    async reply(action, body) {
      const { id } = await door.comment({ id: newId('c'), thread: action.thread, anchor: null, body }, { ...action.buddy, kind: 'ai', level: 'write' });
      posted.set(id, { for: action.for, depth: action.depth + 1 });
    },
  });

  // Who is here: the owner, the room's teammates and the buddies, each {
  // id, name, kind ('person' or 'agent'), mayAsk } and a buddy's own fields.
  async function members() {
    const agents = await buddies();
    const owner = await me();
    const teammates = place().room?.list()?.teammates ?? [];
    return [
      { id: owner.id, name: owner.name, kind: 'person', mayAsk: true },
      ...teammates.map((p) => ({ id: p.id, name: p.name, kind: 'person', mayAsk: p.level === 'write' })),
      ...agents.map((b) => ({ ...b, kind: 'agent', mayAsk: false })),
    ];
  }

  // The doc's threads now (threadsOf), and why its comments cannot be read, or null.
  async function threadsNow(mentionable = []) {
    const { lines, problem } = await door.readComments();
    return { threads: threadsOf(lines.map((l) => l.comment).filter(Boolean), mentionable, door.text()), problem };
  }

  return {
    // How deep agents may wake each other: high, so two buddies can play a long game.
    limits: { depth: DEPTH_LIMIT },
    settleMs: SETTLE_MS,

    // A view's fingerprint: its doc's text's (its comments wake no watcher).
    print: (files) => createHash('sha256').update(files.text).digest('base64url'),
    // What wakes a buddy: lines of the doc, each whole.
    wakes: (files, lines) => lines.some((l) => files.text.split(/\r?\n/).includes(l)),

    actions,

    members,

    /**
     * Wait until something changed after `version`, or until `deadline`
     * (performance.now()): { rev (the version now), log (the changes after
     * `version` the door's log still holds, oldest first, as the runtime
     * reads them (runtime.js, Change): a buddy's change is an agent's, a
     * file written outside the app the world's own (it is whole, as the
     * door took it once it held still); one only to the comments changes
     * only what is asked; a person's edit leaves the runs only a watch
     * started stale, but an outside one does not, as a program may write
     * more often than a run lasts: the run lands merged, and runs again on it }.
     */
    async wait(version, deadline) {
      for (;;) {
        const since = door.changes(version).map(({ by, comments, ...change }) => ({ ...change, by: { ...by, kind: KINDS[by.kind] }, asks: comments, stale: by.kind === 'person' && !comments }));
        if (since.length || performance.now() >= deadline) return { rev: door.rev(), log: since };
        await new Promise((resolve) => {
          const done = () => {
            waiting.delete(done);
            clearTimeout(timer);
            resolve();
          };
          const timer = Number.isFinite(deadline) ? setTimeout(done, deadline - performance.now()) : null;
          waiting.add(done);
        });
      }
    },

    /**
     * The open asks (asksIn). Rejects with code 'unreadable' when the
     * comments cannot be read: then no ask can be answered.
     */
    async asks() {
      const agents = await buddies();
      const { threads, problem } = await threadsNow(agents.map(({ id, name }) => ({ id, name })));
      if (problem) throw Object.assign(new Error(`the comments cannot be read (${problem})`), { code: 'unreadable' });
      const askers = (await members()).filter((m) => m.mayAsk).map((m) => m.id);
      return asksIn(threads, askers, await readTaken(place().docPath, settingsDir), posted);
    },

    /**
     * What `agent` ({ id, name, about }) sees: { rev, files (copies of the
     * doc and its comments, at the doc's path in the project, and the
     * project folder to read: { path, text, comments, project }), prompt
     * (buildPrompt) }, given `asks` (theirs, from asks()) and, for a
     * watcher, `since`: the files of its last look, or null on its first.
     */
    async view(agent, { since, asks = [] }) {
      const rev = door.rev();
      const { docPath, folder } = place();
      const files = { path: folder ? await pathInProject() : basename(docPath), text: door.text(), comments: await readSidecarText(docPath), project: folder };
      const agents = await buddies();
      const { threads } = await threadsNow(agents.map(({ id, name }) => ({ id, name })));
      const given = new Set(asks.map((a) => a.id));
      const heard = since ? new Set(parseSidecar(since.comments ?? '').lines.map((l) => l.comment?.id).filter(Boolean)) : null;
      const prompt = buildPrompt({
        buddy: agent, buddies: agents, docName: files.path, sidecarName: files.path + SIDECAR_SUFFIX, project: Boolean(folder),
        threads: threads.filter((t) => given.has(t.id)),
        watch: since === undefined ? null : newSince({ agent: agent.id, base: since?.text ?? null, heard, text: files.text, threads }),
        human: { name: (await me()).name, about: (await settingsWithId(settingsDir)).about.trim() },
        actions: await listActions(settingsDir),
      });
      return { rev, files, prompt };
    },

    /**
     * Land what a run left behind, as `agent` ({ id, name, for: the people
     * it ran for, depth: its run's }), on the doc of version `version`,
     * unless one of those people may no longer ask: `old` what it was
     * given ({ files, asks }), `made` what it made ({ text, comments: {
     * before, after }, groups, actions, output }); the actions on comments
     * it posted are recorded, to be carried out (doc-actions.js). Each comment's edits (its group)
     * land as a version of their own, merged with what landed since
     * (merge3), then its comments; in a thread that asked it, just after
     * the last comment it was given. Resolves to { landed (in words, for
     * its trace), comments (the ids of those it posted) }.
     */
    async propose(agent, version, old, made) {
      const here = await members();
      if (!agent.for.every((id) => here.some((m) => m.id === id && m.mayAsk))) return { comments: [], landed: 'Dropped: whoever asked can no longer edit' };
      const by = { id: agent.id, name: agent.name, kind: 'ai' };
      const { threads } = await threadsNow();
      const open = new Map(threads.filter((t) => !t.resolved).map((t) => [t.id, t]));
      const { posts, byLine, carried } = toChanges({ by, base: old.files.text, edited: made.text, comments: made.comments, groups: made.groups, threads, asking: old.asks.map((a) => a.id), output: made.output });
      const who = { ...by, level: 'write' };
      let prev = old.files.text;
      let conflict = false;
      for (const { comment, doc, lands } of carried) {
        if (!door.missing() && lands && doc !== prev) { // a doc gone has nothing to land on
          const now = { text: door.text(), rev: door.rev() };
          const merged = merge3(prev, now.text, doc);
          conflict ||= merged.conflicts > 0;
          await door.submit({ ops: diffOps(now.text, merged.text), rev: now.rev, epoch: door.epoch(), id: newId('e'), reply: comment.id, thread: comment.thread ?? comment.id, conflict: merged.conflicts > 0 }, who)
            .catch((error) => { if (error.code !== 'not_saved') throw error; }); // landed: windows hear it is not saved
          // A reply whose edits rewrote its thread's text moves the thread (SPEC §3).
          const anchor = comment.thread !== undefined && movedAnchor(open.get(comment.thread).anchor, prev, doc, door.text());
          if (anchor) comment.anchor = anchor;
        }
        prev = doc;
      }
      if (!posts.length) return { comments: [], landed: 'Nothing to do' };
      // A reply comes just after the latest comment the run was given in
      // its thread, each after the one before it.
      const after = new Map(old.asks.map((a) => [a.id, a.until]));
      try {
        for (const c of posts) {
          const { at } = await door.comment({ id: c.id, thread: c.thread, anchor: c.anchor ?? null, body: c.body, after: c.thread !== undefined ? after.get(c.thread) : undefined }, who);
          if (c.thread !== undefined && after.has(c.thread)) after.set(c.thread, at);
          posted.set(c.id, { for: agent.for, depth: agent.depth });
        }
      } catch (error) {
        console.error(`Could not post ${agent.name}'s comments:`, error);
        return { comments: [], landed: 'Its comments were not posted' };
      }
      const proposed = (made.actions ?? []).filter((a) => byLine.has(a.comment)).map((a) => {
        const c = byLine.get(a.comment);
        return { comment: c.id, thread: c.thread ?? c.id, action: a.action, input: a.input };
      });
      if (proposed.length) await actions.propose(agent, proposed);
      return { comments: posts.map((c) => c.id), landed: conflict ? 'Posted; where it collided with people, their lines stayed' : 'Posted' };
    },
  };
}
