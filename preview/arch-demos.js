// The architecture page's live demos (site/architecture.html), each played
// step by step with a caption: the problem and the solution a row at a time;
// for each part of the solution, what you see, in a Ponjo window drawn with
// the app's own classes (with what happens behind the scenes beside it,
// merged in with merge3, src/core/diff.js), and the parts under the hood that
// make it so; and a real turn of the Ponjo agent (agents/ponjo-core.mjs) on
// the preview's model, landed as the doc host lands one
// (src/host/doc-service.js, finishRun). preview/build.js bundles it into
// dist/preview, which the site serves at /preview/; the model
// (infer.ponjo.app) answers pages on ponjo.app only.

/* global document, IntersectionObserver */

import { diffOps, mapOffset } from '../src/core/ot.js';
import { lineChanges, merge3 } from '../src/core/diff.js';
import { newId, serializeSidecar, threadsOf } from '../src/core/comments.js';
import { buildPrompt } from '../src/core/prompt.js';
import { INFER, turn } from '../agents/ponjo-core.mjs';
import { agentFace, buddyColor, personFace, setBuddies, setPeople } from '../web/faces.js';
import { cursorNode } from '../web/marks.js';
import { icon } from '../web/icons.js';

const $ = (root, selector) => root.querySelector(selector);
const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

// Set `text` in a textarea, its selection moved over `ops`, as others' edits move a caret.
function show(area, text, ops) {
  const [from, to] = [mapOffset(area.selectionStart, ops), mapOffset(area.selectionEnd, ops)];
  area.value = text;
  area.setSelectionRange(from, to);
}

// `after` drawn as a revision of `before`, by whole lines as they merge:
// the lines taken out struck through, those put in in the buddy's colour.
function revision(node, before, after) {
  const runs = []; // { from, to } in `before`, { at, end } in `after`
  let shift = 0;
  for (const op of diffOps(before, after)) {
    const from = op.from && before.lastIndexOf('\n', op.from - 1) + 1; // lastIndexOf at -1 looks at 0
    const end = before.indexOf('\n', Math.max(op.from, op.to - 1));
    const to = end < 0 ? before.length : end + 1;
    const at = from + shift;
    shift += op.insert.length - (op.to - op.from);
    const last = runs.at(-1);
    if (last && from < last.to) Object.assign(last, { to: Math.max(last.to, to), end: Math.max(last.to, to) + shift });
    else runs.push({ from, to, at, end: to + shift });
  }
  let at = 0;
  node.replaceChildren();
  for (const run of runs) {
    node.append(before.slice(at, run.from), el('del', 'pj-buddy-del', before.slice(run.from, run.to)), el('span', 'pj-buddy-edit', after.slice(run.at, run.end)));
    at = run.to;
  }
  node.append(before.slice(at));
}

// ---- A real turn: Clippy on a copy, landed as the doc host lands it ----

const DOC = 'plan.md';
const SIDECAR = `${DOC}.comments.jsonl`;
const PLAN = `# Launch plan

We ship the beta in March to fifty design partners, who each get a private onboarding call, a shared channel with the team and early access to every feature as it lands, so that we hear what breaks before anyone else does.

Then we open the waitlist, in the order people joined it.
`;
const CLIPPY = { id: 'clippy', name: 'Clippy', about: '' };
const YOU = { id: 'you', name: 'You', kind: 'human' };
const infer = INFER.openai({ endpoint: 'https://infer.ponjo.app/infer', model: 'nemotron', key: 'preview' });

// A tool call as a trace shows it: its name and what it was given.
function called({ name, args }) {
  let a = {};
  try {
    a = JSON.parse(args);
  } catch {} // shown by name alone; the turn says what was wrong
  if (name === 'read') return `read ${a.path ?? ''}${a.lines ? ` ${a.lines.join('–')}` : ''}`;
  if (name === 'find' || name === 'grep') return `${name} ${a.pattern ?? ''}`;
  if (name === 'comment') return `comment on “${(a.on ?? '').slice(0, 24)}”`;
  if (name === 'propose') return `propose ${a.edits?.length ?? 0} ${a.edits?.length === 1 ? 'edit' : 'edits'}`;
  return name;
}

