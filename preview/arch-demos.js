// The architecture page's live demos (site/architecture.html), each on the
// app's own code: the three ways as scripts on one clock, Ponjo's turns
// landed and undone by merge3 (src/core/diff.js); one turn's path, drawn; the
// open asks as the Runner reads them (threadsOf, askedOf); a turn of the
// Ponjo agent's own loop (agents/ponjo-core.mjs) with its model scripted;
// merge3 to edit; and a real turn on the preview's model, landed as the doc
// host lands one (src/host/doc-service.js, finishRun). preview/build.js
// bundles it into dist/preview, which the site serves at /preview/; the model
// (infer.ponjo.app) answers pages on ponjo.app only.

/* global document, IntersectionObserver */

import { diffOps, mapOffset } from '../src/core/ot.js';
import { lineChanges, merge3 } from '../src/core/diff.js';
import { askedOf, newId, serializeSidecar, threadsOf } from '../src/core/comments.js';
import { buildPrompt } from '../src/core/prompt.js';
import { INFER, turn } from '../agents/ponjo-core.mjs';
import { agentFace, buddyColor, personFace, setBuddies, setPeople } from '../web/faces.js';

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

function face(name, person, size = 20) {
  const avatar = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
  avatar.style.setProperty('--size', `${size}px`);
  avatar.append(person ? personFace(name) : agentFace(name));
  const box = el('span', 'pj-agent-face');
  box.append(avatar);
  return box;
}

// A doc's lines, each { text, by?, old?, mine? }: by an agent, in its colour;
// `old` struck through before it; `mine`, a line you changed.
function drawLines(node, lines) {
  node.replaceChildren(...lines.map((line) => {
    const row = el('div', 'arch-line');
    if (line.old !== undefined) row.append(el('del', 'pj-buddy-del', line.old));
    const words = el('span', line.by ? 'pj-buddy-edit' : line.mine ? 'arch-mine' : '', line.text);
    if (line.by) words.style.setProperty('--buddy', buddyColor(line.by));
    row.append(words);
    return row;
  }));
}

// ---- Who waits: the same work three ways, on one clock ----

// You ask an agent for two edits and write a line of your own. Each way is
// what each of you does when, in seconds, drawn as lanes on one scale; grey
// is waiting. Played at twice the speed.
const SCALE = 11;
const WAYS = [
  {
    name: 'A chat beside the file', eg: 'e.g. Claude Code desktop, Cursor', end: 11,
    say: 'A chat beside the file: you wait while the agent works, then review its edit, twice.',
    lanes: [
      ['You', true, 'You', [[0, 1, 'asks'], [1, 3.5, 'waits', true], [3.5, 4.5, 'reviews'], [4.5, 5.5, 'asks'], [5.5, 8, 'waits', true], [8, 9, 'reviews'], [9, 11, 'writes']]],
      ['Claude', false, 'Agent, edit 1', [[1, 3.5, 'edits'], [3.5, 4.5, 'waits', true]]],
      ['Claude', false, 'Agent, edit 2', [[5.5, 8, 'edits'], [8, 9, 'waits', true]]],
    ],
  },
  {
    name: 'One agent answering comments', eg: 'e.g. Claude Docs, as we saw it', end: 5.8,
    say: 'One agent answering comments: you keep writing, but your second request waits for the first.',
    lanes: [
      ['You', true, 'You', [[0, 1.6, 'comments'], [1.6, 4, 'writes']]],
      ['Claude', false, 'Agent, edit 1', [[0.8, 3.3, 'edits']]],
      ['Claude', false, 'Agent, edit 2', [[1.6, 3.3, 'waits', true], [3.3, 5.8, 'edits']]],
    ],
  },
  {
    name: 'Ponjo', eg: '', end: 4.1,
    say: 'Ponjo: you keep writing, and both edits are worked on at once.',
    lanes: [
      ['You', true, 'You', [[0, 1.6, 'comments'], [1.6, 4, 'writes']]],
      ['Clippy', false, 'Clippy, edit 1', [[0.8, 3.3, 'edits a copy']]],
      ['Max', false, 'Max, edit 2', [[1.6, 4.1, 'edits a copy']]],
    ],
  },
];

