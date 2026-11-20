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
    tap: ['M7 31 L-10 28', 'M49 31 L56 45'],
    dazed: ['M7 33 L-1 46 L5 50', 'M49 28 L60 17 L55 6'],
    baton: ['M7 33 L-4 37 L-7 31', 'M49 30 L57 25 L61 32'],
    reach: ['M7 31 L-12 30', 'M49 31 L56 45'],
  },
};
const PROPS = {
  carry: [['arch-prop', 'M-26 6 L-8 3 L-5 29 L-23 32 Z'], ['arch-prop-ink', 'M-21 11 L-12 10 M-20 16 L-11 15 M-20 21 L-13 20']],
  write: [['arch-prop arch-prop-pen', 'M55 -13 L62 -12 L62 2 L59 6 L55 2 Z']],
  dazed: [['arch-prop', 'M58 -6 Q52 -8 56 -14 Q56 -22 64 -19 Q70 -25 74 -17 Q81 -15 77 -9 Q76 -2 69 -5 Q63 0 58 -6 Z']],
  baton: [['arch-prop', 'M-19 25 H-5 V31 H-19 Z']],
  reach: [['arch-prop', 'M-27 27 H-13 V33 H-27 Z']],
};
// A headset over a face, in its 100×100 box, and the waves at its ear when it is called.
const HEADSET = ['M10 52 Q50 -32 90 52', 'M0 42 h14 v22 h-14 Z M86 42 h14 v22 h-14 Z'];
const WAVES = 'M108 44 q7 9 0 18 M116 37 q13 16 0 32';
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
function actor(name, presence, { headset = false } = {}) {
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
  if (headset) {
    looks.append(path(HEADSET[0], 'arch-headset'), path(HEADSET[1], 'arch-headset-cups'));
    parts.waves = path(WAVES, 'arch-waves');
    parts.waves.style.display = 'none';
    looks.append(parts.waves);
  }
  const who = face(name, { person: name === 'You', presence });
  const tag = el('span', 'arch-tag');
  who.append(tag, looks);
  figure.append(limbs, who);
  node.append(figure, el('span', '', name));
  const member = { node, figure, face: who, tag, parts };
  pose(member, {});
  return member;
}