function buddyTurn(root) {
  const doc = $(root, '[data-doc]');
  const ask = $(root, '[data-ask]');
  const run = $(root, '[data-run]');
  const reset = $(root, '[data-reset]');
  const status = (text) => {
    $(root, '[data-status]').hidden = !text;
    $(root, '[data-status-text]').textContent = text ?? '';
  };

  async function go() {
    run.disabled = reset.disabled = true;
    $(root, '[data-landed]').hidden = true;
    const first = { id: newId('c'), by: YOU, at: new Date().toISOString(), body: ask.value };
    const thread = threadsOf([first], [CLIPPY])[0];
    let redo = null;
    let steps = 0; // of this run: a run once more has its own 20
    const trace = $(root, '[data-trace]');
    trace.replaceChildren();
    // Each step of the loop as it runs: what the model called and how long it
    // took; and a proposal the program sent back, as its next messages say.
    const traced = async (messages, tools) => {
      const results = messages.slice(messages.findLastIndex((m) => m.role === 'assistant') + 1);
      const back = results.find((m) => m.role === 'tool' && m.content.startsWith('Nothing was changed.'));
      if (back) trace.lastChild.append(el('span', 'arch-back', `sent back: ${back.content.replace('Nothing was changed. ', '').split('. ')[0]}`));
      status(`${redo ? 'Running once more, told what you changed' : 'Clippy is working on a copy'}. Keep editing the doc.`);
      const started = Date.now();
      const step = await infer(messages, tools);
      const row = el('li', '', `${++steps}.`);
      row.append(...(step.calls.length ? step.calls.map(called) : ['answer']).map((text) => el('span', 'arch-tool', text)), `${((Date.now() - started) / 1000).toFixed(1)} s`);
      trace.append(row);
      return step;
    };
    try {
      for (;;) {
        const base = doc.value;
        const copies = { [DOC]: base, [SIDECAR]: serializeSidecar([{ comment: first }]) };
        const prompt = buildPrompt({ buddy: CLIPPY, buddies: [CLIPPY], docName: DOC, sidecarName: SIDECAR, thread, human: { name: YOU.name, about: '' }, redo });
        const readFile = (path) => copies[path] ?? (['', '.'].includes(path) ? Object.keys(copies) : null);
        const { doc: edited, reply } = await turn({ prompt, doc: DOC, sidecar: SIDECAR, thread: thread.id }, { infer: traced, readFile });
        const now = doc.value;
        const merged = merge3(base, now, edited);
        if (merged.conflicts > 0 && !redo) { // as the doc host does: once more, on the doc as it is now
          redo = { mine: lineChanges(base, edited), theirs: lineChanges(base, now) };
          trace.append(el('li', '', 'Its edit collided with yours: the turn runs once more, told what you changed.'));
          steps = 0;
          continue;
        }
        show(doc, merged.text, diffOps(now, merged.text));
        revision($(root, '[data-result]'), now, merged.text);
        $(root, '[data-reply]').textContent = reply || '(no reply: the edit says it all)';
        $(root, '[data-verdict]').textContent = edited === base ? 'Clippy edited nothing.'
          : merged.conflicts ? `It collided with your typing twice: your lines stay there, the rest of its edit landed, and its version says conflict.`
            : redo ? 'Its first edit collided with your typing, so it ran once more on the doc as it was then, and that landed.'
              : 'It landed, merged with what you typed meanwhile.';
        $(root, '[data-landed]').hidden = false;
        break;
      }
    } catch (error) {
      $(root, '[data-reply]').textContent = `Clippy could not answer: ${error.message.split('\n')[0]}`;
      $(root, '[data-result]').replaceChildren();
      $(root, '[data-verdict]').textContent = '';
      $(root, '[data-landed]').hidden = false;
    }
    status(null);
    run.disabled = reset.disabled = false;
  }

  doc.value = PLAN;
  run.onclick = go;
  reset.onclick = () => {
    doc.value = PLAN;
    $(root, '[data-landed]').hidden = true;
    $(root, '[data-trace]').replaceChildren();
  };
}

// ---- Shared: steps played with a caption each, faces, a doc's lines ----

const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const STOPPED = Symbol('stopped');

