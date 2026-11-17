// Runner: a buddy's run is a filter (docs/architecture.md, A run). The
// agent is always the fake script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../src/core/prompt.js';
import { agentsFor } from '../src/host/doc-service.js';
import { Runner } from '../src/host/runner.js';
import { agentScript, agentsDir, installAgents, listAgents } from '../src/store/agents.js';
import { readSecrets, secretTails, writeSecrets } from '../src/store/secrets.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, readOnly, tempDoc, until } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// In project mode the doc is drafts/plan.md in the project.
async function withDoc(fn, { buddies = null, folder = null, content = SAMPLE, settings = {} } = {}) {
  const docPath = folder ? join(folder, 'drafts', 'plan.md') : await tempDoc(content);
  if (folder) await mkdir(dirname(docPath)).then(() => writeFile(docPath, content));
  const settingsDir = await fakeConfig(settings);
  let opened = await openTestDoc(docPath, { settingsDir, folder, buddies });
  const release = (buddy) => writeFile(join(settingsDir, `release-${buddy}`), '');
  const restart = async () => {
    await opened.doc.close();
    opened = await openTestDoc(docPath, { settingsDir, folder, buddies });
  };
  try {
    await fn({
      docPath, settingsDir, release, restart,
      call: (type, arg) => opened.call(type, arg),
      edit: (...args) => opened.edit(...args),
      state: () => opened.state(),
      runs: () => fakeRuns(settingsDir),
    });
  } finally {
    await opened.doc.close();
  }
}

const runLog = async (settingsDir) => (await readFile(join(settingsDir, 'logs', 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const comment = (call, body, anchor = null) => call('comment', { anchor, body }).then((r) => r.id);
const reply = (call, thread, body) => call('comment', { thread, body });
const threadOf = async (state, id) => (await state()).threads.find((t) => t.id === id);
const repliesIn = async (state, id) => (await threadOf(state, id)).comments.filter((c) => c.by.kind === 'ai');

test('a run\'s Claude API usage, from its trace, is in its log line, with Trace runs off; Settings > Usage sums it', { timeout: 30_000 }, async () => {
  await withDoc(async ({ settingsDir, call, state }) => {
    const id = await comment(call, '@Clippy usage say Done.');
    await until(async () => (await repliesIn(state, id)).length === 1, 'the reply');
    await until(async () => (await runLog(settingsDir).catch(() => [])).length === 1, 'its log line');
    assert.deepEqual((await runLog(settingsDir))[0].usage, { model: 'claude-opus-5-5', input: 100, output: 10, cacheRead: 900, cacheWrite: 0 });
    const { periods, models } = await call('usage');
    assert.deepEqual([periods[0].runs, periods[0].input, periods[0].hit], [1, 1000, 0.9]);
    assert.equal(models[0].model, 'claude-opus-5-5');
  });
});

test('a run edits its copy and appends its reply: the doc has the edit, the thread the reply; the run sees only the copy', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, state, runs }) => {
    const id = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.by.name, 'Clippy');
    assert.equal(answer.body, 'Replaced "extra load".');
    assert.ok(!answer.conflict && !answer.failed);
    assert.match(await readFile(docPath, 'utf8'), /the extra peak load\./);

    const [run] = await runs();
    assert.deepEqual(run.files.sort(), ['plan.md', 'plan.md.comments.jsonl'], 'its folder holds only the copies');
    assert.notEqual(run.cwd, dirname(docPath));
    assert.equal(join(basename(dirname(run.doc)), basename(run.doc)), join(basename(run.cwd), 'plan.md'), 'the copy, in its folder (macOS may name /var as /private/var)');
    assert.equal(run.buddy, 'Clippy');
    assert.deepEqual(run.threadIds, [id], 'the threads that ask it');
    assert.equal(run.project, '');
    assert.equal(run.ponjo, false, 'no ponjo to call');
    assert.deepEqual(run.settings, {}, 'an agent with no manifest has no settings');
    assert.match(run.prompt, /A general writing assistant/, 'Clippy, written on first run');
    assert.match(run.prompt, /fzhan: @Clippy replace/);
    await until(() => !existsSync(run.cwd), 'the folder to be gone after', 5000);
  });
});

test('the human edits the same lines during a run: their lines stay, the rest lands, its version says conflict, and it does not run again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, edit, state, runs, release }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load" replace "## Risks" with "## Open risks"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await edit((await state()).text.replace('extra load', 'extra traffic'));
    await release('Clippy');
    const [reply] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /the extra traffic\./);
    assert.doesNotMatch(text, /peak/);
    assert.match(text, /## Open risks/);
    assert.equal((await state()).edits[reply.id].conflict, true);
    assert.equal(reply.conflict, undefined, 'nothing of it in the comments\' file');
    await sleep(500);
    assert.equal((await runs()).length, 1);
  });
});

test('A3 C4: a turn that ends while the doc cannot be written lands once and runs once; the file has its edit once it can be', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, state, runs, release }) => {
    await comment(call, '@Clippy hold, then replace "extra load" with "extra extra load"');
    await until(async () => (await runs()).length === 1, 'the turn started');
    await readOnly(docPath, true); // the doc and its comments
    try {
      await release('Clippy');
      await until(async () => (await state()).text.includes('extra extra load'), 'the edit landed');
      await sleep(1500); // a turn whose answer could not be written is not run again
      assert.equal((await runs()).length, 1);
    } finally {
      await readOnly(docPath, false);
    }
    await until(async () => (await readFile(docPath, 'utf8')).includes('extra extra load'), 'the edit written');
    assert.equal((await readFile(docPath, 'utf8')).split('extra extra load').length, 2, 'once');
    assert.equal((await runs()).length, 1);
  });
});

