// Runs: the traces of this doc's buddy runs (Settings > Agents > Trace
// runs), newest first, for whoever works on an agent. A run shows what it
// was given (the prompt), each step the agent wrote to its trace (the Ponjo
// agent's: the model's thinking and tool calls, each call's result, how long
// it took and its tokens), what it printed, what it changed and what landed.
// Like the version history, it takes the doc's place while open. Only the
// owner's window has it: a trace holds the doc and the prompt.

import { lineChanges } from '../src/core/diff.js';
import { icon } from './icons.js';
import { avatar } from './threads.js';

const OUTCOMES = { ok: 'Done', failed: 'Failed', timedOut: 'Timed out', stopped: 'Stopped' };
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const count = new Intl.NumberFormat();

/**
 * `api` is web/api.js; `enabled()` whether this window traces runs (the
 * owner's, with Trace runs on); `commentOf(threadId)` is the text of the
 * comment a run answered, or null; `onChange()` follows each new list of
 * runs (a reply's Trace link shows from it); `onOpen()` and `onClose()`
 * when it opens and closes.
 */
export function createRuns({ api, enabled, commentOf, onChange, onOpen, onClose }) {
  const root = document.documentElement;
  const stage = document.querySelector('.pj-runs-stage');
  const page = stage.querySelector('.pj-trace');
  const list = stage.querySelector('.pj-history-list');
  const bar = document.querySelector('.pj-runs-bar');
  const heading = bar.querySelector('.pj-history-heading');
  const toggleButton = document.querySelector('.pj-tool-runs');

  let runs = []; // newest first, as api.runs gives them
  let selected = null;
  let loads = 0;

  const isOpen = () => root.hasAttribute('data-runs');

  async function open(run = runs[0]?.run ?? null) {
    if (!isOpen()) {
      onOpen();
      root.setAttribute('data-runs', '');
      toggleButton.setAttribute('aria-pressed', 'true');
      render();
    }
    await select(run);
    list.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    root.removeAttribute('data-runs');
    toggleButton.setAttribute('aria-pressed', 'false');
    onClose();
  }

  // The runs again: on opening the doc, after a run ends, and when Trace runs is switched.
  async function refresh() {
    toggleButton.hidden = !enabled();
    if (!enabled()) {
      runs = [];
      close();
      onChange();
      return;
    }
    try {
      runs = await api.runs();
    } catch (error) {
      heading.textContent = `Could not load the runs: ${error.message}`;
      return;
    }
    onChange();
    if (!isOpen()) return;
    render();
    if (!runs.some((r) => r.run === selected)) await select(runs[0]?.run ?? null);
  }

  // ---- the list ----

  function render() {
    list.replaceChildren(...(runs.length ? runs.map(row) : [el('li', 'pj-history-empty', 'No runs traced yet. A buddy\'s next run shows here.')]));
    markSelected();
  }

  function row(run) {
    const li = el('li', 'pj-version', null, { role: 'option', 'data-id': run.run });
    const top = el('span', 'pj-version-top');
    top.append(el('span', 'pj-version-who', run.buddy));
    if (run.outcome !== 'ok') top.append(el('span', 'pj-version-tag', OUTCOMES[run.outcome] ?? run.outcome, run.outcome === 'stopped' ? {} : { 'data-failed': '' }));
    li.append(avatar(run.buddy, 'agent', true), top, el('span', 'pj-version-time', `${when(run.at)} · ${seconds(run.ms)}`));
    const comment = commentOf(run.thread);
    if (comment) {
      const what = el('span', 'pj-version-what');
      what.append(el('span', 'pj-version-note', `On “${comment.replace(/\s+/g, ' ').trim()}”`));
      li.append(what);
    }
    li.addEventListener('click', () => select(run.run));
    return li;
  }

  function markSelected() {
    for (const li of list.querySelectorAll('.pj-version')) {
      const on = li.dataset.id === selected;
      li.setAttribute('aria-selected', String(on));
      if (on) list.setAttribute('aria-activedescendant', li.id = `pj-run-${li.dataset.id}`);
    }
  }

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [...list.querySelectorAll('.pj-version')];
    const at = rows.findIndex((li) => li.dataset.id === selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next && next.dataset.id !== selected) {
      next.scrollIntoView({ block: 'nearest' });
      select(next.dataset.id);
    }
  });

  // ---- the selected run ----

  async function select(id) {
    selected = id;
    markSelected();
    heading.textContent = '';
    const load = ++loads;
    if (!id) return page.replaceChildren();
    let trace;
    try {
      trace = await api.trace(id);
    } catch (error) {
      if (load === loads) heading.textContent = `Could not load this run: ${error.message}`;
      return;
    }
    if (load !== loads) return; // another run was picked meanwhile
    page.replaceChildren(...traceNodes(trace, commentOf(trace.thread)));
    page.scrollIntoView({ block: 'start' });
  }

  bar.querySelector('[data-action="close"]').addEventListener('click', close);
  toggleButton.addEventListener('click', () => (isOpen() ? close() : open()));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen() && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      close();
    }
  });

  return {
    refresh, close, isOpen,
    /** The run that posted reply `id`, or undefined. */
    runOf: (id) => runs.find((r) => r.reply === id)?.run,
    /** Open on run `run`. */
    show: (run) => open(run),
  };
}