// Lanes on one scale; the bars grow as the time `t` they are drawn at.
function drawLanes(node, lanes, end) {
  const bars = [];
  const at = (s) => `${(s / SCALE) * 100}%`;
  const rows = lanes.map(([who, person, label, list]) => {
    const track = el('div', 'arch-track');
    track.style.setProperty('--buddy', buddyColor(who));
    for (const [from, to, words, waiting] of list) {
      const bar = el('span', waiting ? 'arch-bar arch-wait' : 'arch-bar', words);
      bar.style.left = at(from);
      track.append(bar);
      bars.push({ bar, from, to });
    }
    const name = el('span', 'arch-actor');
    name.append(face(who, person), label);
    const row = el('div', 'arch-lane');
    row.append(name, track);
    return row;
  });
  const done = el('span', 'arch-done');
  const foot = el('div', 'arch-lane');
  const axis = el('div', 'arch-axis');
  axis.append(done);
  foot.append(el('span'), axis);
  node.replaceChildren(...rows, foot);
  return (t) => {
    for (const { bar, from, to } of bars) bar.style.width = at(Math.max(0, Math.min(t, to) - from));
    done.textContent = t >= end ? `done in ${end} s` : '';
  };
}

function whoWaits(root) {
  const caption = el('p', 'arch-caption');
  const ways = WAYS.map((way) => {
    const box = el('div', 'arch-way');
    const name = el('div', 'arch-way-name', way.name);
    if (way.eg) name.append(el('span', '', way.eg));
    const lanes = el('div', 'arch-lanes');
    box.append(name, lanes);
    return { box, lanes, way };
  });
  root.append(caption, ...ways.map(({ box }) => box));
  stepper(root, caption, ways.map(({ box, lanes, way }) => ({
    say: way.say,
    run: async (wait) => {
      box.hidden = false;
      const draw = drawLanes(lanes, way.lanes, way.end);
      for (let t = 0; t < way.end; t += 0.1) {
        draw(t);
        await wait(50);
      }
      draw(way.end);
    },
    hold: 2500,
  })), () => {
    for (const { box } of ways) box.hidden = true;
  });
}

// ---- How it works: one request, end to end ----

// You, the doc, the part that starts agents, and the agents at work, as
// boxes; `part` (you, doc, start, agents, merge) in focus, the rest dimmed.
function flow(node, part) {
  const on = (...names) => (names.includes(part) ? ' class="on"' : '');
  node.toggleAttribute('data-focus', Boolean(part));
  node.innerHTML = `<svg viewBox="0 0 760 214" role="img" aria-label="You @mention an agent in a comment; the app starts an agent for each @mention; each works on its own copy of the doc; the app merges the copy into the doc">
<defs><marker id="arch-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arch-tip" d="M0 0L10 5L0 10z"/></marker></defs>
<g${on('you')}><rect x="20" y="20" width="160" height="56" rx="10"/><text x="100" y="44">You</text><text class="sub" x="100" y="62">write and comment</text></g>
<g${on('you')}><path d="M180 48H294" marker-end="url(#arch-tip)"/><text class="sub" x="238" y="38">@mention</text></g>
<g${on('doc', 'merge')}><rect x="300" y="20" width="160" height="56" rx="10"/><text x="380" y="44">The doc</text><text class="sub" x="380" y="62">file, comments, history</text></g>
<g${on('start')}><path d="M460 48H574" marker-end="url(#arch-tip)"/><text class="sub" x="518" y="38">@mentions</text></g>
<g${on('start')}><rect x="580" y="20" width="160" height="56" rx="10"/><text x="660" y="44">Starts agents</text><text class="sub" x="660" y="62">one per @mention</text></g>
<g${on('start')}><path d="M660 76V124" marker-end="url(#arch-tip)"/></g>
<g${on('agents')}><rect x="420" y="130" width="320" height="70" rx="10"/><text class="sub start" x="436" y="150">Agents at work, at once</text><rect class="chip" x="436" y="158" width="140" height="30" rx="6"/><text x="506" y="178">Clippy · own copy</text><rect class="chip" x="588" y="158" width="140" height="30" rx="6"/><text x="658" y="178">Max · own copy</text></g>
<g${on('merge')}><path d="M420 165H380V82" marker-end="url(#arch-tip)"/><text class="sub end" x="372" y="130">merged in</text></g>
</svg>`;
}

