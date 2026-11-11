// The architecture page's live demos (site/architecture.html), each on the
// app's own code: two pages' client (web/client.js) in a host's order played
// here, merge3 (src/core/diff.js), and a turn of the Ponjo agent
// (agents/ponjo-core.mjs) on the preview's model, each step traced, landed
// as the doc host lands one (src/host/doc-service.js, finishRun).
// preview/build.js bundles it into dist/preview, which the site serves at
// /preview/; the model (infer.ponjo.app) answers pages on ponjo.app only.

/* global document, IntersectionObserver */

import { createClient } from '../web/client.js';
import { apply, diffOps, mapOffset, transform } from '../src/core/ot.js';
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

function pick(root, attribute, value) {
  for (const button of root.querySelectorAll(`[${attribute}]`)) button.setAttribute('aria-checked', button.getAttribute(attribute) === value);
}

// ---- By character: two pages typing, the host ordering their edits ----

const TYPED = 'We ship in March.';

function typing(root) {
  let delay = 0;
  let host;

  // A line one way: messages arrive in order, `delay` after they are sent.
  const line = () => {
    let last = 0;
    return (deliver) => {
      last = Math.max(last, Date.now() + delay);
      setTimeout(deliver, last - Date.now());
    };
  };

  function note(event, made) {
    const what = event.ops.map((op) => (op.insert ? `“${op.insert}”` : `deleted ${op.to - op.from}`)).join(', ');
    const item = el('li', '', `rev ${event.rev} · ${event.by} · ${what}`);
    if (made < event.rev - 1) item.append(el('span', 'arch-moved', ` made on rev ${made}, moved over ${made + 1 === event.rev - 1 ? `rev ${made + 1}` : `revs ${made + 1}–${event.rev - 1}`}`));
    $(root, '[data-log]').prepend(item);
  }

  function paint() {
    $(root, '[data-file]').textContent = host.text;
    $(root, '[data-rev]').textContent = `rev ${host.rev}`;
    const same = host.pages.every((page) => page.area.value === host.text && page.client.idle());
    $(root, '[data-converged]').hidden = !same;
  }

  // The doc host's side (DocService): an edit made on an older rev is moved
  // over each one landed since, then lands; every page hears it, its sender's
  // event before its answer.
  function submit(by, { ops, rev, id }) {
    for (const landed of host.events.filter((event) => event.rev > rev)) ops = transform(ops, landed.ops);
    host.text = apply(host.text, ops);
    const event = { epoch: 1, rev: ++host.rev, ops, id, by };
    host.events.push(event);
    note(event, rev);
    for (const page of host.pages) page.down(() => {
      page.client.receive(event);
      paint();
    });
    return { rev: event.rev };
  }

  function start() {
    host = { text: TYPED, rev: 7, events: [], pages: [] };
    $(root, '[data-log]').replaceChildren();
    for (const area of root.querySelectorAll('[data-page]')) {
      const page = { area, up: line(), down: line() };
      const by = area.dataset.page;
      page.client = createClient({
        view: { getText: () => area.value, selection: () => ({ from: area.selectionStart, to: area.selectionEnd }), composing: () => page.composing },
        call: (type, arg) => new Promise((answer) => page.up(() => {
          const reply = type === 'submit' ? submit(by, arg) : type === 'state' ? { epoch: 1, rev: host.rev, text: host.text, level: 'write', events: host.events.filter((e) => e.rev > arg.since.rev) } : {};
          page.down(() => answer(reply));
        })),
        show: (text, ops) => show(area, text, ops),
        onLanded: paint,
      });
      area.value = TYPED;
      page.client.start({ epoch: 1, rev: host.rev, text: TYPED, level: 'write' });
      area.oninput = () => page.composing || page.client.edited();
      area.oncompositionstart = () => { page.composing = true; };
      area.oncompositionend = () => {
        page.composing = false;
        page.client.edited();
      };
      host.pages.push(page);
    }
    paint();
  }

  // Both type at once, a character at a time, each where the line says.
  async function play() {
    setDelay('1500');
    const [noor, alice] = host.pages;
    const words = [[noor, 'the beta ', (text) => text.indexOf('in March')], [alice, ' 2027', (text) => text.indexOf('.')]];
    await Promise.all(words.map(async ([{ area, client }, word, where]) => {
      area.selectionEnd = where(area.value) < 0 ? area.value.length : where(area.value);
      for (const char of word) { // at the caret, which others' edits move (show)
        const caret = area.selectionEnd;
        area.value = area.value.slice(0, caret) + char + area.value.slice(caret);
        area.setSelectionRange(caret + 1, caret + 1);
        client.edited();
        await new Promise((done) => setTimeout(done, 90));
      }
    }));
  }

  function setDelay(value) {
    delay = Number(value);
    pick(root, 'data-delay', value);
  }

  for (const button of root.querySelectorAll('[data-delay]')) button.onclick = () => setDelay(button.dataset.delay);
  $(root, '[data-play]').onclick = play;
  $(root, '[data-reset]').onclick = start;
  start();
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

function receipt() {
  const box = el('div', 'pj-receipt');
  const undo = el('span', 'pj-icon-btn');
  undo.append(icon('undo'));
  box.append(icon('pencil'), el('span', '', '1 edit'), el('span', 'pj-spacer'), undo);
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

// 1. A chat beside the file: ask, wait, review, ask again.
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
    const messages = [[1, 'Noor', 'Clippy, shorten line 1.'], [1, 'Clippy', t < 3.5 ? 'Working…' : 'Done. Review it.'],
      [5.5, 'Noor', 'Max, lengthen line 2.'], [5.5, 'Max', t < 8 ? 'Working…' : 'Done. Review it.']].filter(([at]) => t >= at);
    const now = messages.map(([, , text]) => text).join('|');
    if (now !== said) {
      said = now;
      log.replaceChildren(...messages.map(([, who, text]) => {
        const row = el('div', 'arch-actor');
        row.append(face(who, who === 'Noor'), el('span', 'arch-say', text));
        return row;
      }));
    }
    prompt.textContent = t < 1 ? typed('Clippy, shorten line 1.', span(t, 0, 1)) : t >= 4.5 && t < 5.5 ? typed('Max, lengthen line 2.', span(t, 4.5, 5.5)) : '';
    const lines = [agent(t, LINES[0], SHORT, 'Clippy', 1), agent(t, LINES[1], LONG, 'Max', 5.5)];
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
// queue, each ask waits for the one before and edits the doc as it goes; in
// Ponjo each works on its own copy at once, merged (merge3) when it ends.
const ASKS = {
  queue: { Clippy: [0, 0.8, 0.8, 3.3], Max: [0.8, 1.6, 3.3, 5.8] }, // asked from, to; works from, to
  ponjo: { Clippy: [0, 0.8, 0.8, 3.3], Max: [0.8, 1.6, 1.6, 4.1] },
};

function docWindow(win, way) {
  const body = el('div', 'arch-lines');
  const doc = el('div', 'arch-pane');
  doc.append(el('span', 'arch-who', 'plan.md'), body);
  const margin = el('div', 'arch-margin');
  win.append(doc, margin);
  const ponjo = way === 'ponjo';
  const cards = Object.entries(ASKS[way]).map(([buddy, [from, to, start, end]]) => {
    const card = el('div', 'pj-card arch-card');
    card.style.setProperty('--buddy', buddyColor(buddy));
    const head = el('div', 'arch-actor');
    head.append(face('Noor', true), 'Noor');
    const ask = el('div', 'arch-ask');
    const who = face(buddy, false);
    const said = el('span', '');
    const status = el('div', 'arch-actor arch-status');
    status.append(who, said);
    const done = receipt();
    card.append(head, ask, status, done);
    margin.append(card);
    return (t) => {
      const working = t >= start && t < end;
      card.hidden = t < from;
      ask.textContent = typed(`@${buddy} ${buddy === 'Clippy' ? 'shorten this' : 'lengthen this'}`, span(t, from, to));
      card.classList.toggle('pj-card-working', working);
      if (working) who.dataset.presence = 'working';
      else if (t >= to && t < start) who.dataset.presence = 'away';
      else delete who.dataset.presence;
      said.textContent = t < start ? 'Queued' : working ? (ponjo ? 'Working on its copy' : 'Working…') : 'Done';
      status.hidden = t < to || (ponjo && t >= end);
      done.hidden = !(ponjo && t >= end);
    };
  });
  const [clippy, max] = Object.values(ASKS[way]);
  return (t) => {
    for (const card of cards) card(t);
    const mine = typed(MINE, span(t, 1.6, 4));
    let lines;
    if (ponjo) {
      const base = `${LINES.join('\n')}\n`;
      let text = base + mine;
      if (t >= clippy[3]) text = merge3(base, text, `${SHORT}\n${LINES[1]}\n`).text;
      if (t >= max[3]) text = merge3(base, text, `${LINES[0]}\n${LONG}\n`).text;
      const [one, two] = text.split('\n');
      lines = [
        t >= clippy[3] ? { text: one, by: 'Clippy' } : { text: one, hl: true, caret: t >= clippy[2] ? { at: 0, by: 'Clippy', working: true } : null },
        t >= max[3] ? { text: two, by: 'Max' } : { text: two, hl: t >= max[0], caret: t >= max[2] ? { at: 0, by: 'Max', working: true } : null },
      ];
    } else {
      const edit = (line, next, by, [from, , start, end]) => {
        if (t >= end) return { text: next };
        if (t < start) return { text: line, hl: t >= from };
        const now = overwrite(line, next, span(t, start, end));
        return { text: now.text, caret: { at: now.at, by, working: true } };
      };
      lines = [edit(LINES[0], SHORT, 'Clippy', clippy), edit(LINES[1], LONG, 'Max', max)];
    }
    if (t >= 1.6) lines.push({ text: mine, caret: { at: mine.length, by: 'Noor' } });
    drawLines(body, lines);
  };
}

const WRITES = [[0, 1.6, 'comments'], [1.6, 4, 'writes']];
const MODES = {
  chat: {
    end: 11,
    window: chatWindow,
    lanes: {
      Noor: [[0, 1, 'asks'], [1, 3.5, 'waits', true], [3.5, 4.5, 'reviews'], [4.5, 5.5, 'asks'], [5.5, 8, 'waits', true], [8, 9, 'reviews'], [9, 11, 'writes']],
      Clippy: [[1, 3.5, 'edits'], [3.5, 4.5, 'waits', true]],
      Max: [[5.5, 8, 'edits'], [8, 9, 'waits', true]],
    },
  },
  queue: {
    end: 5.8,
    window: (win) => docWindow(win, 'queue'),
    lanes: { Noor: WRITES, Clippy: [[0.8, 3.3, 'edits']], Max: [[1.6, 3.3, 'queued', true], [3.3, 5.8, 'edits']] },
  },
  ponjo: {
    end: 4.1,
    window: (win) => docWindow(win, 'ponjo'),
    lanes: { Noor: WRITES, Clippy: [[0.8, 3.3, 'edits its copy']], Max: [[1.6, 4.1, 'edits its copy']] },
  },
};

// Who did what when, on one scale for every way: a bar grows as it happens.
function drawLanes(node, lanes, end) {
  const bars = [];
  const heads = [];
  const at = (s) => `${(s / SCALE) * 100}%`;
  const rows = Object.entries(lanes).map(([who, list]) => {
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
    name.append(face(who, who === 'Noor'), who);
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

setBuddies([{ id: 'Clippy', name: 'Clippy' }, { id: 'Max', name: 'Max' }]);
setPeople(['Noor']);
deck();
for (const root of document.querySelectorAll('[data-demo="mode"]')) mode(root);
typing($(document, '[data-demo="typing"]'));
lines($(document, '[data-demo="lines"]'));
buddyTurn($(document, '[data-demo="turn"]'));
