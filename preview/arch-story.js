// The architecture page (site/architecture.html): the blackboard agent
// runtime (docs/runtime-vision.md) as a few chapters, each a looping
// animation with one line under it on the idea it shows. Back and Next go
// from chapter to chapter. With reduced motion a chapter shows its last
// frame and holds still. preview/build.js bundles it into dist/preview.

/* global document, window */

import { agentFace, buddyColor, personFace, setBuddies, setOwner, setPeople } from '../web/faces.js';

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

// A member: its face over its name, and a tag over its face for what it did.
function actor(name, presence) {
  const node = el('div', 'arch-actor');
  const who = face(name, { person: name === 'You', presence });
  const tag = el('span', 'arch-tag');
  who.append(tag);
  node.append(who, el('span', '', name));
  return { node, face: who, tag };
}

// A doc drawn as lines, not words: a title and grey bars.
function paper(title, widths) {
  const node = el('div', 'arch-paper');
  node.append(el('b', '', title), ...widths.map(bar));
  return node;
}

function bar(width) {
  const node = el('i', 'arch-bar');
  node.style.width = `${width}%`;
  return node;
}

// ---- a diagram: straight arrows, and nodes at points on it ----

const NS = 'http://www.w3.org/2000/svg';
const f = (n) => n.toFixed(1);

// A straight arrow from `from` to `to`: the shaft and the head.
function arrow([x0, y0], [x1, y1]) {
  const k = Math.hypot(x1 - x0, y1 - y0);
  const [ux, uy] = [(x1 - x0) / k, (y1 - y0) / k];
  const wing = (side) => `${f(x1 - ux * 10 + side * uy * 6)} ${f(y1 - uy * 10 - side * ux * 6)}`;
  return [`M${f(x0)} ${f(y0)} L${f(x1)} ${f(y1)}`, `M${wing(1)} L${f(x1)} ${f(y1)} L${wing(-1)}`];
}

// An arrow from the edge of a box `size` round `from` to the face at `to`.
function between(from, [w, h], to) {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const k = Math.hypot(dx, dy);
  const edge = Math.min(w / 2 / Math.abs(dx || 1e-9), h / 2 / Math.abs(dy || 1e-9)) + 8 / k;
  return arrow([from[0] + dx * edge, from[1] + dy * edge], [to[0] - (dx / k) * 44, to[1] - (dy / k) * 44]);
}

// A cross at `at`, two strokes.
function cross([x, y]) {
  const s = 8;
  return [`M${f(x - s)} ${f(y - s)} L${f(x + s)} ${f(y + s)}`, `M${f(x + s)} ${f(y - s)} L${f(x - s)} ${f(y + s)}`];
}

// The diagram's paper, W×H, upright on a phone: an SVG for the lines,
// `ink` to draw one, and `place` to put a node at a point, `size` across.
function sketch(stage) {
  const [W, H] = stage.clientWidth < 560 ? [400, 520] : [760, 420];
  const box = el('div', 'arch-sketch');
  box.style.aspectRatio = `${W} / ${H}`;
  box.style.width = `min(100%, ${W}px)`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  box.append(svg);
  stage.append(box);
  const at = ([x, y]) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });
  const place = (node, point, size) => {
    node.classList.add('arch-at');
    Object.assign(node.style, at(point));
    if (size) Object.assign(node.style, { width: `${(size[0] / W) * 100}%`, height: `${(size[1] / H) * 100}%` });
    box.append(node);
    return node;
  };
  const ink = (d, className = 'arch-ink') => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    svg.append(path);
    return path;
  };
  return { W, H, at, place, ink, upright: W < H };
}

// One showing of one chapter, until the reader leaves it: waits and moves
// that throw STOPPED once it is over, and take no time with reduced motion.
class Scene {
  constructor(stage) {
    this.stage = stage;
    this.stopped = false;
    this.timers = new Set();
  }

  check() {
    if (this.stopped) throw STOPPED;
  }

  wait(ms) {
    this.check();
    if (still) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    }).then(() => this.check());
  }

  // `node` moves by `keyframes`, and stays there.
  move(node, keyframes, ms, easing = 'cubic-bezier(0.4, 0, 0.2, 1)') {
    this.check();
    return node.animate(keyframes, { duration: still ? 0 : ms, easing, fill: 'forwards' }).finished.then(() => this.check());
  }

  fade(node, to, ms = 300) {
    return this.move(node, [{ opacity: to ? 0 : 1 }, { opacity: to ? 1 : 0 }], ms);
  }

  // `path` draws itself, `part` of it.
  draw(path, ms, part = 1) {
    const length = path.getTotalLength();
    path.style.strokeDasharray = `${length} ${length}`;
    return this.move(path, [{ strokeDashoffset: length }, { strokeDashoffset: length * (1 - part) }], ms, 'ease-in-out');
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
  }
}

// ---- the chapters: each draws its scene, then plays it once; it loops ----

