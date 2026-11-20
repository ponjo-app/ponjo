// The architecture page (site/architecture.html): the blackboard agent
// runtime (docs/runtime-vision.md) as a few chapters, each a looping
// animation with one line under it on the idea it shows. Back and Next go
// from chapter to chapter. With reduced motion a chapter shows its last
// frame and holds still. preview/build.js bundles it into dist/preview.

/* global document, window */

import { INK, agentFace, buddyColor, personFace, setBuddies, setOwner, setPeople } from '../web/faces.js';

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STOPPED = Symbol('stopped');
const OPENHANDS = 'https://github.com/OpenHands/extensions/blob/cfd1d0f873c0d97e0a1c30093b34c6364a1141c0/skills/github-repo-monitor/scripts/main.py#L1012-L1042';

setBuddies(['Clippy', 'Otto', 'Pip'].map((name) => ({ id: name, name })));
setOwner('You');
setPeople(['You']);

const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const f = (n) => n.toFixed(1);

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

// A member's arms, legs and what it holds, drawn as by hand around its face
// in a 56×80 box (the face is the top 56×56), facing left; each part a pose
// of paths. Props are filled: a sheet of paper, a pen, a puff of smoke.
const LIMBS = {
  legs: {
    stand: ['M21 50 L20 71 L14 72', 'M35 50 L36 71 L42 72'],
    a: ['M21 50 L14 61 L19 69', 'M35 49 L44 57 L52 51'],
    b: ['M21 50 L19 62 L12 66', 'M35 50 L38 62 L45 66'],
  },
  arms: {
    stand: ['M7 31 L0 45', 'M49 31 L56 45'],
    a: ['M7 31 L-1 40 L1 47', 'M49 30 L57 25 L61 32'],
    b: ['M7 31 L0 25 L-4 31', 'M49 31 L56 40 L54 47'],
    carry: ['M7 33 L-4 37 L-7 30', 'M49 30 L57 25 L61 32'],
    write: ['M7 31 L0 45', 'M48 27 L58 6'],
    look: ['M7 31 L0 45', 'M49 30 L54 15'],
    tap: ['M7 31 L-10 28', 'M49 31 L56 45'],
    dazed: ['M7 33 L-1 46 L5 50', 'M49 28 L60 17 L55 6'],
  },
};
const PROPS = {
  carry: [['arch-prop', 'M-26 6 L-8 3 L-5 29 L-23 32 Z'], ['arch-prop-ink', 'M-21 11 L-12 10 M-20 16 L-11 15 M-20 21 L-13 20']],
  write: [['arch-prop arch-prop-pen', 'M55 -13 L62 -12 L62 2 L59 6 L55 2 Z']],
  look: [['', 'M54 15 L58 8'], ['arch-prop', 'M57 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0']],
  dazed: [['arch-prop', 'M58 -6 Q52 -8 56 -14 Q56 -22 64 -19 Q70 -25 74 -17 Q81 -15 77 -9 Q76 -2 69 -5 Q63 0 58 -6 Z']],
};
// Looks a face has only in these scenes, drawn in its own ink in place of
// its eyes and mouth, in its 100×100 box: [kind, path], a 'fill' solid, a
// 'drop' filled with paper. Running: brows down, eyes set, a frown and a
// drop of sweat. Dazed: worried brows, spiral eyes, a wobbly mouth.
// a spiral round (x, y): half turns that grow by `gap` each full turn
function spiral(x, y, turns = 2, gap = 3.4) {
  let [at, r] = [x - gap / 4, gap / 2];
  let d = `M${f(at)} ${y}`;
  for (let i = 0; i < turns * 2; i++) {
    at += (i % 2 ? -2 : 2) * r;
    d += ` A${f(r)} ${f(r)} 0 0 1 ${f(at)} ${y}`;
    r += gap / 2;
  }
  return d;
}
const LOOKS = {
  run: [
    ['line', 'M27 31 L42 37 M73 31 L58 37'],
    ['fill', 'M34 44 a3.5 4.5 0 1 0 7 0 a3.5 4.5 0 1 0 -7 0 M59 44 a3.5 4.5 0 1 0 7 0 a3.5 4.5 0 1 0 -7 0'],
    ['line', 'M43 62 Q50 55 57 62'],
    ['drop', 'M84 6 Q92 18 84 22 Q76 18 84 6 Z'],
  ],
  dazed: [
    ['line', 'M27 32 L40 28 M73 32 L60 28'],
    ['thin', `${spiral(36, 46)} ${spiral(62, 46)}`],
    ['line', 'M40 63 q5 -5 10 0 q5 5 10 0'],
  ],
};

