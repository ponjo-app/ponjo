// The architecture page's demo and drawing (site/architecture.html). The
// demo is a Ponjo window playing scripted scenes, a tab each: its comment
// cards are the app's own comment margin (web/threads.js), with the app's
// header, faces and cursors around a doc drawn in the app's classes, and a
// panel below with what happens behind the scenes; edits merge as the doc
// host merges them (merge3, src/core/diff.js). The drawing is the runtime's
// parts, each point beside it putting its parts in focus. preview/build.js
// bundles this into dist/preview, which the site serves at /preview/.

/* global document, IntersectionObserver */

import { merge3 } from '../src/core/diff.js';
import { buddyColor, setBuddies, setOwner, setPeople } from '../web/faces.js';
import { cursorNode } from '../web/marks.js';
import { icon } from '../web/icons.js';
import { avatar, createCommentMargin } from '../web/threads.js';

const $ = (root, selector) => root.querySelector(selector);
const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const STOPPED = Symbol('stopped');

const TITLE = 'Launch plan';
const YOU = { id: 'You', name: 'You', kind: 'human' };
const ALICE = { id: 'Alice', name: 'Alice', kind: 'human' };
const FILES = new Set(['pricing.md', 'schedule.md', 'waitlist.csv']); // the project's, as links in comments
const ai = (name) => ({ id: name, name, kind: 'ai' });
const text = (paras) => `# ${TITLE}\n\n${paras.join('\n\n')}\n`;
const parasOf = (doc) => doc.trimEnd().split('\n\n').slice(1);

// Text `from` turned into `to` a part `x` of the way, as a buddy writes it:
// what they share at the start kept, the rest of `from` deleted, then the rest of `to` typed.
function writing(from, to, x) {
  let same = 0;
  while (from[same] === to[same] && same < to.length) same++;
  if (x < 0.4) return from.slice(0, from.length - Math.round((from.length - same) * x / 0.4));
  return to.slice(0, same + Math.round((to.length - same) * Math.min(1, (x - 0.4) / 0.6)));
}

// ---- A Ponjo window: the app's header, a doc, its comment margin ----

