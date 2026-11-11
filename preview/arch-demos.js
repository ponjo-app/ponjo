// The architecture page's live demos (site/architecture.html), each played
// step by step with a caption: who waits, the same work three ways on one
// clock; what blocks and the three designs that remove it; asking in a
// comment while you type on; agents working at once on copies, one stopped
// with nothing to undo; the app merging copies in (merge3, src/core/diff.js);
// one request through a drawing; and a real turn of the Ponjo agent
// (agents/ponjo-core.mjs) on the preview's model, landed as the doc host lands
// one (src/host/doc-service.js, finishRun). preview/build.js bundles it into
// dist/preview, which the site serves at /preview/; the model
// (infer.ponjo.app) answers pages on ponjo.app only.

/* global document, IntersectionObserver */

import { diffOps, mapOffset } from '../src/core/ot.js';
import { lineChanges, merge3 } from '../src/core/diff.js';
import { newId, serializeSidecar, threadsOf } from '../src/core/comments.js';
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

// ---- Design 1: asking an agent never stops you ----

// You ask Clippy in a comment and type on; Clippy's edit, made on its copy,
// lands when it is done (merge3), beside what you typed.
const DOC_LINES = ['# Launch', 'We ship in March.', 'Then we open the waitlist.'];
const TYPED = ', in the order people joined it';
const typed = (text, x) => text.slice(0, Math.round(text.length * x));
const docText = (lines) => `${lines.join('\n')}\n`;

function background(root) {
  const caption = el('p', 'arch-caption');
  const doc = el('div', 'arch-lines');
  const left = el('div', 'arch-pane');
  left.append(el('span', 'arch-who', 'Your doc'), doc);
  const ask = el('div', 'arch-row');
  const who = face('Clippy', false);
  const state = el('span', 'arch-quiet');
  const status = el('div', 'arch-actor arch-row');
  status.append(who, state);
  const right = el('div', 'arch-pane');
  right.append(el('span', 'arch-who', 'A comment'), ask, status);
  const panes = el('div', 'arch-two');
  panes.append(left, right);
  root.append(caption, panes);
  const mine = (x) => [DOC_LINES[0], DOC_LINES[1], DOC_LINES[2].replace('.', `${typed(TYPED, x)}.`)];
  const reset = () => {
    drawLines(doc, DOC_LINES.map((text) => ({ text })));
    ask.textContent = '';
    state.textContent = '';
    delete who.dataset.presence;
    status.hidden = true;
  };
  stepper(root, caption, [
    { say: 'You @mention Clippy in a comment. That is all: no chat to switch to, nothing to wait for.', run: async (wait) => {
      const words = '@Clippy make line 2 precise';
      for (let i = 1; i <= words.length; i++) {
        ask.textContent = words.slice(0, i);
        await wait(40);
      }
      status.hidden = false;
      who.dataset.presence = 'working';
      state.textContent = 'working in the background';
    } },
    { say: 'Clippy works in the background, and you keep typing.', run: async (wait) => {
      for (let x = 0; x <= 1; x += 0.05) {
        drawLines(doc, mine(x).map((text, i) => ({ text, mine: i === 2 && x > 0, caret: i === 2 })));
        await wait(120);
      }
    } },
    { say: 'When Clippy is done, its edit lands in your doc, beside what you typed.', run: async () => {
      const copy = [DOC_LINES[0], 'We ship the beta on March 3.', DOC_LINES[2]];
      const now = merge3(docText(DOC_LINES), docText(mine(1)), docText(copy)).text.trimEnd().split('\n');
      drawLines(doc, now.map((text, i) => ({ text, by: i === 1 ? 'Clippy' : undefined, mine: i === 2 })));
      delete who.dataset.presence;
      state.textContent = 'done: 1 edit';
    }, hold: 5000 },
  ], reset);
}

// ---- Design 2: agents always run in parallel ----

// Clippy and Max each work on a copy of the doc at once. Until one is done
// it changes nothing but its copy, so stopping it leaves nothing to undo;
// the one that finishes is merged in (merge3).
const EDITS = {
  Clippy: [1, 'We ship the beta on March 3.'],
  Max: [2, 'Then we invite fifty design partners.'],
};