// Plays `steps` in order each time `root` comes into view: each shows its
// caption, runs, then holds. `reset` puts the demo back at its start; a
// Replay button plays it again. With reduced motion, nothing waits.
function stepper(root, caption, steps, reset) {
  const again = el('button', 'pj-link-button', 'Replay');
  again.type = 'button';
  const controls = el('div', 'arch-controls');
  controls.append(again);
  root.append(controls);
  let playing = 0;
  async function play() {
    const id = ++playing;
    const wait = (ms) => new Promise((done, stop) => setTimeout(() => (id === playing ? done() : stop(STOPPED)), still ? 0 : ms));
    reset();
    try {
      for (const step of steps) {
        caption.textContent = step.say;
        await step.run(wait);
        await wait(step.hold ?? 3500);
      }
    } catch (error) {
      if (error !== STOPPED) throw error;
    }
  }
  again.onclick = play;
  new IntersectionObserver(([seen]) => {
    if (seen.isIntersecting) play();
    else playing += 1; // stops it at its next wait
  }, { threshold: 0.5 }).observe(root);
}

// A doc's lines, each { text, by?, old?, mine?, caret? }: by an agent, in its
// colour; `old` struck through before it; `mine`, a line you changed; `caret`,
// where you type.
function drawLines(node, lines) {
  node.replaceChildren(...lines.map((line) => {
    const row = el('div', 'arch-line');
    if (line.old !== undefined) row.append(el('del', 'pj-buddy-del', line.old));
    const words = el('span', line.by ? 'pj-buddy-edit' : line.mine ? 'arch-mine' : '', line.text);
    if (line.by) words.style.setProperty('--buddy', buddyColor(line.by));
    row.append(words);
    if (line.caret) row.append(el('span', 'arch-caret'));
    return row;
  }));
}

// ---- The problem and the solution, a row at a time ----

const TABLES = {
  problem: {
    say: 'In tools like Claude Docs, as we used it, an agent works in a chat session behind the doc, and its context builds up there.',
    head: ['What follows', 'Why'],
    rows: [
      ['Asks wait in line', 'Each run builds on what the session kept from the last one, so a new ask waits for it to finish.'],
      ['What the agent knows is hidden', 'Its context is a history you never see, so an edit can rest on things that were never on the page.'],
      ['Context splits', 'What one person’s session learns stays in it, so each person and agent works from a different picture.'],
    ],
  },
  solution: {
    say: 'In Ponjo, each agent run is a stateless function of the doc, its comments and the thread it answers.',
    head: ['What follows', 'Why'],
    rows: [
      ['Ask many things at once', 'A run starts from the doc and its thread, never from what an earlier run left behind.'],
      ['Nothing it knows is hidden', 'A run knows only the doc, its comments, its persona and the files it reads.'],
      ['Everyone shares one context', 'What an agent learns goes into the doc or a comment, or it is gone.'],
      ['You keep the last word', 'An agent changes only its copy; the app, the only writer, merges it in.'],
    ],
  },
};

function table(root, { say, head, rows }) {
  const caption = el('p', 'arch-caption');
  const top = el('div', 'arch-block arch-who');
  top.append(...head.map((words) => el('span', '', words)));
  const lines = rows.map(([claim, why]) => {
    const row = el('div', 'arch-block');
    row.append(el('span', 'arch-design', claim), el('span', 'arch-blocks', why));
    return row;
  });
  root.append(caption, top, ...lines);
  stepper(root, caption, lines.map((row) => ({
    say,
    run: async () => {
      row.hidden = false;
    },
    hold: 3000,
  })), () => {
    for (const row of lines) row.hidden = true;
  });
}

// ---- Under the hood: the parts that make each one work ----

