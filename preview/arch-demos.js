// The architecture page's live demos (site/architecture.html), each on the
// app's own code: the three ways as scripts on one clock, Ponjo's turns
// landed and undone by merge3 (src/core/diff.js); a turn of the Ponjo agent's
// own loop (agents/ponjo-core.mjs) with its model scripted; the open asks as
// the Runner reads them (threadsOf, askedOf); merge3 to edit; and a real turn
// on the preview's model, landed as the doc host lands one
// (src/host/doc-service.js, finishRun). preview/build.js bundles it into
// dist/preview, which the site serves at /preview/; the model
// (infer.ponjo.app) answers pages on ponjo.app only.

/* global document, IntersectionObserver */

import { diffOps, mapOffset } from '../src/core/ot.js';
import { lineChanges, merge3 } from '../src/core/diff.js';
import { askedOf, newId, serializeSidecar, threadsOf } from '../src/core/comments.js';
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

function pick(root, attribute, value) {
  for (const button of root.querySelectorAll(`[${attribute}]`)) button.setAttribute('aria-checked', button.getAttribute(attribute) === value);
}

// ---- By line: merge3 of the copy, the doc now and the buddy's copy ----

const SIDES = {
  base: '# Launch\nWe ship in March.\nTen teams try it first.\nThen open the waitlist.\n',
  ours: '# Launch\nWe ship the beta in March.\nTen teams try it first.\nThen open the waitlist.\n',
  apart: '# Launch\nWe ship in March.\nTen teams try it first.\nThen invite fifty design partners.\n',
  collide: '# Launch\nWe ship on March 3.\nTen teams try it first.\nThen invite fifty design partners.\n',
};

