// The architecture page (site/architecture.html): the blackboard agent
// runtime (docs/runtime-vision.md) as a few chapters, each a looping
// animation with one line under it on the idea it shows. Back and Next go
// from chapter to chapter. With reduced motion a chapter shows its last
// frame and holds still. preview/build.js bundles it into dist/preview.

/* global document, window */

import { agentFace, buddyColor, personFace, setBuddies, setOwner, setPeople } from '../web/faces.js';
import { icon } from '../web/icons.js';

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

// Stick arms and legs, drawn behind a face in a 56×80 box: [part, path].
const LIMBS = [
  ['arm-l', 'M10 34 L-2 45'],
  ['arm-r', 'M46 34 L60 47'],
  ['leg-l', 'M23 48 L20 73 L15 73'],
  ['leg-r', 'M33 48 L36 73 L41 73'],
];

// A member: its face on stick arms and legs, its name under it, and a tag
// over its face for what it did. Its figure takes data-move="run" or "walk"
// to swing its limbs, and data-writing to lift its pen.
function actor(name, presence) {
  const node = el('div', 'arch-actor');
  const figure = el('div', 'arch-figure');
  const limbs = document.createElementNS(NS, 'svg');
  limbs.setAttribute('viewBox', '0 0 56 80');
  limbs.setAttribute('class', 'arch-limbs');
  for (const [part, d] of LIMBS) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `arch-${part}`);
    limbs.append(path);
  }
  const who = face(name, { person: name === 'You', presence });
  const tag = el('span', 'arch-tag');
  who.append(tag);
  figure.append(limbs, who);
  node.append(figure, el('span', '', name));
  return { node, figure, face: who, tag };
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

// A spark where two things crash, round `at`, as a star of `points`.
function spark([x, y], points = 8) {
  const d = [...Array(points * 2)].map((_, i) => {
    const a = (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 ? 9 : 22;
    return `${i ? 'L' : 'M'}${f(x + Math.cos(a) * r)} ${f(y + Math.sin(a) * r)}`;
  });
  return `${d.join(' ')}Z`;
}

// `member` runs (or walks, slower and with smaller steps) along `points`,
// bobbing as it goes and leaning the way it goes; `with` runs alongside it,
// each with its own offset from it.
function run(scene, s, member, points, ms, { walk = false, carry = [] } = {}) {
  const step = walk ? 320 : 200;
  const lean = Math.sign(points.at(-1)[0] - points[0][0]) * (walk ? 3 : 10);
  member.figure.dataset.move = walk ? 'walk' : 'run';
  if (!still) {
    member.figure.animate([
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: `translateY(${walk ? -3 : -8}px) rotate(${lean}deg)` },
      { transform: 'translateY(0) rotate(0deg)' },
    ], { duration: step, iterations: Math.max(1, Math.round(ms / step)) });
  }
  return Promise.all([
    scene.move(member.node, points.map((point) => s.at(point)), ms, 'linear'),
    ...carry.map(([node, [dx, dy]]) => scene.move(node, points.map(([x, y]) => s.at([x + dx, y + dy])), ms, 'linear')),
  ]).finally(() => delete member.figure.dataset.move);
}