// The window, the doc host (the only writer of the file), the runner, the
// project's files, and the runs, each an agent in its own process on its own
// copy. `parts` are the boxes and lines in focus; the rest are dimmed.
function machine(node, parts) {
  const on = (name) => (parts.includes(name) ? ' class="on"' : '');
  node.toggleAttribute('data-focus', parts.length > 0);
  node.innerHTML = `<svg viewBox="0 0 760 240" role="img" aria-label="The window sends your typing and comments to the doc host, the only writer of the file; the runner starts a run for each open ask; each run works on its own copy of the doc and its comments and can read the project's files; the host merges each copy back with merge3">
<defs><marker id="arch-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arch-tip" d="M0 0L10 5L0 10z"/></marker></defs>
<g${on('window')}><rect x="20" y="20" width="160" height="72" rx="10"/><text x="100" y="50">Window</text><text class="sub" x="100" y="70">people type and comment</text></g>
<g${on('typing')}><path d="M180 42H294" marker-end="url(#arch-tip)"/><text class="sub" x="238" y="34">typing</text></g>
<g${on('comment')}><path d="M180 72H294" marker-end="url(#arch-tip)"/><text class="sub" x="238" y="88">@mention</text></g>
<g${on('host')}><rect x="300" y="20" width="160" height="72" rx="10"/><text x="380" y="44">Doc host</text><text class="sub" x="380" y="62">the only writer</text><text class="sub" x="380" y="78">doc, comments, versions</text></g>
<g${on('asks')}><path d="M460 56H574" marker-end="url(#arch-tip)"/><text class="sub" x="518" y="48">open asks</text></g>
<g${on('runner')}><rect x="580" y="20" width="160" height="72" rx="10"/><text x="660" y="50">Runner</text><text class="sub" x="660" y="70">a run per open ask</text></g>
<g${on('start')}><path d="M660 92V146" marker-end="url(#arch-tip)"/><text class="sub start" x="668" y="124">start, stop</text></g>
<g${on('copy')}><path d="M440 92V146" marker-end="url(#arch-tip)"/><text class="sub start" x="448" y="124">a copy</text></g>
<g${on('project')}><rect x="20" y="164" width="160" height="60" rx="10"/><text x="100" y="190">Project files</text><text class="sub" x="100" y="208">as in the sidebar</text></g>
<g${on('read')}><path d="M180 204H396" marker-end="url(#arch-tip)"/><text class="sub" x="290" y="198">read only</text></g>
<g${on('turns')}><rect x="400" y="152" width="340" height="72" rx="10"/><text class="sub start" x="414" y="172">Runs, each a process on its own copy</text><rect class="chip" x="414" y="182" width="154" height="30" rx="6"/><text class="small" x="491" y="202">Clippy · copy + agent</text><rect class="chip" x="574" y="182" width="154" height="30" rx="6"/><text class="small" x="651" y="202">Max · copy + agent</text></g>
<g${on('merge')}><path d="M400 172H380V98" marker-end="url(#arch-tip)"/><text class="sub end" x="372" y="140">merge3</text></g>
</svg>`;
}

// A slide's steps: each a caption and the parts it puts in focus.
function underTheHood(root, steps) {
  const caption = el('p', 'arch-caption');
  const drawing = el('div', 'arch-flow');
  root.append(caption, drawing);
  stepper(root, caption, steps.map(([parts, say], i) => ({
    say,
    run: async () => machine(drawing, parts),
    hold: i === steps.length - 1 ? 6000 : 4500,
  })), () => machine(drawing, []));
}

const HOODS = {
  parallel: [
    [['comment', 'host', 'asks', 'runner'], 'An ask is a line in the doc’s comments. The runner keeps one run going for each open ask: no queue, no line.'],
    [['copy', 'turns'], 'Each run starts from a fresh copy of the doc and its comments, and keeps nothing from any run before it.'],
    [['runner', 'start', 'turns'], 'So no run depends on another: they go in parallel, and any one can stop, or start over, at any time.'],
  ],
  visible: [
    [['host', 'copy', 'turns'], 'A run gets a copy of the doc and all its comments, and the persona of the buddy you asked.'],
    [['project', 'read', 'turns'], 'It can read the project’s files, read only, as anyone sees them in the sidebar. Nothing else.'],
    [['turns'], 'It keeps no memory between runs, so it knows nothing you cannot see. With traces on, you see which files it read.'],
  ],
  shared: [
    [['window', 'typing', 'comment', 'host'], 'There is one doc, one set of comments and one project, for everyone in it.'],
    [['copy', 'project', 'read', 'turns'], 'Every run reads the same ones, whoever asked: you, a teammate, or another agent’s comment.'],
    [['merge', 'host'], 'What a run learns comes back only through the doc, as an edit or a comment. Every later run, and every person, sees it.'],
  ],
  control: [
    [['host'], 'The doc host is the only writer of the file: every edit, typed or merged, goes through it, in order.'],
    [['turns', 'merge', 'host'], 'When a run ends, the host merges its copy into the doc as it is now, by line: merge3 of the copy as it started, the doc now, and the copy as it ended.'],
    [['merge', 'runner', 'start', 'turns'], 'Where you changed the same lines, your lines stay, and the runner runs it once more on your version.'],
    [['host'], 'Each run lands as one version, with the one before it kept: that is its “1 edit” count, and its Undo.'],
  ],
};

// ---- A Ponjo window, as the app draws it ----