function howItWorks(root) {
  const caption = el('p', 'arch-caption');
  const drawing = el('div', 'arch-flow');
  root.append(caption, drawing);
  const focus = (part, say) => ({ say, run: async () => flow(drawing, part) });
  stepper(root, caption, [
    focus('you', 'You @mention an agent in a comment, and keep writing.'),
    focus('start', 'The app starts an agent for every @mention, all at once.'),
    focus('agents', 'Each agent works on its own copy of the doc, so it is never in your way.'),
    focus('merge', 'When an agent is done, the app merges its copy into the doc, line by line.'),
    { ...focus(null, 'So nobody waits: not you, and not the other agents.'), hold: 5000 },
  ], () => flow(drawing, null));
}

// ---- An agent for every @mention ----

// The @mentions not yet answered are the app's own reading of the comments
// (threadsOf, askedOf). The app keeps one agent at work for each, and no
// more: none for an @mention resolved or answered, and after a restart, one
// again for each still unanswered.
const BUDDIES = [{ id: 'Clippy', name: 'Clippy' }, { id: 'Max', name: 'Max' }];
const NOOR = { id: 'noor', name: 'You', kind: 'human' };
const WORK = 14; // seconds an agent works: still at work when the app restarts

function agents(root) {
  const caption = el('p', 'arch-caption');
  const asked = el('div', 'arch-list');
  const working = el('div', 'arch-list');
  const pane = (title, list) => {
    const box = el('div', 'arch-pane');
    box.append(el('span', 'arch-who', title), list);
    return box;
  };
  const panes = el('div', 'arch-two');
  panes.append(pane('@mentions not yet answered', asked), pane('Agents at work', working));
  root.append(caption, panes);
  let comments = [];
  let running = new Map(); // comment id + agent → { id, n, left }
  let up = true;
  let seq = Date.now();
  const now = () => new Date(++seq).toISOString();
  const add = (comment) => {
    comments = [...comments, { id: newId('c'), at: now(), by: NOOR, ...comment }];
    settle();
  };

  // One agent for each @mention not yet answered: start the missing, stop the rest.
  function settle() {
    const threads = threadsOf(comments, BUDDIES);
    const wanted = new Map();
    threads.forEach((thread, i) => {
      for (const id of askedOf(thread, [NOOR.id])) wanted.set(`${thread.id} ${id}`, { thread: thread.id, n: i + 1, id });
    });
    running = new Map([...wanted].filter(([key]) => running.has(key) || up).map(([key, want]) => [key, running.get(key) ?? { ...want, left: WORK }]));
    asked.replaceChildren(...[...wanted.values()].map(({ id, n }) => {
      const row = el('div', 'arch-actor arch-row');
      row.append(face(id, false), `@${id} in comment ${n}`);
      return row;
    }));
    if (!wanted.size) asked.append(el('span', 'arch-quiet', 'None'));
    draw();
  }

  const bars = new Map(); // an agent's run → its bar
  function draw() {
    bars.clear();
    working.replaceChildren(...[...running.values()].map((run) => {
      const row = el('div', 'arch-row arch-job');
      row.style.setProperty('--buddy', buddyColor(run.id));
      const who = face(run.id, false);
      who.dataset.presence = 'working';
      const name = el('div', 'arch-actor');
      name.append(who, `${run.id}, comment ${run.n}`);
      const bar = el('span', 'arch-bar');
      bars.set(run, bar);
      grow(run);
      const track = el('div', 'arch-track');
      track.append(bar);
      row.append(name, track);
      return row;
    }));
    if (!running.size) working.append(el('span', 'arch-quiet', up ? 'None' : 'The app is restarting'));
  }
  const grow = (run) => {
    const bar = bars.get(run);
    if (bar) bar.style.width = `${(1 - run.left / WORK) * 100}%`;
  };

  // Time passes: each agent's work goes on; one that is done answers its comment.
  setInterval(() => {
    let answered = false;
    for (const run of running.values()) {
      run.left -= 0.1;
      if (run.left <= 0) {
        comments = [...comments, { id: newId('c'), thread: run.thread, at: now(), by: { id: run.id, name: run.id, kind: 'ai' }, body: 'Done.' }];
        answered = true;
      } else grow(run);
    }
    if (answered) settle();
  }, 100);

  let first = null;
  stepper(root, caption, [
    { say: 'You @mention Clippy and Max. The app starts both at once.', run: async () => {
      first = { anchor: null, body: '@Clippy shorten this' };
      add(first);
      add({ anchor: null, body: '@Max check the dates' });
    } },
    { say: 'You resolve the first comment. Its agent stops right away.', run: async () => {
      add({ thread: comments.find((c) => c.body === first.body).id, body: '', resolved: true });
    } },
    { say: 'The app restarts. Max’s work so far is lost, but its @mention is still unanswered…', run: async (wait) => {
      running = new Map();
      up = false;
      draw();
      await wait(2000);
    }, hold: 0 },
    { say: '…so the app starts Max again. Nothing to recover: the comments say what is left to do.', run: async () => {
      up = true;
      settle();
    }, hold: 7000 },
  ], () => {
    comments = [];
    running = new Map();
    up = true;
    settle();
  });
}