function cover(scene) {
  const pet = face('Clippy', { tag: 'button' });
  pet.classList.add('dl-pet');
  pet.type = 'button';
  pet.dataset.follow = '';
  pet.setAttribute('aria-label', 'Poke Clippy');
  const title = el('h1', '', 'People and agents on one board');
  const lead = el('p', '', 'How Ponjo’s agents run, in two contrasts: how you work with agents, and how a runtime decides when they run.');
  scene.stage.classList.add('arch-cover');
  scene.stage.append(pet, title, lead);
}

// Who watches the doc wears glasses (faces.js): the buddies on the blackboard.
const watching = (on) => setBuddies(['Clippy', 'Otto', 'Pip'].map((name) => ({ id: name, name, watching: on })));

// A bar of a doc, now `name`'s edit, in its colour.
function paint(node, name) {
  node.style.setProperty('--buddy', buddyColor(name));
  node.classList.add('arch-mine');
}

// Delegate, with two agents: each takes its own copy of the doc into its
// own session, works there unseen by the other, and hands back a result;
// you merge the two by hand.
async function delegate(scene) {
  watching(false);
  const s = sketch(scene.stage);
  const up = s.upright;
  const you = up ? [s.W / 2, s.H - 56] : [110, s.H / 2];
  const home = up ? [s.W / 2, s.H - 180] : [270, s.H / 2]; // the doc, by you
  const seats = up ? { Clippy: [100, 100], Otto: [300, 100] } : { Clippy: [s.W - 120, 110], Otto: [s.W - 120, 310] };
  const desk = (name) => (up ? [seats[name][0], 200] : [s.W - 290, seats[name][1]]); // its copy, in its session
  const SIZE = [120, 84];
  const me = actor('You', 'idle');
  s.place(me.node, you);
  s.place(paper('Doc', [80, 60, 70]), home, SIZE);
  const buddies = {};
  for (const name of ['Clippy', 'Otto']) {
    const room = s.place(el('div', 'arch-session'), up ? [seats[name][0], 160] : [s.W - 210, seats[name][1]], up ? [176, 240] : [300, 168]);
    room.append(el('span', '', `${name}’s session`));
    buddies[name] = actor(name, 'idle');
    s.place(buddies[name].node, seats[name]);
  }
  const slide = (node, from, to, ms) => scene.move(node, [s.at(from), s.at(to)], ms);

  await scene.wait(900);
  const copies = {};
  await Promise.all(['Clippy', 'Otto'].map((name) => {
    copies[name] = s.place(paper('Copy', [80, 60, 70]), home, SIZE);
    return slide(copies[name], home, desk(name), 800);
  }));
  for (const name of ['Clippy', 'Otto']) buddies[name].face.dataset.presence = 'working';
  await scene.wait(1200);
  paint(copies.Clippy.children[1], 'Clippy');
  await scene.wait(500);
  paint(copies.Otto.children[1], 'Otto');
  await scene.wait(900);
  for (const name of ['Clippy', 'Otto']) buddies[name].face.dataset.presence = 'idle';
  const back = (name, k) => (up ? [home[0] + k * 70, home[1] - 30] : [home[0] + 60, home[1] + k * 70]);
  await Promise.all(['Clippy', 'Otto'].map((name, i) => slide(copies[name], desk(name), back(name, i ? 1 : -1), 800)));
  me.face.dataset.presence = 'working';
  me.tag.textContent = 'Merging by hand';
  await scene.wait(3200);
}

// The blackboard: one doc, and everyone on it. The buddies watch it; you
// write, and both edit at once, each change on the doc as it lands.
async function blackboard(scene) {
  watching(true);
  const s = sketch(scene.stage);
  const middle = [s.W / 2, s.H / 2 - 10];
  const size = [260, 150];
  const seats = s.upright
    ? { Clippy: [s.W * 0.25, 52], Otto: [s.W * 0.75, 52], You: [s.W / 2, s.H - 50] }
    : { Clippy: [110, middle[1]], Otto: [s.W - 110, middle[1]], You: [s.W / 2, s.H - 50] };
  for (const at of Object.values(seats)) {
    const [d] = between(middle, size, at);
    s.ink(d, 'arch-ink arch-see');
  }
  const doc = s.place(paper('Doc', [90, 70]), middle, size);
  const who = Object.fromEntries(Object.entries(seats).map(([name, at]) => {
    const member = actor(name, 'idle');
    s.place(member.node, at);
    return [name, member];
  }));
  const [first, second] = [...doc.querySelectorAll('.arch-bar')];

  await scene.wait(900);
  who.You.face.dataset.presence = 'working';
  const mine = bar(50);
  paint(mine, 'You');
  doc.append(mine);
  await scene.move(mine, [{ width: '0%' }, { width: '50%' }], 900);
  who.Clippy.face.dataset.presence = 'working';
  who.Otto.face.dataset.presence = 'working';
  await scene.wait(1200);
  paint(first, 'Clippy');
  who.Clippy.tag.textContent = 'Edited';
  const more = bar(65);
  paint(more, 'You');
  doc.append(more);
  await scene.move(more, [{ width: '0%' }, { width: '65%' }], 900);
  paint(second, 'Otto');
  who.Otto.tag.textContent = 'Edited';
  for (const name of ['You', 'Clippy', 'Otto']) who[name].face.dataset.presence = 'idle';
  await scene.wait(3000);
}