// Delegate, with two agents, each in a room of its own: a copy of the doc
// goes to each desk, each agent rewrites lines unseen by the other, then both
// run theirs back to you at once, and crash into each other on the way.
async function delegate(scene) {
  watching(false);
  const s = sketch(scene.stage);
  const up = s.upright;
  const you = up ? [s.W / 2, s.H - 46] : [90, s.H / 2];
  const home = up ? [s.W / 2, s.H - 150] : [225, s.H / 2]; // your desk, with the doc
  const meet = up ? [s.W / 2, 292] : [335, s.H / 2]; // where they crash
  const ROOM = up ? [176, 230] : [290, 170];
  const rooms = up ? { Clippy: [100, 130], Otto: [300, 130] } : { Clippy: [s.W - 175, 108], Otto: [s.W - 175, 312] };
  const SIZE = [104, 74];
  const desk = (at) => s.place(el('div', 'arch-desk'), [at[0], at[1] + SIZE[1] / 2 + 6], [SIZE[0] + 24, 6]);
  const me = actor('You', 'idle');
  s.place(me.node, you);
  desk(home);
  s.place(paper('Doc', [80, 60, 70]), home, SIZE);
  const buddies = {};
  const door = {};
  const seat = {};
  const table = {};
  for (const [name, [x, y]] of Object.entries(rooms)) {
    const room = s.place(el('div', 'arch-room'), [x, y], ROOM);
    room.dataset.door = up ? 'bottom' : 'left';
    room.append(el('span', '', `${name}’s room`));
    door[name] = up ? [x, y + ROOM[1] / 2] : [x - ROOM[0] / 2, y];
    table[name] = up ? [x, y + 4] : [x - 60, y];
    seat[name] = up ? [x, y - 66] : [x + 84, y];
    desk(table[name]);
    buddies[name] = actor(name, 'idle');
    s.place(buddies[name].node, seat[name]);
  }
  const slide = (node, points, ms, turn = 0, easing) => scene.move(node, points.map((point, i) => ({ ...s.at(point), rotate: `${i === points.length - 1 ? 0 : turn}deg` })), ms, easing);
  // an agent rewrites line `i` of its copy: the line goes, and comes back in its colour
  const rewrite = async (copy, name, i) => {
    const line = copy.children[i];
    const width = line.style.width;
    await scene.move(line, [{ width }, { width: '0%' }], 250);
    paint(line, name);
    await scene.move(line, [{ width: '0%' }, { width }], 600);
  };

  // the copies go out, one to each desk
  await scene.wait(700);
  const copies = {};
  await Promise.all(['Clippy', 'Otto'].map(async (name, i) => {
    await scene.wait(i * 200);
    copies[name] = s.place(paper('Copy', [80, 60, 70]), home, SIZE);
    await slide(copies[name], [home, door[name], table[name]], 900, i ? 10 : -10);
  }));
  for (const name of ['Clippy', 'Otto']) buddies[name].face.dataset.presence = 'working';
  await Promise.all([
    rewrite(copies.Clippy, 'Clippy', 1).then(() => rewrite(copies.Clippy, 'Clippy', 2)),
    scene.wait(300).then(() => rewrite(copies.Otto, 'Otto', 3)).then(() => rewrite(copies.Otto, 'Otto', 1)),
  ]);
  for (const name of ['Clippy', 'Otto']) buddies[name].face.dataset.presence = 'idle';
  await scene.wait(500);

  // both run theirs back to you at once, out of their doors, held over their
  // heads, and meet head on
  const hold = [0, -80];
  const face = up ? { Clippy: [meet[0] - 30, meet[1]], Otto: [meet[0] + 30, meet[1]] } : { Clippy: [meet[0], meet[1] - 34], Otto: [meet[0], meet[1] + 34] };
  for (const copy of Object.values(copies)) copy.style.scale = '0.7';
  await Promise.all(['Clippy', 'Otto'].map((name) => run(scene, s, buddies[name], [seat[name], table[name], door[name], face[name]], 1500, { carry: [[copies[name], hold]] })));
  const bang = document.createElementNS(NS, 'svg');
  bang.setAttribute('viewBox', '-24 -24 48 48');
  bang.append(document.createElementNS(NS, 'path'));
  bang.firstChild.setAttribute('d', spark([0, 0]));
  s.place(bang, meet, [72, 72]).classList.add('arch-spark');
  scene.move(bang, [{ scale: 0, opacity: 1 }, { scale: 1.3, opacity: 1, offset: 0.4 }, { scale: 1, opacity: 0 }], 800).catch(() => {});
  const avatars = [me, buddies.Clippy, buddies.Otto].map((member) => member.face.querySelector('.pj-avatar'));
  for (const avatar of avatars.slice(1)) avatar.classList.add('pj-failed');
  const knocked = up ? { Clippy: [meet[0] - 70, meet[1] - 20], Otto: [meet[0] + 70, meet[1] - 20] } : { Clippy: [meet[0] + 24, meet[1] - 80], Otto: [meet[0] + 24, meet[1] + 80] };
  const strewn = up ? { Clippy: [home[0] - 34, home[1] - 34], Otto: [home[0] + 34, home[1] - 28] } : { Clippy: [home[0] + 8, home[1] - 30], Otto: [home[0] + 14, home[1] + 26] };
  await Promise.all(['Clippy', 'Otto'].flatMap((name, i) => [
    scene.move(buddies[name].node, [s.at(face[name]), s.at(knocked[name])], 450, 'cubic-bezier(0.2, 1.4, 0.4, 1)'),
    scene.move(buddies[name].figure, [{ rotate: '0deg' }, { rotate: `${i ? 25 : -25}deg` }, { rotate: '0deg' }], 900),
    scene.move(copies[name], [{ ...s.at([face[name][0] + hold[0], face[name][1] + hold[1]]), rotate: '0deg', scale: 0.7 }, { ...s.at(strewn[name]), rotate: `${i ? 14 : -16}deg`, scale: 1 }], 700, 'cubic-bezier(0.2, 0.9, 0.3, 1.1)'),
  ]));
  avatars[0].classList.add('pj-failed');
  await scene.wait(700);
  for (const avatar of avatars) avatar.classList.remove('pj-failed');

  // they walk back to their rooms, and you are left to merge the two
  me.face.dataset.presence = 'working';
  me.tag.textContent = 'Merging by hand';
  await Promise.all(['Clippy', 'Otto'].map((name) => run(scene, s, buddies[name], [knocked[name], door[name], seat[name]], 1600, { walk: true })));
  await scene.wait(1800);
}

