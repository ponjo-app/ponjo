// A stand-in for an agent CLI (docs/agent-config.md): it reads the prompt
// on stdin, edits the doc's copy at PONJO_DOC and appends its comments to
// PONJO_COMMENTS. It acts on each thread of the prompt whose latest comment
// is not its own, as that comment says:
//   replace "<before>" with "<after>"   edit the copy (each such command, in turn)
//   hold                                wait for $FAKE_DIR/release-<buddy> first
//   fail                                print to stderr and exit 1
//   until "<text>"                      while the copy lacks <text>, leave the thread as it is
//   usage                               write a step with the Claude API's usage to the trace
//   say <text>                          reply <text>
//   quiet                               reply nothing
//   ungrouped                           write no group of edits to PONJO_GROUPS
//   append <json>                       append a line to the sidecar's copy
//   reply-first <text>                  append a reply in the sidecar's first thread
//   resolve                             append the line that resolves the thread
//   resolve-first                       append the line that resolves the sidecar's first thread
//   tamper                              change the first comment's line, and append one that resolves its thread
// Watching the doc, it says "Watching." on the whole doc when it has no
// thread of its own there yet (found in the sidecar's copy, as any agent
// reads it), else "Saw <n> new lines." in it, n the lines the changes put in;
// nothing when one of them says quiet. Watching a doc that says fail-watch,
// it fails; one that says hold-watch, it waits for release-<buddy> first;
// one that says ping-pong, it adds the line "<buddy> moved." too.
// Commands after the first may follow `;;`. It prints Done. A reply is `say`'s text, else
// what it replaced, else "Nothing to change.". A reply that carries edits
// writes them, as its group, to PONJO_GROUPS.
// Each run logs one JSON line to $FAKE_DIR/runs.log when it starts, with
// the PONJO_SETTING_* it was given, and writes { started: <ask> } to its trace.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const { PONJO_DOC: doc, PONJO_COMMENTS: comments, PONJO_PROJECT: project, PONJO_GROUPS: groups, PONJO_BUDDY: buddy, FAKE_DIR: dir } = process.env;
// The prompt's threads, each { id, ask (its latest comment), mine (whether that is this buddy's) }.
const threads = [...prompt.matchAll(/Thread (c_[\w-]+), [^\n]*\n\n<thread>\n([\s\S]*?)\n<\/thread>/g)].map(([, id, said]) => {
  const ask = said.split(/\n\n(?=[^\s:]+: )/).at(-1); // a comment starts with its writer's name
  return { id, ask, mine: ask.startsWith(`${buddy}: `) };
});
const todo = threads.filter((t) => !t.mine);
const ask = todo.map((t) => t.ask).join('\n\n');
const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PONJO_SETTING_')));
const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && ['ponjo', 'ponjo.cmd'].some((f) => existsSync(join(d, f))));
appendFileSync(join(dir, 'runs.log'), JSON.stringify({ buddy, ask, threadIds: threads.map((t) => t.id), cwd: process.cwd(), files: readdirSync(process.cwd()), doc, comments, project, projectFiles: project ? readdirSync(project).sort() : null, prompt, settings, ponjo: onPath }) + '\n');
if (process.env.PONJO_TRACE) appendFileSync(process.env.PONJO_TRACE, `${JSON.stringify({ started: ask })}\nnot JSON\n`);
// `usage`: a step as the Ponjo agent writes it, with the Claude API's count.
if (/\busage\b/.test(ask)) appendFileSync(process.env.PONJO_TRACE, `${JSON.stringify({ role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 } })}\n`);

if (/You watch the doc\./.test(prompt)) {
  const now = readFileSync(doc, 'utf8');
  if (now.includes('fail-watch')) {
    console.error('fake agent: the watch run failed');
    process.exit(1);
  }
  if (now.includes('hold-watch')) while (!existsSync(join(dir, `release-${buddy}`))) await new Promise((r) => setTimeout(r, 50));
}
if (/\bhold\b/.test(ask)) {
  while (!existsSync(join(dir, `release-${buddy}`))) await new Promise((r) => setTimeout(r, 50));
}
if (/\bfail\b/.test(ask)) {
  console.log('some output');
  console.error('fake agent: something went wrong');
  process.exit(1);
}
const lines = readFileSync(comments, 'utf8').split('\n');
const first = lines.slice(1).find(Boolean);
let text = readFileSync(doc, 'utf8');
let appended = 0; // the lines appended, which PONJO_GROUPS names a comment by
const append = (line) => {
  appendFileSync(comments, `${line}\n`);
  appended += 1;
};
for (const thread of todo) {
  const awaited = thread.ask.match(/\buntil "(.*?)"/)?.[1];
  if (awaited !== undefined && !text.includes(awaited)) continue;
  const edits = [...thread.ask.matchAll(/replace "(.*?)" with "(.*?)"/g)];
  const was = text;
  text = edits.reduce((t, [, before, after]) => t.replace(before, after), text);
  for (const command of thread.ask.split(';;').map((c) => c.trim())) {
    const json = command.match(/\bappend (\{.*\})$/)?.[1];
    if (json) append(json);
    const answer = command.match(/\breply-first (.*)$/)?.[1];
    if (answer) append(JSON.stringify({ thread: JSON.parse(first).id, body: answer }));
    if (/\bresolve$/.test(command)) append(JSON.stringify({ thread: thread.id, resolved: true }));
    if (/\bresolve-first$/.test(command)) append(JSON.stringify({ thread: JSON.parse(first).id, resolved: true }));
    if (/\btamper$/.test(command)) {
      const changed = lines.map((l) => (l === first ? JSON.stringify({ ...JSON.parse(l), body: 'Tampered.' }) : l)).join('\n');
      writeFileSync(comments, `${changed}${JSON.stringify({ thread: JSON.parse(first).id, body: 'Closing.', resolved: true })}\n`);
      appended += 1;
    }
  }
  if (/\bquiet\b/.test(thread.ask)) continue;
  const said = thread.ask.match(/\bsay (.*)/)?.[1];
  append(JSON.stringify({ thread: thread.id, body: said ?? (edits.length ? `Replaced "${edits[0][1]}".` : 'Nothing to change.') }));
  if (groups && text !== was && !/\bungrouped\b/.test(thread.ask)) appendFileSync(groups, `${JSON.stringify({ comment: appended - 1, doc: text })}\n`);
}
const watch = prompt.match(/You watch the doc\.[\s\S]*$/)?.[0];
if (watch && !/^\+.*\bquiet\b/m.test(watch)) {
  const parsed = lines.slice(1).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const own = parsed.find((c) => c.thread === undefined && !c.anchor && c.by?.name === buddy && !parsed.some((r) => r.thread === c.id && r.resolved))?.id;
  append(JSON.stringify(own ? { thread: own, body: `Saw ${(watch.match(/^\+/gm) ?? []).length} new lines.` } : { body: 'Watching.' }));
  if (text.includes('ping-pong')) {
    text += `${buddy} moved.\n`;
    if (groups) appendFileSync(groups, `${JSON.stringify({ comment: appended - 1, doc: text })}\n`);
  }
}
writeFileSync(doc, text);
console.log('Done.'); // its last words: for the trace, never posted
