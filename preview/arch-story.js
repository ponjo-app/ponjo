// The architecture page (site/architecture.html): the blackboard agent
// runtime (docs/runtime-vision.md) as a story in chapters. Clippy goes from
// scene to scene; in each the reader does one thing and sees what follows.
// A chapter is a script: say a line, wait for the reader, move things.
// Next plays the rest of a chapter at once, and a second Next goes on.
// preview/build.js bundles it into dist/preview.

/* global document, window */

import { agentFace, personFace, setBuddies, setOwner, setPeople } from '../web/faces.js';

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STOPPED = Symbol('stopped');
const OPENHANDS = 'https://github.com/OpenHands/extensions/blob/cfd1d0f873c0d97e0a1c30093b34c6364a1141c0/skills/github-repo-monitor/scripts/main.py#L1012-L1042';

setBuddies(['Clippy', 'Otto', 'Pip'].map((name) => ({ id: name, name })));
setOwner('You');
setPeople(['You']);

const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

function button(text, className = 'pj-secondary') {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

// A face in the wrapper that says its state (life.js): 'idle', 'working' or 'away'.
function face(name, { person = false, presence = 'idle', tag = 'span' } = {}) {
  const wrap = el(tag, 'pj-agent-face');
  wrap.dataset.presence = presence;
  const avatar = el('span', `pj-avatar${person ? '' : ' pj-avatar-agent'}`);
  avatar.append(person ? personFace(name) : agentFace(name));
  wrap.append(avatar);
  return wrap;
}

// A member: its face over its name.
function actor(name, options) {
  const node = el('div', 'arch-actor');
  node.append(face(name, options), el('span', '', name));
  return node;
}

const centre = (node) => {
  const r = node.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};

// ---- a diagram: boxes, straight arrows, members at points on it ----

const NS = 'http://www.w3.org/2000/svg';
const f = (n) => n.toFixed(1);

// A straight arrow from `from` to `to`: the shaft and the head.
function arrow([x0, y0], [x1, y1]) {
  const k = Math.hypot(x1 - x0, y1 - y0);
  const [ux, uy] = [(x1 - x0) / k, (y1 - y0) / k];
  const wing = (side) => `${f(x1 - ux * 10 + side * uy * 6)} ${f(y1 - uy * 10 - side * ux * 6)}`;
  return [`M${f(x0)} ${f(y0)} L${f(x1)} ${f(y1)}`, `M${wing(1)} L${f(x1)} ${f(y1)} L${wing(-1)}`];
}

// A cross at `at`, two strokes.
function cross([x, y]) {
  const s = 8;
  return [`M${f(x - s)} ${f(y - s)} L${f(x + s)} ${f(y + s)}`, `M${f(x + s)} ${f(y - s)} L${f(x - s)} ${f(y + s)}`];
}

// A box `w`×`h` round `at`.
function rect(svg, [x, y], w, h) {
  const node = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 10, class: 'arch-box' })) node.setAttribute(k, v);
  svg.append(node);
  return node;
}

function line(svg, d, className = 'arch-ink') {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', className);
  svg.append(path);
  return path;
}

// The diagram's paper, W×H, upright on a phone: an SVG for the lines, and
// `place` to put a node at a point on it.
function sketch(stage) {
  const [W, H] = stage.clientWidth < 560 ? [400, 520] : [760, 420];
  const box = el('div', 'arch-sketch');
  box.style.aspectRatio = `${W} / ${H}`;
  box.style.width = `min(100%, ${W}px)`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  box.append(svg);
  stage.append(box);
  const place = (node, [x, y]) => {
    node.classList.add('arch-at');
    node.style.left = `${(x / W) * 100}%`;
    node.style.top = `${(y / H) * 100}%`;
    box.append(node);
    return node;
  };
  return { svg, place, W, H };
}

// One run of one chapter. Its waits end at once when hurried, and throw
// STOPPED once the reader has left the chapter.
class Scene {
  constructor(stage, caption) {
    this.stage = stage;
    this.caption = caption;
    this.fast = still;
    this.stopped = false;
    this.ends = new Set(); // what ends each pending wait
    this.moves = new Set();
  }

  check() {
    if (this.stopped) throw STOPPED;
  }

  say(text) {
    this.check();
    this.caption.textContent = text;
  }

  // Resolves when `end` is called, by the wait itself or by hurry().
  pending(start) {
    this.check();
    return new Promise((resolve) => {
      const end = () => {
        this.ends.delete(end);
        resolve();
      };
      this.ends.add(end);
      if (this.fast) end();
      else start(end);
    }).then(() => this.check());
  }

  wait(ms) {
    return this.pending((end) => setTimeout(end, ms));
  }

  // The reader's move: a click on `node`, which then goes.
  click(node) {
    return this.pending((end) => node.addEventListener('click', end, { once: true })).then(() => node.remove());
  }