// ---- Agents suggest, the app checks: a real run of the Ponjo agent ----

// The Ponjo agent's own loop (turn) on a copy of a doc, its model scripted:
// it reads, suggests an edit quoting text the doc does not have, which the
// app sends back, then quotes it right, and the edit lands on the copy.
const PLAN_LINES = ['The beta ships in March to fifty design partners, who each get a private call and early access.', 'Then we open the waitlist.'];
const SHORT = 'Fifty design partners get the beta in March.';
const SCRIPTED = [
  [['read', { path: 'plan.md' }]],
  [['propose', { edits: [{ old: 'fifty design partner,', new: 'fifty partners,' }], reply: '' }]],
  [['propose', { edits: [{ old: PLAN_LINES[0], new: SHORT }], reply: 'Shortened the first line.' }]],
];

function suggest(root) {
  const caption = el('p', 'arch-caption');
  const copy = el('div', 'arch-lines');
  const left = el('div', 'arch-pane');
  left.append(el('span', 'arch-who', 'Clippy’s copy of the doc'), copy);
  const quote = el('div', 'arch-quote');
  const verdict = el('div', 'arch-verdict');
  const right = el('div', 'arch-pane');
  right.append(el('span', 'arch-who', 'Clippy’s suggested edit'), quote, verdict);
  const panes = el('div', 'arch-two');
  panes.append(left, right);
  root.append(caption, panes);
  const doc = `${PLAN_LINES.join('\n')}\n`;
  const reset = () => {
    drawLines(copy, PLAN_LINES.map((text) => ({ text })));
    quote.replaceChildren(el('span', 'arch-quiet', 'None yet'));
    verdict.textContent = '';
    verdict.className = 'arch-verdict';
  };
  const show = (call) => {
    const { edits: [{ old, new: by }] } = JSON.parse(call.args);
    quote.replaceChildren(el('div', '', 'Replace'), el('del', 'pj-buddy-del', `“${old}”`), el('div', '', 'with'), el('div', '', `“${by}”`));
    verdict.textContent = 'Checking…';
    verdict.className = 'arch-verdict';
  };
  // The model's answers, one a step: each says what the step is about first.
  const SAY = [
    'Clippy reads the doc. It can read, comment and suggest edits, nothing else: no commands, no web.',
    'It suggests an edit, quoting the text to replace.',
    'It quotes the text exactly this time.',
  ];
  stepper(root, caption, [{
    say: SAY[0],
    run: async (wait) => {
      const copies = { 'plan.md': doc, 'plan.md.comments.jsonl': '' };
      const readFile = (path) => copies[path] ?? (['', '.'].includes(path) ? Object.keys(copies) : null);
      let step = 0;
      let last = null;
      const model = async (messages) => {
        const answer = messages.at(-1);
        if (last?.name === 'propose' && answer.role === 'tool' && answer.content.startsWith('Nothing was changed.')) {
          caption.textContent = 'The quote is not in the doc, so the app sends the edit back. Nothing changes.';
          verdict.textContent = 'Sent back: that text is not in the doc';
          verdict.className = 'arch-verdict arch-back';
          await wait(4500);
        }
        await wait(step ? 1500 : 3500);
        const calls = (SCRIPTED[step] ?? []).map(([name, args], i) => ({ id: `${step}.${i}`, name, args: JSON.stringify(args) }));
        last = calls[0];
        if (step > 0) {
          caption.textContent = SAY[step];
          show(last);
          await wait(3500);
        }
        step += 1;
        return { calls, text: '', sent: null };
      };
      const done = await turn({ prompt: 'Clippy, shorten the first line.', doc: 'plan.md', sidecar: 'plan.md.comments.jsonl', thread: 't1' }, { infer: model, readFile });
      caption.textContent = 'The app applies it, to Clippy’s copy only. Your doc changes when the copy is merged in.';
      verdict.textContent = 'Applied to the copy';
      verdict.className = 'arch-verdict arch-ok';
      const [one, two] = done.doc.split('\n');
      drawLines(copy, [{ text: one, old: PLAN_LINES[0], by: 'Clippy' }, { text: two }]);
    },
    hold: 7000,
  }], reset);
}