// Triggered by events: an ask on the doc sends the buddy asked a message,
// and it runs when that arrives. Clippy's is lost, so its ask stays.
async function events(scene) {
  watching(false);
  const s = sketch(scene.stage);
  const middle = [s.W / 2, s.H / 2 - 10];
  const size = s.upright ? [260, 160] : [260, 150];
  const seats = s.upright
    ? { Clippy: [s.W * 0.25, 52], Otto: [s.W * 0.75, 52], You: [s.W / 2, s.H - 50] }
    : { Clippy: [110, middle[1]], Otto: [s.W - 110, middle[1]], You: [s.W / 2, s.H - 50] };
  const doc = s.place(paper('Doc', [90, 70]), middle, size);
  const who = Object.fromEntries(Object.entries(seats).map(([name, at]) => {
    const member = actor(name, name === 'You' ? 'idle' : 'away');
    s.place(member.node, at);
    return [name, member];
  }));
  const foot = el('p', 'arch-foot', 'A runtime that starts a run per event loses the work with the event: ');
  const link = el('a', '', 'even OpenHands drops requests when a poll fails');
  link.href = OPENHANDS;
  foot.append(link, '.');
  scene.stage.append(foot);

  // an ask on the doc: a highlighted line with the face of the buddy asked
  const ask = (name) => {
    const line = el('div', 'arch-ask');
    line.style.setProperty('--buddy', buddyColor(name));
    const small = face(name);
    line.append(bar(60), small);
    doc.append(line);
    return line;
  };
  const message = (name) => between(middle, size, seats[name]).map((d) => s.ink(d));

  await scene.wait(900);
  const otto = ask('Otto');
  await scene.fade(otto, 1);
  const [shaft, head] = message('Otto');
  await scene.draw(shaft, 600);
  await scene.draw(head, 150);
  who.Otto.face.dataset.presence = 'working';
  await scene.wait(1600);
  otto.classList.add('arch-edited');
  who.Otto.tag.textContent = 'Edited';
  who.Otto.face.dataset.presence = 'away';
  await Promise.all([scene.fade(shaft, 0), scene.fade(head, 0)]);

  await scene.wait(700);
  const clippy = ask('Clippy');
  await scene.fade(clippy, 1);
  const [lost, tip] = message('Clippy');
  tip.remove();
  await scene.draw(lost, 500, 0.45);
  const at = lost.getPointAtLength(lost.getTotalLength() * 0.45);
  for (const d of cross([at.x, at.y])) await scene.draw(s.ink(d, 'arch-ink arch-lost'), 150);
  await scene.move(lost, [{ opacity: 1 }, { opacity: 0.25 }], 300);
  await scene.wait(3500);
}

// [eyebrow, the idea in a line, the scene]
const CHAPTERS = [
  ['', 'Two contrasts, a picture each: Next goes on.', cover],
  ['How you work with agents · Delegate', 'Delegate: each agent takes its own copy of the work into a session of its own. They can’t see each other’s work, and you merge what comes back.', delegate],
  ['How you work with agents · Blackboard', 'Blackboard: there is one doc, and everyone works on it. Each change lands where everyone sees it at once: nothing is handed out, and nothing is merged back.', blackboard],
  ['How a runtime decides · Triggered by events', 'Triggered by events: each change sends a message, and an agent runs only when its message arrives. Lose a message, and the work is lost with it.', events],
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

// Chapter `i`: its scene played over and over, fresh each time, until the reader leaves.
async function open(i) {
  scene?.stop();
  current = i;
  const [eyebrow, idea, play] = CHAPTERS[i];
  title.textContent = eyebrow;
  caption.textContent = idea;
  dots.forEach((dot, j) => dot.toggleAttribute('aria-current', i === j));
  back.disabled = i === 0;
  next.textContent = i === 0 ? 'Start' : i === CHAPTERS.length - 1 ? 'Start over' : 'Next';
  const run = (scene = new Scene(stage));
  try {
    do {
      stage.replaceChildren();
      stage.className = 'arch-stage';
      await play(run);
    } while (!still && play !== cover);
  } catch (error) {
    if (error !== STOPPED) throw error;
  }
}

back.addEventListener('click', () => open(current - 1));
next.addEventListener('click', () => open((current + 1) % CHAPTERS.length));
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') next.click();
  if (e.key === 'ArrowLeft' && current > 0) open(current - 1);
});

open(0);
