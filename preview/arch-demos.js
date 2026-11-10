// The architecture page's live demos (site/architecture.html), each on the
// app's own code: two pages' client (web/client.js) in a host's order played
// here, merge3 (src/core/diff.js), and a buddy's turn by the Ponjo agent
// (agents/ponjo-core.mjs) on the preview's model, landed as the doc host
// lands one (src/host/doc-service.js, finishRun). preview/build.js bundles
// it into dist/preview, which the site serves at /preview/; the model
// (infer.ponjo.app) answers pages on ponjo.app only.

/* global document */

import { createClient } from '../web/client.js';
import { apply, diffOps, mapOffset, transform } from '../src/core/ot.js';
import { lineChanges, merge3 } from '../src/core/diff.js';
import { newId, serializeSidecar, threadsOf } from '../src/core/comments.js';
import { buildPrompt } from '../src/core/prompt.js';
import { INFER, turn } from '../agents/ponjo-core.mjs';

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
      ? `${conflicts} ${conflicts > 1 ? 'conflicts' : 'conflict'}: where both changed the same lines, people's lines stay. In the app the turn first runs once more, told what people did; colliding again, it lands like this, its version marked conflict.`
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
    let steps = 0;
    const counted = (messages, tools) => {
      status(`${redo ? 'Running once more, told what you changed' : 'Clippy is working on a copy'} · step ${++steps}. Keep editing the doc.`);
      return infer(messages, tools);
    };
    try {
      for (;;) {
        const base = doc.value;
        const copies = { [DOC]: base, [SIDECAR]: serializeSidecar([{ comment: first }]) };
        const prompt = buildPrompt({ buddy: CLIPPY, buddies: [CLIPPY], docName: DOC, sidecarName: SIDECAR, thread, human: { name: YOU.name, about: '' }, redo });
        const readFile = (path) => copies[path] ?? (['', '.'].includes(path) ? Object.keys(copies) : null);
        const { doc: edited, reply } = await turn({ prompt, doc: DOC, sidecar: SIDECAR, thread: thread.id }, { infer: counted, readFile });
        const now = doc.value;
        const merged = merge3(base, now, edited);
        if (merged.conflicts > 0 && !redo) { // as the doc host does: once more, on the doc as it is now
          redo = { mine: lineChanges(base, edited), theirs: lineChanges(base, now) };
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
  };
}

typing($(document, '[data-demo="typing"]'));
lines($(document, '[data-demo="lines"]'));
buddyTurn($(document, '[data-demo="turn"]'));