test('D8: a thread whose text its buddy rewrote is on the new text: the reply carries its anchor', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state }) => {
    const text = (await state()).text;
    const start = text.indexOf('six features');
    const id = await comment(call, '@Clippy replace "six features" with "the six features we promised the beta cohort last spring"', { exact: 'six features', prefix: text.slice(start - 32, start), suffix: text.slice(start + 12, start + 44), start });
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.anchor.exact, 'the six features we promised the beta cohort last spring');
    const thread = await threadOf(state, id);
    assert.equal(thread.detached, false);
    assert.equal(thread.anchor.exact, 'the six features we promised the beta cohort last spring');

    // Undone, its text is gone: the thread is back on the text it was on.
    await call('undo', { id: (await state()).edits[answer.id].version });
    const back = await threadOf(state, id);
    assert.equal(back.detached, false);
    assert.equal(back.anchor.exact, 'six features');
  });
});

test('two buddies run at once on one doc; both edits land', { timeout: 30_000 }, async () => {
  const buddies = { Clippy: '\n', Ada: '\n' };
  await withDoc(async ({ docPath, call, state, runs, release }) => {
    const first = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    const second = await comment(call, '@Ada hold replace "week one" with "week two"');
    await until(async () => (await runs()).length === 2, 'both runs to start');
    assert.deepEqual((await state()).agents.filter((a) => a.state === 'running').map((a) => a.name).sort(), ['Ada', 'Clippy']);
    await Promise.all([release('Clippy'), release('Ada')]);
    await until(async () => (await repliesIn(state, first)).length && (await repliesIn(state, second)).length, 'both replies');
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /extra peak load/);
    assert.match(text, /week two/);
    for (const id of [first, second]) assert.ok(!(await repliesIn(state, id))[0].conflict);
  }, { buddies });
});

test('a script that exits 1 writes nothing: the buddy\'s status says the thread failed, and why; it runs again on Retry, a settings change or a new comment, never on its own', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, settingsDir, call, state, runs }) => {
    const id = await comment(call, '@Clippy fail');
    const failedIn = async () => (await state()).agents.find((a) => a.name === 'Clippy').failed;
    const [failed] = await until(async () => (await failedIn()).length && failedIn(), 'the failure');
    assert.equal(failed.thread, id);
    assert.match(failed.why, /some output/);
    assert.match(failed.why, /fake agent: something went wrong/);
    assert.ok(failed.why.includes(agentScript('fake', settingsDir)), 'it names the script, to run by hand');
    assert.equal((await repliesIn(state, id)).length, 0, 'no reply');
    assert.equal((await readFile(`${docPath}.comments.jsonl`, 'utf8')).trim().split('\n').length, 2, 'the header and the ask: nothing of the failure in the comments\' file');
    await sleep(500);
    assert.equal((await runs()).length, 1, 'not retried on its own');

    await call('retry', { buddy: 'Clippy' });
    await until(async () => (await runs()).length === 2, 'the run on Retry');
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready' && (await failedIn()).length === 1, 'it failed again');
    await call('saveSettings', { agents: { fake: { model: 'another' } } });
    await until(async () => (await runs()).length === 3, 'the run once the agent\'s settings change');
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready' && (await failedIn()).length === 1, 'it failed again');

    await reply(call, id, '@Clippy replace "week one" with "week 1"');
    await until(async () => (await repliesIn(state, id)).length === 1, 'the reply to the new comment');
    assert.deepEqual(await failedIn(), [], 'answered: no failure');
    const logged = await runLog(settingsDir);
    assert.deepEqual(logged.map((l) => [l.doc, l.buddy, l.threads, l.outcome, l.code]), [...Array(3)].map(() => [docPath, 'Clippy', [id], 'failed', 1]).concat([[docPath, 'Clippy', [id], 'ok', 0]]), 'each run is logged');
    assert.ok(logged.every((l) => Number.isInteger(l.ms) && !Number.isNaN(Date.parse(l.at))));
  });
});

test('a run the host cannot start fails once: it is not run again until asked again', async () => {
  let asked = 0;
  const finished = [];
  const inbox = { buddy: { id: 'b_x', name: 'X', about: '' }, buddies: [], threads: [{ id: 'c_t', comments: [{ at: '2026-11-17T10:00:00.000Z' }] }], askers: ['u_me'] };
  const runner = new Runner({
    asks: async () => (asked++, finished.length ? [] : [inbox]),
    doc: async () => { throw new Error('no doc'); },
    agent: async () => ({ script: 'none', settings: {} }),
    finish: async (result) => { finished.push(result); return null; },
  });
  await runner.reconcile();
  await until(() => finished.length === 1 && runner.statuses().length === 0, 'its failure');
  await sleep(200);
  assert.equal(finished.length, 1);
  assert.deepEqual([finished[0].failed, finished[0].threadIds, finished[0].seen], [true, ['c_t'], { c_t: '2026-11-17T10:00:00.000Z' }]);
  assert.match(finished[0].body, /Ponjo could not run X: no doc/);
  assert.ok(asked < 5, 'no loop');
});

test('a look that could not read the asks is tried again, later each time, until one can: no event need come', async () => {
  let asked = 0;
  const started = [];
  const inbox = { buddy: { id: 'b_x', name: 'X', about: '' }, buddies: [], threads: [{ id: 'c_t', comments: [{ at: '2026-11-17T10:00:00.000Z' }] }], askers: ['u_me'] };
  const runner = new Runner({
    asks: async () => {
      asked += 1;
      if (asked <= 2) throw Object.assign(new Error('EBUSY: the sidecar is locked'), { code: 'EBUSY' });
      return started.length ? [] : [inbox];
    },
    doc: async () => { throw new Error('no doc'); },
    agent: async () => ({ script: 'none', settings: {} }),
    finish: async (result) => { started.push(Date.now()); return null; },
  });
  const from = Date.now();
  await runner.reconcile();
  assert.equal(asked, 1);
  await until(() => started.length === 1, 'the run, once the asks could be read', 6000);
  assert.ok(started[0] - from >= 2900, 'after 1 s, then 2 s');
  await sleep(1500);
  assert.ok(asked <= 5, 'once it could read them, not again on its own');
  await runner.stop();
});