// ---- a trace, as the page shows it ----

function traceNodes(trace, comment) {
  const steps = trace.steps ?? [];
  const answers = steps.filter((s) => s?.role === 'assistant');
  const tokens = answers.reduce((sum, s) => ({ in: sum.in + (s.usage?.input_tokens ?? s.usage?.prompt_tokens ?? 0), out: sum.out + (s.usage?.output_tokens ?? s.usage?.completion_tokens ?? 0) }), { in: 0, out: 0 });
  const facts = [
    `${OUTCOMES[trace.outcome] ?? trace.outcome}${trace.outcome === 'ok' || trace.code === null ? '' : ` (exit ${trace.code})`}`,
    seconds(trace.ms),
    ...(answers.length ? [`${answers.length} ${answers.length === 1 ? 'step' : 'steps'}`] : []),
    ...(tokens.in || tokens.out ? [`${count.format(tokens.in)} tokens in, ${count.format(tokens.out)} out`] : []),
    `${date.format(new Date(trace.at))}, ${time.format(new Date(trace.at))}`,
  ];
  const nodes = [
    el('h1', null, comment ? `${trace.buddy} on “${comment.replace(/\s+/g, ' ').trim()}”` : trace.buddy),
    el('p', 'pj-trace-facts', `${facts.join(' · ')}\n${trace.landed}. Ran ${trace.script}`),
    part('Prompt', [pre(trace.prompt)]),
  ];
  if (steps.length) nodes.push(el('h3', 'pj-setting-group', 'Steps'), ...stepNodes(steps));
  const failed = trace.outcome !== 'ok' && trace.outcome !== 'stopped';
  nodes.push(part('Output', [
    ...(trace.stdout.trim() ? [el('h3', 'pj-setting-group', 'stdout'), pre(trace.stdout)] : []),
    ...(trace.stderr.trim() ? [el('h3', 'pj-setting-group', 'stderr'), pre(trace.stderr)] : []),
    ...(trace.stdout.trim() || trace.stderr.trim() ? [] : [el('p', 'pj-trace-facts', 'It printed nothing.')]),
  ], failed));
  if (trace.edited !== null && trace.edited !== trace.base) nodes.push(part('Its changes to the doc', [diff(lineChanges(trace.base, trace.edited))], true));
  const added = trace.comments && trace.comments.after.startsWith(trace.comments.before) ? trace.comments.after.slice(trace.comments.before.length) : trace.comments?.after;
  if (added?.trim()) nodes.push(part('Its lines in the comments', [pre(added)], true));
  return nodes;
}

