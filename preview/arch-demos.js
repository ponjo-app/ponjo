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
import { agentFace, personFace, setBuddies } from '../web/faces.js';
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

// ---- Three ways to write with an AI: one story, played on one stage ----

// Noor asks Clippy to shorten the first line, then fixes its typo while
// Clippy works. What each way ends on is the app's own code at work:
// transform for edits merged by character, merge3 for a copy merged by line.
const BASE = 'Teh beta ships in March to fifty design partners, who each get a private call and early access.\nThen we open the waitlist.\n';
const fix = (text) => text.replace('Teh', 'The');
const SHORT = 'Fifty design partners get the beta in March.';
const shorten = (text) => `${SHORT}${text.slice(text.indexOf('\n'))}`;
const MORE = ', in the order people joined it';
const STOPPED = Symbol('stopped');

// Text with marks at offsets: [{ at, node }], in order.
function marked(text, marks = []) {
  const out = [];
  let from = 0;
  for (const { at, node } of [...marks].sort((a, b) => a.at - b.at)) {
    out.push(text.slice(from, at), node);
    from = at;
  }
  return [...out, text.slice(from)];
}

// Clippy's rewrite of the first line streamed in, as an agent types: each
// step one operation on the text, its cursor after what it wrote.
function* stream(text) {
  const old = text.indexOf('\n');
  for (let k = 1; k <= SHORT.length; k++) {
    const op = { from: k - 1, to: k - 1 + (k <= old ? 1 : 0), insert: SHORT[k - 1] };
    text = apply(text, [op]);
    yield { text, op, at: k };
  }
  while (text.indexOf('\n') > SHORT.length) {
    const op = { from: SHORT.length, to: Math.min(SHORT.length + 4, text.indexOf('\n')), insert: '' };
    text = apply(text, [op]);
    yield { text, op, at: SHORT.length };
  }
}

// Noor's fix made on BASE, landed after Clippy's rewrite by character:
// the text, and Noor's inserts in it marked.
function spliced() {
  const clippy = diffOps(BASE, shorten(BASE));
  const noor = transform(diffOps(BASE, fix(BASE)), clippy);
  const text = apply(apply(BASE, clippy), noor);
  const out = [];
  let from = 0;
  let shift = 0;
  for (const op of noor) {
    const at = op.from + shift;
    shift += op.insert.length - (op.to - op.from);
    if (!op.insert) continue;
    out.push(text.slice(from, at), el('span', 'arch-splice', op.insert));
    from = at + op.insert.length;
  }
  return [...out, text.slice(from)];
}

function receipt() {
  const box = el('div', 'pj-receipt');
  const undo = el('span', 'pj-icon-btn');
  undo.append(icon('undo'));
  box.append(icon('pencil'), el('span', '', '1 edit'), el('span', 'pj-spacer'), undo);
  return box;
}