function parallel(root) {
  const caption = el('p', 'arch-caption');
  const doc = el('div', 'arch-lines');
  const yours = el('div', 'arch-pane');
  yours.append(el('span', 'arch-who', 'Your doc'), doc);
  const copies = Object.entries(EDITS).map(([name, [line, text]]) => {
    const who = face(name, false);
    const title = el('span', 'arch-who');
    title.append(who, `${name}’s copy`);
    const lines = el('div', 'arch-lines');
    const state = el('div', 'arch-quiet');
    const box = el('div', 'arch-pane');
    box.append(title, lines, state);
    return { name, line, text, who, lines, state, box };
  });
  const row = el('div', 'arch-two');
  row.append(...copies.map(({ box }) => box));
  root.append(caption, yours, row);
  const [clippy, max] = copies;
  const edit = (copy, x) => DOC_LINES.map((text, i) => (i === copy.line
    ? { text: typed(copy.text, x) + text.slice(Math.round(copy.text.length * x)), by: x > 0 ? copy.name : undefined }
    : { text }));
  const reset = () => {
    drawLines(doc, DOC_LINES.map((text) => ({ text })));
    for (const copy of copies) {
      drawLines(copy.lines, DOC_LINES.map((text) => ({ text })));
      copy.state.textContent = '';
      copy.box.classList.remove('arch-gone');
      delete copy.who.dataset.presence;
      copy.box.hidden = true;
    }
  };
  stepper(root, caption, [
    { say: 'You @mention Clippy and Max. Each gets its own copy of the doc, and both start at once.', run: async () => {
      for (const copy of copies) {
        copy.box.hidden = false;
        copy.who.dataset.presence = 'working';
        copy.state.textContent = 'working';
      }
    } },
    { say: 'Each edits only its copy. Your doc does not change, and neither copy touches the other.', run: async (wait) => {
      for (let x = 0; x <= 1; x += 0.05) {
        drawLines(clippy.lines, edit(clippy, x));
        drawLines(max.lines, edit(max, Math.min(1, x * 0.8)));
        await wait(120);
      }
    } },
    { say: 'You resolve Max’s comment. Max just stops: it changed nothing outside its copy, so there is nothing to undo.', run: async () => {
      max.box.classList.add('arch-gone');
      delete max.who.dataset.presence;
      max.state.textContent = 'stopped, its copy thrown away';
    }, hold: 4500 },
    { say: 'Clippy is done. Only now does your doc change: the app merges Clippy’s copy in.', run: async () => {
      const now = merge3(docText(DOC_LINES), docText(DOC_LINES), docText(DOC_LINES.map((t, i) => (i === clippy.line ? clippy.text : t)))).text.trimEnd().split('\n');
      drawLines(doc, now.map((text, i) => ({ text, by: i === clippy.line ? 'Clippy' : undefined })));
      delete clippy.who.dataset.presence;
      clippy.state.textContent = 'done, merged in';
    }, hold: 5000 },
  ], reset);
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
    { say: 'Only the app writes the file. Clippy started from this version, on its own copy.', run: async () => {
      drawLines(start.lines, START.map((t) => ({ text: t })));
      start.box.hidden = false;
    } },
    { say: 'Meanwhile you change line 2, and Clippy changes line 4 on its copy.', run: async () => {
      drawLines(yours.lines, marked(YOURS, START, 'mine'));
      drawLines(theirs.lines, marked(THEIRS, START, 'by'));
      yours.box.hidden = theirs.box.hidden = false;
    } },
    { say: 'Different lines: the app keeps both changes.', run: async () => merge(THEIRS), hold: 4500 },
    { say: 'Same line: your line stays, and Clippy redoes its edit on your version. Nobody resolves anything.', run: async () => {
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
blockers($(document, '[data-demo="blocks"]'));
background($(document, '[data-demo="background"]'));
parallel($(document, '[data-demo="parallel"]'));
merging($(document, '[data-demo="merge"]'));
howItWorks($(document, '[data-demo="how"]'));
buddyTurn($(document, '[data-demo="turn"]'));
