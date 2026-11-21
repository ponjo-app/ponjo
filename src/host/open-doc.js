// An open doc and its buddies (docs/architecture.md, Components): the doc
// service, which knows nothing of buddies, the doc as a world, which reads
// the doc and lands what runs left behind through its door, and the agent
// runtime, which reaches the doc only through the world and hears each
// change. Here they are joined, with the calls that are the buddies' own:
// watching, retrying, resuming the watches, and the buddies' files.

import { newId } from '../core/comments.js';
import { BuddyError, checkBuddyPatch } from '../core/buddies.js';
import { sameName } from '../core/mentions.js';
import { buddiesFor, projectBuddiesDir, removeBuddy, userBuddiesDir, writeBuddy } from '../store/buddies.js';
import { configDir, ownerOf, readSettings, watchSettings } from '../store/settings.js';
import { watchFolder } from '../store/watch.js';
import { StoreError } from '../store/files.js';
import { agentsFor, createBuddyRuntime } from './buddy-runtime.js';
import { actionsFor } from './doc-actions.js';
import { openDocService } from './doc-service.js';
import { createDocWorld } from './doc-world.js';
import { DocError, LEVELS, can } from './door.js';
import { pathInProject } from './project-service.js';

// The settings that choose and set up the agent (settings.js), as JSON.
const agentOf = (settings) => JSON.stringify((({ agent, agents }) => ({ agent, agents }))(settings ?? {}));

/**
 * Open the doc at `docPath` with its buddies: the doc service's handle
 * (doc-service.js), whose `call` also takes the buddies' calls and whose
 * `state` and `hello` also tell of the buddies; `agentChanged()` (the
 * agents' secrets changed) and `running()` (the names of the buddies at
 * work) besides. Options as openDocService's.
 */