test('a teammate hears that a run failed, not why', () => {
  const agents = [{ id: 'b_x', name: 'X', state: 'ready', threadIds: [], failed: [{ thread: 'c_t', at: 'now', why: '/home/me/agents/claude: no key' }] }];
  assert.deepEqual(agentsFor('owner', agents), agents);
  assert.deepEqual(agentsFor('write', agents)[0].failed, [{ thread: 'c_t', at: 'now' }]);
  assert.deepEqual(agentsFor('read', agents)[0].failed, [{ thread: 'c_t', at: 'now' }]);
});

test('a log past 10 MB keeps its newest half, from a line\'s start: runs.jsonl and an agent\'s', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, settingsDir }) => {
    const logs = join(settingsDir, 'logs');
    await mkdir(logs, { recursive: true });
    const old = `${JSON.stringify({ old: 'x'.repeat(1000) })}\n`.repeat(11 * 1024);
    await writeFile(join(logs, 'runs.jsonl'), old);
    await writeFile(join(logs, 'agent.jsonl'), old);
    const id = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
    const sizes = () => Promise.all(['runs.jsonl', 'agent.jsonl'].map(async (name) => (await stat(join(logs, name))).size));
    await until(async () => (await sizes()).every((size) => size <= 5 * 1024 * 1024), 'the logs trimmed');
    assert.deepEqual((await runLog(settingsDir)).at(-1).threads, [id], 'the new line is kept');
    const agents = (await readFile(join(logs, 'agent.jsonl'), 'utf8')).trim().split('\n');
    assert.ok(agents.every((line) => JSON.parse(line).old), 'whole lines');
  });
});

test('with Trace runs on, each run leaves its trace, read by the doc\'s runs: what it was given, did and printed, and what landed; off, none', { timeout: 30_000 }, async () => {
  await withDoc(async ({ settingsDir, call, state, runs, release }) => {
    const traced = async (n) => until(async () => {
      const { runs: list } = await call('runs');
      return list.length === n && list;
    }, `${n} traced runs`);
    const off = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
    await until(async () => (await repliesIn(state, off)).length, 'the reply');
    await until(async () => (await runLog(settingsDir).catch(() => [])).length === 1, 'the run logged');
    assert.ok(!existsSync(join(settingsDir, 'logs', 'traces')), 'none while off');
    assert.deepEqual((await call('runs')).runs, []);

    await call('saveSettings', { trace: true });
    const id = await comment(call, '@Clippy replace "week one" with "week 1"');
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    const [run] = await traced(1);
    assert.deepEqual([run.buddy, run.threads, run.comments, run.outcome], ['Clippy', [id], [answer.id], 'ok'], 'only the thread it has not answered');
    const { trace } = await call('trace', { run: run.run });
    assert.match(trace.prompt, /fzhan: @Clippy replace "week one"/);
    assert.deepEqual(trace.steps, [{ started: 'fzhan: @Clippy replace "week one" with "week 1"' }, 'not JSON'], 'the lines it wrote to PONJO_TRACE');
    assert.ok(trace.comments.after.endsWith(`${JSON.stringify({ thread: id, body: answer.body })}\n`), 'the line it appended');
    assert.ok(trace.base.includes('week one') && trace.edited.includes('week 1') && !trace.edited.includes('week one'));
    assert.ok(trace.comments.before.includes(id), 'the sidecar\'s copy it was given');
    assert.equal(trace.landed, 'Posted');

    const failed = await comment(call, '@Clippy fail');
    const [last] = await traced(2);
    assert.deepEqual([last.threads, last.outcome], [[failed], 'failed']);
    assert.match((await call('trace', { run: last.run })).trace.stderr, /fake agent: something went wrong/);

    // A run ended without an answer, once no thread asks it, keeps what it wrote before it was ended.
    const held = await comment(call, '@Clippy hold');
    await until(async () => (await runs()).length === 4, 'the run to start');
    await call('comment', { thread: held, body: '', resolved: true });
    const [ended] = await traced(3);
    const { trace: cut } = await call('trace', { run: ended.run });
    assert.deepEqual([ended.outcome, ended.comments, cut.landed, cut.steps[0]], ['stopped', [], 'Ended without an answer', { started: 'fzhan: @Clippy hold' }]);
    await release('Clippy');

    await assert.rejects(call('trace', { run: '../settings' }), { code: 'not_found' });
  });
});

test('a comment that mentions no one asks no one; a buddy\'s reply asks no one', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, runs }) => {
    const quiet = await comment(call, 'Clippy, is this clear?');
    const id = await comment(call, '@Clippy say @Clippy');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    await sleep(800);
    assert.equal((await runs()).length, 1);
    assert.equal((await repliesIn(state, quiet)).length, 0);
  });
});

test('in project mode a run gets the project folder, and its copies at the doc\'s path in it', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ponjo-project-'));
  await writeFile(join(folder, 'notes.md'), 'Notes.\n');
  await withDoc(async ({ call, state, runs }) => {
    const id = await comment(call, '@Clippy look around');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    const [run] = await runs();
    assert.equal(run.project, folder, 'the project itself: what an agent reads there is up to its own config');
    assert.deepEqual(run.projectFiles, ['drafts', 'notes.md']);
    assert.deepEqual(run.files, ['drafts'], 'the copies at the doc\'s path in the project');
    assert.ok(run.doc.endsWith(join(basename(run.cwd), 'drafts', 'plan.md')), 'in its folder (macOS may name /var as /private/var)');
    assert.equal(run.comments, `${run.doc}.comments.jsonl`);
    assert.ok(!run.prompt.includes(run.project) && !run.prompt.includes(folder) && !run.prompt.includes(run.cwd), 'no path but the project\'s');
    assert.match(run.prompt, /a member of the doc drafts\/plan\.md\./);
    assert.match(run.prompt, /A file path in a comment is relative to the doc's folder, drafts\/: a comment's notes\.md is drafts\/notes\.md, not notes\.md at the top\./);
    assert.match(run.prompt, /drafts\/plan\.md\.comments\.jsonl holds the doc's threads[\s\S]*append lines to drafts\/plan\.md\.comments\.jsonl, one JSON object per line/);
    await until(() => !existsSync(run.cwd), 'its copies to be gone after', 5000);
  }, { folder });
});

