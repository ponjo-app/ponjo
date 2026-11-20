// Reads one scenario's logs (dealer.jsonl, agent.jsonl, host.jsonl, the
// config's logs/runs.jsonl and logs/agents.log) and writes summary.json and
// turns.tsv: one row per turn (a dealer write that put the action on a seat).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const jsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const stats = (xs) => (xs.length ? { n: xs.length, min: Math.min(...xs), median: median(xs), max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) } : null);

export function analyse(out) {
  const dealer = jsonl(join(out, 'dealer.jsonl'));
  const agent = jsonl(join(out, 'agent.jsonl'));
  const host = jsonl(join(out, 'host.jsonl'));
  const runs = jsonl(join(out, 'config', 'logs', 'runs.jsonl')).map((r) => ({ ...r, t: Date.parse(r.at) }));
  const logText = readFileSync(join(out, 'config', 'logs', 'agents.log'), 'utf8');
  // Looks: { t, why, lines }
  const looks = [];
  for (const line of logText.split('\n')) {
    const m = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) {2}\S+ {2}(.*)$/);
    if (m) looks.push({ t: new Date(m[1].replace(' ', 'T')).getTime(), head: m[2], lines: [] });
    else if (line.trim() && looks.length) looks.at(-1).lines.push(line.trim());
  }
  const start = host.find((e) => e.type === 'dealer-start').t;
  const writes = dealer.filter((e) => e.type === 'write');
  const turns = writes.filter((w) => w.kind !== 'heartbeat' && w.kind !== 'clear');
  const rows = [];
  for (let k = 0; k < turns.length; k++) {
    const w = turns[k];
    const end = turns[k + 1]?.t ?? Infinity;
    const inT = (t) => t >= w.t && t < end;
    const rs = runs.filter((r) => inT(r.t));
    const as = agent.filter((a) => inT(a.t0));
    const ls = looks.filter((l) => inT(l.t));
    const stepsTaken = ls.flatMap((l) => l.lines).filter((l) => /a step taken/.test(l)).length;
    const noStep = ls.flatMap((l) => l.lines).filter((l) => /no step is left/.test(l)).length;
    // The action this turn ended on: the dealer's last 'seen' before the next turn's write, in log order.
    const iW = dealer.indexOf(w);
    const iNext = turns[k + 1] ? dealer.indexOf(turns[k + 1]) : dealer.length;
    const seen = dealer.slice(iW + 1, iNext).filter((e) => e.type === 'seen').at(-1);
    const acted = as.filter((a) => a.verdict === 'acted');
    const door = host.find((e) => e.type === 'change' && e.by === 'outside' && e.t >= w.t);
    const firstOn = rs.filter((r) => r.buddy === w.on).sort((a, b) => a.t - b.t)[0];
    const firstAny = rs.sort((a, b) => a.t - b.t)[0];
    const actRun = acted[0] && runs.find((r) => r.buddy === acted[0].buddy && Math.abs(r.t - acted[0].t0) < 2000 && r.outcome === 'ok');
    rows.push({
      k, hand: w.hand, street: w.street, on: w.on, kind: w.kind,
      runs: rs.length, ok: rs.filter((r) => r.outcome === 'ok').length, stopped: rs.filter((r) => r.outcome === 'stopped').length, failed: rs.filter((r) => r.outcome !== 'ok' && r.outcome !== 'stopped').length,
      gate: as.filter((a) => a.verdict === 'gate').length, already: as.filter((a) => a.verdict === 'already').length, acted: acted.length,
      actedBy: acted.map((a) => a.buddy).join(','), steps: stepsTaken, noStepVerdicts: noStep, looks: ls.length,
      writeToRunOnMs: firstOn ? firstOn.t - w.t : null, writeToAnyRunMs: firstAny ? firstAny.t - w.t : null,
      writeToDoorMs: door ? door.t - w.t : null, doorToActRunMs: door && acted[0] ? acted[0].t0 - door.t : null, writeToActRunMs: acted[0] ? acted[0].t0 - w.t : null,
      paidStale: as.filter((a) => a.verdict !== 'acted' && (!door || a.t0 < door.t)).length,
      agentExitToSeenMs: seen && acted[0] ? seen.t - acted[0].t1 : null,
      runEndToSeenMs: seen && actRun ? seen.t - (actRun.t + actRun.ms) : null,
      writeToSeenMs: seen ? seen.t - w.t : null,
      act: seen?.act ?? null, anomaly: seen?.anomaly ?? null,
    });
  }
  const played = rows.filter((r) => r.on);
  const hands = [...new Set(played.map((r) => r.hand))];
  const perHand = hands.map((h) => {
    const rs = played.filter((r) => r.hand === h);
    const first = turns.find((w) => w.hand === h);
    const result = dealer.find((e) => e.type === 'result' && e.hand === h);
    return { hand: h, actions: rs.filter((r) => r.act).length, runs: rs.reduce((a, r) => a + r.runs, 0), noops: rs.reduce((a, r) => a + r.gate + r.already, 0), stopped: rs.reduce((a, r) => a + r.stopped, 0), steps: rs.reduce((a, r) => a + r.steps, 0), seconds: result ? Math.round((result.t - first.t) / 100) / 10 : null };
  });
  const stepsSeries = host.filter((e) => e.type === 'steps' && e.t >= start);
  const summary = {
    config: JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')),
    handsDone: dealer.filter((e) => e.type === 'result').length,
    actions: dealer.filter((e) => e.type === 'seen').length,
    stall: dealer.find((e) => e.type === 'stall') ?? null,
    anomalies: dealer.filter((e) => e.type === 'anomaly' || (e.type === 'seen' && e.anomaly)),
    dealerOtherChanges: dealer.filter((e) => e.type === 'change').length,
    heartbeats: writes.filter((w) => w.kind === 'heartbeat').length,
    runsTotal: runs.filter((r) => r.t >= start).length,
    runOutcomes: runs.filter((r) => r.t >= start).reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] ?? 0) + 1 }), {}),
    agentVerdicts: agent.filter((a) => a.t0 >= start).reduce((m, a) => ({ ...m, [a.verdict]: (m[a.verdict] ?? 0) + 1 }), {}),
    perActionRuns: stats(played.filter((r) => r.act).map((r) => r.runs)),
    perActionNoops: stats(played.filter((r) => r.act).map((r) => r.gate + r.already)),
    perActionSteps: stats(played.filter((r) => r.act).map((r) => r.steps)),
    writeToDoorMs: stats(played.map((r) => r.writeToDoorMs).filter((x) => x !== null)),
    doorToActRunMs: stats(played.map((r) => r.doorToActRunMs).filter((x) => x !== null)),
    writeToActRunMs: stats(played.map((r) => r.writeToActRunMs).filter((x) => x !== null)),
    staleRuns: played.reduce((a, r) => a + r.paidStale, 0),
    writeToRunOnMs: stats(played.map((r) => r.writeToRunOnMs).filter((x) => x !== null)),
    writeToAnyRunMs: stats(played.map((r) => r.writeToAnyRunMs).filter((x) => x !== null)),
    agentExitToSeenMs: stats(played.map((r) => r.agentExitToSeenMs).filter((x) => x !== null)),
    runEndToSeenMs: stats(played.map((r) => r.runEndToSeenMs).filter((x) => x !== null)),
    writeToSeenMs: stats(played.map((r) => r.writeToSeenMs).filter((x) => x !== null)),
    stepsMinLeft: stepsSeries.length ? Math.min(...stepsSeries.map((e) => e.left)) : null,
    firstZeroStepAfterS: (() => { const z = stepsSeries.find((e) => e.left === 0); return z ? Math.round((z.t - start) / 100) / 10 : null; })(),
    noStepVerdicts: played.reduce((a, r) => a + r.noStepVerdicts, 0),
    duplicateActs: played.filter((r) => r.acted > 1).length,
    wrongActor: played.filter((r) => r.actedBy && r.actedBy.split(',').some((b) => b !== r.on)).length,
    conflicts: looks.filter((l) => /collided/.test(l.head)).length,
    lostEvents: looks.filter((l) => l.lines.some((x) => /one was lost/.test(x))).length,
    perHand,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const cols = Object.keys(rows[0] ?? {});
  writeFileSync(join(out, 'turns.tsv'), [cols.join('\t'), ...rows.map((r) => cols.map((c) => r[c] ?? '').join('\t'))].join('\n') + '\n');
  console.log(JSON.stringify({ ...summary, anomalies: summary.anomalies.length }, null, 2));
  return summary;
}

if (process.argv[1]?.endsWith('analyse.mjs')) analyse(process.argv[2]);