// The app's own classes (web/app.css): its header with the buddies' faces,
// the doc, and the threads in the margin, with a buddy's cursor, its edit
// landing with its name, its reply and Undo. A panel below can show what the
// app does behind the scenes: each buddy's copy of the doc.
const PARAS = [
  'We ship the beta in March to fifty design partners, who each get a private call and early access.',
  'Then we open the waitlist.',
];
const TITLE = 'Launch plan';
const text = (paras) => `# ${TITLE}\n\n${paras.join('\n\n')}\n`;
const parasOf = (doc) => doc.trimEnd().split('\n\n').slice(1);

function avatar(name, person, size = 24) {
  const node = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
  node.style.setProperty('--size', `${size}px`);
  node.append(person ? personFace(name) : agentFace(name));
  return node;
}

function app(root, buddies, { behind = null, people = ['You'] } = {}) {
  const head = el('div', 'arch-app-head');
  head.append(icon('file'), el('span', '', 'plan.md'), el('span', 'pj-spacer'));
  const faces = {};
  for (const name of buddies) {
    const agent = el('span', 'pj-agent');
    const button = el('span', 'pj-agent-face');
    button.append(avatar(name, false, 28));
    agent.append(button);
    faces[name] = agent;
    head.append(agent);
  }
  head.append(...people.map((name) => avatar(name, true, 28)));
  const doc = el('div', 'arch-app-doc');
  const margin = el('div', 'arch-app-margin');
  const body = el('div', 'arch-app-body');
  body.append(doc, margin);
  const frame = el('div', 'arch-app');
  frame.append(head, body);
  const controls = $(root, '.arch-controls'); // the Replay button stays under the window
  root.insertBefore(frame, controls);
  let copies = null;
  if (behind) {
    copies = el('div', 'arch-two');
    const panel = el('div', 'arch-behind');
    panel.append(el('span', 'arch-who', behind === true ? 'Behind the scenes: each buddy’s own copy of the doc' : behind), copies);
    root.insertBefore(panel, controls);
  }
  return {
    faces, margin, copies,
    // The doc: its paragraphs, each { text, hl?, mine?, by?, cursor?, caret? }.
    draw(paras) {
      doc.replaceChildren(el('div', 'arch-app-h1', TITLE), ...paras.map((p) => {
        const row = el('div', 'arch-para');
        let words = el('span', p.hl ? 'pj-hl' : p.mine ? 'arch-mine' : '', p.text);
        if (p.by) {
          words = el('span', 'pj-buddy-edit pj-replay', p.text);
          words.style.setProperty('--buddy', buddyColor(p.by));
          const flag = el('span', 'pj-flag');
          flag.style.cssText = `--buddy: ${buddyColor(p.by)}; --buddy-ink: var(--on-text)`;
          flag.append(el('span', 'pj-flag-label', p.by));
          row.append(flag);
        }
        if (p.cursor) row.append(cursorNode({ by: p.cursor, working: true }));
        row.append(words);
        if (p.caret) row.append(el('span', 'arch-caret'));
        return row;
      }));
    },
    working(name, on) {
      if (on) faces[name].dataset.presence = 'working';
      else delete faces[name].dataset.presence;
    },
  };
}

// A thread in the margin: a comment by `by` asking `buddy`; it can show the
// buddy at work, its reply (with Undo when it edited), or that it was resolved.
function thread(margin, buddy, words, by = 'You') {
  const card = el('article', 'pj-card');
  card.style.setProperty('--buddy', buddyColor(buddy));
  const message = (name, person, ...body) => {
    const msg = el('div', 'pj-msg');
    const head = el('div', 'pj-msg-head');
    const who = el('div', 'pj-who');
    who.append(el('span', 'pj-name', name), el('time', 'pj-time', 'now'));
    head.append(avatar(name, person), who);
    const text = el('div', 'pj-body');
    text.append(...body);
    msg.append(head, text);
    return msg;
  };
  const chip = el('span', 'pj-at pj-at-agent', `@${buddy}`);
  chip.style.setProperty('--buddy', buddyColor(buddy));
  const ask = el('span', '');
  card.append(message(by, true, chip, ' ', ask));
  margin.append(card);
  let busy = null;
  return {
    card,
    async type(wait) {
      for (let i = 1; i <= words.length; i++) {
        ask.textContent = words.slice(0, i);
        await wait(35);
      }
    },
    working(on) {
      card.classList.toggle('pj-card-working', on);
      busy?.remove();
      busy = null;
      if (!on) return;
      busy = el('div', 'pj-typing');
      const face = el('span', 'pj-agent-face');
      face.append(avatar(buddy, false));
      busy.append(face, el('span', '', `${buddy} is working…`));
      card.append(busy);
    },
    reply(words1, edits = 1) {
      this.working(false);
      if (!edits) {
        card.append(message(buddy, false, words1));
        return;
      }
      const receipt = el('div', 'pj-receipt');
      receipt.style.setProperty('--buddy', buddyColor(buddy));
      const count = el('span', 'pj-receipt-show');
      count.append(icon('pencil'), el('span', '', '1 edit'));
      const undo = el('span', 'pj-icon-btn pj-receipt-undo');
      undo.append(icon('undo'));
      receipt.append(count, undo);
      const msg = message(buddy, false, words1);
      msg.append(receipt);
      card.append(msg);
    },
    resolve() {
      this.working(false);
      card.classList.add('pj-card-resolved');
      const row = el('div', 'pj-resolved-row');
      row.append(icon('check'), el('span', '', 'Resolved by you'));
      card.append(row);
    },
  };
}

