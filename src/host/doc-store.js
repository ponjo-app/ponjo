// The doc's store (docs/app/worlds/doc.md, Store): the door holds the text
// and the comments, and lands every change to them; this holds the rest of
// the doc world's state (who is here, the comments runs here posted, the
// watches, the typing to settle) and the answer ledger, and gives each
// member its view (src/core/doc-world.js). A buddy's run lands in one door
// call; what its answer does to the rest is the world's `apply`.

import { createHash } from 'node:crypto';
import { newComment, newId, threadsOf } from '../core/comments.js';
import { CLOCK, docWorld, noted } from '../core/doc-world.js';
import { ledger } from '../core/ledger.js';
import { COULD_NOT_FINISH, toChanges } from '../core/translate.js';
import { notePosted, noteWatching, readPosted, readWatching } from '../store/history.js';
import { createDocActions } from './doc-actions.js';

const world = ledger(docWorld);
// What changed, in the agent log's words: names, never the doc's content.
const said = (ops, kind, name) => (kind === 'outside' ? `${ops ? 'a change' : 'the comments'} from outside` : `${ops ? 'a change' : 'a comment'} by ${name ?? 'a person'}`);
const WORDS = { watch: ({ on }, name) => `${name}'s watch turned ${on ? 'on' : 'off'}`, resume: () => 'the watches resumed', retry: () => 'Retry' };

// A text's fingerprint, as a watch keeps what its last run saw.
const fingerprint = (text) => createHash('sha256').update(text).digest('base64url');

/**
 * The store of the doc behind `door` (doc-service.js: { text, rev,
 * comments, took, comment, land }), whose changes `subscribe(fn)` tells.
 * `docPath()` names it in history. `acted()` is called when a person
 * changes anything. `emit` tells the windows of the actions. Returns {
 * client(member) ({ read, wait, commit }, as src/core/store.js's), members(m)
 * (who is here now: { owner, people, buddies }), why() (what changed last,
 * in words), actions (doc-actions.js) }.
 */