test('a buddy\'s new comment is anchored on the text it quoted, though a person edited that text meanwhile', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state, runs, release }) => {
    await comment(call, '@Clippy hold ;; append {"anchor":{"exact":"cannot handle the extra load"},"body":"Is this measured?"}');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await edit((await state()).text.replace('the extra load', 'the extra holiday load'));
    await release('Clippy');
    const thread = await until(async () => (await state()).threads.find((t) => t.comments[0].body === 'Is this measured?'), 'its comment');
    assert.equal(thread.detached, false);
    assert.equal(thread.anchor.exact, 'cannot handle the extra holiday load');
  });
});

test('a buddy a person sets watching looks at once and opens its watch thread, then runs each time people\'s edits pause, saying nothing when nothing is due; set off, it stops', { timeout: 60_000 }, async () => {
  await withDoc(async ({ docPath, settingsDir, call, edit, state, runs }) => {
    const watching = async () => (await state()).agents.find((a) => a.name === 'Clippy').watching;
    await assert.rejects(call('watch', { buddy: 'Nobody', on: true }), { code: 'not_found' });
    await call('watch', { buddy: 'Clippy', on: true });
    assert.equal(await watching(), true);
    await until(async () => (await runs()).length === 1, 'a run at once');
    assert.match((await runs())[0].prompt, /You watch this doc: .* You have no watch thread yet/);
    const opened = async () => (await state()).threads.find((t) => !t.anchor && t.comments[0].by.name === 'Clippy');
    const thread = await until(opened, 'its watch thread, on the whole doc');
    assert.equal(thread.comments[0].body, 'Watching.');
    assert.doesNotMatch(await readFile(`${docPath}.comments.jsonl`, 'utf8'), /watch/, 'nothing of the watch in the comments\' file');
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready', 'that run to end');

    await edit(`${(await state()).text}\nOne.\n`);
    await sleep(2000);
    assert.equal((await runs()).length, 1, 'not while the edits may go on');
    await until(async () => (await runs()).length === 2, 'a run once they pause', 10_000);
    assert.match((await runs())[1].prompt, new RegExp(`Your watch thread is Thread ${thread.id}: comment there\\.`));
    assert.match((await runs())[1].prompt, /^\+One\.$/m, 'what changed since it last looked');
    await until(async () => (await opened()).comments.at(-1).body === 'Saw 2 new lines.', 'its comment there: the blank line and One.');

    await edit(`${(await state()).text}A quiet line.\n`);
    await until(async () => (await runs()).length === 3, 'a run once they pause', 10_000);
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready', 'that run to end');
    assert.equal((await opened()).comments.length, 2, 'nothing due: nothing said');

    await call('watch', { buddy: 'Clippy', on: false });
    assert.equal(await watching(), false);
    await edit(`${(await state()).text}Two.\n`);
    await sleep(6500);
    assert.equal((await runs()).length, 3, 'no run once set off');
    assert.deepEqual((await runLog(settingsDir)).map((l) => l.watched ?? false), [true, true, true]);
  });
});

test('a watch run is ended when a person types again, with no answer, and runs again once they pause', { timeout: 60_000 }, async () => {
  await withDoc(async ({ settingsDir, call, edit, state, runs, release }) => {
    await call('watch', { buddy: 'Clippy', on: true });
    await until(async () => (await state()).threads.some((t) => !t.anchor && t.comments[0].by.name === 'Clippy'), 'its watch thread');
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready', 'that run to end');
    await edit(`${(await state()).text}\nhold-watch\n`);
    await until(async () => (await runs()).length === 2, 'a run once the edits pause', 10_000);
    await edit(`${(await state()).text}More.\n`);
    await until(async () => (await runLog(settingsDir)).length === 2, 'the run ended');
    assert.equal((await runLog(settingsDir))[1].outcome, 'stopped', 'ended with no answer: it saw the doc as it was');
    await sleep(2000);
    assert.equal((await runs()).length, 2, 'not again while the edits may go on');
    await release('Clippy');
    await until(async () => (await runs()).length === 3, 'a run once they pause', 10_000);
    assert.match((await runs())[2].prompt, /^\+More\.$/m, 'what changed since its last finished look, the edit that ended it too');
  });
});

test('a watch run that fails, before its buddy has a thread, shows on the buddy, why to the owner alone, and Retry runs it again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state, runs }) => {
    await edit(`${(await state()).text}\nfail-watch\n`);
    await call('watch', { buddy: 'Clippy', on: true });
    const failure = async () => (await state()).agents.find((a) => a.name === 'Clippy').watchFailed;
    const failed = await until(failure, 'its failure');
    assert.match(failed.why, /fake agent: the watch run failed/);
    assert.deepEqual((await state()).agents.find((a) => a.name === 'Clippy').failed, [], 'on no thread: it has none yet');
    assert.deepEqual(agentsFor('write', (await state()).agents).find((a) => a.name === 'Clippy').watchFailed, { at: failed.at }, 'a teammate hears that it failed, not why');
    await sleep(500);
    assert.equal((await runs()).length, 1, 'not retried on its own');
    await call('retry', { buddy: 'Clippy' });
    await until(async () => (await runs()).length === 2, 'the run on Retry');
    await edit((await state()).text.replace('fail-watch', 'fine'));
    await until(async () => (await runs()).length === 3, 'a run once the edits pause', 10_000);
    await until(async () => (await failure()) === null, 'no failure once a run goes well');
    assert.equal((await state()).agents.find((a) => a.name === 'Clippy').watching, true, 'still watching all along');
  });
});

