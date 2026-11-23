// The runtime panel (site/design.html, Runtime panel): what the agents'
// controllers (src/core/controller.js) do, as Chrome's DevTools shows a
// page, docked on the right. It knows no world: it shows the events its host
// traces (look, run.end, watches.paused) and the agents' statuses, as its
// host hands them over. Looks: what changed and each agent's verdict: a run
// started, stopped or not started. Runs: each run, what it came to, and
// opened, what it was given, made and landed. Agents: what each runs now,
// and what failed.

import { icon } from './icons.js';

const KEEP = 1000; // events held; older ones go
const TAGS = { running: 'Running', landed: 'Landed', quiet: 'Quiet', refused: 'Refused', failed: 'Failed', stopped: 'Stopped' };
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const count = new Intl.NumberFormat();
const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

// What a run came to, from its end: running, landed, quiet (it made
// nothing: `made` null), refused (the world's answer says why), failed or
// stopped. An end without `made` (the doc host keeps it out) landed.
function cameTo(end) {
  if (!end) return 'running';
  if (end.result.outcome === 'failed' || end.result.outcome === 'stopped') return end.result.outcome;
  if (end.answered?.rejected) return 'refused';
  return end.result.made === null ? 'quiet' : 'landed';
}

/**
 * The panel, appended to the page and open. `where` names what it watches;
 * `faceOf(id, name)` is an agent's face; `askText(id)` an ask in words, as its
 * world names them; `retry(id)` runs an agent's failed asks again;
 * `detail(run)`, if given, resolves to what the host keeps of a run (a
 * trace), as nodes, or null, shown in place of the event's; `onClose()`
 * once it is closed. Returns { add(event, at) (an event its host traced,
 * at `at`, ms since the epoch: a run's end with no look before it is a run
 * from before), agents(statuses) (as its host's `agents` emit has them),
 * show(run) (opens a run), close() }.
 */
