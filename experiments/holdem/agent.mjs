// A deterministic stand-in agent for open-card Hold'em (docs/agent-config.md
// contract). Gate: if the doc does not say `Action on: <me>`, or my seat
// already holds an action, exit 0 changing nothing. Otherwise pick an action
// by a fixed rule, write it after `act=` on my own seat line only, and reply
// in my own thread (opened on the first action) saying what I did.
// Each run appends one line to $HOLDEM_OUT/agent.jsonl: start, end, verdict.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const t0 = Date.now();
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const { PONJO_DOC: docPath, PONJO_COMMENTS: sidecar, PONJO_GROUPS: groups, PONJO_BUDDY: me, HOLDEM_OUT: out, HOLDEM_AGENT_MS: delay = '0' } = process.env;
const log = (entry) => appendFileSync(join(out, 'agent.jsonl'), `${JSON.stringify({ buddy: me, t0, t1: Date.now(), promptChars: prompt.length, ...entry })}\n`);

// With HOLDEM_WAKE, every run names the line that wakes it next (PONJO_WAKE).
if (process.env.HOLDEM_WAKE && process.env.PONJO_WAKE) appendFileSync(process.env.PONJO_WAKE, `${JSON.stringify({ line: `Action on: ${me}` })}\n`);
const doc = readFileSync(docPath, 'utf8');
const field = (name) => doc.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1]?.trim();
const hand = field('Hand');
const street = field('Street');
const on = field('Action on');
// @mention mode (no watches, no dealer): asked in a thread, take the turn and hand it on there by name.
if (process.env.HOLDEM_MENTION) {
  const seats = ['Alice', 'Bob', 'Cara'];
  const thread = prompt.match(/Thread (c_[\w-]+), [^\n]*, which asks you/)?.[1];
  const turn = Number(field('Turns')) + 1;
  const next = seats[(seats.indexOf(me) + 1) % 3];
  const edited = doc.replace(/^Action on: .*$/m, `Action on: ${next}`).replace(/^Turns: .*$/m, `Turns: ${turn}`);
  writeFileSync(docPath, edited);
  appendFileSync(sidecar, `${JSON.stringify(thread ? { thread, body: `Turn ${turn} taken. @${next} your turn.` } : { body: `@${next} your turn.` })}\n`);
  if (groups) appendFileSync(groups, `${JSON.stringify({ comment: 0, doc: edited })}\n`);
  log({ verdict: thread ? 'acted' : 'unasked', act: 'pass', turn, on });
  process.exit(0);
}
if (on !== me) {
  log({ verdict: 'gate', hand, street, on });
  process.exit(0);
}
// Self-dealing mode (no dealer): on my turn, take it and pass the action to the next seat.
if (process.env.HOLDEM_SELF) {
  const seats = ['Alice', 'Bob', 'Cara'];
  const turn = Number(field('Turns')) + 1;
  const edited = doc.replace(/^Action on: .*$/m, `Action on: ${seats[(seats.indexOf(me) + 1) % 3]}`).replace(/^Turns: .*$/m, `Turns: ${turn}`);
  writeFileSync(docPath, edited);
  appendFileSync(sidecar, `${JSON.stringify({ body: `Turn ${turn} taken.` })}\n`);
  if (groups) appendFileSync(groups, `${JSON.stringify({ comment: 0, doc: edited })}\n`);
  log({ verdict: 'acted', act: 'pass', turn, on });
  process.exit(0);
}
const seatRe = new RegExp(`^Seat ${me}: .*$`, 'm');
const seat = doc.match(seatRe)?.[0];
const get = (line, key) => line.match(new RegExp(`\\b${key}=(\\S*)`))?.[1] ?? '';
if (!seat || get(seat, 'act')) {
  log({ verdict: 'already', hand, street, on });
  process.exit(0);
}
// A slow agent (a stand-in for a model's latency), only on its turn: a real script would gate before calling the model.
if (Number(delay)) await new Promise((r) => setTimeout(r, Number(delay)));

const toCall = Number(field('Current bet')) - Number(get(seat, 'bet'));
const raises = Number(field('Raises this street'));
let act;
if (me === 'Alice') act = toCall > 0 ? 'call' : 'check';
else if (me === 'Bob') act = raises === 0 ? 'raise' : toCall > 0 ? 'call' : 'check';
else act = toCall > 0 && street === 'river' ? 'fold' : toCall > 0 ? 'call' : 'check';

const edited = doc.replace(seatRe, seat.replace(/\bact=\S*/, `act=${act}`));
writeFileSync(docPath, edited);
const lines = readFileSync(sidecar, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const mine = lines.find((c) => c.by?.name === me && !c.thread);
const body = `${act} (hand ${hand}, ${street}, to call ${toCall}).`;
appendFileSync(sidecar, `${JSON.stringify(mine ? { thread: mine.id, body } : { body })}\n`);
if (groups) appendFileSync(groups, `${JSON.stringify({ comment: 0, doc: edited })}\n`);
log({ verdict: 'acted', act, hand, street, on, toCall });
console.log(`Done: ${act}`);