test('a buddy\'s change wakes each other buddy watching, never itself, each such run taking a step; with none left they wait, and Refill fills them', { timeout: 60_000 }, async () => {
  await withDoc(async ({ call, edit, state, runs }) => {
    const moves = async () => (await runs()).length;
    const idle = () => until(async () => (await state()).agents.every((a) => a.state === 'ready'), 'the runs to end');
    await call('watch', { buddy: 'Ada', on: true });
    await until(async () => (await state()).text.includes('Ada moved.'), 'Ada\'s first move');
    await idle();
    await sleep(1000);
    assert.equal(await moves(), 1, 'its own change wakes it not');
    assert.deepEqual((await state()).steps, { left: 3, cap: 3, next: null });

    await call('watch', { buddy: 'Ben', on: true });
    await until(async () => (await state()).steps.left === 0, 'the steps to run out');
    await idle();
    await sleep(1000);
    assert.equal(await moves(), 5, 'each first look free, then three steps');
    assert.deepEqual((await runs()).map((r) => r.buddy), ['Ada', 'Ben', 'Ada', 'Ben', 'Ada'], 'each on the other\'s move');
    assert.equal((await state()).steps.next, null, 'none comes on its own');

    await edit(`${(await state()).text}A person's line.\n`);
    await until(async () => (await moves()) === 7, 'both on the pause, free', 10_000);
    await idle();
    await sleep(1000);
    assert.equal(await moves(), 7, 'then they wait again');

    await call('refillSteps', {});
    await until(async () => (await moves()) === 10 && (await state()).steps.left === 0, 'three more moves');
  }, { content: 'ping-pong\n', settings: { steps: 3, refillEvery: 0 }, buddies: { Ada: 'Plays.\n', Ben: 'Plays.\n' } });
});

test('with no step left, buddies watching wait for the next to come on its own', { timeout: 60_000 }, async () => {
  await withDoc(async ({ call, state, runs }) => {
    await call('watch', { buddy: 'Ada', on: true });
    await call('watch', { buddy: 'Ben', on: true });
    await until(async () => (await state()).steps.left === 0 && (await runs()).length === 3, 'the step taken');
    const { next } = (await state()).steps;
    assert.ok(Number.isFinite(next) && next <= Date.now() + 2500, 'when the next comes, within its time');
    await until(async () => (await runs()).length === 4, 'a move on the step that came', 10_000);
    await until(async () => (await runs()).length === 5, 'and on the next', 10_000);
  }, { content: 'ping-pong\n', settings: { steps: 1, refillEvery: 2 }, buddies: { Ada: 'Plays.\n', Ben: 'Plays.\n' } });
});

test('only a person changes a watch: it outlives its thread resolved, a new one opened, and a restart, with no run on opening', { timeout: 60_000 }, async () => {
  await withDoc(async ({ call, edit, state, runs, restart }) => {
    await call('watch', { buddy: 'Clippy', on: true });
    const first = await until(async () => (await state()).threads.find((t) => !t.anchor && t.comments[0].by.name === 'Clippy'), 'its watch thread');
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready', 'its run to end');
    await call('comment', { thread: first.id, body: '', resolved: true });
    await edit(`${(await state()).text}\nOne.\n`);
    await until(async () => (await runs()).length === 2, 'a run once the edits pause', 10_000);
    assert.match((await runs())[1].prompt, /You have no watch thread yet/, 'its thread resolved, it starts another');
    await until(async () => (await state()).threads.filter((t) => !t.anchor && t.comments[0].by.name === 'Clippy').length === 2, 'a second watch thread');
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready', 'that run to end');

    await restart();
    assert.equal((await state()).agents.find((a) => a.name === 'Clippy').watching, true, 'noted on this machine');
    await sleep(1500);
    assert.equal((await runs()).length, 2, 'no run on opening');
    await edit(`${(await state()).text}Two.\n`);
    await until(async () => (await runs()).length === 3, 'a run once the edits pause', 10_000);
    assert.match((await runs())[2].prompt, /This is your first look since the app started/);
  });
});