export function createRuntimePanel({ where, faceOf, askText = (id) => id, retry, detail, onClose = () => {} }) {
  const events = []; // [{ at, ...event }]
  let statuses = [];
  let tab = 'looks';
  let selected = null; // the run opened
  let following = true;
  let pending = false;
  const openLooks = new Set(); // looks opened, by when
  const openParts = new Map(); // a run's parts opened or closed, by title
  const details = new Map(); // run → what `detail` resolved to (nodes, or null), or 'loading'

  const root = el('aside', 'pj-runtime');
  root.setAttribute('aria-label', 'Runtime');
  const head = el('div', 'pj-runtime-head');
  const pause = button('pause', 'Stop following: new events wait');
  const clear = button('trash', 'Clear');
  const close = button('close', 'Close');
  head.append(el('span', 'pj-runtime-title', 'Runtime'), el('span', 'pj-runtime-where', where), pause, clear, close);
  const bar = el('div', 'pj-runtime-bar');
  const tabs = el('div', 'pj-segmented');
  tabs.setAttribute('role', 'radiogroup');
  tabs.setAttribute('aria-label', 'View');
  const counts = {};
  for (const [key, label] of [['looks', 'Looks'], ['runs', 'Runs'], ['agents', 'Agents']]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.tab = key;
    b.setAttribute('role', 'radio');
    if (key !== 'agents') b.append(' ', (counts[key] = el('span', 'pj-runtime-count', '0')));
    b.addEventListener('click', () => {
      tab = key;
      draw();
    });
    tabs.append(b);
  }
  const who = el('select');
  who.setAttribute('aria-label', 'Agent');
  who.addEventListener('change', () => draw());
  const filter = el('label', '', 'Agent ');
  filter.append(who);
  const only = el('input');
  only.type = 'checkbox';
  only.checked = true;
  only.addEventListener('change', () => draw());
  const onlyLabel = el('label');
  onlyLabel.append(only, ' Only looks that started a run');
  bar.append(tabs, filter, onlyLabel);
  const body = el('div', 'pj-runtime-body');
  root.append(head, bar, body);
  document.body.append(root);
  document.documentElement.dataset.runtime = '';

  pause.setAttribute('aria-pressed', 'false');
  pause.addEventListener('click', () => {
    following = !following;
    pause.setAttribute('aria-pressed', String(!following));
    pause.replaceChildren(icon(following ? 'pause' : 'play'));
    pause.title = following ? 'Stop following: new events wait' : 'Follow again';
    if (following) draw();
  });
  clear.addEventListener('click', () => {
    events.length = 0;
    selected = null;
    draw();
  });
  close.addEventListener('click', () => {
    root.remove();
    delete document.documentElement.dataset.runtime;
    onClose();
  });

  function button(name, title) {
    const b = el('button', 'pj-icon-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(icon(name));
    return b;
  }

  // Draws again on the next frame, unless it stopped following.
  function later() {
    if (!following || pending) return;
    pending = true;
    document.defaultView.requestAnimationFrame(() => {
      pending = false;
      draw();
    });
  }

  // The runs, oldest first, each with when it started and its end, if it
  // ended: those the looks started, and runs from before, known by their end.
  function runsOf() {
    const ends = new Map(events.filter((e) => e.type === 'run.end').map((e) => [e.run, e]));
    const started = events.filter((e) => e.type === 'look').flatMap((look) => look.verdicts.filter((v) => v.run).map((v) => ({ id: v.run, agent: v.name, start: look.at, end: ends.get(v.run) })));
    const known = new Set(started.map((r) => r.id));
    const before = [...ends.values()].filter((e) => !known.has(e.run)).map((e) => ({ id: e.run, agent: e.task.agent.name, start: e.at - (e.result.ms ?? 0), end: e }));
    return [...before, ...started].sort((a, b) => a.start - b.start);
  }

  function draw() {
    const looks = events.filter((e) => e.type !== 'run.end');
    const runs = runsOf();
    counts.looks.textContent = count.format(looks.length);
    counts.runs.textContent = count.format(runs.length);
    for (const b of tabs.children) b.setAttribute('aria-checked', String(b.dataset.tab === tab));
    onlyLabel.hidden = tab !== 'looks';
    const names = [...new Set([...statuses.map((s) => s.name), ...runs.map((r) => r.agent)])];
    if (names.join() !== [...who.options].slice(1).map((o) => o.value).join()) {
      const now = who.value;
      who.replaceChildren(Object.assign(el('option', '', 'All'), { value: '' }), ...names.map((n) => Object.assign(el('option', '', n), { value: n })));
      who.value = names.includes(now) ? now : '';
    }
    const scrolls = [body.scrollTop, body.querySelector('.pj-runtime-list')?.scrollTop ?? 0, body.querySelector('.pj-runtime-detail')?.scrollTop ?? 0];
    const split = tab === 'runs' && runs.some((r) => r.id === selected);
    body.toggleAttribute('data-split', split);
    body.replaceChildren(...(tab === 'looks' ? drawLooks(looks) : tab === 'runs' ? drawRuns(runs) : drawAgents()));
    body.scrollTop = scrolls[0];
    const list = body.querySelector('.pj-runtime-list');
    if (list) list.scrollTop = scrolls[1];
    const detail = body.querySelector('.pj-runtime-detail');
    if (detail) detail.scrollTop = scrolls[2];
  }

  function stamp(at) {
    const t = el('span', 'pj-runtime-time', time.format(at));
    t.title = new Date(at).toISOString();
    return t;
  }

  // Looks, newest first: what set each off, the runs it started, and opened, every verdict.
  function drawLooks(looks) {
    const name = who.value;
    const shown = looks.filter((e) => e.type !== 'look' || e.verdicts.some((v) => (!name || v.name === name) && (!only.checked || v.run)));
    if (!shown.length) return [el('p', 'pj-runtime-empty', only.checked ? 'No look has started a run yet.' : 'No looks yet. An agent looks each time what it sees changes.')];
    return shown.slice().reverse().map((e) => {
      const look = el('details', 'pj-runtime-look');
      const sum = el('summary');
      if (e.type !== 'look') { // the watches paused
        sum.append(stamp(e.at), el('span', 'pj-runtime-why', `Watches paused: ${e.runs} runs in ${e.within} min`), el('span'));
        look.append(sum);
        return look;
      }
      look.open = openLooks.has(e.at);
      look.addEventListener('toggle', () => (look.open ? openLooks.add(e.at) : openLooks.delete(e.at)));
      const started = el('span', 'pj-runtime-started');
      for (const v of e.verdicts) if (v.run) started.append(el('span', 'pj-version-tag', `${v.name} ran`));
      sum.append(stamp(e.at), el('span', 'pj-runtime-why', e.why || 'asked to'), started);
      const table = el('table', 'pj-runtime-verdicts');
      for (const v of e.verdicts) {
        if (name && v.name !== name) continue;
        const reason = el('td', '', v.reason);
        if (v.run) {
          const link = el('button', 'pj-runtime-link', v.run);
          link.type = 'button';
          link.addEventListener('click', () => {
            tab = 'runs';
            selected = v.run;
            draw();
          });
          reason.append(' · ', link);
        }
        const row = el('tr');
        row.append(el('td', '', v.name || 'No one'), reason);
        table.append(row);
      }
      look.append(sum, table);
      return look;
    });
  }

  // Runs, newest first, on a timeline from the first event to now; the run opened under them.
  function drawRuns(runs) {
    const name = who.value;
    const shown = runs.filter((r) => !name || r.agent === name);
    if (!shown.length) return [el('p', 'pj-runtime-empty', 'No runs yet.')];
    const from = events[0]?.at ?? Date.now();
    const span = Math.max(Date.now() - from, 1);
    const head = el('div', 'pj-runtime-head-row');
    for (const h of ['Started', 'Agent', 'Asked', 'Came to', 'Timeline']) head.append(el('span', '', h));
    const list = el('div', 'pj-runtime-list');
    list.append(head);
    for (const r of shown.slice().reverse()) {
      const kind = cameTo(r.end);
      const row = el('button', 'pj-runtime-run');
      row.type = 'button';
      row.setAttribute('aria-current', String(r.id === selected));
      const tag = el('span', 'pj-version-tag', TAGS[kind]);
      tag.dataset.kind = kind;
      const lane = el('span', 'pj-runtime-lane');
      const run = el('i');
      run.dataset.kind = kind;
      Object.assign(run.style, { left: `${((r.start - from) / span) * 100}%`, width: `${(((r.end?.at ?? Date.now()) - r.start) / span) * 100}%` });
      lane.append(run);
      row.append(stamp(r.start), el('span', '', r.agent), el('span', 'pj-runtime-asked', r.end ? r.end.task.asks.map((a) => askText(a.id)).join(', ') : '…'), tag, lane);
      row.addEventListener('click', () => {
        selected = r.id;
        draw();
      });
      list.append(row);
    }
    const open = runs.find((r) => r.id === selected);
    return open ? [list, drawRun(open)] : [list];
  }

  function part(title, meta, open, ...children) {
    const p = el('details', 'pj-trace-part');
    p.open = openParts.get(title) ?? open;
    p.addEventListener('toggle', () => openParts.set(title, p.open));
    const sum = el('summary');
    sum.append(icon('chevron'), el('span', 'pj-trace-title', title));
    if (meta) sum.append(el('span', 'pj-trace-meta', meta));
    p.append(sum, ...children);
    return p;
  }
  // Text as a run was given it or wrote it: a string as it is, else each field under its name.
  function texts(value, thinking = []) {
    if (typeof value === 'string') return [el('pre', 'pj-trace-text', value)];
    return Object.entries(value ?? {}).filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [
      el('h3', 'pj-setting-group', k[0].toUpperCase() + k.slice(1)),
      el('pre', `pj-trace-text${thinking.includes(k) ? ' pj-trace-thinking' : ''}`, typeof v === 'string' ? v : JSON.stringify(v, null, 1)),
    ]);
  }

  // A run opened: its facts, then what it was asked, its prompt, what it made and what landed.
  function drawRun(r) {
    const box = el('section', 'pj-runtime-detail');
    const kind = cameTo(r.end);
    const top = el('div', 'pj-runtime-detail-head');
    const title = el('h2', 'pj-runtime-detail-title', `${r.agent} · ${r.id}`);
    const tag = el('span', 'pj-version-tag', TAGS[kind]);
    tag.dataset.kind = kind;
    title.append(tag);
    const shut = button('close', 'Close the run');
    shut.addEventListener('click', () => {
      selected = null;
      draw();
    });
    top.append(title, shut);
    box.append(top);
    const e = r.end;
    if (!e) {
      box.append(el('p', 'pj-runtime-facts', `Started at ${time.format(r.start)}, running…`));
      return box;
    }
    const usage = e.result.usage ? ` · ${count.format(e.result.usage.input_tokens ?? 0)} in, ${count.format(e.result.usage.output_tokens ?? 0)} out` : '';
    box.append(el('p', 'pj-runtime-facts', `Started at ${time.format(r.start)}, took ${((e.result.ms ?? 0) / 1000).toFixed(1)} s${usage}${e.task.depth ? ` · depth ${e.task.depth}` : ''}`));
    const asked = e.task.asks.map((a) => el('div', 'pj-runtime-line', [askText(a.id), a.from && `from ${a.from}`, a.at && `at ${time.format(Date.parse(a.at))}`].filter(Boolean).join(' · ')));
    box.append(part('Asked', String(e.task.asks.length || 'a watch'), true, ...(asked.length ? asked : [el('div', 'pj-runtime-line', 'Its watch: the world changed.')])));
    if (detail) {
      const kept = details.get(r.id);
      if (kept === undefined) {
        details.set(r.id, 'loading');
        detail(r.id).catch(() => null).then((nodes) => {
          details.set(r.id, nodes);
          draw();
        });
      }
      if (kept === undefined || kept === 'loading') box.append(el('p', 'pj-runtime-facts', 'Loading its trace…'));
      else if (kept) box.append(...kept);
      if (kept !== null) return box;
    }    if (e.view?.prompt) box.append(part('Prompt', 'what it saw', false, ...texts(e.view.prompt)));
    if (kind === 'failed') box.append(part('Error', '', true, el('pre', 'pj-trace-text', e.result.body ?? '')));
    if (e.result.made) box.append(part('Made', '', true, ...texts(e.result.made, ['thinking'])));
    else if (kind === 'quiet') box.append(part('Made', 'nothing', false, el('div', 'pj-runtime-line', 'It made nothing: no model was called.')));
    if (e.answered) box.append(part('Landed', kind === 'refused' ? 'refused' : '', true, ...(kind === 'refused' ? [el('pre', 'pj-trace-text', `Refused: ${e.answered.rejected}`)] : texts(e.answered))));
    return box;
  }

  // Agents: what each runs now, what failed with Retry, and whether it watches.
  function drawAgents() {
    const name = who.value;
    const shown = statuses.filter((s) => !name || s.name === name);
    if (!shown.length) return [el('p', 'pj-runtime-empty', 'No agents here.')];
    return shown.map((s) => {
      const row = el('div', 'pj-runtime-agent');
      const mid = el('div');
      mid.append(el('div', 'pj-runtime-agent-name', s.name), el('div', 'pj-runtime-line', s.asks.length ? `Running: ${s.asks.map(askText).join(', ')}` : 'Idle'));
      for (const f of s.failed) {
        const line = el('div', 'pj-runtime-line', `Failed on ${askText(f.ask)}: ${f.why ?? 'see the host'}`);
        line.dataset.failed = '';
        mid.append(line);
      }
      if (s.watchFailed) {
        const line = el('div', 'pj-runtime-line', `Its watch failed: ${s.watchFailed.why ?? ''}`);
        line.dataset.failed = '';
        mid.append(line);
      }
      mid.append(el('div', 'pj-runtime-line', s.watching ? 'Watching' : 'Not watching'));
      const end = el('div');
      if (s.failed.length || s.watchFailed) {
        const again = el('button', 'pj-link-button', 'Retry');
        again.type = 'button';
        again.addEventListener('click', () => retry(s.id));
        end.append(again);
      }
      row.append(faceOf(s.id, s.name), mid, end);
      return row;
    });
  }

  draw();
  return {
    add(event, at = Date.now()) {
      events.push({ at, ...event });
      if (events.length > KEEP) events.splice(0, events.length - KEEP);
      later();
    },
    agents(list) {
      statuses = list;
      later();
    },
    show(run) {
      tab = 'runs';
      selected = run;
      draw();
    },
    close: () => close.click(),
  };
}