// Each step: the model's message with its calls, each call's result under it; the turn's own words between.
function stepNodes(steps) {
  const results = new Map(steps.filter((s) => s?.role === 'tool').map((s) => [s.id, s.content]));
  let n = 0;
  return steps.filter((s) => s?.role !== 'tool').map((step) => {
    if (step?.role === 'assistant') return answerPart(++n, step, results);
    if (step?.role === 'user') return el('p', 'pj-trace-facts', step.content);
    return pre(typeof step === 'string' ? step : JSON.stringify(step, null, 2)); // another agent's own form
  });
}

function answerPart(n, { calls = [], sent, ms, usage }, results) {
  const { thinking, text } = said(sent);
  const meta = [seconds(ms), ...(usage ? [`${count.format(usage.input_tokens ?? usage.prompt_tokens ?? 0)} in, ${count.format(usage.output_tokens ?? usage.completion_tokens ?? 0)} out`] : [])];
  const body = [
    ...(thinking ? [el('h3', 'pj-setting-group', 'Thinking'), pre(thinking, 'pj-trace-thinking')] : []),
    ...(text ? [el('h3', 'pj-setting-group', 'Said'), pre(text)] : []),
    ...calls.flatMap((call) => [
      el('h3', 'pj-setting-group', call.name), pre(pretty(call.args)),
      ...(results.has(call.id) ? [el('h3', 'pj-setting-group', 'Result'), pre(results.get(call.id))] : []), // a proposal taken has none
    ]),
  ];
  return part(`${n}. ${calls.map(summary).join(', ') || 'No tool call'}`, body, false, meta.join(' · '));
}

// What the model wrote besides its calls, from its message as its API sent it (agents/ponjo.mjs INFER).
function said(sent) {
  if (Array.isArray(sent)) { // Anthropic's content blocks
    const of = (type, key) => sent.filter((b) => b.type === type).map((b) => b[key]).join('\n\n');
    return { thinking: of('thinking', 'thinking'), text: of('text', 'text') };
  }
  return { thinking: sent?.reasoning ?? sent?.reasoning_content ?? '', text: typeof sent?.content === 'string' ? sent.content : '' };
}

// A call in a few words: `read plan.md 1–40`, `propose 2 edits`.
function summary({ name, args }) {
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    return name;
  }
  if (name === 'read' && typeof parsed.path === 'string') return `read ${parsed.path.split(/[\\/]/).pop()}${Array.isArray(parsed.lines) ? ` ${parsed.lines.join('–')}` : ''}`;
  if (name === 'propose' && Array.isArray(parsed.edits)) return `propose ${parsed.edits.length} ${parsed.edits.length === 1 ? 'edit' : 'edits'}`;
  return name;
}

function pretty(args) {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

// A part that opens and closes: its title, what is in it, and a note on its right.
function part(title, children, open = false, note = '') {
  const details = el('details', 'pj-trace-part');
  details.open = open;
  const head = el('summary');
  head.append(icon('chevron'), el('span', 'pj-trace-title', title));
  if (note) head.append(el('span', 'pj-trace-meta', note));
  details.append(head, ...children);
  return details;
}

// Changes of whole lines: each one's lines taken out, then those put in.
function diff(changes) {
  const block = el('pre', 'pj-trace-text');
  for (const { before, after } of changes) {
    if (block.childNodes.length) block.append('\n');
    for (const [text, mark, className] of [[before, '-', 'pj-minus'], [after, '+', 'pj-plus']]) {
      for (const line of text ? text.replace(/\n$/, '').split('\n') : []) block.append(el('span', className, `${mark}${line}\n`));
    }
  }
  return block;
}

const pre = (text, className = '') => el('pre', `pj-trace-text ${className}`.trim(), text);

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function when(iso) {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString() ? time.format(at) : `${date.format(at)}, ${time.format(at)}`;
}

function el(tag, className, text, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