test('a run that answers nothing in a thread is not run again for it until someone writes there; a person\'s edit runs nothing', { timeout: 30_000 }, async () => {
  await withDoc(async ({ settingsDir, call, edit, state, runs }) => {
    const id = await comment(call, '@Clippy until "ten" replace "extra load" with "extra peak load"');
    await until(async () => (await runLog(settingsDir).catch(() => []))[0]?.outcome === 'ok', 'a run that did nothing');
    await edit(`${(await state()).text}\nNine, ten.\n`);
    await sleep(1500);
    assert.equal((await runs()).length, 1, 'no run on an edit');
    assert.equal((await repliesIn(state, id)).length, 0, 'no reply');
    await reply(call, id, '@Clippy now: replace "extra load" with "extra peak load"');
    await until(async () => (await repliesIn(state, id)).length === 1, 'the reply to the new comment');
    assert.match((await state()).text, /extra peak load/);
    assert.equal((await runs()).length, 2);
  });
});
test('a buddy\'s reply answers its ask: neither it nor a person\'s edit runs it again; a new comment in the thread does, and its run sees what it said', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state, runs }) => {
    const id = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
    await until(async () => (await repliesIn(state, id)).length === 1, 'its reply');
    await edit(`${(await state()).text}\nMore.\n`);
    await sleep(1500);
    assert.equal((await runs()).length, 1, 'not run again on its own reply or a person\'s edit');
    await reply(call, id, 'replace "week one" with "week 1"');
    await until(async () => (await repliesIn(state, id)).length === 2, 'the second reply');
    assert.match((await runs())[1].prompt, /Clippy: Replaced "extra load"\./, 'its reply, in the thread');
    assert.deepEqual((await runs())[1].threadIds, [id]);
  });
});
test('one run a buddy, with every thread that asks it: each reply carries its own edits, as its own version, undone on its own', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, runs, release }) => {
    const first = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    const second = await comment(call, '@Clippy replace "week one" with "week 1"');
    await sleep(1000);
    assert.equal((await runs()).length, 1, 'no second run while the first is on');
    await release('Clippy');
    await until(async () => (await repliesIn(state, first)).length === 1, 'the first reply');
    await until(async () => (await repliesIn(state, second)).length === 1, 'the second reply, in a run of its own right after the first', 8000);
    await until(async () => (await state()).agents.find((a) => a.name === 'Clippy').state === 'ready', 'its runs to end');
    assert.deepEqual((await runs()).map((r) => r.threadIds), [[first], [second]], 'the second run has only the thread not answered');

    const one = await comment(call, '@Clippy hold replace "## Risks" with "## Open risks"');
    const two = await comment(call, '@Clippy replace "The main risk" with "The one risk"');
    await release('Clippy');
    const [a] = await until(async () => (await repliesIn(state, one)).length === 1 && repliesIn(state, one), 'a reply in one');
    const [b] = await until(async () => (await repliesIn(state, two)).length === 1 && repliesIn(state, two), 'a reply in two');
    const { edits } = await state();
    assert.notEqual(edits[a.id].version, edits[b.id].version, 'a version each');
    await call('undo', { id: edits[a.id].version });
    const text = (await state()).text;
    assert.match(text, /## Risks/, 'one\'s edit undone');
    assert.match(text, /The one risk/, 'two\'s edit stays');
  });
});

test('no edit lands without a comment: an agent that edits and says nothing gets an empty reply carrying its edits; one that writes no groups, its last comment', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state }) => {
    const id = await comment(call, '@Clippy quiet replace "extra load" with "extra peak load"');
    const [empty] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(empty.body, '');
    assert.ok((await state()).edits[empty.id], 'its edits hang on it, with their Undo');
    const other = await comment(call, '@Clippy ungrouped replace "week one" with "week 1"');
    const [said] = await until(async () => (await repliesIn(state, other)).length && repliesIn(state, other), 'the reply');
    assert.equal(said.body, 'Replaced "week one".');
    assert.ok((await state()).edits[said.id], 'on its comment');
  });
});

test('after a restart, an unanswered ask runs again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ settingsDir, call, state, runs, release, restart }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await restart(); // ends the run with no answer
    assert.equal((await repliesIn(state, id)).length, 0);
    assert.equal((await runLog(settingsDir))[0].outcome, 'stopped', 'a stopped run is logged');
    await until(async () => (await runs()).length === 2, 'the run to start again');
    await release('Clippy');
    await until(async () => (await repliesIn(state, id)).length === 1, 'one reply');
  });
});

test('a run gets each of its agent\'s settings as PONJO_SETTING_<KEY>: the stored value or the default', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig({ agents: { fake: { model: 'small', effort: 'high', other: 'x' }, claude: { model: 'opus' } } });
  await writeFile(join(settingsDir, 'agents', 'fake.json'), JSON.stringify({ name: 'Fake', settings: [
    { key: 'model', type: 'text', label: 'Model', default: 'big' },
    { key: 'effort', type: 'choice', label: 'Effort', options: [['low', 'Low'], ['high', 'High']], default: 'low' },
    { key: 'endpoint', type: 'text', label: 'Endpoint', default: '' },
    { key: 'tries', type: 'number', label: 'Tries', min: 1, max: 5, default: 3 },
    { key: 'fast', type: 'switch', label: 'Fast', default: false },
    { key: 'key', type: 'secret', label: 'Key' },
  ] }));
  const { doc, call } = await openTestDoc(docPath, { settingsDir });
  try {
    await call('comment', { anchor: null, body: '@Clippy quiet' });
    const [run] = await until(async () => (await fakeRuns(settingsDir)).length && fakeRuns(settingsDir), 'the run');
    assert.deepEqual(run.settings, {
      PONJO_SETTING_MODEL: 'small', PONJO_SETTING_EFFORT: 'high', PONJO_SETTING_ENDPOINT: '', PONJO_SETTING_TRIES: '3', PONJO_SETTING_FAST: 'false', PONJO_SETTING_KEY: '',
    }, 'every field, only its agent\'s; none set is empty');
  } finally {
    await doc.close();
  }
});

// A stand-in for Electron's safeStorage: not encryption, but not the text either.
const cipher = {
  encryptString: (text) => Buffer.from(text).reverse(),
  decryptString: (bytes) => Buffer.from(bytes).reverse().toString(),
};