function pose(member, { arms = 'stand', legs = 'stand', look = null, right = false }) {
  for (const [key, g] of Object.entries(member.parts)) {
    if (key === 'waves') continue;
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

// ---- a scene: lines in an SVG, and nodes at points on it ----

const NS = 'http://www.w3.org/2000/svg';

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
  const title = el('h1', '', 'Blackboard Multi-agent System');
  const lead = el('p', '', 'How Ponjo’s agents work, in two contrasts: how you work with them, and when they run.');
  scene.stage.classList.add('arch-cover');
  scene.stage.append(pet, title, lead);
}
cover.once = true;

// A page that states what the scenes after it show: the claim, then what it
// replaces, quieter.
function point(claim, instead) {
  const page = (scene) => {
    const line = el('h2');
    line.append(el('span', '', claim), el('span', 'arch-instead', instead));
    scene.stage.classList.add('arch-point');
    scene.stage.append(line);
  };
  page.once = true;
  return page;
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

// Motion, after the old principles of animation: a figure crouches before it
// runs (anticipation), speeds up and slows down on its way (ease in and out),
// leans on past its stop and settles (follow-through), squashes on a hit and
// stretches on a jump; its scale and lean are from its feet.
const EASE_RUN = 'cubic-bezier(0.45, 0, 0.25, 1)';
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // past the mark, and back

// `member` hops: stretched on the way up, squashed as it lands.
function hop(scene, member, height = 10, ms = 480) {
  return scene.move(member.figure, [
    { translate: '0 0', scale: '1 1' },
    { translate: `0 -${height}px`, scale: '0.9 1.14', offset: 0.35 },
    { translate: '0 0', scale: '1.12 0.88', offset: 0.75 },
    { translate: '0 0', scale: '1 1' },
  ], ms, 'ease-out');
}

// `member` runs (or walks, slower) along `points`: it crouches first if it
// runs from a standstill (`ready`), its legs and arms step, it bobs and leans
// the way it goes and faces that way, and, with `stop`, slows to a halt and
// settles; without, it is still going full tilt at the end (into a crash).
// `arms` and `look` hold while it goes; `carry` moves other nodes alongside
// it, each at an offset from it.
async function run(scene, s, member, points, ms, { walk = false, arms = null, look = null, carry = [], ready = !walk, stop = true } = {}) {
  const step = walk ? 340 : 220;
  const right = points.at(-1)[0] > points[0][0];
  const lean = (right ? 1 : -1) * (walk ? 3 : 10);
  const { figure } = member;
  if (ready) {
    pose(member, { arms, look, right });
    await scene.move(figure, [{ scale: '1 1', rotate: '0deg' }, { scale: '1.12 0.86', rotate: `${-lean * 0.8}deg` }], 220, 'ease-out');
    scene.move(figure, [{ scale: '1.12 0.86', rotate: `${-lean * 0.8}deg` }, { scale: '0.94 1.08', rotate: `${lean}deg`, offset: 0.4 }, { scale: '1 1', rotate: '0deg' }], 300, 'ease-out').catch(() => {});
  }
  let k = 0;
  const stride = () => pose(member, { legs: k ? 'a' : 'b', arms: arms ?? (k ? 'a' : 'b'), look, right });
  stride();
  const timer = still ? null : setInterval(() => {
    k ^= 1;
    stride();
  }, step / 2);
  if (!still) {
    figure.animate([
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: `translateY(${walk ? -3 : -7}px) rotate(${lean}deg)` },
      { transform: 'translateY(0) rotate(0deg)' },
    ], { duration: step, iterations: Math.max(1, Math.round(ms / step)) });
  }
  const easing = stop ? EASE_RUN : 'cubic-bezier(0.4, 0, 1, 1)';
  try {
    await Promise.all([
      scene.move(member.node, points.map((point) => s.at(point)), ms, easing),
      ...carry.map(([node, [dx, dy]]) => scene.move(node, points.map(([x, y]) => s.at([x + dx, y + dy])), ms, easing)),
    ]);
  } finally {
    clearInterval(timer);
    pose(member, { arms: arms ?? 'stand', look, right });
  }
  if (stop && !walk) scene.move(figure, [{ rotate: `${lean}deg`, scale: '1.06 0.94' }, { rotate: '0deg', scale: '1 1' }], 360, SPRING).catch(() => {});
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
  // Otto sets off a beat later and runs a beat faster: they meet all the same
  await Promise.all(['Clippy', 'Otto'].map(async (name, i) => {
    await scene.wait(i * 160);
    await run(scene, s, buddies[name], [seat[name], table[name], door[name], near[name]], 1500 - i * 160, { arms: 'carry', look: 'run', stop: false });
  }));
  // the hit: both squashed flat against each other, and a beat of stillness
  const flat = up ? '0.8 1.14' : '1.14 0.8';
  await Promise.all(['Clippy', 'Otto'].map((name) => scene.move(buddies[name].figure, [{ scale: '1 1' }, { scale: flat }], 70, 'ease-out')));
  const bang = svg('-24 -24 48 48', 'arch-spark');
  bang.append(path(spark([0, 0])));
  s.place(bang, meet, [72, 72]);
  scene.move(bang, [{ scale: 0, opacity: 1 }, { scale: 1.4, opacity: 1, offset: 0.3 }, { scale: 1.1, opacity: 0 }], 700, 'ease-out').catch(() => {});
  await scene.wait(160);
  const knocked = up ? { Clippy: [meet[0] - 70, meet[1] - 20], Otto: [meet[0] + 70, meet[1] - 20] } : { Clippy: [meet[0] + 24, meet[1] - 80], Otto: [meet[0] + 24, meet[1] + 80] };
  const strewn = up ? { Clippy: [home[0] - 34, home[1] - 34], Otto: [home[0] + 34, home[1] - 28] } : { Clippy: [home[0] + 8, home[1] - 30], Otto: [home[0] + 14, home[1] + 26] };
  for (const name of ['Clippy', 'Otto']) pose(buddies[name], { arms: 'dazed', look: 'dazed', right: up && name === 'Otto' });
  await Promise.all(['Clippy', 'Otto'].flatMap((name, i) => [
    scene.move(buddies[name].node, [s.at(near[name]), s.at(knocked[name])], 500, 'cubic-bezier(0.2, 1.4, 0.4, 1)'),
    scene.move(buddies[name].figure, [{ scale: flat, rotate: '0deg' }, { scale: '1 1', rotate: `${i ? 22 : -22}deg`, offset: 0.35 }, { scale: '1 1', rotate: `${i ? -6 : 6}deg`, offset: 0.7 }, { scale: '1 1', rotate: '0deg' }], 1000, 'ease-out'),
    scene.move(copies[name], [{ ...s.at(near[name]), rotate: '0deg', opacity: 1, scale: 0.4 }, { ...s.at(strewn[name]), rotate: `${i ? 14 : -16}deg`, opacity: 1, scale: 1 }], 700, 'cubic-bezier(0.2, 0.9, 0.3, 1.1)'),
  ]));
  // a beat to take it in, then you flinch
  await scene.wait(500);
  const yours = me.face.querySelector('.pj-avatar');
  yours.classList.add('pj-failed');
  await hop(scene, me, 6, 360);
  await scene.wait(1000);
  yours.classList.remove('pj-failed');

  // they walk back to their rooms, and you are left to merge the two
  me.face.dataset.presence = 'working';
  me.tag.textContent = 'Merging by hand';
  await Promise.all(['Clippy', 'Otto'].map(async (name, i) => {
    await scene.wait(i * 220);
    await run(scene, s, buddies[name], [knocked[name], door[name], seat[name]], 1700, { walk: true });
  }));
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
  const walk = (from, to) => Promise.all(Object.values(who).map(async (member, i) => {
    await scene.wait([1, 0, 2][i] * 140); // you first, then Clippy, then Otto
    await run(scene, s, member, [[member.x, from], [member.x, to]], 900, { walk: true });
  }));
  await walk(back, close);
  const lines = [['You', 55], ['Clippy', 75], ['Otto', 45]].map(async ([name, width], i) => {
    const line = bar(width);
    paint(line, name);
    board.append(line);
    await scene.wait(i * 300);
    who[name].face.dataset.presence = 'working';
    pose(who[name], { arms: 'write' });
    if (!still) who[name].parts['arms-write'].animate([{ rotate: '-6deg' }, { rotate: '8deg' }, { rotate: '-6deg' }], { duration: 300, iterations: 6 });
    await scene.move(line, [{ width: '0%' }, { width: `${width}%` }], 1800, 'ease-in-out');
    who[name].face.dataset.presence = 'idle';
    pose(who[name], {});
    await hop(scene, who[name], 8);
  });
  await Promise.all(lines);
  await scene.wait(600);
  await walk(close, back);
  pose(who.You, {});
  await scene.wait(2200);
}

// A relay: Otto, Clippy and Pip, each its leg of a track, Clippy asleep with
// z's over it. With `headsets`, each wears one, and the board by the track
// says which legs are run.
function race(scene, { headsets = false } = {}) {
  const s = sketch(scene.stage);
  const up = s.upright;
  const y = headsets ? (up ? 340 : 280) : (up ? 260 : 220); // where they stand
  const track = y + 62;
  const start = up ? { Otto: 60, Clippy: 180, Pip: 300 } : { Otto: 90, Clippy: 310, Pip: 530 };
  const leg = up ? 60 : 140; // how far each runs
  s.ink(`M${up ? 20 : 40} ${track} H${s.W - (up ? 20 : 40)}`, 'arch-ink arch-track');
  const who = {};
  for (const name of ['Otto', 'Clippy', 'Pip']) {
    who[name] = actor(name, name === 'Clippy' ? 'away' : 'idle', { headset: headsets });
    s.place(who[name].node, [start[name], y]);
  }
  const zzz = s.place(el('span', 'arch-zzz'), [start.Clippy + 30, y - 66]);
  zzz.append(...'zzz'.split('').map((z) => el('i', '', z)));
  const t = { s, up, y, track, start, leg, who, zzz };
  if (headsets) {
    const board = t.board = s.place(el('div', 'arch-paper arch-score'), up ? [s.W / 2, 110] : [s.W / 2, 80], up ? [240, 150] : [260, 128]);
    board.append(el('b', '', 'Board'));
    t.marks = {};
    ['Otto', 'Clippy', 'Pip'].forEach((name, i) => {
      const row = el('div', 'arch-leg');
      t.marks[name] = el('span', 'arch-mark', '—');
      row.append(el('span', '', `Leg ${i + 1}`), face(name), t.marks[name]);
      board.append(row);
    });
  }
  // `name` runs its leg, and is pleased with itself
  t.runs = async (name) => {
    await run(scene, s, who[name], [[start[name], y], [start[name] + leg, y]], 1200, { look: 'run' });
    pose(who[name], { right: true });
    await hop(scene, who[name], 6, 360); // done: a little hop
  };
  return t;
}

// Triggered by events: each runner runs when the one before hands it the
// baton. Clippy is asleep and misses it; the baton falls, and Pip waits.
async function events(scene) {
  watching(false);
  const t = race(scene);
  const { who } = t;
  pose(who.Otto, { arms: 'baton' });
  const foot = el('p', 'arch-foot');
  const link = el('a', '', 'Even OpenHands drops requests when a poll fails.');
  link.href = OPENHANDS;
  foot.append(link);
  scene.stage.append(foot);

  await scene.wait(800);
  const to = t.start.Clippy - 70;
  await run(scene, t.s, who.Otto, [[t.start.Otto, t.y], [to, t.y]], 1400, { arms: 'baton', look: 'run' });
  pose(who.Otto, { arms: 'reach', right: true });
  who.Otto.tag.textContent = 'Here!';
  await scene.wait(500);
  await hop(scene, who.Otto, 4, 300); // a nudge: take it!
  await scene.wait(600);
  // nobody takes it: it slips, falls to the track and bounces, less each time
  pose(who.Otto, { arms: 'tap', right: true });
  who.Otto.tag.textContent = '';
  const baton = t.s.place(svg('-14 -5 28 10', 'arch-baton'), [to + 34, t.y - 4], [28, 10]);
  baton.append(path('M-13 -4 H13 V4 H-13 Z'));
  const at = (x, y, turn) => ({ ...t.s.at([to + x, y]), rotate: `${turn}deg` });
  const floor = t.track - 4;
  await scene.move(baton, [at(34, t.y - 4, 0), at(44, floor, 70)], 420, 'cubic-bezier(0.5, 0, 1, 1)');
  await scene.move(baton, [at(44, floor, 70), at(52, floor - 18, 130)], 200, 'cubic-bezier(0, 0, 0.5, 1)');
  await scene.move(baton, [at(52, floor - 18, 130), at(58, floor, 175)], 200, 'cubic-bezier(0.5, 0, 1, 1)');
  await scene.move(baton, [at(58, floor, 175), at(62, floor - 5, 185), at(64, floor, 180)], 240, 'ease-in-out');
  const otto = who.Otto.face.querySelector('.pj-avatar');
  otto.classList.add('pj-failed');
  await scene.wait(600);
  // Pip, still waiting, bounces on its toes
  who.Pip.tag.textContent = 'Waiting…';
  if (!still) who.Pip.figure.animate([{ translate: '0 0' }, { translate: '0 -3px' }, { translate: '0 0' }], { duration: 500, iterations: Infinity, easing: 'ease-in-out' });
  await scene.wait(600);
  otto.classList.remove('pj-failed');
  await scene.wait(2600);
}

// Reconciled from state: no baton. The runtime reads the board and calls,
// in its headset, whoever's leg is not run yet, and calls again while it is
// not: Clippy sleeps through the first call and wakes at the second.
async function state(scene) {
  watching(false);
  const t = race(scene, { headsets: true });
  const { who, marks } = t;
  // a call from the board to `name`'s headset: a dashed line, and the waves
  // at its ear pulse; louder, they are bigger
  const call = async (name, loud = false) => {
    const runner = who[name].node;
    const [from, to] = [t.board.getBoundingClientRect(), runner.getBoundingClientRect()];
    const box = t.board.parentNode.getBoundingClientRect();
    const k = t.s.W / box.width; // page pixels to the diagram's units
    const line = t.s.ink(`M${f((from.left + from.width / 2 - box.left) * k)} ${f((from.bottom - box.top) * k + 4)} L${f((to.left + to.width / 2 - box.left) * k)} ${f((to.top - box.top) * k)}`, 'arch-ink arch-call');
    const waves = who[name].parts.waves;
    waves.style.display = '';
    waves.style.scale = loud ? '1.4' : '1';
    await scene.move(waves, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }, { opacity: 0 }], 900, 'linear');
    waves.style.display = 'none';
    line.remove();
  };
  const ran = (name) => {
    marks[name].textContent = '✓';
    marks[name].classList.add('arch-done');
  };

  await scene.wait(800);
  await call('Otto');
  await t.runs('Otto');
  ran('Otto');
  await scene.wait(500);
  await call('Clippy'); // asleep: nothing
  await scene.wait(900);
  await call('Clippy', true); // again, since leg 2 is still not run
  scene.fade(t.zzz, 0, 200).catch(() => {});
  who.Clippy.face.dataset.presence = 'idle';
  await hop(scene, who.Clippy, 16, 520); // it starts awake
  await scene.wait(250);
  await t.runs('Clippy');
  ran('Clippy');
  await scene.wait(400);
  await call('Pip');
  await t.runs('Pip');
  ran('Pip');
  await scene.wait(2600);
}

// [eyebrow, the idea in a line, the scene]
const CHAPTERS = [
  ['', 'Press Start.', cover],
  ['How you work', '', point('Agents work beside you, in front of a blackboard,', 'instead of apart from you, in an isolated room.')],
  ['How you work · Delegate', 'Delegate: each agent works alone on its own copy. The copies clash, and you merge them by hand.', delegate],
  ['How you work · Blackboard', 'Blackboard: everyone works on one board and sees every change. Nothing to hand off, nothing to merge.', blackboard],
  ['When agents run', '', point('Agent orchestration is a state reconciliation problem,', 'instead of an event triggering problem.')],
  ['When agents run · Events', 'Triggered by events: each agent runs when the one before hands it on. Miss one handoff, and the race stops.', events],
  ['When agents run · State', 'Reconciled from state: the runtime reads the board and calls whoever’s leg isn’t run, again until it is. Nobody wires who goes next, and a missed call costs nothing.', state],
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
    } while (!still && !play.once);
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