  // The reader drags `node` and lets go anywhere, or clicks it; where it was let go.
  drag(node) {
    let at = null;
    return this.pending((end) => {
      let from = null;
      node.addEventListener('pointerdown', (e) => {
        from = [e.clientX, e.clientY];
        node.setPointerCapture(e.pointerId);
      });
      node.addEventListener('pointermove', (e) => {
        if (from) node.style.translate = `${e.clientX - from[0]}px ${e.clientY - from[1]}px`;
      });
      node.addEventListener('pointerup', () => {
        at = centre(node);
        node.style.translate = '';
        end();
      });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') end();
      });
    }).then(() => at);
  }

  // `node` moves by `keyframes` (transforms from where it is), and stays there.
  move(node, keyframes, ms, easing = 'cubic-bezier(0.4, 0, 0.2, 1)') {
    this.check();
    const move = node.animate(keyframes, { duration: this.fast ? 0 : ms, easing, fill: 'forwards' });
    this.moves.add(move);
    return move.finished.then(() => this.check(), () => this.check());
  }

  // `node`, placed at `from` ([x, y] on the page) and moved to `to`, a node or a point,
  // stopping `part` of the way there, as small as `scale` and as faint as `opacity`.
  fly(node, from, to, ms, { part = 1, scale = 1, opacity = 1 } = {}) {
    const [x0, y0] = from;
    const [x1, y1] = Array.isArray(to) ? to : centre(to);
    const [sx, sy] = centre(node);
    const at = (k) => `translate(${x0 + (x1 - x0) * k - sx}px, ${y0 + (y1 - y0) * k - sy}px)`;
    return this.move(node, [{ transform: at(0) }, { transform: `${at(part)} scale(${scale})`, opacity }], ms);
  }

  // `path` draws itself, `part` of it.
  draw(path, ms, part = 1) {
    const length = path.getTotalLength();
    path.style.strokeDasharray = `${length} ${length}`;
    return this.move(path, [{ strokeDashoffset: length }, { strokeDashoffset: length * (1 - part) }], ms, 'ease-in-out');
  }

  // The rest of the chapter, at once.
  hurry() {
    this.fast = true;
    for (const end of [...this.ends]) end();
    for (const move of this.moves) move.finish();
  }

  stop() {
    this.stopped = true;
    for (const end of [...this.ends]) end();
  }
}

// ---- the chapters ----

async function cover(scene) {
  const pet = face('Clippy', { tag: 'button' });
  pet.classList.add('dl-pet');
  pet.type = 'button';
  pet.dataset.follow = '';
  pet.setAttribute('aria-label', 'Poke Clippy');
  const title = el('h1', '', 'People and agents on one board');
  const lead = el('p', '', 'How Ponjo’s agents run: when the board changes, the runtime works out who is due; each agent decides whether to act, and the board’s writer decides what lands.');
  scene.stage.classList.add('arch-cover');
  scene.stage.append(pet, title, lead);
  scene.say('This is Clippy, an AI buddy. Poke it, then press Start.');
}

async function delegate(scene) {
  const row = el('div', 'arch-row');
  const you = actor('You', { person: true });
  const clippy = actor('Clippy');
  const task = el('div', 'arch-task');
  task.tabIndex = 0;
  task.setAttribute('role', 'button');
  task.setAttribute('aria-label', 'Give the task to Clippy');
  const what = el('b', '', 'Write the launch plan');
  const state = el('span', '', 'A task');
  task.append(what, state);
  row.append(you, task, clippy);
  scene.stage.append(row);
  const clippyFace = clippy.querySelector('.pj-agent-face');

  scene.say('Today you delegate: give an agent a task, wait, and review what comes back. Drag the task to Clippy.');
  const from = await scene.drag(task);
  await scene.fly(task, from ?? centre(task), clippyFace, 500, { scale: 0.2, opacity: 0 });
  clippyFace.dataset.presence = 'working';
  scene.say('Clippy takes it into its own session and works on it alone. You wait.');
  await scene.wait(2600);

  clippyFace.dataset.presence = 'idle';
  what.textContent = 'Launch plan';
  state.textContent = 'A draft, for you to review';
  await scene.move(task, [{ transform: 'none', opacity: 1 }], 500);
  scene.say('It hands back the result. Review it.');
  const approve = button('Approve');
  scene.stage.append(approve);
  await scene.click(approve);

  state.textContent = 'Approved';
  task.classList.add('arch-done');
  scene.say('One agent, one task: delegating works. But what if the work is shared?');
}