export async function createDocStore({ door, subscribe, docPath, settingsDir, owner, acted = () => {}, emit = () => {} }) {
  let members = { owner: await owner(), people: [], buddies: [] };
  const watching = await readWatching(docPath(), settingsDir);
  // The world's state the door does not hold. On opening, a watcher whose
  // last run saw a text looks again if the text is not that.
  let own = {
    posted: await readPosted(docPath(), settingsDir),
    watches: Object.fromEntries(Object.entries(watching).map(([id, { by, print = null, wake = null }]) => [id, { by, seen: print, since: print === null ? null : { depth: 0, n: 0 }, wake }])),
    typed: null, settled: null, n: 0,
  };
  let answers = {};
  let rev = 0;
  let why = 'the doc opened';

  // The state now (doc-world.js, State): the threads and what was taken,
  // read again only when the comments or the buddies change; the text's
  // fingerprint only when a view asks for it.
  let memo = { lines: null };
  let hashed = { text: null, hash: null };
  function state() {
    const { lines, problem } = door.comments();
    if (memo.lines !== lines || memo.buddies !== members.buddies) {
      const comments = lines.map((l) => l.comment).filter(Boolean);
      memo = { lines, buddies: members.buddies, threads: threadsOf(comments, members.buddies.map(({ id, name }) => ({ id, name }))), taken: new Set(comments.filter(door.took).map((c) => c.id)) };
    }
    const text = door.text();
    return {
      text, lines, threads: memo.threads, problem, members, taken: memo.taken, ...own,
      get hash() {
        if (hashed.text !== text) hashed = { text, hash: fingerprint(text) };
        return hashed.hash;
      },
    };
  }

  // ---- waking ----

  const prints = new Map(); // member → { rev, print }: its view as it last read it
  const waiting = new Set(); // { member, print, done }
  let holding = 0; // while a run lands, no one is woken: they are, once it is in
  const printOf = (member, view = world.view({ world: state(), answers }, member)) => `${door.rev()} ${JSON.stringify(view.tasks)}`;
  const wake = (w) => {
    if (printOf(w.member) === w.print) return;
    waiting.delete(w);
    w.done(rev);
  };
  function changed(what) {
    rev++;
    if (what) why = `${what}, rev ${door.rev()}`;
    if (!holding) for (const w of waiting) wake(w);
  }

  // ---- what is kept for a restart ----

  // The watches (as `watching.json` has them) and the comments posted here,
  // each written when it changed.
  let keeping = Promise.resolve();
  let kept = { watches: JSON.stringify(watching), posted: own.posted };
  function keep() {
    const watches = JSON.stringify(Object.fromEntries(Object.entries(own.watches).map(([id, { by, seen, wake: lines }]) => [id, { by, print: seen, wake: lines }])));
    const { posted } = own;
    const ids = door.comments().lines.map((l) => l.comment?.id);
    const was = kept;
    kept = { watches, posted };
    keeping = keeping.then(async () => {
      if (watches !== was.watches) await noteWatching(docPath(), settingsDir, JSON.parse(watches));
      if (posted !== was.posted) await notePosted(docPath(), settingsDir, posted, ids);
    }).catch((error) => console.error('Could not note the doc\'s buddies:', error));
    return keeping;
  }
  function take({ world: s, answers: a }) {
    const { posted, watches, typed, settled, n } = s;
    own = { posted, watches, typed, settled, n };
    answers = a;
  }

  // ---- the door's own changes ----

  let landing = null; // the buddy whose run is landing: its change is the world's apply
  subscribe((event) => {
    if (landing !== null && event.by.id === landing) return;
    const name = members.buddies.find((b) => b.id === event.by.id)?.name;
    if (event.by.kind === 'person') acted();
    own = { ...own, ...noted(own, { kind: event.by.kind, text: event.ops.length > 0, at: Date.now() }) };
    changed(said(event.ops.length > 0, event.by.kind, name));
  });

  // What runs here proposed to do outside the doc; each result is its buddy's reply, a step deeper.
  const actions = createDocActions({
    settingsDir, docPath, owner, changed: (list) => emit('actions', list),
    async reply(action, body) {
      const { id } = await door.comment({ id: newId('c'), thread: action.thread, anchor: null, body }, { ...action.buddy, kind: 'ai', level: 'write' });
      own = { ...own, posted: { ...own.posted, [id]: { for: action.for, depth: action.depth + 1 } } };
      changed(`${action.buddy.name}'s action ended`);
      await keep();
    },
  });

  // ---- landing a run ----

  // Buddy `member`'s run, as its controller commits it: `answers` its tasks;
  // `body` { base (the text it was given), made (runner.js's, as Translate
  // takes it), tasks (those it was handed) }, or { failed (why), base?,
  // tasks? }. It lands in one door call: its groups and comments, each of
  // its asks still open answered by a comment of its; else, failed, "Could
  // not finish.". Then the world's `apply` keeps what that did (doc-world.js).
  async function land(member, { answers: given = [], body }) {
    const due = world.view({ world: state(), answers }, member).tasks.filter((t) => given.includes(t.given));
    if (!due.length) return { refused: 'None of these tasks is due.', landed: 'Refused: none of its tasks is due' };
    const buddy = members.buddies.find((b) => b.id === member);
    const by = { id: buddy.id, name: buddy.name, kind: 'ai' };
    const handed = (body.tasks ?? due).filter((t) => t.kind === 'ask' && due.some((d) => d.given === t.given));
    const from = [...new Set(due.flatMap((t) => t.from))];
    const depth = Math.min(...due.map((t) => t.depth));
    const { threads } = state();
    const open = new Set(threads.filter((t) => !t.resolved).map((t) => t.id));
    const change = body.failed !== undefined
      ? { posts: handed.filter((t) => open.has(t.thread)).map((t) => newComment({ thread: t.thread, body: COULD_NOT_FINISH }, { by, at: '' })), byLine: new Map(), carried: [] }
      : toChanges({ by, base: body.base, edited: body.made.text, comments: body.made.comments, groups: body.made.groups, threads, asking: handed.map((t) => t.thread), output: body.made.output });
    let landed;
    holding++;
    landing = member;
    try {
      landed = await door.land({
        base: body.base, comments: change.posts, after: Object.fromEntries(handed.map((t) => [t.thread, t.until])),
        groups: change.carried.filter((c) => c.lands).map(({ comment, doc }) => ({ comment, doc })),
      }, { ...by, level: 'write' });
    } catch (error) {
      console.error(`Could not land ${buddy.name}'s run:`, error);
      landed = { refused: error.message };
    } finally {
      landing = null;
      holding--;
    }
    landed ??= { refused: 'The doc closed.' };
    const out = world.apply({ world: state(), answers }, {
      by: member, as: member, at: Date.now(), answers: given,
      body: landed.refused ? { type: 'landed', refused: landed.refused } : {
        type: 'landed', base: body.base === undefined ? null : fingerprint(body.base), before: fingerprint(landed.before), after: fingerprint(landed.after),
        posted: landed.comments.map((c) => c.id), from, depth, wake: body.made?.wake?.length ? body.made.wake : null, failed: body.failed !== undefined,
      },
    });
    if (out.state) take(out.state);
    changed(`${buddy.name}'s run landed`);
    await keep();
    if (landed.refused) return { rev, refused: out.refused, landed: `Refused: ${landed.refused}` };
    const posted = new Set(landed.comments.map((c) => c.id));
    const proposed = (body.made?.actions ?? []).filter((a) => posted.has(change.byLine.get(a.comment)?.id)).map((a) => {
      const c = change.byLine.get(a.comment);
      return { comment: c.id, thread: c.thread ?? c.id, action: a.action, input: a.input };
    });
    if (proposed.length) await actions.propose({ ...by, for: from, depth }, proposed);
    const words = body.failed !== undefined ? 'Failed' : landed.error ? 'Its comments were not posted' : !change.posts.length ? 'Nothing to do' : landed.conflict ? 'Posted; where it collided with people, their lines stayed' : 'Posted';
    return { rev, effects: [], landed: words, comments: [...posted] };
  }

  return {
    client: (member) => ({
      /** { rev, view }: the state now, as `member` may see it. */
      read() {
        const view = world.view({ world: state(), answers }, member);
        prints.set(member, { rev, print: printOf(member, view) });
        return { rev, view };
      },
      /** Resolves once `member`'s view is no longer what it read at `since`. */
      wait(since) {
        const last = prints.get(member);
        return new Promise((done) => {
          const w = { member, print: last?.rev === since ? last.print : null, done };
          waiting.add(w);
          wake(w);
        });
      },
      /**
       * Lands `change` ({ as, answers, body }) by `member`: a buddy's run
       * through the door (land), a person's or the clock's at once. Resolves
       * to { rev, effects, landed? } or { refused }.
       */
      async commit(change) {
        if (members.buddies.some((b) => b.id === member)) return land(member, change);
        if (member !== CLOCK) acted();
        const out = world.apply({ world: state(), answers }, { ...change, by: member, at: Date.now() });
        if (!out.state) return out;
        take(out.state);
        changed(member === CLOCK ? 'people paused' : `${WORDS[change.body.type](change.body, members.buddies.find((b) => b.id === change.body.buddy)?.name)} by a person`);
        await keep();
        return { rev, effects: out.effects, ...(out.refused ? { refused: out.refused } : {}) };
      },
    }),
    /** Who is here now: { owner, people: [{ id, name, level }], buddies: [{ id, name, about }] }. */
    members(next) {
      members = next;
      changed('who is here changed');
    },
    why: () => why,
    /** The buddies watching the doc. */
    watching: () => Object.keys(own.watches),
    actions,
  };
}