// ---- Merging back, line by line ----

// A short doc as the agent started from it, your version, the agent's copy,
// and merge3's result; then the same with both changing one line.
const START = ['# Launch', 'We ship in March.', 'Ten teams try it first.', 'Then we open the waitlist.'];
const YOURS = ['# Launch', 'We ship the beta in March.', 'Ten teams try it first.', 'Then we open the waitlist.'];
const THEIRS = ['# Launch', 'We ship in March.', 'Ten teams try it first.', 'Then we invite fifty design partners.'];
const CLASH = ['# Launch', 'We ship on March 3.', 'Ten teams try it first.', 'Then we open the waitlist.'];

function merging(root) {
  const caption = el('p', 'arch-caption');
  const col = (title) => {
    const lines = el('div', 'arch-lines');
    const box = el('div', 'arch-pane');
    box.append(el('span', 'arch-who', title), lines);
    return { box, lines };
  };
  const start = col('When Clippy started');
  const yours = col('Your doc, meanwhile');
  const theirs = col('Clippy’s copy');
  const result = col('Your doc after the merge');
  const cols = el('div', 'arch-three');
  cols.append(start.box, yours.box, theirs.box);
  root.append(caption, cols, result.box);
  const text = (lines) => `${lines.join('\n')}\n`;
  const marked = (lines, from, kind) => lines.map((line, i) => ({ text: line, [kind]: line !== from[i] ? (kind === 'by' ? 'Clippy' : true) : undefined }));
  const merge = (agent) => {
    const merged = merge3(text(START), text(YOURS), text(agent)).text.trimEnd().split('\n');
    drawLines(result.lines, merged.map((line, i) => ({ text: line, mine: (line === YOURS[i] && line !== START[i]) || undefined, by: line === agent[i] && line !== START[i] && line !== YOURS[i] ? 'Clippy' : undefined })));
    result.box.hidden = false;
  };
  stepper(root, caption, [
    { say: 'Clippy starts from the doc as it is, and works on its own copy.', run: async () => {
      drawLines(start.lines, START.map((t) => ({ text: t })));
      start.box.hidden = false;
    } },
    { say: 'Meanwhile you change line 2, and Clippy changes line 4 on its copy.', run: async () => {
      drawLines(yours.lines, marked(YOURS, START, 'mine'));
      drawLines(theirs.lines, marked(THEIRS, START, 'by'));
      yours.box.hidden = theirs.box.hidden = false;
    } },
    { say: 'Different lines: the app keeps both changes.', run: async () => merge(THEIRS), hold: 4500 },
    { say: 'Same line: your line stays, and Clippy redoes its edit on your version.', run: async () => {
      drawLines(theirs.lines, marked(CLASH, START, 'by'));
      merge(CLASH);
    }, hold: 6000 },
  ], () => {
    for (const { box } of [start, yours, theirs, result]) box.hidden = true;
  });
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
setPeople(['You']);
deck();
whoWaits($(document, '[data-demo="who"]'));
howItWorks($(document, '[data-demo="how"]'));
agents($(document, '[data-demo="agents"]'));
suggest($(document, '[data-demo="suggest"]'));
merging($(document, '[data-demo="merge"]'));
buddyTurn($(document, '[data-demo="turn"]'));