// A buddy's copy behind the scenes: the paragraph it changes, and a line on what it is doing.
function copyOf(copies, buddy) {
  const title = el('span', 'arch-who');
  title.append(avatar(buddy, false, 18), `${buddy}’s copy`);
  const lines = el('div', 'arch-lines');
  const state = el('div', 'arch-quiet');
  const box = el('div', 'arch-pane');
  box.append(title, lines, state);
  copies.append(box);
  return {
    box,
    show(paras, changed, words) {
      drawLines(lines, [{ text: paras[changed], by: buddy }]);
      state.textContent = words;
    },
  };
}

// Text `from` turned into `to` a part `x` of the way, as a buddy writes it:
// the new text typed over the old, then what is left of the old deleted.
function writing(from, to, x) {
  const k = Math.round(x * Math.max(from.length, to.length));
  return to.slice(0, Math.min(k, to.length)) + from.slice(k);
}

// ---- Nothing it knows is hidden ----

// Clippy checks a price. Beside the window, everything its run knew, all of
// it on the page or in the project: then its edit, resting on one of them.
function visible(root) {
  const caption = el('p', 'arch-caption');
  root.append(caption);
  const DOC = ['The beta ships in March to fifty design partners.', 'It costs $10 a month.'];
  const KNEW = [
    ['plan.md', 'the doc'],
    ['plan.md comments', 'every thread on it'],
    ['Clippy.md', 'its persona, in the project'],
    ['pricing.md', 'a file it chose to read'],
  ];
  let win;
  let ask;
  const reset = () => {
    for (const node of root.querySelectorAll('.arch-app, .arch-behind')) node.remove();
    win = app(root, ['Clippy'], { behind: 'Everything Clippy’s run knew' });
    win.draw(DOC.map((t) => ({ text: t })));
  };
  stepper(root, caption, [
    { say: 'You ask Clippy whether the price is right.', run: async (wait) => {
      win.draw([{ text: DOC[0] }, { text: DOC[1], hl: true }]);
      ask = thread(win.margin, 'Clippy', 'is this price right?');
      await ask.type(wait);
    } },
    { say: 'Its run knows only what you can see too: the doc, its comments, its persona, and the files it reads.', run: async (wait) => {
      win.working('Clippy', true);
      ask.working(true);
      win.draw([{ text: DOC[0] }, { text: DOC[1], hl: true, cursor: 'Clippy' }]);
      for (const [path, what] of KNEW) {
        const row = el('div', 'arch-actor arch-row');
        row.append(icon('file'), el('b', '', path), el('span', 'arch-quiet', what));
        win.copies.append(row);
        await wait(900);
      }
    }, hold: 3000 },
    { say: 'So its edit rests on nothing you cannot check: pricing.md says $12.', run: async () => {
      win.working('Clippy', false);
      win.draw([{ text: DOC[0] }, { text: 'It costs $12 a month.', by: 'Clippy' }]);
      ask.reply('pricing.md says $12 a month.');
    }, hold: 6000 },
  ], reset);
}

// ---- Everyone shares one context ----

