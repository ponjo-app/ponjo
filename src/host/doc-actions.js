// The doc world's outside actions (docs/runtime/README.md#effects):
// each one a landed run proposed, recorded on this machine, approved by the
// owner (unless the owner lets it run without asking, for their own runs),
// carried out once, and its result posted as a reply. One started and not
// ended, as the host stopped, is never started again on its own.

import { newId } from '../core/comments.js';
import { asksFirst } from '../core/settings.js';
import { actionScript, listActions, readActions, recordAction } from '../store/actions.js';
import { readSettings } from '../store/settings.js';
import { DocError } from './door.js';
import { runAction } from './runner.js';

/** Actions as `level` sees them: why one failed is the owner's alone, as a run's is. */
export function actionsFor(level, actions) {
  return level === 'owner' ? actions : actions.map(({ why, ...seen }) => seen);
}

/**
 * The actions of the doc at `docPath()`, in config folder `settingsDir`.
 * `owner()` resolves to the owner ({ id }); `reply(action, body)` posts `body` as the
 * reply of `action`'s buddy in its thread, at its depth + 1; `changed(actions)`
 * hears each step, with the doc's actions then.
 */
export function createDocActions({ settingsDir, docPath, owner, reply, changed = () => {} }) {
  const deciding = new Set(); // the ids a person is deciding on now: one decision at a time
  const running = new Set(); // the ids this host is carrying out now
  // A step of an action, recorded, then told.
  async function note(step) {
    await recordAction(settingsDir, step);
    changed(await list());
  }

  // This doc's actions, oldest first; one started that this host is not carrying out may have run.
  async function list() {
    return (await readActions(settingsDir)).filter((a) => a.doc === docPath())
      .map((a) => (a.state === 'started' && !running.has(a.id) ? { ...a, state: 'unknown' } : a));
  }

  // A person `who` ({ id, name }) moves action `id` from one of `from` to
  // `state`; when that is 'approved', it is carried out once.
  async function decide(id, who, from, state) {
    if (deciding.has(id)) throw new DocError('stale', 'the action is being decided on');
    deciding.add(id);
    try {
      const action = (await list()).find((a) => a.id === id);
      if (!action) throw new DocError('not_found', 'no such action');
      if (!from.includes(action.state)) throw new DocError('stale', `the action is ${action.state}`);
      await note({ id, state, by: { id: who.id, name: who.name } });
      if (state === 'approved') carryOut(action);
    } finally {
      deciding.delete(id);
    }
  }

  // Carry out `action`, just approved, once.
  function carryOut(action) {
    running.add(action.id);
    return carry(action);
  }
  async function carry(action) {
    try {
      await note({ id: action.id, state: 'started' });
      const done = await runAction({ script: actionScript(action.action, settingsDir), id: action.id, input: action.input });
      await note(done.ok ? { id: action.id, state: 'done', result: done.result } : { id: action.id, state: 'failed', why: done.why });
      await reply(action, done.ok ? `${action.name}: ${done.result || 'done.'}` : `${action.name} failed.`);
    } catch (error) {
      console.error(`Could not carry out action ${action.id}:`, error);
    } finally {
      running.delete(action.id);
    }
  }

  return {
    /**
     * Record what landed run `by` ({ id, name, for, depth }) proposed:
     * `proposed`, [{ comment, thread, action, input }], each on a comment it
     * posted. An action not installed here is dropped. Each that need not
     * ask first is carried out at once.
     */
    async propose(by, proposed) {
      const installed = new Map((await listActions(settingsDir)).map((a) => [a.id, a]));
      const { settings } = await readSettings(settingsDir);
      const { id: ownerId } = await owner();
      const mine = by.for.length > 0 && by.for.every((id) => id === ownerId);
      for (const p of proposed) {
        const known = installed.get(p.action);
        if (!known) continue;
        const action = { id: newId('a'), state: 'proposed', doc: docPath(), comment: p.comment, thread: p.thread, action: p.action, name: known.name, input: p.input ?? null, buddy: { id: by.id, name: by.name }, for: by.for, depth: by.depth };
        await note(action);
        if (mine && !asksFirst(settings, p.action)) {
          await note({ id: action.id, state: 'approved', by: null }); // set to run without asking
          carryOut(action);
        }
      }
    },

    /** This doc's actions, oldest first: each as its record holds it, 'unknown' when it started and may have run. */
    list,

    /** The owner `who` ({ id, name }) approves action `id`, waiting: it is carried out once. */
    approve: (id, who) => decide(id, who, ['proposed'], 'approved'),

    /** The owner `who` declines action `id`, waiting: it is never carried out. */
    decline: (id, who) => decide(id, who, ['proposed'], 'declined'),

    /** The owner `who` has action `id` carried out again: one that failed, or may have run. */
    retry: (id, who) => decide(id, who, ['failed', 'unknown'], 'approved'),
  };
}