function ways(root) {
  setBuddies([{ id: 'Clippy', name: 'Clippy' }]);
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const caption = $(root, '[data-caption]');
  const doc = $(root, '[data-doc]');
  const copy = $(root, '[data-copy]');
  const marks = $(root, '[data-marks]');
  const actor = (name, person) => {
    const face = el('span', 'pj-agent-face');
    const avatar = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
    avatar.style.setProperty('--size', '28px');
    avatar.append(person ? personFace(name) : agentFace(name));
    face.append(avatar);
    const say = el('span', 'arch-say');
    const row = el('div', 'arch-actor');
    row.append(face, say);
    $(root, '[data-cast]').append(row);
    return (state, text) => {
      if (state) face.dataset.presence = state;
      else delete face.dataset.presence;
      say.textContent = text;
      say.hidden = !text;
    };
  };
  const noor = actor('Noor', true);
  const clippy = actor('Clippy', false);
  const caret = (by) => cursorNode({ by, working: by !== 'Noor' });
  let playing = 0;

  async function play(way) {
    const id = ++playing;
    pick(root, 'data-way', way);
    const wait = (ms) => new Promise((done, stop) => setTimeout(() => (id === playing ? done() : stop(STOPPED)), ms));
    // Draws each frame in turn; with reduced motion, only the last.
    const frames = async (list, ms, draw) => {
      const all = [...list];
      for (const [i, frame] of all.entries()) {
        if (still && i < all.length - 1) continue;
        draw(frame);
        await wait(ms);
      }
    };
    const paint = (node, text, at = []) => node.replaceChildren(...marked(text, at));
    const say = (n, text) => {
      caption.textContent = `${n}. ${text}`;
    };
    const typeIn = (node, text, at, insert, by) => frames(
      [...insert].map((_, k) => ({ text: text.slice(0, at) + insert.slice(0, k + 1) + text.slice(at), caret: at + k + 1 })),
      70, (f) => paint(node, f.text, [{ at: f.caret, node: caret(by) }]),
    );
    const end = (good) => {
      marks.replaceChildren(...good.map((ok, i) => {
        const item = el('li', ok ? 'arch-good' : '');
        item.append(icon(ok ? 'check' : 'close'), ['Natural', 'Focused', 'In control'][i]);
        return item;
      }));
    };
    marks.replaceChildren();
    copy.hidden = true;
    noor(null, '');
    clippy(null, '');
    paint(doc, BASE);
    try {
      await wait(400);
      if (way === 'turns') {
        say(1, 'Noor asks, then waits.');
        noor(null, '@Clippy shorter');
        await wait(900);
        noor('away', '…');
        clippy('working', 'On it.');
        await frames(stream(BASE), 40, (f) => paint(doc, f.text, [{ at: f.at, node: caret('Clippy') }]));
        say(2, 'Noor reviews the change.');
        noor(null, 'Accept? Reject?');
        clippy(null, 'Done.');
        revision(doc, BASE, shorten(BASE));
        const choices = el('div', 'arch-choices');
        const accept = el('span', 'pj-secondary', 'Accept');
        choices.append(accept, el('span', 'pj-secondary', 'Reject'));
        doc.append(choices);
        await wait(1400);
        accept.classList.add('arch-pressed');
        await wait(500);
        say(3, 'Only then writes on.');
        clippy(null, '');
        noor('working', 'Finally.');
        const text = shorten(BASE);
        await typeIn(doc, text, text.lastIndexOf('.'), MORE, 'Noor');
        noor(null, '');
        end([false, false, true]);
      } else if (way === 'live') {
        say(1, 'Both type in one line.');
        noor('working', 'teh → the');
        clippy('working', 'Rewriting…');
        let at = 1; // Noor's caret, moved by each of Clippy's operations
        paint(doc, BASE, [{ at, node: caret('Noor') }]);
        await wait(900);
        say(2, 'The text moves under Noor.');
        noor('working', 'Hey, my caret!');
        await frames(stream(BASE), 40, (f) => {
          at = mapOffset(at, [f.op]);
          paint(doc, f.text, [{ at: f.at, node: caret('Clippy') }, { at, node: caret('Noor') }]);
        });
        await wait(500);
        say(3, 'The edits splice, silently.');
        doc.replaceChildren(...spliced());
        noor(null, 'Wait, what?');
        clippy(null, 'Done!');
        end([true, false, false]);
      } else {
        say(1, 'Clippy works on a copy.');
        noor(null, '@Clippy shorter');
        await wait(900);
        copy.hidden = false;
        const label = el('span', 'arch-who', 'Clippy’s copy');
        const text = el('div');
        copy.replaceChildren(label, text);
        noor('working', 'Writing on.');
        clippy('working', 'On my copy.');
        const more = BASE.lastIndexOf('.');
        await Promise.all([
          frames(stream(BASE), 60, (f) => paint(text, f.text, [{ at: f.at, node: caret('Clippy') }])),
          typeIn(doc, BASE, more, MORE, 'Noor').then(async () => {
            const now = BASE.slice(0, more) + MORE + BASE.slice(more);
            noor('working', 'teh → the');
            await frames([{ t: `T${now.slice(3)}`, c: 1 }, { t: `Th${now.slice(3)}`, c: 2 }, { t: fix(now), c: 3 }], 200,
              (f) => paint(doc, f.t, [{ at: f.c, node: caret('Noor') }]));
          }),
        ]);
        const now = fix(BASE.slice(0, more) + MORE + BASE.slice(more));
        const { conflicts } = merge3(BASE, now, shorten(BASE));
        say(2, 'Same line changed: Clippy redoes it.');
        noor(null, '');
        clippy('working', 'Redoing.');
        label.textContent = `Clippy’s copy · ${conflicts} line collides → redo`;
        await frames(stream(now), 25, (f) => paint(text, f.text, [{ at: f.at, node: caret('Clippy') }]));
        say(3, 'One change lands, with Undo.');
        copy.hidden = true;
        revision(doc, now, merge3(now, now, shorten(now)).text);
        for (const edit of doc.querySelectorAll('.pj-buddy-edit, .pj-buddy-del')) edit.classList.add('pj-replay');
        doc.append(receipt());
        noor(null, 'Nice.');
        clippy(null, 'Shortened.');
        end([true, true, true]);
      }
    } catch (error) {
      if (error !== STOPPED) throw error;
    }
  }
  for (const button of root.querySelectorAll('[data-way]')) button.onclick = () => play(button.dataset.way);
  $(root, '[data-play]').onclick = () => play($(root, '[data-way][aria-checked="true"]').dataset.way);
  // Played first when it comes into view.
  new IntersectionObserver((seen, watch) => {
    if (!seen.some((entry) => entry.isIntersecting)) return;
    watch.disconnect();
    play('turns');
  }, { threshold: 0.3 }).observe(root);
}

ways($(document, '[data-demo="ways"]'));
typing($(document, '[data-demo="typing"]'));
lines($(document, '[data-demo="lines"]'));
buddyTurn($(document, '[data-demo="turn"]'));
