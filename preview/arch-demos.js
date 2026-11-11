// The architecture page's live demos (site/architecture.html), each played
// step by step with a caption: who waits, the same work three ways on one
// clock; what blocks and the three designs that remove it, each shown in a
// Ponjo window drawn with the app's own classes, and behind it each buddy's
// copy, merged in with merge3 (src/core/diff.js); one request through a
// drawing; and a real turn of the Ponjo agent (agents/ponjo-core.mjs) on the
// preview's model, landed as the doc host lands one
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

function face(name, person, size = 20) {
  const avatar = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
  avatar.style.setProperty('--size', `${size}px`);
  avatar.append(person ? personFace(name) : agentFace(name));
  const box = el('span', 'pj-agent-face');
  box.append(avatar);
  return box;
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
    focus('you', '1 · You @mention an agent in a comment, and keep writing.'),
    focus('start', '2 · The app starts an agent for every @mention, all at once.'),
    focus('agents', '2 · Each works on its own copy, changing nothing else until it is done.'),
    focus('merge', '3 · The app, the only writer, merges each copy into the doc.'),
    { ...focus(null, 'So nobody waits: not you, not the other people, not the other agents.'), hold: 5000 },
  ], () => flow(drawing, null));
}

// ---- Three things block; three designs remove them ----

const BLOCKS = [
  ['You wait while an agent works', '1 · You ask in a comment, and the agent works in the background'],
  ['Agents wait for each other', '2 · Every agent works on its own copy, changing nothing else until it is done'],
  ['Someone has to resolve conflicts', '3 · Only the app writes the file, and it merges every change'],
];

function blockers(root) {
  const caption = el('p', 'arch-caption');
  const head = el('div', 'arch-block arch-who');
  head.append(el('span', '', 'What blocks'), el('span', '', 'What Ponjo does instead'));
  const rows = BLOCKS.map(([blocks, design]) => {
    const row = el('div', 'arch-block');
    row.append(el('span', 'arch-blocks', blocks), el('span', 'arch-design', design));
    return row;
  });
  root.append(caption, head, ...rows);
  stepper(root, caption, rows.map((row) => ({
    say: 'Many people and many agents edit one file. Three things usually make someone wait.',
    run: async () => {
      row.hidden = false;
    },
    hold: 3000,
  })), () => {
    for (const row of rows) row.hidden = true;
  });
}

// ---- A Ponjo window, as the app draws it, for the three designs ----

// The app's own classes (web/app.css): its header with the buddies' faces,
// the doc, and the threads in the margin, with a buddy's cursor, its edit
// landing with its name, its reply and Undo. A panel below can show what the
// app does behind the scenes: each buddy's copy of the doc.
const PARAS = [
  'We ship the beta in March to fifty design partners, who each get a private call and early access.',
  'Then we open the waitlist.',
];
const TITLE = 'Launch plan';
const MINE = 'Pricing comes after the beta.';
const text = (paras) => `# ${TITLE}\n\n${paras.join('\n\n')}\n`;
const parasOf = (doc) => doc.trimEnd().split('\n\n').slice(1);

function avatar(name, person, size = 24) {
  const node = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
  node.style.setProperty('--size', `${size}px`);
  node.append(person ? personFace(name) : agentFace(name));
  return node;
}

function app(root, buddies, { behind = false } = {}) {
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
  head.append(avatar('You', true, 28));
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
    panel.append(el('span', 'arch-who', 'Behind the scenes: each buddy’s own copy of the doc'), copies);
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

// A thread in the margin: your comment asking `buddy`; it can show the buddy
// at work, its reply with Undo, or that you resolved it.
function thread(margin, buddy, words) {
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
  card.append(message('You', true, chip, ' ', ask));
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
    reply(words1) {
      this.working(false);
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

// ---- 1 · Asking an agent never stops you ----

function design1(root) {
  const caption = el('p', 'arch-caption');
  root.append(caption);
  const SHORTER = 'Fifty design partners get the beta in March.';
  let win;
  let ask;
  const reset = () => {
    root.querySelector('.arch-app')?.remove();
    win = app(root, ['Clippy']);
    ask = null;
    win.draw(PARAS.map((t) => ({ text: t })));
  };
  stepper(root, caption, [
    { say: 'Clippy is an AI buddy: an AI agent with a name and a face. You ask it in a comment, as you would a teammate.', run: async (wait) => {
      win.draw([{ text: PARAS[0], hl: true }, { text: PARAS[1] }]);
      ask = thread(win.margin, 'Clippy', 'make this shorter');
      await ask.type(wait);
    } },
    { say: 'Clippy gets to work. You do not wait: you keep writing.', run: async (wait) => {
      win.working('Clippy', true);
      ask.working(true);
      for (let i = 0; i <= MINE.length; i += 1) {
        win.draw([{ text: PARAS[0], hl: true, cursor: 'Clippy' }, { text: PARAS[1] }, { text: MINE.slice(0, i), caret: true }]);
        await wait(90);
      }
    } },
    { say: 'When Clippy is done, its edit lands in your doc with its name on it, and its reply has Undo.', run: async () => {
      const now = merge3(text(PARAS), text([...PARAS, MINE]), text([SHORTER, PARAS[1]])).text;
      const [one, two, three] = parasOf(now);
      win.working('Clippy', false);
      win.draw([{ text: one, by: 'Clippy' }, { text: two }, { text: three }]);
      ask.reply('Made it shorter.');
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
    { say: 'You ask Clippy and Max, in two comments. Max is another AI buddy.', run: async (wait) => {
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
setPeople(['You']);
deck();
whoWaits($(document, '[data-demo="who"]'));
blockers($(document, '[data-demo="blocks"]'));
design1($(document, '[data-demo="design1"]'));
design2($(document, '[data-demo="design2"]'));
design3($(document, '[data-demo="design3"]'));
howItWorks($(document, '[data-demo="how"]'));
buddyTurn($(document, '[data-demo="turn"]'));