// The table: the dealer in a box, the four round it, the dealer's messages
// arrows to them.
async function table(scene) {
  const box = sketch(scene.stage);
  const { W, H } = box;
  const ink = (d, className) => line(box.svg, d, className);
  const MIDDLE = [W / 2, H / 2];
  const [bw, bh] = [W < 500 ? 120 : 160, 72]; // the dealer's box
  const SEATS = { Otto: [W / 2, 50], Pip: [W - 80, H / 2], You: [W / 2, H - 50], Clippy: [80, H / 2] };
  const seats = Object.fromEntries(Object.entries(SEATS).map(([name, at]) => {
    const node = box.place(actor(name, { person: name === 'You', presence: name === 'You' ? 'idle' : 'away' }), at);
    const tag = el('span', 'arch-tag');
    node.querySelector('.pj-agent-face').append(tag);
    return [name, { node, face: node.querySelector('.pj-agent-face'), tag }];
  }));
  const dealer = el('div', 'arch-label', 'Dealer');
  const action = el('p', 'arch-status');
  scene.stage.append(action);

  scene.say('Now the work is shared: you and three buddies around one table, and a dealer who says whose turn it is.');
  await scene.move(rect(box.svg, MIDDLE, bw, bh), [{ opacity: 0 }, { opacity: 1 }], 400);
  box.place(dealer, MIDDLE);
  scene.say('Here a buddy runs only when a message tells it to. Start the hand.');
  const deal = box.place(button('Start the hand'), [W / 2, H / 2 + bh / 2 + 32]);
  await scene.click(deal);

  // The dealer's message to `name`: an arrow from the box's edge to its face.
  const toward = (name) => {
    const [x, y] = SEATS[name];
    const [dx, dy] = [x - MIDDLE[0], y - MIDDLE[1]];
    const k = Math.hypot(dx, dy);
    const edge = Math.min(bw / 2 / Math.abs(dx || 1e-9), bh / 2 / Math.abs(dy || 1e-9)) + 8 / k;
    const [shaft, head] = arrow([MIDDLE[0] + dx * edge, MIDDLE[1] + dy * edge], [x - (dx / k) * 44, y - (dy / k) * 44]);
    return [ink(shaft), ink(head)];
  };
  const message = async (name, play) => {
    action.textContent = `Action on: ${name}`;
    const [shaft, head] = toward(name);
    await scene.draw(shaft, 600);
    await scene.draw(head, 150);
    seats[name].face.dataset.presence = 'working';
    await scene.wait(1200);
    seats[name].tag.textContent = play;
    seats[name].face.dataset.presence = 'away';
    await Promise.all([shaft, head].map((path) => scene.move(path, [{ opacity: 1 }, { opacity: 0 }], 400)));
  };
  await message('Otto', 'Call');
  await message('Pip', 'Raise 40');

  action.textContent = 'Action on: Clippy';
  const [shaft, head] = toward('Clippy');
  head.remove();
  await scene.draw(shaft, 500, 0.45);
  scene.say('Clippy is next, and its message is on the way. Lose it.');
  const lose = box.place(button('Lose the message'), [W / 2, H / 2 + bh / 2 + 32]);
  await scene.click(lose);

  const at = shaft.getPointAtLength(shaft.getTotalLength() * 0.45);
  await scene.move(shaft, [{ opacity: 1 }, { opacity: 0.25 }], 300);
  for (const d of cross([at.x, at.y])) await scene.draw(ink(d, 'arch-ink arch-lost'), 150);
  scene.say('The message is lost, so Clippy never runs, and nothing looks at the table again. The hand is stuck.');
  const foot = el('p', 'arch-foot', 'A runtime that starts a run per event loses the work with the event: ');
  const link = el('a', '', 'even OpenHands drops requests when a poll fails');
  link.href = OPENHANDS;
  foot.append(link, '.');
  scene.stage.append(foot);
  let waited = 0;
  const tick = setInterval(() => {
    if (scene.stopped) return clearInterval(tick);
    waited += 1;
    action.textContent = `Action on: Clippy · waiting ${Math.floor(waited / 60)}:${String(waited % 60).padStart(2, '0')}`;
  }, 1000);
}

const CHAPTERS = [
  ['', cover],
  ['1 · Delegate', delegate],
  ['2 · A shared table', table],
];

// ---- the story: a chapter at a time, with Back, Next and a dot for each ----

const stage = document.querySelector('[data-stage]');
const caption = document.querySelector('[data-say]');
const title = document.querySelector('[data-title]');
const back = document.querySelector('[data-back]');
const next = document.querySelector('[data-next]');
const dots = CHAPTERS.map(([name], i) => {
  const dot = button('', 'arch-dot');
  dot.setAttribute('aria-label', name || 'Start');
  dot.addEventListener('click', () => open(i));
  return dot;
});
document.querySelector('[data-dots]').append(...dots);

let current = 0;
let scene = null;

function open(i) {
  scene?.stop();
  current = i;
  stage.replaceChildren();
  stage.className = 'arch-stage';
  caption.textContent = '';
  title.textContent = CHAPTERS[i][0];
  dots.forEach((dot, j) => dot.toggleAttribute('aria-current', i === j));
  back.disabled = i === 0;
  next.textContent = i === 0 ? 'Start' : i === CHAPTERS.length - 1 ? 'Start over' : 'Next';
  next.className = 'pj-secondary';
  const run = (scene = new Scene(stage, caption));
  CHAPTERS[i][1](run).then(() => {
    run.done = true;
    if (!run.stopped) next.className = 'pj-primary';
  }, (error) => {
    if (error !== STOPPED) throw error;
  });
}

back.addEventListener('click', () => open(current - 1));
next.addEventListener('click', () => {
  if (!scene.done) scene.hurry();
  else open((current + 1) % CHAPTERS.length);
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, [role="button"]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') next.click();
  if (e.key === 'ArrowLeft' && current > 0) open(current - 1);
});

open(0);