function lines(root) {
  const side = (name) => $(root, `[data-side="${name}"]`);
  function paint() {
    const ours = side('ours').value;
    const { text, conflicts } = merge3(side('base').value, ours, side('theirs').value);
    revision($(root, '[data-result]'), ours, text);
    $(root, '[data-verdict]').textContent = conflicts
      ? `${conflicts} ${conflicts > 1 ? 'conflicts' : 'conflict'}: where both changed the same lines, the doc's lines stay. In the app the turn first runs once more, told what people did; colliding again, it lands like this, its version marked conflict.`
      : 'No conflict: Clippy\'s lines land among people\'s, as one edit at the current revision.';
  }
  function preset(name) {
    pick(root, 'data-preset', name);
    side('base').value = SIDES.base;
    side('ours').value = SIDES.ours;
    side('theirs').value = SIDES[name];
    paint();
  }
  for (const area of root.querySelectorAll('[data-side]')) area.oninput = paint;
  for (const button of root.querySelectorAll('[data-preset]')) button.onclick = () => preset(button.dataset.preset);
  preset('apart');
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

// ---- Who waits for whom: three ways, one story, one clock ----

// Noor asks Clippy to shorten line 1 and Max to lengthen line 2, and has
// line 3 to write. Each way is a script on one clock, in seconds: what each
// writer does when (drawn as lanes on one scale, so the ways compare), and
// its window at any moment, a function of the time. Ponjo's landings are
// merge3, the app's own merge.
const LINES = ['The beta ships in March to fifty design partners, who each get a private call and early access.', 'Then we open the waitlist.'];
const SHORT = 'Fifty design partners get the beta in March.';
const LONG = 'Then we open the waitlist, in the order people joined it.';
const MINE = 'Pricing comes after the beta.';
const SCALE = 11; // seconds on every timeline
const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const span = (t, from, to) => Math.min(1, Math.max(0, (t - from) / (to - from)));
const typed = (text, x) => text.slice(0, Math.round(text.length * x));

// `old` overwritten by `next` as an agent streams it: the text, and its cursor.
function overwrite(old, next, x) {
  const k = Math.round(x * Math.max(old.length, next.length));
  return { text: next.slice(0, Math.min(k, next.length)) + old.slice(k), at: Math.min(k, next.length) };
}

// Text with marks at offsets: [{ at, node }], in order.
function marked(text, marks = []) {
  const out = [];
  let from = 0;
  for (const { at, node } of marks) {
    out.push(text.slice(from, at), node);
    from = at;
  }
  return [...out, text.slice(from)];
}

function face(name, person, size = 20) {
  const avatar = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
  avatar.style.setProperty('--size', `${size}px`);
  avatar.append(person ? personFace(name) : agentFace(name));
  const box = el('span', 'pj-agent-face');
  box.append(avatar);
  return box;
}

// Lines of a doc, each { text, caret?, hl?, by?, old? }: a caret ({ at, by,
// working }), commented (hl), landed in `by`'s colour, or under review: `old`
// struck through, `text` in `by`'s colour.
function drawLines(node, lines) {
  node.replaceChildren(...lines.map((line) => {
    const row = el('div', 'arch-line');
    const parts = line.caret ? marked(line.text, [{ at: line.caret.at, node: cursorNode(line.caret) }]) : [line.text];
    const wrap = line.by ? el('span', 'pj-buddy-edit') : line.hl ? el('span', 'pj-hl') : null;
    if (line.by) wrap.style.setProperty('--buddy', buddyColor(line.by));
    if (line.old !== undefined) row.append(el('del', 'pj-buddy-del', line.old));
    if (wrap) wrap.append(...parts);
    row.append(...(wrap ? [wrap] : parts));
    return row;
  }));
}

// 1. A chat with one agent beside the file: ask, wait, review, ask again.
function chatWindow(win) {
  win.classList.add('arch-win-chat');
  const log = el('div', 'arch-log');
  const prompt = el('div', 'pj-input arch-prompt');
  const chat = el('div', 'arch-pane');
  chat.append(el('span', 'arch-who', 'Chat'), log, prompt);
  const body = el('div', 'arch-lines');
  const review = el('div', 'arch-choices');
  const accept = el('span', 'pj-secondary', 'Accept');
  review.append(accept, el('span', 'pj-secondary', 'Reject'));
  const file = el('div', 'arch-pane');
  file.append(el('span', 'arch-who', 'plan.md'), body, review);
  win.append(chat, file);
  let said = '';
  const agent = (t, line, next, by, from) => {
    if (t < from) return { text: line };
    if (t < from + 2.5) {
      const now = overwrite(line, next, span(t, from, from + 2.5));
      return { text: now.text, caret: { at: now.at, by, working: true } };
    }
    return t < from + 3.5 ? { text: next, old: line, by } : { text: next };
  };
  return (t) => {
    const messages = [[1, 'Noor', 'Shorten line 1.'], [1, 'Claude', t < 3.5 ? 'Working…' : 'Done. Review it.'],
      [5.5, 'Noor', 'Now lengthen line 2.'], [5.5, 'Claude', t < 8 ? 'Working…' : 'Done. Review it.']].filter(([at]) => t >= at);
    const now = messages.map(([, , text]) => text).join('|');
    if (now !== said) {
      said = now;
      log.replaceChildren(...messages.map(([, who, text]) => {
        const row = el('div', 'arch-actor');
        row.append(face(who, who === 'Noor'), el('span', 'arch-say', text));
        return row;
      }));
    }
    prompt.textContent = t < 1 ? typed('Shorten line 1.', span(t, 0, 1)) : t >= 4.5 && t < 5.5 ? typed('Now lengthen line 2.', span(t, 4.5, 5.5)) : '';
    const lines = [agent(t, LINES[0], SHORT, 'Claude', 1), agent(t, LINES[1], LONG, 'Claude', 5.5)];
    if (t >= 9) {
      const text = typed(MINE, span(t, 9, 11));
      lines.push({ text, caret: { at: text.length, by: 'Noor' } });
    }
    drawLines(body, lines);
    review.hidden = !((t >= 3.5 && t < 4.5) || (t >= 8 && t < 9));
    accept.classList.toggle('arch-pressed', (t >= 4.2 && t < 4.5) || (t >= 8.7 && t < 9));
  };
}

// 2. One queue, and 3. Ponjo: a doc with its threads in the margin. In the
// queue, one agent answers the asks in turn and edits the doc as it goes; in
// Ponjo each ask is its own turn on its own copy, merged (merge3) when it ends.
const ASKS = { // [who answers, the ask, asked from, to, works from, to]
  queue: [['Claude', 'shorten this', 0, 0.8, 0.8, 3.3], ['Claude', 'lengthen this', 0.8, 1.6, 3.3, 5.8]],
  ponjo: [['Clippy', 'shorten this', 0, 0.8, 0.8, 3.3], ['Max', 'lengthen this', 0.8, 1.6, 1.6, 4.1]],
};

function docWindow(win, way) {
  const body = el('div', 'arch-lines');
  const doc = el('div', 'arch-pane');
  doc.append(el('span', 'arch-who', 'plan.md'), body);
  const margin = el('div', 'arch-margin');
  win.append(doc, margin);
  const ponjo = way === 'ponjo';
  const undone = new Set(); // Ponjo's turns undone from their reply, by index
  let shown = null; // the turn whose change shows as a revision
  let last = 0; // the time last drawn
  const cards = ASKS[way].map(([buddy, words, from, to, start, end], i) => {
    const card = el('div', 'pj-card arch-card');
    card.style.setProperty('--buddy', buddyColor(buddy));
    const head = el('div', 'arch-actor');
    head.append(face('Noor', true), 'Noor');
    const quote = el('div', 'arch-quote');
    const who = face(buddy, false);
    const said = el('span', '');
    const state = el('div', 'arch-actor arch-state');
    state.append(who, said);
    // Its reply's receipt, in Ponjo: the count shows the turn's change, the icon undoes it.
    const done = el('div', 'pj-receipt');
    const count = el('button', 'pj-receipt-show');
    count.type = 'button';
    const undo = el('button', 'pj-icon-btn pj-receipt-undo');
    undo.type = 'button';
    undo.title = 'Undo this edit';
    undo.setAttribute('aria-label', undo.title);
    undo.append(icon('undo'));
    done.append(count, undo);
    count.onclick = () => {
      shown = shown === i ? null : i;
      update(last);
    };
    undo.onclick = () => {
      undone.add(i);
      shown = null;
      update(last);
    };
    card.append(head, quote, state, done);
    margin.append(card);
    return (t) => {
      const working = t >= start && t < end;
      card.hidden = t < from;
      quote.textContent = typed(`@${buddy} ${words}`, span(t, from, to));
      card.classList.toggle('pj-card-working', working);
      if (working) who.dataset.presence = 'working';
      else if (t >= to && t < start) who.dataset.presence = 'away';
      else delete who.dataset.presence;
      said.textContent = t < start ? 'Queued' : working ? (ponjo ? 'Working on its copy' : 'Working…') : 'Done';
      state.hidden = t < to || (ponjo && t >= end);
      done.hidden = !(ponjo && t >= end);
      done.classList.toggle('pj-receipt-undone', undone.has(i));
      count.disabled = undone.has(i);
      count.setAttribute('aria-pressed', String(shown === i));
      count.replaceChildren(icon('pencil'), el('span', '', undone.has(i) ? 'Edit undone' : '1 edit'));
      undo.hidden = undone.has(i);
    };
  });
  const [first, second] = ASKS[way].map(([by, , from, , start, end]) => ({ by, from, start, end }));
  const update = (t) => {
    last = t;
    for (const card of cards) card(t);
    const mine = typed(MINE, span(t, 1.6, 4));
    let lines;
    if (ponjo) {
      const base = `${LINES.join('\n')}\n`;
      const copies = [`${SHORT}\n${LINES[1]}\n`, `${LINES[0]}\n${LONG}\n`];
      let text = base + mine;
      const landed = [first, second].map((turn, i) => {
        if (t < turn.end) return null;
        const before = text;
        text = merge3(base, text, copies[i]).text;
        return { before, after: text };
      });
      // An undo is the turn's change taken back, merged with all written since.
      for (const i of undone) text = merge3(landed[i].after, text, landed[i].before).text;
      const [one, two] = text.split('\n');
      const line = (words, { by, from, start, end }, i, old) => {
        if (t < end) return { text: words, hl: t >= from, caret: t >= start ? { at: 0, by, working: true } : null };
        if (undone.has(i)) return { text: words };
        return shown === i ? { text: words, old, by } : { text: words, by };
      };
      lines = [line(one, first, 0, LINES[0]), line(two, second, 1, LINES[1])];
    } else {
      const edit = (line, next, { by, from, start, end }) => {
        if (t >= end) return { text: next };
        if (t < start) return { text: line, hl: t >= from };
        const now = overwrite(line, next, span(t, start, end));
        return { text: now.text, caret: { at: now.at, by, working: true } };
      };
      lines = [edit(LINES[0], SHORT, first), edit(LINES[1], LONG, second)];
    }
    if (t >= 1.6) lines.push({ text: mine, caret: { at: mine.length, by: 'Noor' } });
    drawLines(body, lines);
  };
  return update;
}

// Lanes: Noor's, then one per run of an agent, named by its agent and its line.
const WRITES = ['Noor', '', [[0, 1.6, 'comments'], [1.6, 4, 'writes']]];
const MODES = {
  chat: {
    end: 11,
    window: chatWindow,
    lanes: [
      ['Noor', '', [[0, 1, 'asks'], [1, 3.5, 'waits', true], [3.5, 4.5, 'reviews'], [4.5, 5.5, 'asks'], [5.5, 8, 'waits', true], [8, 9, 'reviews'], [9, 11, 'writes']]],
      ['Claude', 'line 1', [[1, 3.5, 'edits'], [3.5, 4.5, 'waits', true]]],
      ['Claude', 'line 2', [[5.5, 8, 'edits'], [8, 9, 'waits', true]]],
    ],
  },
  queue: {
    end: 5.8,
    window: (win) => docWindow(win, 'queue'),
    lanes: [WRITES, ['Claude', 'line 1', [[0.8, 3.3, 'edits']]], ['Claude', 'line 2', [[1.6, 3.3, 'queued', true], [3.3, 5.8, 'edits']]]],
  },
  ponjo: {
    end: 4.1,
    window: (win) => docWindow(win, 'ponjo'),
    lanes: [WRITES, ['Clippy', 'line 1', [[0.8, 3.3, 'edits its copy']]], ['Max', 'line 2', [[1.6, 4.1, 'edits its copy']]]],
  },
};

// Who did what when, on one scale for every way: a bar grows as it happens.
function drawLanes(node, lanes, end) {
  const bars = [];
  const heads = [];
  const at = (s) => `${(s / SCALE) * 100}%`;
  const rows = lanes.map(([who, run, list]) => {
    const track = el('div', 'arch-track');
    track.style.setProperty('--buddy', buddyColor(who));
    for (const [from, to, label, waiting] of list) {
      const bar = el('span', waiting ? 'arch-bar arch-wait' : 'arch-bar', label);
      bar.style.left = at(from);
      track.append(bar);
      bars.push({ bar, from, to });
    }
    const head = el('span', 'arch-head');
    heads.push(head);
    track.append(head);
    const name = el('span', 'arch-actor');
    name.append(face(who, who === 'Noor'), run ? `${who} · ${run}` : who);
    const row = el('div', 'arch-lane');
    row.append(name, track);
    return row;
  });
  const axis = el('div', 'arch-axis');
  for (let s = 0; s < SCALE - 2; s += 2) { // the last, where `done` says when it ended
    const tick = el('span', 'arch-tick', `${s} s`);
    tick.style.left = at(s);
    axis.append(tick);
  }
  const done = el('span', 'arch-done');
  axis.append(done);
  const foot = el('div', 'arch-lane');
  foot.append(el('span'), axis);
  node.replaceChildren(...rows, foot);
  return (t) => {
    for (const { bar, from, to } of bars) bar.style.width = at(Math.max(0, Math.min(t, to) - from));
    for (const head of heads) head.style.left = at(t);
    done.textContent = t >= end ? `Done at ${end} s` : '';
  };
}

function mode(root) {
  const { end, window: build, lanes } = MODES[root.dataset.mode];
  const win = el('div', 'arch-win');
  const track = el('div', 'arch-lanes');
  const again = el('button', 'pj-link-button', 'Play again');
  again.type = 'button';
  const controls = el('div', 'arch-controls');
  controls.append(again);
  root.append(win, track, controls);
  let timer = null;
  function play() {
    clearInterval(timer);
    win.className = 'arch-win';
    win.replaceChildren();
    const scene = build(win);
    const lanesAt = drawLanes(track, lanes, end);
    const draw = (t) => {
      scene(t);
      lanesAt(t);
    };
    if (still) return draw(end);
    const start = Date.now();
    draw(0);
    timer = setInterval(() => {
      const t = Math.min((Date.now() - start) / 1000, end);
      draw(t);
      if (t >= end) clearInterval(timer);
    }, 50);
  }
  again.onclick = play;
  // Played each time its slide comes into view, as a slide's animation is.
  new IntersectionObserver(([seen]) => {
    if (seen.isIntersecting) play();
    else clearInterval(timer);
  }, { threshold: 0.6 }).observe(root);
}

// The page as slides: a dot per slide, the current one marked; a click goes there.
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

// The cover: how long the same work takes each way, in the demos below.
function doneChart(root) {
  const rows = [['chat', 'Chat beside the file'], ['queue', 'One agent queue'], ['ponjo', 'Ponjo']].map(([way, name]) => {
    const { end } = MODES[way];
    const bar = el('span', way === 'ponjo' ? 'arch-bar arch-best' : 'arch-bar arch-plain', `${end} s`);
    bar.style.width = `${(end / SCALE) * 100}%`;
    const track = el('div', 'arch-track');
    track.append(bar);
    const row = el('div', 'arch-lane');
    row.append(el('span', '', name), track);
    return row;
  });
  root.append(...rows, el('small', 'arch-eg', 'Seconds until the same work is done in the demos that follow: two asks to an agent, and a line Noor writes.'));
}

// ---- The agent as a member: a turn of the real loop (turn), its model scripted ----

// Clippy's turn on a copy of plan.md, its model's steps scripted: each the
// calls of one answer. The third quotes text the doc does not have, so the
// program sends the proposal back; the fourth quotes it right and ends the turn.
const PLAN_COPY = `${LINES.join('\n')}\n`;
const SCRIPTED = [
  [['read', { path: 'plan.md' }]],
  [['comment', { on: 'the waitlist', body: 'Open it by invite first?' }]],
  [['propose', { edits: [{ old: 'fifty design partner,', new: 'fifty partners,' }], reply: 'Shortened.' }]],
  [['resolve', {}], ['propose', { edits: [{ old: LINES[0], new: SHORT }], reply: 'Shortened the first line.' }]],
];
const ACTIONS = [ // what a member does in Ponjo, and the agent's tools that do it
  [['read', 'find', 'grep'], 'Reads the doc and the files in the sidebar', 'read · find · grep'],
  [['comment'], 'Comments on a passage', 'comment'],
  [['propose'], 'Edits by quote, and replies', 'propose'],
  [['resolve'], 'Resolves the thread', 'resolve'],
];
const STOPPED = Symbol('stopped');

function member(root) {
  const copy = el('div', 'arch-lines');
  const pane = el('div', 'arch-pane');
  pane.append(el('span', 'arch-who', 'Clippy’s copy of plan.md'), copy);
  const head = el('div', 'arch-action arch-who');
  head.append(el('span', '', 'A member'), el('span', '', 'The agent’s tool'));
  const rows = ACTIONS.map(([, does, tool]) => {
    const row = el('div', 'arch-action');
    row.append(el('span', '', does), el('span', 'arch-tool', tool));
    return row;
  });
  const actions = el('div', 'arch-pane arch-actions');
  actions.append(head, ...rows);
  const win = el('div', 'arch-win arch-member');
  win.append(pane, actions);
  const steps = el('ol', 'arch-trace');
  const verdict = el('p', 'arch-verdict');
  const again = el('button', 'pj-link-button', 'Play again');
  again.type = 'button';
  const controls = el('div', 'arch-controls');
  controls.append(again);
  root.append(win, steps, verdict, controls);
  let playing = 0;

  async function play() {
    const id = ++playing;
    const wait = (ms) => new Promise((done, stop) => setTimeout(() => (id === playing ? done() : stop(STOPPED)), still ? 0 : ms));
    const lit = (names) => rows.forEach((row, i) => row.toggleAttribute('data-on', ACTIONS[i][0].some((tool) => names.includes(tool))));
    drawLines(copy, LINES.map((text) => ({ text })));
    steps.replaceChildren();
    verdict.textContent = 'Until a proposal passes the program’s check, the copy does not change.';
    const copies = { 'plan.md': PLAN_COPY, 'plan.md.comments.jsonl': '' };
    const readFile = (path) => copies[path] ?? (['', '.'].includes(path) ? Object.keys(copies) : null);
    let made = []; // the last step's rows, one per call, for the program's answers
    let step = 0;
    // The model: the next scripted step, after a pause; first, the program's
    // answers to the last step's calls go on their rows.
    const model = async (messages) => {
      const answers = messages.slice(messages.findLastIndex((m) => m.role === 'assistant') + 1).filter((m) => m.role === 'tool');
      for (const [i, { content }] of answers.entries()) {
        const back = content.startsWith('Nothing was changed.');
        made[i].append(el('span', back ? 'arch-back' : '', made[i].dataset.tool === 'read' ? '→ the doc, with line numbers'
          : `→ ${back ? `sent back: ${content.replace('Nothing was changed. ', '')}` : content}`));
      }
      await wait(1400);
      const calls = (SCRIPTED[step] ?? []).map(([name, args], i) => ({ id: `${step}.${i}`, name, args: JSON.stringify(args) }));
      step += 1;
      made = calls.map((call) => {
        const row = el('li', '', `${step}.`);
        row.dataset.tool = call.name;
        row.append(el('span', 'arch-tool', called(call)));
        return row;
      });
      steps.append(...made);
      lit(calls.map((call) => call.name));
      return { calls, text: '', sent: null };
    };
    try {
      await wait(600);
      const done = await turn({ prompt: 'Clippy, shorten the first line.', doc: 'plan.md', sidecar: 'plan.md.comments.jsonl', thread: 't1' }, { infer: model, readFile });
      for (const row of made) row.append(el('span', '', row.dataset.tool === 'propose' ? '→ checked, applied to the copy' : '→ resolved when the turn ends'));
      await wait(800);
      lit([]);
      const added = done.sidecar.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((c) => c.anchor);
      const [one, two] = done.doc.split('\n');
      const at = two.indexOf(added.anchor.exact);
      drawLines(copy, [{ text: one, old: LINES[0], by: 'Clippy' }, { text: two }]);
      const commented = el('span', 'pj-hl', added.anchor.exact);
      copy.lastChild.replaceChildren(two.slice(0, at), commented, two.slice(at + added.anchor.exact.length));
      verdict.textContent = `Reply: “${done.reply}” The turn changed only its copy, and added a comment and a resolve to land with it.`;
    } catch (error) {
      if (error !== STOPPED) throw error;
    }
  }
  again.onclick = play;
  new IntersectionObserver(([seen]) => {
    if (seen.isIntersecting) play();
    else playing += 1; // stops the turn at its next pause
  }, { threshold: 0.6 }).observe(root);
}

// ---- The runner: the running turns made equal to the open asks ----

// The open asks are the app's own reading of the comments (threadsOf,
// askedOf), as the Runner reads them. A turn here is a bar of four seconds,
// then its reply, which answers its ask.
const BUDDIES = [{ id: 'Clippy', name: 'Clippy' }, { id: 'Max', name: 'Max' }];
const NOOR = { id: 'noor', name: 'Noor', kind: 'human' };
const TURN = 4; // seconds
const WORDS = { Clippy: 'shorten this', Max: 'lengthen this', both: 'tighten this' };

function runner(root) {
  const asks = el('div', 'arch-margin');
  const asksPane = el('div', 'arch-pane');
  asksPane.append(el('span', 'arch-who', 'The comments: open asks'), asks);
  const turns = el('div', 'arch-margin');
  const turnsPane = el('div', 'arch-pane');
  turnsPane.append(el('span', 'arch-who', 'Running turns'), turns);
  const win = el('div', 'arch-win arch-runner');
  win.append(asksPane, el('span', 'arch-reconcile', 'reconcile()'), turnsPane);
  const controls = el('div', 'arch-controls');
  const button = (label, onclick, kind = 'pj-secondary') => {
    const b = el('button', kind, label);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  };
  const log = el('ol', 'arch-trace');
  root.append(controls, win, log);
  let comments = [];
  const running = new Map(); // thread id + buddy id → { thread, n, id, left }
  let up = true;
  let seq = Date.now();
  const now = () => new Date(++seq).toISOString();
  const say = (text, back = false) => {
    const line = el('li');
    line.append(el('span', back ? 'arch-back' : '', text));
    log.prepend(line);
    while (log.children.length > 4) log.lastChild.remove();
  };
  const ask = (who) => {
    const names = who === 'both' ? ['Clippy', 'Max'] : [who];
    comments = [...comments, { id: newId('c'), anchor: null, by: NOOR, at: now(), body: `${names.map((n) => `@${n}`).join(' ')} ${WORDS[who]}` }];
    reconcile();
  };
  const bars = new Map();

  // The Runner's one job: start a turn for each open ask without one, stop
  // each turn whose ask is gone. Nothing else holds what is running.
  function reconcile() {
    const threads = threadsOf(comments, BUDDIES);
    const want = new Map();
    threads.forEach((thread, i) => {
      for (const id of askedOf(thread, [NOOR.id])) want.set(`${thread.id} ${id}`, { thread: thread.id, n: i + 1, id });
    });
    for (const [key, run] of running) {
      if (want.has(key)) continue;
      running.delete(key);
      say(`stop ${run.id} on thread ${run.n}: its ask is gone`, true);
    }
    if (up) {
      for (const [key, want1] of want) {
        if (running.has(key)) continue;
        running.set(key, { ...want1, left: TURN });
        say(`start ${want1.id} on thread ${want1.n}`);
      }
    }
    drawAsks(threads);
    drawTurns();
  }

  function drawAsks(threads) {
    asks.replaceChildren(...threads.map((thread, i) => {
      const card = el('div', 'pj-card arch-card');
      const head = el('div', 'arch-actor');
      head.append(face('Noor', true), `Thread ${i + 1}`);
      card.append(head, el('div', 'arch-quote', thread.comments[0].body));
      for (const reply of thread.comments.slice(1).filter((c) => c.body)) {
        const row = el('div', 'arch-actor arch-state');
        row.append(face(reply.by.id, false), reply.body);
        card.append(row);
      }
      const waiting = askedOf(thread, [NOOR.id]);
      const foot = el('div', 'arch-actor arch-state');
      foot.append(thread.resolved ? 'Resolved' : waiting.length ? `Asks ${waiting.join(' and ')}` : 'Answered');
      if (!thread.resolved) {
        foot.append(button('Resolve', () => {
          comments = [...comments, { id: newId('c'), thread: thread.id, by: NOOR, at: now(), body: '', resolved: true }];
          reconcile();
        }, 'pj-link-button'));
      }
      card.append(foot);
      return card;
    }));
    if (!threads.length) asks.append(el('span', 'arch-state', 'No comments yet. Ask a buddy above.'));
  }

  function drawTurns() {
    bars.clear();
    turns.replaceChildren(...[...running].map(([key, run]) => {
      const row = el('div', 'arch-turn');
      row.style.setProperty('--buddy', buddyColor(run.id));
      const who = face(run.id, false);
      who.dataset.presence = 'working';
      const name = el('div', 'arch-actor arch-state');
      name.append(who, `${run.id} on thread ${run.n}, on its copy`);
      const bar = el('span', 'arch-bar');
      const track = el('div', 'arch-track');
      track.append(bar);
      bars.set(key, bar);
      row.append(name, track);
      return row;
    }));
    if (!running.size) turns.append(el('span', 'arch-state', up ? 'No turn is running.' : 'The app is restarting: no turn runs.'));
    tick(0);
  }

  // Time passes: each turn's bar grows; one that is done posts its reply.
  function tick(seconds) {
    let answered = false;
    for (const [key, run] of running) {
      run.left -= seconds;
      if (run.left <= 0) {
        running.delete(key);
        comments = [...comments, { id: newId('c'), thread: run.thread, by: { id: run.id, name: run.id, kind: 'ai' }, at: now(), body: `Done: ${WORDS[run.id].replace(' this', 'ed it')}.` }];
        say(`${run.id} answered thread ${run.n}`);
        answered = true;
      } else {
        const bar = bars.get(key);
        if (bar) bar.style.width = `${(1 - run.left / TURN) * 100}%`;
      }
    }
    if (answered) reconcile();
  }

  controls.append(
    button('@Clippy', () => ask('Clippy')),
    button('@Max', () => ask('Max')),
    button('@Clippy @Max', () => ask('both')),
    button('Restart the app', () => {
      if (!up) return;
      say(`restart: ${running.size} running ${running.size === 1 ? 'turn' : 'turns'} lost`, true);
      running.clear();
      up = false;
      drawTurns();
      setTimeout(() => {
        up = true;
        say('the app is back: reconcile');
        reconcile();
      }, 1500);
    }),
  );
  reconcile();
  setInterval(() => tick(0.1), 100);
  // Asked once, as it first comes into view.
  new IntersectionObserver(([seen], watch) => {
    if (!seen.isIntersecting) return;
    watch.disconnect();
    ask('both');
  }, { threshold: 0.6 }).observe(root);
}

setBuddies(['Clippy', 'Max', 'Claude'].map((name) => ({ id: name, name })));
setPeople(['Noor']);
deck();
doneChart($(document, '[data-demo="done"]'));
for (const root of document.querySelectorAll('[data-demo="mode"]')) mode(root);
member($(document, '[data-demo="member"]'));
runner($(document, '[data-demo="runner"]'));
lines($(document, '[data-demo="lines"]'));
buddyTurn($(document, '[data-demo="turn"]'));