const svg = (viewBox, className) => {
  const node = document.createElementNS(NS, 'svg');
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('class', className);
  return node;
};
const path = (d, className) => {
  const node = document.createElementNS(NS, 'path');
  node.setAttribute('d', d);
  if (className) node.setAttribute('class', className);
  return node;
};

// A member: its face with arms and legs, its name under it, and a tag over its
// face for what it did. pose() sets its arms, legs, look and the way it faces.
function actor(name, presence) {
  const node = el('div', 'arch-actor');
  const figure = el('div', 'arch-figure');
  figure.style.setProperty('--buddy', buddyColor(name));
  const limbs = svg('0 0 56 80', 'arch-limbs');
  const parts = {};
  for (const [kind, poses] of Object.entries(LIMBS)) {
    for (const [pose, ds] of Object.entries(poses)) {
      const g = document.createElementNS(NS, 'g');
      g.append(...ds.map((d) => path(d)));
      if (kind === 'arms') for (const [className, d] of PROPS[pose] ?? []) g.append(path(d, className));
      parts[`${kind}-${pose}`] = g;
      limbs.append(g);
    }
  }
  const looks = svg('0 0 100 100', 'arch-looks');
  for (const [look, strokes] of Object.entries(LOOKS)) {
    const g = document.createElementNS(NS, 'g');
    for (const [kind, d] of strokes) {
      const line = path(d, `arch-look-${kind}`);
      line.setAttribute(kind === 'fill' ? 'fill' : 'stroke', INK);
      g.append(line);
    }
    parts[`look-${look}`] = g;
    looks.append(g);
  }
  const who = name === 'Runtime' ? machine() : face(name, { person: name === 'You', presence });
  const tag = el('span', 'arch-tag');
  who.append(tag, looks);
  figure.append(limbs, who);
  node.append(figure, el('span', '', name));
  const member = { node, figure, face: who, tag, parts };
  pose(member, {});
  return member;
}

// The runtime's head: not a buddy's face, as it is no member, but a plain
// round one in ink, with dots for eyes.
function machine() {
  const head = el('span', 'pj-agent-face arch-machine');
  const drawn = svg('0 0 100 100', 'arch-machine-head');
  drawn.append(path('M6 50 a44 44 0 1 0 88 0 a44 44 0 1 0 -88 0'), path('M38 45 v2 M62 45 v2 M42 62 H58'));
  head.append(drawn);
  return head;
}