export async function openDoc(docPath, { folder = null, room = null, settingsDir = configDir(), secrets = () => ({}), emit = () => {} } = {}) {
  const doc = await openDocService(docPath, { folder, room, settingsDir, secrets, emit });
  const me = () => ownerOf(settingsDir);
  const buddies = () => buddiesFor(folder, settingsDir);
  const world = createDocWorld({
    door: doc.door, subscribe: doc.subscribe,
    place: () => ({ docPath: doc.docPath(), folder, room }),
    pathInProject: () => pathInProject(folder, doc.docPath()),
    buddies, me, settingsDir, emit,
  });
  const runtime = await createBuddyRuntime({ world, docPath: doc.docPath, settingsDir, secrets, emit });

  // What else may change what is asked: the buddies' files, who may ask, the agent.
  const stopWatchingUserBuddies = watchFolder(userBuddiesDir(settingsDir), runtime.sync);
  let stopWatchingProjectBuddies = folder ? watchFolder(projectBuddiesDir(folder), runtime.sync) : () => {};
  let stopFollowingRoom = room?.onChange(() => runtime.look('who is in the room changed')) ?? (() => {});
  let agent = agentOf((await readSettings(settingsDir)).settings);
  const stopWatchingSettings = watchSettings(async () => {
    const was = agent;
    agent = agentOf((await readSettings(settingsDir)).settings);
    if (agent !== was) runtime.agentChanged();
  }, settingsDir);

  // ---- the buddies' files ----

  // A buddy can be called anything but another buddy's name here (not
  // buddy `id`'s), its owner's or a teammate's.
  async function checkBuddy(fields, id = null) {
    try {
      checkBuddyPatch(fields);
    } catch (error) {
      throw new DocError(error.code, error.message);
    }
    if (fields.name === undefined) return;
    const taken = [...(await buddies()).filter((b) => b.id !== id).map((b) => b.name), (await me()).name, ...(room?.names() ?? [])];
    if (taken.some((n) => sameName(fields.name, n))) throw new DocError('bad_input', `the name ${fields.name} is taken`);
  }
  async function buddyById(id) {
    const found = (await buddies()).find((b) => b.id === id);
    if (!found) throw new DocError('not_found', 'no such buddy');
    return found;
  }
  const dirOf = (where) => (where === 'project' ? projectBuddiesDir(folder) : userBuddiesDir(settingsDir));
  // Write buddy files; a folder watch tells every window.
  async function changeBuddies(work) {
    try {
      await work();
    } catch (error) {
      if (error instanceof BuddyError) throw new DocError(error.code, error.message);
      throw error;
    }
    await runtime.sync();
    return { agents: runtime.statuses() };
  }

  const calls = {
    // The actions runs here proposed (doc-actions.js): anyone in the doc sees them; only the owner decides.
    read: { actions: async (arg, who) => actionsFor(who.level, await world.actions.list()) },
    write: runtime.calls,
    owner: {
      approveAction: ({ id } = {}, who) => world.actions.approve(id, who),
      declineAction: ({ id } = {}, who) => world.actions.decline(id, who),
      retryAction: ({ id } = {}, who) => world.actions.retry(id, who),
      // A new buddy: in a project, the project's (in .ponjo/buddies/, made if
      // missing); in a doc on its own, the user's.
      async createBuddy({ buddy } = {}) {
        const fields = { about: '', ...buddy };
        await checkBuddy(fields);
        if (!fields.name) throw new DocError('bad_input', 'a buddy needs a name');
        return changeBuddies(() => writeBuddy(dirOf(folder ? 'project' : 'user'), { id: newId('b'), ...fields }));
      },
      // Change buddy `id` here: its name (renames its file) or who it is.
      async updateBuddy({ id, patch = {} } = {}) {
        const { where, ...was } = await buddyById(id);
        await checkBuddy(patch, id);
        return changeBuddies(() => writeBuddy(dirOf(where), { ...was, ...patch }, was.name));
      },
      // Delete buddy `id`'s file. Its comments stay.
      async deleteBuddy({ id } = {}) {
        const found = await buddyById(id);
        return changeBuddies(() => removeBuddy(dirOf(found.where), found.name));
      },
      testAgent: () => runtime.testAgent(),
      // What the buddies' runtime did lately, for the runtime panel: only the owner's, as runs' traces are.
      runtime: () => ({ events: runtime.recent() }),
    },
  };

  await runtime.sync(); // the asks the files hold are looked at once the doc opens

  return {
    ...doc,
    // The door: the buddies' calls here, the doc's at the doc's door.
    async call(type, arg, who) {
      const level = LEVELS.find((l) => Object.hasOwn(calls[l], type));
      if (!level) {
        const answer = await doc.call(type, arg, who);
        return type === 'state' ? { ...answer, agents: agentsFor(who.level, runtime.statuses()), watches: runtime.watches(), actions: actionsFor(who.level, await world.actions.list()) } : answer;
      }
      if (!can(who, level)) throw new DocError('forbidden', `${who?.name ?? 'no one'} may not ${type} here`);
      try {
        return await calls[level][type](arg, who);
      } catch (error) {
        if (error instanceof StoreError) throw new DocError(error.code, error.message);
        throw error;
      }
    },
    hello: () => ({ ...doc.hello(), agents: runtime.statuses() }),
    /** The agents' secrets changed: the failed asks run again. */
    agentChanged: () => runtime.agentChanged(),
    running: () => runtime.running(),
    async moveTo(...args) {
      const moved = await doc.moveTo(...args);
      await runtime.sync();
      return moved;
    },
    setFolder(next, nextRoom) {
      folder = next;
      room = nextRoom;
      doc.setFolder(next, nextRoom);
      stopFollowingRoom();
      stopFollowingRoom = room?.onChange(() => runtime.look('who is in the room changed')) ?? (() => {});
      stopWatchingProjectBuddies();
      stopWatchingProjectBuddies = folder ? watchFolder(projectBuddiesDir(folder), runtime.sync) : () => {};
      runtime.sync();
    },
    async close() {
      stopWatchingUserBuddies();
      stopWatchingProjectBuddies();
      stopFollowingRoom();
      stopWatchingSettings();
      await runtime.close();
      await doc.close();
    },
  };
}