// The blackboard: one board, and everyone in front of it with a pen. The
// buddies watch it; all three walk up and write on it at once, each line in
// its writer's colour, then step back.
async function blackboard(scene) {
  watching(true);
  const s = sketch(scene.stage);
  const up = s.upright;
  const board = s.place(paper('Doc', [85, 60]), [s.W / 2, up ? 150 : 120], up ? [360, 220] : [520, 180]);
  board.classList.add('arch-board');
  const back = up ? s.H - 70 : s.H - 60; // where they stand, then where they write
  const close = up ? 330 : 280;
  const gap = up ? 120 : 170;
  const who = {};
  for (const [name, x] of [['Clippy', s.W / 2 - gap], ['You', s.W / 2], ['Otto', s.W / 2 + gap]]) {
    who[name] = actor(name, 'idle');
    who[name].x = x;
    const pen = el('span', 'arch-pen');
    pen.append(icon('pencil'));
    pen.style.setProperty('--buddy', buddyColor(name));
    who[name].figure.append(pen);
    who[name].pen = pen;
    s.place(who[name].node, [x, back]);
  }

  await scene.wait(800);
  await Promise.all(Object.values(who).map((member) => run(scene, s, member, [[member.x, back], [member.x, close]], 900, { walk: true })));
  const lines = [['You', 55], ['Clippy', 75], ['Otto', 45]].map(async ([name, width], i) => {
    const line = bar(width);
    paint(line, name);
    board.append(line);
    who[name].face.dataset.presence = 'working';
    who[name].figure.toggleAttribute('data-writing', true);
    await scene.wait(i * 300);
    if (!still) who[name].pen.animate([{ rotate: '-12deg' }, { rotate: '14deg' }, { rotate: '-12deg' }], { duration: 260, iterations: 7 });
    await scene.move(line, [{ width: '0%' }, { width: `${width}%` }], 1800);
    who[name].face.dataset.presence = 'idle';
    who[name].figure.toggleAttribute('data-writing', false);
  });
  await Promise.all(lines);
  await scene.wait(600);
  await Promise.all(Object.values(who).map((member) => run(scene, s, member, [[member.x, close], [member.x, back]], 900, { walk: true })));
  await scene.wait(2200);
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
  ['How you work with agents · Delegate', 'Delegate: each agent works on its own copy, in a room of its own. Neither sees the other’s work, so what they hand back can clash, and you merge it by hand.', delegate],
  ['How you work with agents · Blackboard', 'Blackboard: everyone works in front of one board. Each change lands where everyone sees it at once: nothing is handed out, and nothing is merged back.', blackboard],
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