function pose(member, { arms = 'stand', legs = 'stand', look = null, right = false }) {
  for (const [key, g] of Object.entries(member.parts)) {
    g.style.display = [`arms-${arms}`, `legs-${legs}`, `look-${look}`].includes(key) ? '' : 'none';
  }
  if (look) member.figure.dataset.look = look;
  else delete member.figure.dataset.look;
  member.figure.classList.toggle('arch-right', right);
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
  const lead = el('p', '', 'How Ponjo’s agents work, in two contrasts: how you work with them, and when they run.');
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

// `member` runs (or walks, slower) along `points`: its legs and arms step,
// it bobs and leans the way it goes, and faces that way. `arms` and `look`
// hold while it goes ('carry' keeps its arms on what it holds); `carry` moves
// other nodes alongside it, each at an offset from it.
function run(scene, s, member, points, ms, { walk = false, arms = null, look = null, carry = [] } = {}) {
  const step = walk ? 340 : 220;
  const right = points.at(-1)[0] > points[0][0];
  const lean = (right ? 1 : -1) * (walk ? 3 : 10);
  let k = 0;
  const stride = () => pose(member, { legs: k ? 'a' : 'b', arms: arms ?? (k ? 'a' : 'b'), look, right });
  stride();
  const timer = still ? null : setInterval(() => {
    k ^= 1;
    stride();
  }, step / 2);
  if (!still) {
    member.figure.animate([
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: `translateY(${walk ? -3 : -7}px) rotate(${lean}deg)` },
      { transform: 'translateY(0) rotate(0deg)' },
    ], { duration: step, iterations: Math.max(1, Math.round(ms / step)) });
  }
  return Promise.all([
    scene.move(member.node, points.map((point) => s.at(point)), ms, 'linear'),
    ...carry.map(([node, [dx, dy]]) => scene.move(node, points.map(([x, y]) => s.at([x + dx, y + dy])), ms, 'linear')),
  ]).finally(() => {
    clearInterval(timer);
    pose(member, { arms: arms ?? 'stand', look, right });
  });
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

  // both pick theirs up and run it back to you at once, out of their doors,
  // and meet head on
  const near = up ? { Clippy: [meet[0] - 30, meet[1]], Otto: [meet[0] + 30, meet[1]] } : { Clippy: [meet[0], meet[1] - 34], Otto: [meet[0], meet[1] + 34] };
  for (const copy of Object.values(copies)) copy.style.opacity = '0'; // now in their hands
  await Promise.all(['Clippy', 'Otto'].map((name) => run(scene, s, buddies[name], [seat[name], table[name], door[name], near[name]], 1500, { arms: 'carry', look: 'run' })));
  const bang = svg('-24 -24 48 48', 'arch-spark');
  bang.append(path(spark([0, 0])));
  s.place(bang, meet, [72, 72]);
  scene.move(bang, [{ scale: 0, opacity: 1 }, { scale: 1.3, opacity: 1, offset: 0.4 }, { scale: 1, opacity: 0 }], 800).catch(() => {});
  const knocked = up ? { Clippy: [meet[0] - 70, meet[1] - 20], Otto: [meet[0] + 70, meet[1] - 20] } : { Clippy: [meet[0] + 24, meet[1] - 80], Otto: [meet[0] + 24, meet[1] + 80] };
  const strewn = up ? { Clippy: [home[0] - 34, home[1] - 34], Otto: [home[0] + 34, home[1] - 28] } : { Clippy: [home[0] + 8, home[1] - 30], Otto: [home[0] + 14, home[1] + 26] };
  for (const name of ['Clippy', 'Otto']) pose(buddies[name], { arms: 'dazed', look: 'dazed', right: up && name === 'Otto' });
  await Promise.all(['Clippy', 'Otto'].flatMap((name, i) => [
    scene.move(buddies[name].node, [s.at(near[name]), s.at(knocked[name])], 450, 'cubic-bezier(0.2, 1.4, 0.4, 1)'),
    scene.move(buddies[name].figure, [{ rotate: '0deg' }, { rotate: `${i ? 20 : -20}deg` }, { rotate: '0deg' }], 900),
    scene.move(copies[name], [{ ...s.at(near[name]), rotate: '0deg', opacity: 1, scale: 0.4 }, { ...s.at(strewn[name]), rotate: `${i ? 14 : -16}deg`, opacity: 1, scale: 1 }], 700, 'cubic-bezier(0.2, 0.9, 0.3, 1.1)'),
  ]));
  const yours = me.face.querySelector('.pj-avatar');
  yours.classList.add('pj-failed');
  await scene.wait(1400);
  yours.classList.remove('pj-failed');

  // they walk back to their rooms, and you are left to merge the two
  me.face.dataset.presence = 'working';
  me.tag.textContent = 'Merging by hand';
  await Promise.all(['Clippy', 'Otto'].map((name) => run(scene, s, buddies[name], [knocked[name], door[name], seat[name]], 1600, { walk: true })));
  for (const name of ['Clippy', 'Otto']) pose(buddies[name], {});
  await scene.wait(1800);
}

// The blackboard: one board, and everyone in front of it. The buddies watch
// it; all three walk up and write on it at once, each with a pen raised and
// each line in its writer's colour, then step back.
async function blackboard(scene) {
  watching(true);
  const s = sketch(scene.stage);
  const up = s.upright;
  const board = s.place(paper('Doc', [85, 60]), [s.W / 2, up ? 150 : 120], up ? [360, 220] : [520, 180]);
  board.classList.add('arch-board');
  const back = up ? s.H - 70 : s.H - 60; // where they stand, then where they write
  const close = up ? 330 : 285;
  const gap = up ? 120 : 170;
  const who = {};
  for (const [name, x] of [['Clippy', s.W / 2 - gap], ['You', s.W / 2], ['Otto', s.W / 2 + gap]]) {
    who[name] = actor(name, 'idle');
    who[name].x = x;
    s.place(who[name].node, [x, back]);
  }

  await scene.wait(800);
  await Promise.all(Object.values(who).map((member) => run(scene, s, member, [[member.x, back], [member.x, close]], 900, { walk: true })));
  const lines = [['You', 55], ['Clippy', 75], ['Otto', 45]].map(async ([name, width], i) => {
    const line = bar(width);
    paint(line, name);
    board.append(line);
    await scene.wait(i * 300);
    who[name].face.dataset.presence = 'working';
    pose(who[name], { arms: 'write' });
    if (!still) who[name].parts['arms-write'].animate([{ rotate: '-6deg' }, { rotate: '8deg' }, { rotate: '-6deg' }], { duration: 300, iterations: 6 });
    await scene.move(line, [{ width: '0%' }, { width: `${width}%` }], 1800);
    who[name].face.dataset.presence = 'idle';
    pose(who[name], {});
  });
  await Promise.all(lines);
  await scene.wait(600);
  await Promise.all(Object.values(who).map((member) => run(scene, s, member, [[member.x, close], [member.x, back]], 900, { walk: true })));
  pose(who.You, {});
  await scene.wait(2200);
}