test('a secret is kept encrypted in the config folder, reaches its agent\'s run, and never settings.json or a log', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig({ agents: { fake: { model: 'small' } } });
  await writeFile(join(settingsDir, 'agents', 'fake.json'), JSON.stringify({ name: 'Fake', settings: [
    { key: 'model', type: 'text', label: 'Model', default: '' },
    { key: 'key', type: 'secret', label: 'API key' },
  ] }));
  assert.deepEqual(await readSecrets(cipher, settingsDir), {}, 'none yet');
  await writeSecrets(cipher, { fake: { key: 'sk-fake-123' }, other: { key: 'sk-other-456' } }, settingsDir);
  const secrets = await readSecrets(cipher, settingsDir);
  assert.deepEqual(secrets, { fake: { key: 'sk-fake-123' }, other: { key: 'sk-other-456' } });
  assert.deepEqual(secretTails(secrets), { fake: { key: '-123' }, other: { key: '-456' } }, 'Settings learns only their last 4 characters');
  const { doc, call } = await openTestDoc(docPath, { settingsDir, secrets: () => secrets });
  try {
    assert.deepEqual((await call('scripts')).secrets, { fake: { key: '-123' }, other: { key: '-456' } });
    const id = (await call('comment', { anchor: null, body: '@Clippy say done' })).id;
    await until(async () => (await call('state')).threads.find((t) => t.id === id).comments.length === 2, 'the reply');
    const [run] = await fakeRuns(settingsDir);
    assert.deepEqual(run.settings, { PONJO_SETTING_MODEL: 'small', PONJO_SETTING_KEY: 'sk-fake-123' }, 'its own agent\'s only');
  } finally {
    await doc.close();
  }
  const written = async (dir) => (await Promise.all((await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name !== 'runs.log').map((e) => readFile(join(e.parentPath, e.name), 'utf8')))).join('\n');
  assert.ok((await readdir(settingsDir)).includes('secrets.bin'));
  assert.doesNotMatch(await written(settingsDir), /sk-fake|sk-other/, 'not in settings.json, the runs\' log or any other file of the config folder');
});

test('Test runs the picked agent once on an empty doc, with its settings, and says what it printed or why it failed', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig({ agents: { fake: { model: 'small' } } });
  await writeFile(join(settingsDir, 'agents', 'fake.json'), JSON.stringify({ name: 'Fake', settings: [
    { key: 'model', type: 'text', label: 'Model', default: '' },
    { key: 'key', type: 'secret', label: 'API key' },
  ] }));
  const { doc, call } = await openTestDoc(docPath, { settingsDir, secrets: () => ({ fake: { key: 'sk-fake-123' } }) });
  try {
    const works = await call('testAgent');
    assert.equal(works.ok, true);
    assert.equal(works.out, 'Done.');
    const [run] = await fakeRuns(settingsDir);
    assert.deepEqual(run.settings, { PONJO_SETTING_MODEL: 'small', PONJO_SETTING_KEY: 'sk-fake-123' });
    assert.deepEqual(run.files.sort(), ['test.md', 'test.md.comments.jsonl'], 'an empty doc of its own, not this one');
    await call('saveSettings', { agent: 'missing' });
    const broken = await call('testAgent');
    assert.equal(broken.ok, false);
    assert.match(broken.out, /no such agent script/);
  } finally {
    await doc.close();
  }
});

test('the shipped scripts pass the project folder only when there is one', () => {
  for (const name of ['claude', 'codex', 'ponjo']) assert.match(readFileSync(join(ROOT, 'agents', `${name}.cmd`), 'utf8'), /\r\n/, `${name}.cmd has Windows line ends`);
  assert.match(readFileSync(join(ROOT, 'agents', 'claude.cmd'), 'utf8'), /set ADD=--add-dir "%PONJO_PROJECT%" --disallowedTools "Edit\(\/%P%\/\*\*\)"/, 'claude.cmd keeps the project read only');
  assert.doesNotMatch(readFileSync(join(ROOT, 'agents', 'codex.cmd'), 'utf8'), /codex exec[^\r]*--add-dir/, 'Codex reads the project without it');
  if (process.platform === 'win32') return;
  // A fake `claude` and `codex` on PATH read the prompt (else writing it can
  // fail with EPIPE) and print the arguments they get, one a line; Codex's
  // last message is its instructions.
  const bin = execFileSync('mktemp', ['-d']).toString().trim();
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\ncat >/dev/null; printf "%%s\\\\n" "$@"\\n' > "${bin}/claude"; printf '#!/bin/sh\\ncat >/dev/null; while [ "$1" != "--output-last-message" ]; do shift; done; echo "reply to: $3" > "$2"\\n' > "${bin}/codex"; chmod +x "${bin}/claude" "${bin}/codex"`]);
  const run = (name, project, model = '') => execFileSync(join(ROOT, 'agents', name), { input: 'prompt', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PONJO_PROJECT: project, PONJO_DOC: '/run/my doc.md', PONJO_SETTING_MODEL: model }, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim().split('\n');
  const claude = ['-p', '@"/run/my doc.md"', '--permission-mode', 'acceptEdits', '--no-session-persistence'];
  const where = 'The paths in the prompt are the project\'s. Your copies of the doc and its comments are at those paths in your working folder; the project\'s other files are at those paths in /work/my project, read only.';
  assert.deepEqual(run('claude', ''), claude, 'Claude gets the doc copy as already read');
  assert.deepEqual(run('claude', '/work/my project'), [...claude, '--add-dir', '/work/my project', '--disallowedTools', 'Edit(//work/my project/**)', '--append-system-prompt', where], 'the project is read only, and where the prompt\'s paths are');
  assert.deepEqual(run('claude', '', 'opus'), [...claude, '--model', 'opus'], 'the model, when set');
  assert.deepEqual(run('codex', ''), ['reply to: -'], 'codex prints only its last message; the prompt is its stdin');
  assert.match(run('codex', '/work/my project')[0], /^reply to: The task is in the stdin block\. Its paths are the project's: .* in \/work\/my project, read only\.$/, 'in a project, where the prompt\'s paths are first');
});

test('the shipped agents are written when missing, then updated until edited; Reset writes one again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-agents-'));
  await installAgents(dir, { platform: 'linux' });
  await installAgents(dir, { platform: 'win32' });
  const ids = async (platform) => (await listAgents(dir, platform)).map((a) => a.id);
  assert.deepEqual([await ids('linux'), await ids('win32')], [['claude', 'codex', 'ponjo'], ['claude', 'codex', 'ponjo']]);
  assert.deepEqual((await listAgents(dir, 'linux')).map((a) => [a.name, a.settings.map((f) => `${f.key}:${f.type}`).join()]), [
    ['Claude Code', 'model:text'], ['Codex', 'model:text'], ['Ponjo agent', 'provider:choice,endpoint:text,anthropic_model:text,anthropic_key:secret,web:switch,openai_model:text,openai_key:secret,nebius_model:text,nebius_key:secret,effort:choice'],
  ], 'each with its manifest, all valid');
  const windows = await mkdtemp(join(tmpdir(), 'ponjo-agents-'));
  await installAgents(windows, { platform: 'win32' });
  assert.deepEqual((await readdir(agentsDir(windows))).sort(), ['.shipped.json', 'claude.cmd', 'claude.json', 'codex.cmd', 'codex.json', 'ponjo-core.mjs', 'ponjo.cmd', 'ponjo.json', 'ponjo.mjs'], 'with the program the Ponjo agent runs, and what was written');
  await writeFile(join(agentsDir(dir), 'mine'), '#!/bin/sh\n');
  await writeFile(join(agentsDir(dir), 'broken'), '#!/bin/sh\n');
  await writeFile(join(agentsDir(dir), 'broken.json'), '{ "name": ');
  assert.deepEqual((await listAgents(dir, 'linux')).filter((a) => ['broken', 'mine'].includes(a.id)), [
    { id: 'broken', name: 'broken', about: '', settings: [] }, { id: 'mine', name: 'mine', about: '', settings: [] },
  ], 'without a manifest, or with one that is not JSON, an agent is its file name');
  const manifest = join(agentsDir(dir), 'claude.json');
  await writeFile(manifest, '{}');
  await installAgents(dir, { platform: 'linux', reset: 'claude' });
  assert.equal(await readFile(manifest, 'utf8'), await readFile(join(ROOT, 'agents', 'claude.json'), 'utf8'), 'Reset writes the manifest too');
  const claude = agentScript('claude', dir, 'linux');
  assert.equal(basename(agentScript('claude', dir, 'win32')), 'claude.cmd');
  await writeFile(claude, '#!/bin/sh\necho mine\n');
  await installAgents(dir, { platform: 'linux' });
  assert.equal(await readFile(claude, 'utf8'), '#!/bin/sh\necho mine\n', 'yours once edited');
  // As written by an older version: the record says so, and it was not edited.
  const codex = agentScript('codex', dir, 'linux');
  const written = join(agentsDir(dir), '.shipped.json');
  await writeFile(codex, '#!/bin/sh\necho old\n');
  await writeFile(written, JSON.stringify({ ...JSON.parse(await readFile(written, 'utf8')), codex: createHash('sha256').update('#!/bin/sh\necho old\n').digest('hex') }));
  await installAgents(dir, { platform: 'linux' });
  assert.equal(await readFile(codex, 'utf8'), await readFile(join(ROOT, 'agents', 'codex'), 'utf8'), 'an unedited older version is replaced');
  await installAgents(dir, { platform: 'linux', reset: 'claude' });
  assert.equal(await readFile(claude, 'utf8'), await readFile(join(ROOT, 'agents', 'claude'), 'utf8'));
});