function app() {
  const head = el('header', 'pj-header arch-app-head');
  const title = el('div', 'pj-title');
  const docIcon = el('span', 'pj-doc-icon');
  docIcon.append(icon('file'));
  title.append(docIcon, el('span', 'pj-doc-name', 'plan.md'));
  const faces = el('div', 'pj-agents');
  const people = el('div', 'pj-people');
  people.append(faces);
  head.append(title, el('span', 'pj-spacer'), people);

  const doc = el('div', 'arch-app-doc');
  const marginNode = el('div', 'arch-app-margin');
  const body = el('div', 'arch-app-body');
  body.append(doc, marginNode);
  const frame = el('div', 'arch-app');
  frame.append(head, body);
  const behindTitle = el('span', 'arch-who');
  const behindBody = el('div', 'arch-behind-body');
  const panel = el('div', 'arch-behind');
  panel.append(behindTitle, behindBody);

  let paras = [];
  let threads = [];
  let agents = [];
  let edits = {};
  let traces = {};
  let hovered = null;
  const noop = async () => {};
  const margin = createCommentMargin(marginNode, {
    onCreate: noop, onCancelDraft: noop, onReply: noop, onResolve: noop, onReopen: noop, onUndo: noop,
    onShowEdits() {}, onSelect() {}, onTrace() {},
    onHover(id) {
      hovered = id;
      paint();
    },
    anchorTops: (items) => new Map(items.map(({ id, anchor }) => [id, doc.children[anchor.para + 1].getBoundingClientRect().top])),
    mentionable: () => [...faces.children].map((node) => ({ id: node.dataset.name, name: node.dataset.name, kind: node.dataset.kind })),
    files: () => FILES,
    traceOf: (id) => traces[id],
  });

  // The doc: its paragraphs, each { text, mine?, by?, cursor?, caret? };
  // those with an open thread highlighted, the hovered thread's brighter.
  function paint() {
    const open = new Map(threads.filter((t) => !t.resolved).map((t) => [t.anchor.para, t.id]));
    doc.replaceChildren(el('div', 'arch-app-h1', TITLE), ...paras.map((p, i) => {
      const row = el('div', 'arch-para');
      const hl = open.has(i) && !p.by ? `pj-hl${open.get(i) === hovered ? ' pj-hl-active' : ''}` : '';
      let words = el('span', p.mine ? 'arch-mine' : hl, p.text);
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
  }
  const refresh = () => {
    paint();
    margin.update(threads, YOU, edits);
  };
  const threadOf = (id) => threads.find((t) => t.id === id);

  return {
    frame, panel,
    // A new scene: these buddies and people in the header, these paragraphs, no comments.
    reset({ buddies, people: names = ['You'], behind }) {
      setBuddies(buddies.map((name) => ({ id: name, name })));
      setPeople(names);
      faces.replaceChildren(...[...buddies.map((name) => [name, 'agent']), ...names.map((name) => [name, 'human'])].map(([name, kind]) => {
        const wrap = el('span', 'pj-agent');
        Object.assign(wrap.dataset, { name, kind });
        const face = el('span', kind === 'agent' ? 'pj-agent-face' : 'pj-me');
        face.append(avatar(name, kind));
        wrap.append(face);
        return wrap;
      }));
      behindTitle.textContent = behind;
      behindBody.replaceChildren();
      [threads, agents, edits, traces, paras] = [[], [], {}, {}, []];
      margin.setAgents(agents);
      refresh();
    },
    draw(next) {
      paras = next;
      refresh();
    },
    // A comment by `by` on paragraph `para` asking `buddy`, typed out.
    async ask(wait, id, by, buddy, words, para) {
      const comment = { id: `${id}-0`, by, at: new Date().toISOString(), body: '' };
      threads.push({ id, anchor: { para }, resolved: false, detached: false, comments: [comment] });
      const all = `@${buddy} ${words}`;
      for (let i = buddy.length + 2; i <= all.length; i += 2) {
        comment.body = all.slice(0, i);
        refresh();
        await wait(30);
      }
      comment.body = all;
      refresh();
    },
    // `buddy` at work on thread `id`, or done: its face in the header, its row on the card.
    working(buddy, id, on) {
      agents = agents.filter((a) => a.id !== buddy);
      if (on) agents.push({ id: buddy, name: buddy, threadIds: [id] });
      for (const node of faces.children) if (node.dataset.name === buddy) node.dataset.presence = on ? 'working' : 'here';
      margin.setAgents(agents);
    },
    // `buddy`'s reply on thread `id`; `edited`: it changed the doc, so it shows its edit and Undo.
    reply(buddy, id, body, { edited = false, trace = false } = {}) {
      this.working(buddy, id, false);
      const comment = { id: `${id}-${threadOf(id).comments.length}`, by: ai(buddy), at: new Date().toISOString(), body };
      threadOf(id).comments.push(comment);
      if (edited) edits[comment.id] = { state: 'edited', by: buddy, changes: 1 };
      if (trace) traces[comment.id] = 'run';
      refresh();
    },
    // Behind the scenes: a buddy's copy of the doc, its paragraph (at first `start`) and a line on what it does.
    copy(buddy, start) {
      const name = el('span', 'arch-who');
      name.append(avatar(buddy, 'agent', true), `${buddy}’s copy`);
      const line = el('div', 'arch-lines');
      line.style.setProperty('--buddy', buddyColor(buddy));
      const state = el('div', 'arch-quiet');
      const box = el('div', 'arch-pane');
      box.append(name, line, state);
      behindBody.append(box);
      return {
        box,
        show(words, doing) {
          line.textContent = words;
          line.classList.toggle('pj-buddy-edit', words !== start); // in its colour once it changed
          state.textContent = doing;
        },
      };
    },
    // Behind the scenes: one thing a run knew, and where it is.
    known(path, what) {
      const words = el('div', '');
      words.append(el('b', '', path), el('div', 'arch-quiet', what));
      const row = el('div', 'arch-actor arch-row');
      row.append(icon('file'), words);
      behindBody.append(row);
    },
  };
}

// ---- The scenes: what you see, a step at a time ----

const P0 = 'We ship the beta in March to fifty design partners, who each get a private call and early access.';
const P1 = 'Then we open the waitlist to its 1,200 people.';
const SHORTER = 'Fifty design partners get the beta in March.';
const step = (say, run, hold = 3500) => ({ say, run, hold });

const SCENES = [
  {
    name: 'Ask many at once',
    cast: { buddies: ['Clippy', 'Max'], behind: 'Behind the scenes: each run on its own copy of the doc' },
    steps(win) {
      let clippy;
      let max;
      // Clippy writes its copy from a part `from` of the way to `to`.
      const write = async (wait, from, to) => {
        for (let x = from; x <= to + 1e-9; x += 0.05) {
          clippy.show(writing(P0, SHORTER, x), 'working');
          await wait(110);
        }
      };
      return [
        step('You ask Clippy for a rewrite: an @mention in a comment on the paragraph.', async (wait) => {
          win.draw([{ text: P0 }, { text: P1 }]);
          await win.ask(wait, 'rewrite', YOU, 'Clippy', 'rewrite this more briefly', 0);
        }, 1500),
        step('Clippy starts at once, on its own copy of the doc. Your doc doesn’t change while it works.', async (wait) => {
          win.working('Clippy', 'rewrite', true);
          win.draw([{ text: P0, cursor: 'Clippy' }, { text: P1 }]);
          clippy = win.copy('Clippy', P0);
          await write(wait, 0, 0.3);
        }, 500),
        step('Without waiting, you ask Max for a fact-check in another thread. Max starts too: two runs, side by side.', async (wait) => {
          await win.ask(wait, 'check', YOU, 'Max', 'is 1,200 right?', 1);
          win.working('Max', 'check', true);
          win.draw([{ text: P0, cursor: 'Clippy' }, { text: P1, cursor: 'Max' }]);
          max = win.copy('Max', P1);
          max.show(P1, 'reading waitlist.csv');
          await write(wait, 0.35, 0.7);
        }, 500),
        step('Max finishes first, though you asked it second, and answers in its thread.', async (wait) => {
          win.reply('Max', 'check', 'Yes: waitlist.csv has 1,200 people.');
          win.draw([{ text: P0, cursor: 'Clippy' }, { text: P1 }]);
          max.show(P1, 'done: nothing to change');
          max.box.classList.add('arch-gone');
          await write(wait, 0.75, 1);
        }, 2500),
        step('Clippy finishes, and the app merges its copy into your doc: one edit, with Undo.', async () => {
          const [one, two] = parasOf(merge3(text([P0, P1]), text([P0, P1]), text([SHORTER, P1])).text);
          win.draw([{ text: one, by: 'Clippy' }, { text: two }]);
          win.reply('Clippy', 'rewrite', 'Made it shorter.', { edited: true });
          clippy.show(one, 'done, merged in');
        }, 6000),
      ];
    },
  },
  {
    name: 'Nothing is hidden',
    cast: { buddies: ['Clippy'], behind: 'Behind the scenes: everything Clippy’s run knew' },
    steps(win) {
      const BETA = 'The beta ships in March to fifty design partners.';
      return [
        step('You ask Clippy whether the price is right.', async (wait) => {
          win.draw([{ text: BETA }, { text: 'It costs $10 a month.' }]);
          await win.ask(wait, 'price', YOU, 'Clippy', 'is this price right?', 1);
        }, 1500),
        step('Its run knows only what you can see too: the doc, its comments, its persona, and the files it reads.', async (wait) => {
          win.working('Clippy', 'price', true);
          win.draw([{ text: BETA }, { text: 'It costs $10 a month.', cursor: 'Clippy' }]);
          for (const [path, what] of [['plan.md', 'the doc'], ['plan.md comments', 'every thread on it'], ['Clippy.md', 'its persona, a file in the project'], ['pricing.md', 'a file it chose to read']]) {
            await wait(900);
            win.known(path, what);
          }
        }),
        step('So its edit rests on nothing you can’t check: pricing.md says $12. With traces on, its reply links to the list of what it read.', async () => {
          win.draw([{ text: BETA }, { text: 'It costs $12 a month.', by: 'Clippy' }]);
          win.reply('Clippy', 'price', 'pricing.md says $12 a month.', { edited: true, trace: true });
        }, 6500),
      ];
    },
  },
  {
    name: 'One shared context',
    cast: { buddies: ['Max', 'Clippy'], people: ['Alice', 'You'], behind: 'Behind the scenes: what Clippy’s run read' },
    steps(win) {
      const DOC = [{ text: 'The beta ships in March to fifty design partners.' }, { text: 'Then we open the waitlist.' }];
      return [
        step('Alice, a teammate, asks Max to check the dates.', async (wait) => {
          win.draw(DOC);
          await win.ask(wait, 'dates', ALICE, 'Max', 'are the dates right?', 0);
          win.working('Max', 'dates', true);
        }),
        step('Max finds the launch moved, and says so in its thread, on the doc, where everyone sees it.', async () => {
          win.reply('Max', 'dates', 'The launch moved to April: see schedule.md.');
        }),
        step('Later you ask Clippy for a one-line summary. Nobody tells Clippy about April.', async (wait) => {
          await win.ask(wait, 'sum', YOU, 'Clippy', 'add a one-line summary', 1);
          win.working('Clippy', 'sum', true);
          win.draw([DOC[0], { ...DOC[1], cursor: 'Clippy' }]);
          for (const [path, what] of [['plan.md', 'the doc'], ['plan.md comments', 'every thread on it: Max’s “moved to April” too'], ['Clippy.md', 'its persona']]) {
            await wait(900);
            win.known(path, what);
          }
        }),
        step('Its run read every comment on the doc, Max’s too, so its summary says April. One shared picture, no private sessions.', async () => {
          win.draw([...DOC, { text: 'In short: fifty design partners get the beta in April.', by: 'Clippy' }]);
          win.reply('Clippy', 'sum', 'Added a summary.', { edited: true });
        }, 6500),
      ];
    },
  },
  {
    name: 'You stay in control',
    cast: { buddies: ['Clippy'], behind: 'Behind the scenes: Clippy’s copy of the doc' },
    steps(win) {
      const YOURS = P0.replace('in March', 'in April');
      const REDONE = 'Fifty design partners get the beta in April.';
      let copy;
      return [
        step('You ask Clippy to shorten the first paragraph. It works on its own copy.', async (wait) => {
          win.draw([{ text: P0 }, { text: P1 }]);
          await win.ask(wait, 'short', YOU, 'Clippy', 'make this shorter', 0);
          win.working('Clippy', 'short', true);
          win.draw([{ text: P0, cursor: 'Clippy' }, { text: P1 }]);
          copy = win.copy('Clippy', P0);
          for (let x = 0; x <= 1 + 1e-9; x += 0.1) {
            copy.show(writing(P0, SHORTER, x), 'working');
            await wait(120);
          }
        }, 1500),
        step('Meanwhile you change the same paragraph: the beta moves to April. Your typing never waits.', async () => {
          win.draw([{ text: YOURS, mine: true, caret: true }, { text: P1 }]);
        }),
        step('Clippy is done, but its copy says March. The app keeps your line, and has Clippy redo its edit on your version.', async (wait) => {
          const { conflicts } = merge3(text([P0, P1]), text([YOURS, P1]), text([SHORTER, P1]));
          copy.show(SHORTER, `${conflicts} paragraph changed by you too: redo it on yours`);
          await wait(2500);
          win.draw([{ text: YOURS, cursor: 'Clippy' }, { text: P1 }]);
          for (let x = 0; x <= 1 + 1e-9; x += 0.1) {
            copy.show(writing(YOURS, REDONE, x), 'redoing, on your version');
            await wait(120);
          }
        }),
        step('Clippy’s new edit lands with your April in it, as one version you can undo. Nobody had to resolve anything.', async () => {
          const [one, two] = parasOf(merge3(text([YOURS, P1]), text([YOURS, P1]), text([REDONE, P1])).text);
          win.draw([{ text: one, by: 'Clippy' }, { text: two }]);
          win.reply('Clippy', 'short', 'Made it shorter.', { edited: true });
          copy.show(one, 'done, merged in');
        }, 6500),
      ];
    },
  },
];

// The scenes as tabs over one window. A scene plays while the demo is in
// view, a caption a step, then the next scene; a tab plays its scene from
// the start. With reduced motion, a scene shows its end and all its captions.
function demo(root) {
  const tabs = el('div', 'pj-segmented arch-tabs');
  tabs.setAttribute('role', 'radiogroup');
  tabs.setAttribute('aria-label', 'Scene');
  const caption = el('p', 'arch-caption');
  caption.setAttribute('aria-live', 'polite');
  const win = app();
  const again = el('button', 'pj-link-button', 'Replay');
  again.type = 'button';
  const bar = el('div', 'arch-controls');
  bar.append(tabs, again);
  const stage = el('div', 'arch-stage');
  stage.append(win.frame, win.panel);
  root.append(bar, caption, stage);

  let current = 0;
  let playing = 0;
  const buttons = SCENES.map((scene, i) => {
    const button = el('button', '', scene.name);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.onclick = () => play(i);
    return button;
  });
  tabs.append(...buttons);

  async function play(i) {
    current = i;
    buttons.forEach((button, j) => button.setAttribute('aria-checked', String(j === i)));
    const id = ++playing;
    const wait = (ms) => new Promise((done, stop) => setTimeout(() => (id === playing ? done() : stop(STOPPED)), still ? 0 : ms));
    win.reset(SCENES[i].cast);
    const steps = SCENES[i].steps(win);
    try {
      for (const { say, run, hold } of steps) {
        caption.textContent = still ? steps.map((s) => s.say).join(' ') : say;
        await run(wait);
        await wait(hold);
      }
      if (!still) play((i + 1) % SCENES.length);
    } catch (error) {
      if (error !== STOPPED) throw error;
    }
  }
  again.onclick = () => play(current);
  new IntersectionObserver(([seen]) => {
    if (seen.isIntersecting) play(current);
    else playing += 1; // stops it at its next wait
  }, { threshold: 0.4 }).observe(root);
}

// ---- How it works: the parts, each point putting its own in focus ----

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

function howItWorks(drawing, points) {
  machine(drawing, []);
  for (const point of points.children) {
    point.tabIndex = 0;
    const focus = () => machine(drawing, point.dataset.parts.split(' '));
    const blur = () => machine(drawing, []);
    point.addEventListener('pointerenter', focus);
    point.addEventListener('focus', focus);
    point.addEventListener('pointerleave', blur);
    point.addEventListener('blur', blur);
  }
}

// ---- The page as slides: a dot per slide, the current one marked ----

function deck() {
  const slides = [...document.querySelectorAll('.arch-slide')];
  const dots = slides.map((slide, i) => {
    const dot = el('button', 'arch-dot');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Slide ${i + 1}: ${$(slide, 'h1, h2').textContent}`);
    dot.onclick = () => slide.scrollIntoView({ behavior: still ? 'auto' : 'smooth' });
    return dot;
  });
  $(document, '[data-dots]').replaceChildren(...dots);
  const watch = new IntersectionObserver((seen) => {
    for (const entry of seen) if (entry.isIntersecting) dots.forEach((dot, i) => dot.toggleAttribute('aria-current', slides[i] === entry.target));
  }, { rootMargin: '-50% 0px -50% 0px' });
  for (const slide of slides) watch.observe(slide);
}

setOwner('You');
deck();
demo($(document, '[data-demo]'));
howItWorks($(document, '[data-machine]'), $(document, '[data-points]'));