// The doc in the middle, you and two buddies round it, asleep till woken;
// with `runtime`, the runtime too, which reads the doc (scan) and wakes
// whoever is due (wake).
function docScene(scene, { runtime = false } = {}) {
  const s = sketch(scene.stage);
  const up = s.upright;
  const middle = [s.W / 2, s.H / 2 + (runtime && !up ? 8 : -10)];
  const size = up ? [260, 160] : [260, 150];
  const seats = up
    ? { Clippy: [s.W * 0.25, 52], Otto: [s.W * 0.75, 52], You: [s.W * (runtime ? 0.28 : 0.5), s.H - 50] }
    : { Clippy: [110, middle[1]], Otto: [s.W - 110, middle[1]], You: [s.W / 2, s.H - 50] };
  if (runtime) seats.Runtime = up ? [s.W * 0.72, s.H - 50] : [s.W / 2, 52];
  const doc = s.place(paper('Doc', [90, 70]), middle, size);
  const who = Object.fromEntries(Object.entries(seats).map(([name, at]) => {
    const member = actor(name, name === 'You' ? 'idle' : 'away');
    s.place(member.node, at);
    return [name, member];
  }));
  const t = { s, doc, who, middle, size, seats };

  // a line of the doc with the small face of the buddy it is for: an ask, highlighted
  t.ask = (name, asked = true) => {
    const line = el('div', asked ? 'arch-ask' : 'arch-ask arch-quiet');
    line.style.setProperty('--buddy', buddyColor(name));
    line.append(bar(60), face(name));
    doc.append(line);
    return line;
  };
  t.message = (name) => between(middle, size, seats[name]).map((d) => s.ink(d));
  // the runtime reads the doc, top to bottom
  t.scan = async () => {
    pose(who.Runtime, { arms: 'look' });
    const band = el('i', 'arch-scan');
    doc.append(band);
    await scene.move(band, [{ top: '0%', opacity: 1 }, { top: '100%', opacity: 1, offset: 0.85 }, { top: '100%', opacity: 0 }], 1200, 'ease-in-out');
    band.remove();
    pose(who.Runtime, {});
  };
  // the runtime walks over to `name`, taps it awake, and walks back
  t.wake = async (name) => {
    const [from, to] = [seats.Runtime, seats[name]];
    const k = 1 - 80 / Math.hypot(to[0] - from[0], to[1] - from[1]);
    const near = up // upright, beside it, clear of the doc; else on the way to it
      ? [to[0] + (to[0] < s.W / 2 ? 72 : -72), to[1]]
      : [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
    await run(scene, s, who.Runtime, [from, near], 900, { walk: true });
    pose(who.Runtime, { arms: 'tap', right: to[0] > near[0] });
    await scene.wait(300);
    who[name].face.dataset.presence = 'working';
    who[name].tag.textContent = '';
    await scene.wait(300);
    await run(scene, s, who.Runtime, [near, from], 900, { walk: true });
    pose(who.Runtime, {});
  };
  // `name` does what `line` asks: the line turns its colour, and it sleeps again
  t.done = (name, line) => {
    line.classList.remove('arch-found', 'arch-quiet');
    line.classList.add('arch-edited');
    who[name].tag.textContent = 'Edited';
    who[name].face.dataset.presence = 'away';
  };
  return t;
}

// A message that does not arrive: drawn part of the way, then crossed out.
async function lose(scene, t, name) {
  const [lost, tip] = t.message(name);
  tip.remove();
  await scene.draw(lost, 500, 0.45);
  const at = lost.getPointAtLength(lost.getTotalLength() * 0.45);
  for (const d of cross([at.x, at.y])) await scene.draw(t.s.ink(d, 'arch-ink arch-lost'), 150);
  await scene.move(lost, [{ opacity: 1 }, { opacity: 0.25 }], 300);
}

// Triggered by events: an ask on the doc sends the buddy asked a message,
// and it runs when that arrives. Clippy's is lost, so its ask stays.
async function events(scene) {
  watching(false);
  const t = docScene(scene);
  const foot = el('p', 'arch-foot');
  const link = el('a', '', 'Even OpenHands drops requests when a poll fails.');
  link.href = OPENHANDS;
  foot.append(link);
  scene.stage.append(foot);

  await scene.wait(900);
  const otto = t.ask('Otto');
  await scene.fade(otto, 1);
  const [shaft, head] = t.message('Otto');
  await scene.draw(shaft, 600);
  await scene.draw(head, 150);
  t.who.Otto.face.dataset.presence = 'working';
  await scene.wait(1600);
  t.done('Otto', otto);
  await Promise.all([scene.fade(shaft, 0), scene.fade(head, 0)]);

  await scene.wait(700);
  await scene.fade(t.ask('Clippy'), 1);
  await lose(scene, t, 'Clippy');
  await scene.wait(3500);
}

// Reconciled from state: an ask on the doc only nudges the runtime to look
// again. The nudge is lost and the runtime restarts; starting, it reads the
// doc, finds Clippy's ask, and wakes Clippy all the same.
async function state(scene) {
  watching(false);
  const t = docScene(scene, { runtime: true });
  const { Runtime } = t.who;

  await scene.wait(900);
  const ask = t.ask('Clippy');
  await scene.fade(ask, 1);
  await lose(scene, t, 'Runtime');
  await scene.move(Runtime.figure, [{ rotate: '0deg' }, { rotate: '-90deg' }], 400, 'cubic-bezier(0.5, 0, 1, 1)');
  await scene.wait(1000);
  await scene.move(Runtime.figure, [{ rotate: '-90deg' }, { rotate: '0deg' }], 500, 'cubic-bezier(0.2, 1.4, 0.4, 1)');
  Runtime.tag.textContent = 'Restarted';
  await t.scan();
  Runtime.tag.textContent = '';
  ask.classList.add('arch-found');
  await t.wake('Clippy');
  await scene.wait(1200);
  t.done('Clippy', ask);
  await scene.wait(600);
  await t.scan();
  await scene.wait(2600);
}

// No orchestrator: you ask Otto; Otto's edit changes the line Clippy keeps,
// so the runtime, reading the doc, finds Clippy due next. Nobody sends
// Clippy anything.
async function relay(scene) {
  watching(false);
  const t = docScene(scene, { runtime: true });
  const kept = t.ask('Clippy', false); // the line Clippy keeps

  await scene.wait(900);
  const ask = t.ask('Otto');
  await scene.fade(ask, 1);
  await t.scan();
  ask.classList.add('arch-found');
  await t.wake('Otto');
  await scene.wait(1200);
  t.done('Otto', ask);
  kept.classList.remove('arch-quiet'); // Otto's edit leaves Clippy's line due
  await scene.wait(500);
  await t.scan();
  kept.classList.add('arch-found');
  await t.wake('Clippy');
  await scene.wait(1200);
  t.done('Clippy', kept);
  await scene.wait(500);
  await t.scan();
  await scene.wait(2600);
}

// [eyebrow, the idea in a line, the scene]
const CHAPTERS = [
  ['', 'Press Start.', cover],
  ['How you work · Delegate', 'Delegate: each agent works alone on its own copy. The copies clash, and you merge them by hand.', delegate],
  ['How you work · Blackboard', 'Blackboard: everyone works on one board and sees every change. Nothing to hand off, nothing to merge.', blackboard],
  ['When agents run · Events', 'Triggered by events: an agent runs only when a message reaches it. Lose the message, lose the work.', events],
  ['When agents run · State', 'Reconciled from state: the runtime reads the doc and wakes whoever is due. Lose a message, or restart: nothing is lost.', state],
  ['When agents run · No orchestrator', 'No orchestrator: one agent’s change is the next one’s cue. Nobody wires who goes next.', relay],
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
