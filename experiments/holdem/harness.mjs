// Headless harness: one doc opened through the real doc host and agent
// runtime (src/host/open-doc.js, as test/helpers.js does; no Electron),
// three buddies watching it, the fake agent (agent.mjs) as the picked
// agent, and the dealer (dealer.mjs) as a separate process writing the file.
// Usage: node harness.mjs <name> [--hands 3] [--steps 20] [--refill 60] [--agentMs 0] [--heartbeat 0] [--script path]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [name = 'default', ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i < 0 ? d : rest[i + 1]; };
const cfg = { hands: Number(opt('hands', 3)), steps: Number(opt('steps', 20)), refill: Number(opt('refill', 60)), agentMs: Number(opt('agentMs', 0)), heartbeat: Number(opt('heartbeat', 0)), stall: Number(opt('stall', 120000)), script: opt('script', null) };
const out = join(here, 'runs', name);
rmSync(out, { recursive: true, force: true });
const project = join(out, 'project');
const config = join(out, 'config');
mkdirSync(join(project, '.ponjo', 'buddies'), { recursive: true });
mkdirSync(join(config, 'agents'), { recursive: true });
const docPath = join(project, 'table.md');
writeFileSync(docPath, '# Open-card Hold\'em\n\nWaiting for the dealer.\n');
for (const [b, about] of [['Alice', 'Plays Alice\'s seat: checks or calls.'], ['Bob', 'Plays Bob\'s seat: raises once a street.'], ['Cara', 'Plays Cara\'s seat: calls, folds to a river bet.']]) writeFileSync(join(project, '.ponjo', 'buddies', `${b}.md`), `${about}\n`);
const script = cfg.script ?? `#!/bin/sh\nexec "${process.execPath}" "${join(here, 'agent.mjs')}"\n`;
writeFileSync(join(config, 'agents', 'holdem'), script, { mode: 0o755 });
writeFileSync(join(config, 'settings.json'), JSON.stringify({ name: 'Owner', agent: 'holdem', steps: cfg.steps, refillEvery: cfg.refill }));
process.env.PONJO_CONFIG_DIR = config;
process.env.HOLDEM_OUT = out;
process.env.HOLDEM_AGENT_MS = String(cfg.agentMs);
if (rest.includes('--wake')) process.env.HOLDEM_WAKE = '1';
cfg.wake = rest.includes('--wake');
cfg.mention = rest.includes('--mention');
writeFileSync(join(out, 'config.json'), JSON.stringify(cfg, null, 2));

const { openDoc } = await import('../../src/host/open-doc.js');
const ev = (e) => appendFileSync(join(out, 'host.jsonl'), `${JSON.stringify({ t: Date.now(), ...e })}\n`);
const doc = await openDoc(docPath, { folder: project, settingsDir: config, emit: (type, data) => { if (type === 'steps') ev({ type: 'steps', left: data.left, cap: data.cap }); } });
doc.subscribe(({ rev, by, comments }) => ev({ type: 'change', rev, by: by.kind === 'buddy' ? by.id : by.kind, comments: Boolean(comments) }));
const owner = await doc.owner();
const state = () => doc.call('state', {}, owner);
const idle = async () => { for (;;) { const s = await state(); if (s.agents.every((a) => a.state === 'ready') && doc.running().length === 0) return; await new Promise((r) => setTimeout(r, 100)); } };
if (!cfg.mention) for (const b of ['Alice', 'Bob', 'Cara']) await doc.call('watch', { buddy: b, on: true }, owner);
await new Promise((r) => setTimeout(r, 1500));
await idle();
ev({ type: 'dealer-start' });
if (opt('self', null)) {
  // No dealer: one outside write starts the round, then the buddies pass the turn themselves.
  process.env.HOLDEM_SELF = '1';
  const target = Number(opt('self')); const wait = Number(opt('selfWait', 240000));
  writeFileSync(docPath, 'Action on: Alice\nTurns: 0\n');
  if (cfg.mention) {
    // The owner asks Alice once; from then on each buddy names the next.
    process.env.HOLDEM_MENTION = '1';
    await new Promise((r) => setTimeout(r, 1000));
    await doc.call('comment', { anchor: null, body: '@Alice start the round.' }, owner);
  }
  let last = -1; let since = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const n = Number(readFileSync(docPath, 'utf8').match(/^Turns: (\d+)/m)?.[1] ?? 0);
    if (n !== last) { ev({ type: 'turn', n }); last = n; since = Date.now(); }
    if (n >= target || Date.now() - since > wait) break;
  }
  ev({ type: 'self-end', turns: last });
  await idle(); await doc.close();
  const host = readFileSync(join(out, 'host.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const turns = host.filter((e) => e.type === 'turn'); const t0 = turns[0].t;
  const runs = readFileSync(join(config, 'logs', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const log = readFileSync(join(config, 'logs', 'agents.log'), 'utf8');
  const res = { turnsDone: last, runs, stepsTaken: (log.match(/a step taken/g) ?? []).length, noStepVerdicts: (log.match(/no step is left/g) ?? []).length, turnTimesS: turns.map((e) => Math.round((e.t - t0) / 100) / 10) };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(res, null, 2)); console.log(JSON.stringify(res));
  process.exit(0);
}
const dealer = spawn(process.execPath, [join(here, 'dealer.mjs'), docPath, out, String(cfg.hands), '--heartbeat', String(cfg.heartbeat), '--stall', String(cfg.stall)], { stdio: 'inherit' });
await new Promise((r) => dealer.on('exit', r));
ev({ type: 'dealer-exit' });
await new Promise((r) => setTimeout(r, 7000)); // the last write's pause and its runs
await idle();
await doc.close();
const { analyse } = await import('./analyse.mjs');
analyse(out);
process.exit(0);