// Alice asks Max to check the dates; Max's finding goes into its reply, on
// the doc. Later you ask Clippy for a summary, and Clippy's run reads Max's
// reply too: no private session holds it.
function shared(root) {
  const caption = el('p', 'arch-caption');
  root.append(caption);
  const DOC = ['The beta ships in March to fifty design partners.', 'Then we open the waitlist.'];
  let win;
  let alice;
  let you;
  const reset = () => {
    for (const node of root.querySelectorAll('.arch-app, .arch-behind')) node.remove();
    win = app(root, ['Max', 'Clippy'], { people: ['Alice', 'You'] });
    win.draw(DOC.map((t) => ({ text: t })));
  };
  stepper(root, caption, [
    { say: 'Alice, a teammate, asks Max to check the dates.', run: async (wait) => {
      win.draw([{ text: DOC[0], hl: true }, { text: DOC[1] }]);
      alice = thread(win.margin, 'Max', 'are the dates right?', 'Alice');
      await alice.type(wait);
      win.working('Max', true);
      alice.working(true);
    } },
    { say: 'Max finds the launch moved, and says so in the thread, on the doc, where everyone can see it.', run: async () => {
      win.working('Max', false);
      alice.reply('The launch moved to April: see schedule.md.', 0);
    } },
    { say: 'Later you ask Clippy for a one-line summary. Nobody tells Clippy about April.', run: async (wait) => {
      win.draw(DOC.map((t) => ({ text: t })));
      you = thread(win.margin, 'Clippy', 'add a one-line summary');
      await you.type(wait);
      win.working('Clippy', true);
      you.working(true);
    } },
    { say: 'Clippy’s run reads every comment on the doc, Max’s too, so its summary says April. One shared picture, no private sessions.', run: async () => {
      win.working('Clippy', false);
      win.draw([...DOC.map((t) => ({ text: t })), { text: 'In short: the beta ships in April.', by: 'Clippy' }]);
      you.reply('Added a summary.');
    }, hold: 6000 },
  ], reset);
}

// ---- 2 · Agents always run in parallel ----

function design2(root) {
  const caption = el('p', 'arch-caption');
  root.append(caption);
  const EDIT = { Clippy: [0, 'Fifty design partners get the beta in March.'], Max: [1, 'Then we invite everyone on the waitlist, oldest first.'] };
  let win;
  let threads;
  let copies;
  const reset = () => {
    for (const node of root.querySelectorAll('.arch-app, .arch-behind')) node.remove();
    win = app(root, ['Clippy', 'Max'], { behind: true });
    win.draw(PARAS.map((t) => ({ text: t })));
    threads = {};
    copies = {};
  };
  const doc = (marks = {}) => win.draw(PARAS.map((t, i) => ({ text: t, hl: marks.hl?.includes(i), cursor: marks.cursor?.[i] })));
  stepper(root, caption, [
    { say: 'Clippy and Max are AI buddies: AI agents with a name and a face. You ask them in comments, as you would teammates.', run: async (wait) => {
      doc({ hl: [0, 1] });
      threads.Clippy = thread(win.margin, 'Clippy', 'make this shorter');
      await threads.Clippy.type(wait);
      threads.Max = thread(win.margin, 'Max', 'say who comes first');
      await threads.Max.type(wait);
    } },
    { say: 'Both start at once, each on its own copy. Your doc does not change while they work.', run: async (wait) => {
      for (const name of ['Clippy', 'Max']) {
        win.working(name, true);
        threads[name].working(true);
        copies[name] = copyOf(win.copies, name);
      }
      doc({ hl: [0, 1], cursor: { 0: 'Clippy', 1: 'Max' } });
      for (let x = 0; x <= 1.0001; x += 0.05) {
        for (const name of ['Clippy', 'Max']) {
          const [i, to] = EDIT[name];
          const k = name === 'Max' ? Math.min(1, x * 0.75) : x;
          copies[name].show(PARAS.map((t, j) => (j === i ? writing(t, to, k) : t)), i, 'working');
        }
        await wait(140);
      }
    } },
    { say: 'You resolve Max’s comment. Max stops at once, and its copy is thrown away: nothing to undo.', run: async () => {
      threads.Max.resolve();
      win.working('Max', false);
      copies.Max.box.classList.add('arch-gone');
      copies.Max.show(PARAS.map((t, j) => (j === 1 ? EDIT.Max[1] : t)), 1, 'stopped, thrown away');
      doc({ hl: [0], cursor: { 0: 'Clippy' } });
    }, hold: 4500 },
    { say: 'Clippy is done. Only now does your doc change: the app merges Clippy’s copy in.', run: async () => {
      const now = merge3(text(PARAS), text(PARAS), text([EDIT.Clippy[1], PARAS[1]])).text;
      const [one, two] = parasOf(now);
      win.working('Clippy', false);
      win.draw([{ text: one, by: 'Clippy' }, { text: two }]);
      threads.Max.card.hidden = true; // a resolved thread hides, as in the app
      threads.Clippy.reply('Made it shorter.');
      copies.Clippy.show([one, two], 0, 'done, merged in');
    }, hold: 6000 },
  ], reset);
}