test('the prompt tells a buddy who the other members are, as the app shows them', () => {
  const thread = { id: 'c_thread01', anchor: null, comments: [{ by: { name: 'fzhan', kind: 'human' }, body: 'hi' }] };
  const buddies = [{ id: 'b_ada', name: 'Ada', about: 'Edits for tone.' }, { id: 'b_bo', name: 'Bo', about: '' }, { id: 'b_cy', name: 'Cy', about: 'Checks facts.' }];
  const prompt = buildPrompt({ buddy: buddies[0], buddies, docName: 'a.md', sidecarName: 'a.md.comments.jsonl', threads: [thread] });
  assert.match(prompt, /The other members of the doc:\n\nBo\n\nCy: Checks facts\./);
  assert.doesNotMatch(prompt, /Ada: /, 'not itself');
  const withUser = buildPrompt({ buddy: buddies[0], buddies, docName: 'a.md', sidecarName: 'a.md.comments.jsonl', threads: [thread], human: { name: 'fzhan', about: 'I write novels.' } });
  assert.match(withUser, /The other members of the doc:\n\nfzhan \(owner\): I write novels\.\n\nBo/);
  assert.match(withUser, /When it does not, start a thread only where a member must decide something, and fix small things in the doc instead\..* Only people resolve threads\./);
  assert.match(withUser, /The situation now:\n\nThe threads that ask you, each oldest comment first:\n\nThread c_thread01, on the whole doc:/, 'each by its id, in the situation, last');
  assert.doesNotMatch(prompt, /I write novels/, 'nothing about an owner who wrote nothing');
});

test('the prompt names files by their paths in the project, a comment\'s from the doc\'s folder', () => {
  const thread = { id: 'c_thread01', anchor: null, comments: [{ by: { name: 'fzhan', kind: 'human' }, body: 'Summarize rule.md' }] };
  const prompt = (docName, project) => buildPrompt({ buddy: { id: 'b_ada', name: 'Ada', about: '' }, docName, sidecarName: `${docName}.comments.jsonl`, threads: [thread], project });
  assert.match(prompt('a.md', true), /every path here is from the project's top folder: .* relative to the doc's folder, the top one\./);
  assert.match(prompt('plans/2026/a.md', true), /relative to the doc's folder, plans\/2026\/: a comment's notes\.md is plans\/2026\/notes\.md/);
  assert.match(prompt('plans/2026/a.md', true), /First, work out which file each thread is about\. "The doc" and "this doc" are plans\/2026\/a\.md\. Another file or doc a comment names .* find it by name/, 'not taken for the doc');
  assert.doesNotMatch(prompt('a.md', false), /project/, 'in doc mode, no project');
});
