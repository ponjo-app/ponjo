// The Agents section of the preview's Settings, for both of its windows
// (doc-stub.js, start-stub.js): the agents the app ships, as their
// manifests declare them, and the one the preview's buddies run on,
// picked and fixed: its Worker (relay/worker.js) holds the key and picks
// the model, MODEL in relay/wrangler.toml.

import { agentOf } from '../src/core/settings.js';
import claude from '../agents/claude.json' with { type: 'json' };
import codex from '../agents/codex.json' with { type: 'json' };
import ponjo from '../agents/ponjo.json' with { type: 'json' };

export const AGENTS = Object.entries({ claude, codex, ponjo }).map(([id, manifest]) => agentOf(id, manifest));

/** The settings that say so: the Ponjo agent, on Nemotron at Nebius Token Factory. */
export const PICKED = { agent: 'ponjo', agents: { ponjo: { provider: 'nebius' } } };

/** What the agents' list is (web/api.js `scripts`), `fixed`: Agents can't be changed here. */
export const SCRIPTS = {
  agents: AGENTS,
  shipped: AGENTS.map((agent) => agent.id),
  folder: '',
  secrets: {},
  fixed: 'In this preview, every buddy runs on the Ponjo agent, on NVIDIA Nemotron through Nebius Token Factory. Picking an agent or changing its settings needs the desktop app.',
};