// ---- 3 · The app merges. You never resolve. ----

function design3(root) {
  const caption = el('p', 'arch-caption');
  root.append(caption);
  const SHORTER = 'Fifty design partners get the beta in March.';
  const YOURS = PARAS[0].replace('in March', 'in April');
  const REDONE = 'Fifty design partners get the beta in April.';
  let win;
  let ask;
  let copy;
  const reset = () => {
    for (const node of root.querySelectorAll('.arch-app, .arch-behind')) node.remove();
    win = app(root, ['Clippy'], { behind: true });
    win.draw(PARAS.map((t) => ({ text: t })));
  };
  stepper(root, caption, [
    { say: 'You ask Clippy to shorten the first paragraph. It works on its own copy.', run: async (wait) => {
      win.draw([{ text: PARAS[0], hl: true }, { text: PARAS[1] }]);
      ask = thread(win.margin, 'Clippy', 'make this shorter');
      await ask.type(wait);
      win.working('Clippy', true);
      ask.working(true);
      copy = copyOf(win.copies, 'Clippy');
      for (let x = 0; x <= 1.0001; x += 0.1) {
        copy.show([writing(PARAS[0], SHORTER, x), PARAS[1]], 0, 'working');
        await wait(120);
      }
    } },
    { say: 'Meanwhile you change the same paragraph: the beta moves to April.', run: async () => {
      win.draw([{ text: YOURS, mine: true, cursor: 'Clippy' }, { text: PARAS[1] }]);
    } },
    { say: 'Clippy is done, but its copy says March. The app keeps your line, and has Clippy redo its edit on your version.', run: async (wait) => {
      const { conflicts } = merge3(text(PARAS), text([YOURS, PARAS[1]]), text([SHORTER, PARAS[1]]));
      copy.show([SHORTER, PARAS[1]], 0, `${conflicts} paragraph changed by you too: redo it on yours`);
      await wait(2500);
      for (let x = 0; x <= 1.0001; x += 0.1) {
        copy.show([writing(YOURS, REDONE, x), PARAS[1]], 0, 'redoing, on your version');
        await wait(120);
      }
    } },
    { say: 'Clippy’s new edit lands, with your April in it. Nobody had to resolve anything.', run: async () => {
      const now = merge3(text([YOURS, PARAS[1]]), text([YOURS, PARAS[1]]), text([REDONE, PARAS[1]])).text;
      const [one, two] = parasOf(now);
      win.working('Clippy', false);
      win.draw([{ text: one, by: 'Clippy' }, { text: two }]);
      ask.reply('Made it shorter.');
      copy.show([one, two], 0, 'done, merged in');
    }, hold: 6000 },
  ], reset);
}

// ---- The page as slides: a dot per slide, the current one marked ----

function deck() {
  const slides = [...document.querySelectorAll('.arch-slide')];
  const dots = slides.map((slide, i) => {
    const dot = el('button', 'arch-dot');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Slide ${i + 1}: ${$(slide, 'h1, h2, .arch-merge-head b').textContent}`);
    dot.onclick = () => slide.scrollIntoView({ behavior: still ? 'auto' : 'smooth' });
    return dot;
  });
  $(document, '[data-dots]').replaceChildren(...dots);
  const watch = new IntersectionObserver((seen) => {
    for (const entry of seen) if (entry.isIntersecting) dots.forEach((dot, i) => dot.toggleAttribute('aria-current', slides[i] === entry.target));
  }, { rootMargin: '-50% 0px -50% 0px' });
  for (const slide of slides) watch.observe(slide);
}

setBuddies(['Clippy', 'Max', 'Claude'].map((name) => ({ id: name, name })));
setPeople(['You', 'Alice']);
deck();
for (const root of document.querySelectorAll('[data-table]')) table(root, TABLES[root.dataset.table]);
design2($(document, '[data-demo="design2"]'));
visible($(document, '[data-demo="visible"]'));
shared($(document, '[data-demo="shared"]'));
design3($(document, '[data-demo="design3"]'));
for (const root of document.querySelectorAll('[data-hood]')) underTheHood(root, HOODS[root.dataset.hood]);
buddyTurn($(document, '[data-demo="turn"]'));
