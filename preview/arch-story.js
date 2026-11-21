// The architecture page (site/architecture.html): the blackboard agent
// runtime (docs/runtime-vision.md) as a few chapters, each a looping
// animation with one line under it on the idea it shows. Back and Next go
// from chapter to chapter. With reduced motion a chapter shows its last
// frame and holds still. preview/build.js bundles it into dist/preview.

/* global document, window */

import { INK, agentFace, buddyColor, personFace, setBuddies, setOwner, setPeople } from '../web/faces.js';

const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let still = motionPreference.matches;
const STOPPED = Symbol('stopped');

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
// A headset over a face, in its 100×100 box: a band arched clear over the
// head, rounded cups at the sides, each with a speaker's dot; and the waves
// at its ear when it is called.
const cup = (x) => `M${x} 44 a8 8 0 0 1 8 -8 a8 8 0 0 1 8 8 v12 a8 8 0 0 1 -8 8 a8 8 0 0 1 -8 -8 Z`;
const HEADSET = ['M2 42 C0 -22 100 -22 98 42', `${cup(-6)} ${cup(90)}`, 'M2 50 a2.5 2.5 0 1 0 0.01 0 M98 50 a2.5 2.5 0 1 0 0.01 0'];
const WAVES = 'M114 42 q7 9 0 18 M122 35 q13 16 0 32';
// Looks a face has only in these scenes, drawn in its own ink in place of
// its eyes and mouth, in its 100×100 box: [kind, path], a 'fill' solid, a
// 'drop' filled with paper. Running: brows down, eyes set, a frown and a
// drop of sweat. Shocked: brows up, eyes wide, mouth open, and a jolt.
// Dazed: worried brows, spiral eyes, a wobbly mouth.
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
  shocked: [
    ['line', 'M28 26 L40 30 M72 26 L60 30'],
    ['thin', 'M29 45 a7 8 0 1 0 14 0 a7 8 0 1 0 -14 0 M57 45 a7 8 0 1 0 14 0 a7 8 0 1 0 -14 0'],
    ['fill', 'M34 45 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0 M62 45 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0 M44 58 h12 v9 a4 4 0 0 1 -4 4 h-4 a4 4 0 0 1 -4 -4 Z'],
    ['thin', 'M100 14 l5 -12 M108 22 l9 -9 M112 34 l12 -4'],
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
    looks.append(path(HEADSET[0], 'arch-headset'), path(HEADSET[1], 'arch-headset-cups'), path(HEADSET[2], 'arch-headset-dots'));
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

// The scene's paper, W×H, wide or upright, whichever the stage holds bigger,
// and scaled to fill it (refit whenever the window changes): an SVG for the
// lines, `ink` to draw one, and `place` to put a node at a point, `size`
// across. Sizes are the stage's own, not as a slide's scale shows them.
let fitting = null;
function sketch(stage) {
  const fit = ([w, h]) => Math.min(stage.clientWidth / w, stage.clientHeight / h);
  const [W, H] = fit([400, 520]) > fit([760, 420]) * 1.15 ? [400, 520] : [760, 420];
  const box = el('div', 'arch-sketch');
  box.style.width = `${W}px`;
  box.style.height = `${H}px`;
  fitting = () => {
    box.style.scale = String(fit([W, H]));
  };
  fitting();
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
  const art = document.querySelector('#cover-art').content.firstElementChild.cloneNode(true);
  const pet = face('Clippy', { tag: 'button' });
  pet.classList.add('dl-pet');
  pet.type = 'button';
  pet.dataset.follow = '';
  const title = el('h1', '', 'Work with agents like teammates, not tools');
  const lead = el('p', '', 'People and agents work on one board, at the same time. The board, not an LLM, decides who acts next.');
  scene.stage.classList.add('arch-cover');
  art.append(pet);
  scene.stage.append(art, title, lead);
  const strokes = ['.arch-chalk-route', '.arch-chalk-return', '.arch-chalk-edit'].map((selector) => art.querySelector(selector));
  function traceEdit() {
    if (still) return;
    let delay = 0;
    for (const stroke of strokes) {
      for (const previous of stroke.getAnimations()) previous.cancel();
      const length = stroke.getTotalLength();
      stroke.style.strokeDasharray = String(length);
      const duration = stroke === strokes[2] ? 300 : 650;
      stroke.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
        delay, duration, fill: 'backwards', easing: 'ease-in-out',
      });
      delay += duration + 120;
    }
  }
  pet.setAttribute('aria-label', 'Replay the board loop with Clippy');
  pet.addEventListener('click', traceEdit);
  traceEdit();
}
cover.once = true;

// A page that states what the scenes after it show: the claim, then what it
// replaces, quieter, which a beat later is struck out, a line at a time.
function point(claim, instead) {
  const page = async (scene) => {
    const line = el('h2');
    const gone = el('del', '', instead);
    const quiet = el('span', 'arch-instead');
    quiet.append(gone);
    line.append(el('span', '', claim), quiet);
    scene.stage.classList.add('arch-point');
    scene.stage.append(line);
    await scene.fade(quiet, 1, 300);
    await scene.wait(280);
    await scene.move(gone, [{ backgroundSize: '0% 3px' }, { backgroundSize: '100% 3px' }], 650, 'ease-in-out');
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
  const lean = Math.sign(points.at(-1)[0] - points[0][0]) * (walk ? 2 : 6);
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
      { transform: `translateY(${walk ? -2 : -4}px) rotate(${lean}deg)` },
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
  // Otto sets off a beat later and runs a beat faster: they meet all the same
  await Promise.all(['Clippy', 'Otto'].map(async (name, i) => {
    await scene.wait(i * 160);
    await run(scene, s, buddies[name], [seat[name], table[name]], 520, { walk: true });
    await scene.move(copies[name], [{ scale: 1, opacity: 1 }, { scale: 0.4, opacity: 0 }], 180);
    await run(scene, s, buddies[name], [table[name], door[name], near[name]], 980 - i * 160, { arms: 'carry', look: 'run', stop: false });
  }));
  // the hit: both squashed flat against each other, and a beat of stillness
  const flat = up ? '0.8 1.14' : '1.14 0.8';
  await Promise.all(['Clippy', 'Otto'].map((name) => scene.move(buddies[name].figure, [{ scale: '1 1' }, { scale: flat }], 70, 'ease-out')));
  const bang = svg('-24 -24 48 48', 'arch-spark');
  bang.append(path(spark([0, 0])));
  s.place(bang, meet, [44, 44]);
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

// One board: Clippy, You and Otto write on it at once. Your typing lands as
// you type; an agent's line is a proposal, dashed, made on the version it
// saw, until the writer lands it. Each landing moves the board on a version.
// Clippy's, made on v1, lands first; Otto's, also made on v1, comes in when
// the board is at v3, so it is refused: Otto looks again, proposes on v3,
// and it lands.
async function blackboard(scene) {
  watching(true);
  const s = sketch(scene.stage);
  const up = s.upright;
  const board = s.place(paper('Doc', [85, 60]), [s.W / 2, up ? 150 : 120], up ? [360, 220] : [520, 180]);
  board.classList.add('arch-board');
  let version = 1;
  const stamp = el('span', 'arch-version', 'v1');
  board.firstChild.append(stamp);
  const back = up ? s.H - 70 : s.H - 60; // where they stand, then where they write
  const close = up ? 330 : 285;
  const gap = up ? 120 : 170;
  const who = {};
  for (const [name, x] of [['Clippy', s.W / 2 - gap], ['You', s.W / 2], ['Otto', s.W / 2 + gap]]) {
    who[name] = actor(name, 'idle');
    who[name].x = x;
    s.place(who[name].node, [x, back]);
  }
  const say = (name, words) => {
    who[name].tag.textContent = words;
  };
  // `name` writes a line `width` wide; an agent's is a proposal on this version
  const write = async (name, width, ms) => {
    const row = el('div', 'arch-line');
    const line = bar(width);
    paint(line, name);
    row.append(line);
    if (name !== 'You') {
      line.classList.add('arch-proposed');
      row.append(el('span', 'arch-on', `on v${version}`));
    }
    board.append(row);
    who[name].face.dataset.presence = 'working';
    pose(who[name], { arms: 'write' });
    if (!still) who[name].parts['arms-write'].animate([{ rotate: '-6deg' }, { rotate: '8deg' }, { rotate: '-6deg' }], { duration: 300, iterations: Math.round(ms / 300) });
    await scene.move(line, [{ width: '0%' }, { width: `${width}%` }], ms, 'ease-in-out');
    who[name].face.dataset.presence = 'idle';
    pose(who[name], {});
    return row;
  };
  // the writer lands it: solid, and the board one version on
  const land = (row) => {
    row.querySelector('.arch-proposed')?.classList.remove('arch-proposed');
    row.querySelector('.arch-on')?.remove();
    version += 1;
    stamp.textContent = `v${version}`;
    return scene.move(stamp, [{ scale: '1.5' }, { scale: '1' }], 360, SPRING);
  };

  await scene.wait(800);
  const walk = (from, to) => Promise.all(Object.values(who).map(async (member, i) => {
    await scene.wait([1, 0, 2][i] * 140); // you first, then Clippy, then Otto
    await run(scene, s, member, [[member.x, from], [member.x, to]], 900, { walk: true });
  }));
  await walk(back, close);
  const clippy = write('Clippy', 75, 1400).then(land);
  await scene.wait(100);
  const otto = write('Otto', 50, 2600);
  await scene.wait(100);
  await Promise.all([clippy, write('You', 55, 1800).then(land)]);

  // Otto's, made on v1, comes in at v3: refused
  const stale = await otto;
  stale.classList.add('arch-refused');
  stale.querySelector('.arch-on').textContent = 'on v1 ✕';
  say('Otto', `Refused: board is at v${version}`);
  pose(who.Otto, { look: 'shocked' });
  await Promise.all([
    hop(scene, who.Otto, 12, 480),
    scene.move(stale, [{ translate: '0' }, { translate: '-6px' }, { translate: '6px' }, { translate: '-4px' }, { translate: '0' }], 420, 'ease-in-out'),
  ]);
  await scene.wait(1300);
  await scene.fade(stale, 0, 300);
  stale.remove();
  pose(who.Otto, {});
  say('Otto', 'Looking again…');
  await scene.wait(1100);
  say('Otto', '');
  await land(await write('Otto', 50, 1200));
  say('Otto', 'Landed');
  await scene.wait(1100);
  say('Otto', '');

  await scene.wait(400);
  await walk(close, back);
  pose(who.You, {});
  await scene.wait(2200);
}

// A relay round an oval track: Clippy, Pip and Otto, each a leg of it, Pip
// asleep with z's over it. Places on the track are angles, in degrees
// clockwise from the right.
const RUNNERS = { Clippy: 180, Pip: 270, Otto: 360 };
const LEGS = { Clippy: [180, 240] }; // the leg Clippy runs, stopping short of Pip

function race(scene) {
  const s = sketch(scene.stage);
  const up = s.upright;
  // A track as anyone knows one: two straights joined by half circles, two
  // lanes, lying across the scene, smaller on a phone. `r` is the radius
  // of the centre line, `half` half a straight; `k` moves out
  // (or in) from that line. A place on it is an angle in degrees, clockwise
  // from the right: 90 the middle of the near straight, 270 of the far one.
  const [cx, cy] = up ? [200, 300] : [380, 222];
  const [half, r, lane] = up ? [52, 82, 15] : [166, 112, 18];
  const on = (deg, k = 0) => {
    const R = r + k;
    const P = 2 * Math.PI * r + 4 * half; // round the line, the lengths that set where 90, 180 and 270 fall
    let d = ((((deg / 360) % 1) + 1) % 1) * P;
    const bend = (from, to) => [cx + to * half + R * Math.cos(from + d / r), cy + R * Math.sin(from + d / r)];
    if (d < (Math.PI * r) / 2) return bend(0, 1);
    d -= (Math.PI * r) / 2;
    if (d < 2 * half) return [cx + half - d, cy + R];
    d -= 2 * half;
    if (d < Math.PI * r) return bend(Math.PI / 2, -1);
    d -= Math.PI * r;
    if (d < 2 * half) return [cx - half + d, cy - R];
    d -= 2 * half;
    return bend((3 * Math.PI) / 2, 1);
  };
  const at = (deg) => { // a runner on the track: its feet in the inside lanes
    const [x, y] = on(deg, -lane / 2);
    return [x, y - 30];
  };
  const arc = (from, to) => {
    const points = [];
    for (let deg = from; deg < to; deg += 4) points.push(at(deg));
    points.push(at(to));
    return points;
  };
  // an outline of the track at `k`, as a path
  const outline = (k) => {
    const points = [];
    for (let deg = 0; deg < 360; deg += 2) points.push(on(deg, k));
    return `M${points.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z`;
  };
  s.ink(`${outline(2 * lane)} ${outline(-2 * lane)}`, 'arch-track');
  s.ink(outline(-2 * lane), 'arch-field');
  s.ink(outline(0), 'arch-track-lane');
  const startX = cx - half / 2;
  s.ink(`M${startX} ${cy + r - 2 * lane}v${4 * lane}`, 'arch-track-lane');
  const who = {};
  for (const [name, deg] of Object.entries(RUNNERS)) {
    who[name] = actor(name, name === 'Pip' ? 'away' : 'idle');
    s.place(who[name].node, at(deg));
  }
  const [zx, zy] = at(RUNNERS.Pip);
  const zzz = s.place(el('span', 'arch-zzz'), [zx + 34, zy - 66]);
  zzz.append(...'zzz'.split('').map((z) => el('i', '', z)));
  const t = { s, at, arc, who, zzz };
  // `name` runs its leg round the track, and is pleased with itself
  t.runs = async (name, { arms = null, to = LEGS[name][1] } = {}) => {
    await run(scene, s, who[name], arc(LEGS[name][0], to), 1300 + (to - LEGS[name][0]) * 4, { arms, look: 'run' });
    pose(who[name], { arms: arms ?? 'stand', right: true });
  };
  return t;
}

// A die's face `n` as one path of dots, in its 24×24 box.
const PIPS = [[], [[0, 0]], [[-5, -5], [5, 5]], [[-5, -5], [0, 0], [5, 5]], [[-5, -5], [5, -5], [-5, 5], [5, 5]],
  [[-5, -5], [5, -5], [0, 0], [-5, 5], [5, 5]], [[-5, -5], [5, -5], [-5, 0], [5, 0], [-5, 5], [5, 5]]];
const pips = (n) => PIPS[n].map(([x, y]) => `M${x - 2.2} ${y}a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0`).join('');

// Handed on by an agent: Pip is awake and ready this time. Clippy runs its
// leg with the baton and stops where it should hand on; whether it does is
// an LLM's call, a die rolled in its head. It says it is done and turns
// away, baton in hand: nothing dropped, nothing sent, and Pip waits on.
async function handoff(scene) {
  watching(false);
  const t = race(scene);
  const { who } = t;
  who.Pip.face.dataset.presence = 'idle';
  t.zzz.remove();
  who.Pip.tag.textContent = 'Ready!';
  pose(who.Clippy, { arms: 'baton' });

  await scene.wait(800);
  const stop = 245;
  await t.runs('Clippy', { arms: 'baton', to: stop });
  // it stops to decide: a die rolls in a thought over its head
  const [hx, hy] = t.at(stop);
  const thought = t.s.place(el('span', 'arch-think'), [hx - 34, hy - 70]);
  const die = svg('-12 -12 24 24', 'arch-die');
  const face = path(pips(5), 'arch-die-pips');
  die.append(path('M-9 -11h18a2 2 0 0 1 2 2v18a2 2 0 0 1 -2 2h-18a2 2 0 0 1 -2 -2v-18a2 2 0 0 1 2 -2Z', 'arch-die-body'), face);
  thought.append(die);
  thought.style.opacity = '0';
  await scene.fade(thought, 1, 200);
  const roll = scene.move(die, [{ rotate: '0deg' }, { rotate: '720deg' }], 1400, 'cubic-bezier(0.2, 0.6, 0.3, 1)');
  for (const n of [2, 6, 3, 4, 2, 5, 6, 3]) {
    face.setAttribute('d', pips(n));
    await scene.wait(160);
  }
  face.setAttribute('d', pips(1));
  await roll;
  await scene.wait(700);
  await scene.fade(thought, 0, 200);
  // it came up no: Clippy is done, it thinks, and turns away with the baton
  who.Clippy.tag.textContent = 'Done!';
  pose(who.Clippy, { arms: 'baton' });
  await scene.wait(1400);
  who.Pip.tag.textContent = 'Waiting…';
  await hop(scene, who.Pip, 6, 360);
  await scene.wait(2600);
}

// Triggered by events: each runner runs when the one before hands it the
// baton. Clippy brings it round to Pip, who is asleep and misses it; the
// baton falls, and Otto, waiting next, sees it go.
async function events(scene) {
  watching(false);
  const t = race(scene);
  const { who } = t;
  pose(who.Clippy, { arms: 'baton' });
  // Otto waits for the handoff and reacts when the baton lands.
  who.Otto.tag.textContent = 'Waiting…';

  await scene.wait(800);
  const stop = 245;
  await t.runs('Clippy', { arms: 'baton', to: stop });
  pose(who.Clippy, { arms: 'reach', right: true });
  who.Clippy.tag.textContent = 'Here!';
  await scene.wait(500);
  await hop(scene, who.Clippy, 4, 300); // a nudge: take it!
  await scene.wait(600);
  // nobody takes it: it slips, falls to the track and bounces, less each time
  pose(who.Clippy, { arms: 'tap', right: true });
  who.Clippy.tag.textContent = '';
  const [hx, hy] = t.at(stop);
  const floor = hy + 34;
  const baton = t.s.place(svg('-14 -5 28 10', 'arch-baton'), [hx + 34, hy - 4], [28, 10]);
  baton.append(path('M-13 -4 H13 V4 H-13 Z'));
  const spot = (x, y, turn) => ({ ...t.s.at([hx + x, y]), rotate: `${turn}deg` });
  await scene.move(baton, [spot(34, hy - 4, 0), spot(44, floor, 70)], 420, 'cubic-bezier(0.5, 0, 1, 1)');
  await scene.move(baton, [spot(44, floor, 70), spot(52, floor - 18, 130)], 200, 'cubic-bezier(0, 0, 0.5, 1)');
  await scene.move(baton, [spot(52, floor - 18, 130), spot(58, floor, 175)], 200, 'cubic-bezier(0.5, 0, 1, 1)');
  await scene.move(baton, [spot(58, floor, 175), spot(62, floor - 5, 185), spot(64, floor, 180)], 240, 'ease-in-out');
  // Otto sees it fall: a jolt, and its jaw drops
  who.Otto.tag.textContent = '';
  pose(who.Otto, { look: 'shocked' });
  await hop(scene, who.Otto, 10, 420);
  const clippy = who.Clippy.face.querySelector('.pj-avatar');
  clippy.classList.add('pj-failed');
  await scene.wait(1200);
  clippy.classList.remove('pj-failed');
  await scene.wait(2400);
}

// The runtime as an eye, which watches the board: its lid
// half shut while nothing changes, open when something does; its pupil
// reads along the board's lines and turns to whoever is due.
function eye() {
  const node = svg('-50 -50 100 100', 'arch-eye');
  const opening = 'M-34 0Q-20 -22 0 -21Q21 -22 34 0Q18 22 0 21Q-21 22 -34 0Z';
  node.append(path(opening, 'arch-eye-white'));
  const pupil = document.createElementNS(NS, 'g');
  pupil.append(
    path('M-10 0a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', 'arch-eye-pupil'),
    path('M-7 -5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'arch-eye-glint'),
  );
  const lid = path('M-38 -25H38V19Q0 32 -38 19Z', 'arch-eye-lid');
  const clip = document.createElementNS(NS, 'clipPath');
  clip.id = `arch-eye-${Math.random().toString(36).slice(2)}`;
  clip.append(path(opening));
  const inside = document.createElementNS(NS, 'g');
  inside.setAttribute('clip-path', `url(#${clip.id})`);
  inside.append(pupil, lid);
  node.append(clip, inside, path(opening, 'arch-eye-rim'));
  return { node, pupil, lid };
}

// The runtime's room: a board with a line for each of Clippy, Otto and Pip;
// the runtime as an eye under it, its lid half shut while nothing changes;
// a wire from it to each one's headset; all three asleep. A change on the
// board opens the eye (`due`); it reads the board and calls whoever is due
// down their wire (`call`); they wake, do their line and sleep again
// (`wake`); with nothing due, its lid falls (`rest`).
function room(scene) {
  watching(false);
  const s = sketch(scene.stage);
  const up = s.upright;
  const ROWS = ['Clippy', 'Otto', 'Pip'];
  const [bx, by] = up ? [200, 84] : [380, 86];
  const [bw, bh] = up ? [300, 128] : [320, 128];
  const board = s.place(paper('Board', []), [bx, by], [bw, bh]);
  board.classList.add('arch-board');
  const lines = Object.fromEntries(ROWS.map((name) => {
    const line = el('div', 'arch-ask arch-quiet');
    line.style.setProperty('--buddy', buddyColor(name));
    line.append(bar(60), face(name));
    board.append(line);
    return [name, line];
  }));
  const middle = up ? [200, 250] : [380, 236];
  const seats = up ? { Clippy: [70, 370], Pip: [200, 450], Otto: [330, 370] } : { Clippy: [120, 330], Pip: [380, 368], Otto: [640, 330] };
  // the wires, from under the eye to each one's ear
  const wires = {};
  for (const [name, [x, y]] of Object.entries(seats)) {
    // into the cup on the side towards the eye; under it, the one to its left, from outside
    const side = x < middle[0] ? 1 : -1;
    const ear = [x + side * 30, y - 22];
    const near = x === middle[0] ? [ear[0] - 36, ear[1] - 6] : [ear[0] + side * 44, ear[1] - 4];
    const d = `M${f(middle[0])} ${f(middle[1] + 20)} C${f(middle[0])} ${f(middle[1] + 80)} ${f(near[0])} ${f(near[1])} ${f(ear[0])} ${f(ear[1])}`;
    s.ink(d, 'arch-ink arch-wire');
    wires[name] = d;
  }
  const { node, pupil, lid } = eye();
  s.place(node, middle, [92, 92]);
  const restarting = s.place(el('span', 'arch-label', 'Restarting…'), [middle[0], middle[1] - 62]);
  restarting.style.opacity = '0';
  const who = {};
  const zzz = {};
  for (const [name, at] of Object.entries(seats)) {
    who[name] = actor(name, 'away', { headset: true });
    s.place(who[name].node, at);
    zzz[name] = s.place(el('span', 'arch-zzz'), [at[0] + 32, at[1] - 70]);
    zzz[name].append(...'zzz'.split('').map((z) => el('i', '', z)));
  }

  const half = { scale: '1 0.55' };
  lid.style.scale = '1 0.55';
  const blink = (to) => scene.move(lid, [{ scale: lid.style.scale }, { scale: '1 1', offset: 0.4 }, { scale: `1 ${to}` }], 320, 'ease-in-out').then(() => { lid.style.scale = `1 ${to}`; });
  const look = (to, ms = 260) => {
    const [dx, dy] = [to[0] - middle[0], to[1] - middle[1]];
    const k = 12 / Math.max(1, Math.hypot(dx, dy));
    return scene.move(pupil, [{ translate: pupil.style.translate || '0 0' }, { translate: `${f(dx * k)}px ${f(dy * k)}px` }], ms, 'ease-in-out').then(() => { pupil.style.translate = `${f(dx * k)}px ${f(dy * k)}px`; });
  };
  // it reads the board, line by line, left to right
  const read = async () => {
    for (let i = 0; i < ROWS.length; i++) {
      const y = by - bh / 2 + 52 + i * 26;
      await look([bx - bw / 3, y], 160);
      await look([bx + bw / 3, y], 220);
    }
  };
  // a call down `name`'s wire: a pulse runs along it, and the headset buzzes
  const call = async (name, loud = false) => {
    await look(seats[name]);
    const pulse = s.ink(wires[name], 'arch-ink arch-pulse');
    await scene.draw(pulse, 500);
    const waves = who[name].parts.waves;
    waves.style.display = '';
    waves.style.scale = loud ? '1.5' : '1';
    await scene.move(waves, [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], 420, 'ease-in-out');
    waves.style.display = 'none';
    pulse.remove();
  };
  // `name` wakes with a start, does its line, says `said` if anything, and sleeps again
  const wake = async (name, said = '') => {
    zzz[name].style.opacity = '0';
    who[name].face.dataset.presence = 'idle';
    pose(who[name], { look: 'shocked' });
    await hop(scene, who[name], 14, 480);
    pose(who[name], {});
    who[name].face.dataset.presence = 'working';
    lines[name].classList.remove('arch-found');
    lines[name].classList.add('arch-edited');
    const edit = lines[name].querySelector('.arch-bar');
    edit.style.transformOrigin = 'left';
    await scene.move(edit, [{ scale: '0 1' }, { scale: '1 1' }], 650, 'ease-in-out');
    if (said) {
      who[name].tag.textContent = said;
      await scene.wait(1100);
      who[name].tag.textContent = '';
    }
    who[name].face.dataset.presence = 'away';
    zzz[name].style.opacity = '';
  };
  // the runtime restarts: its eye shuts, a while, and opens with nothing remembered
  const restart = async () => {
    await look(middle, 200);
    await scene.move(lid, [{ scale: lid.style.scale }, { scale: '1 1' }], 360, 'ease-in');
    lid.style.scale = '1 1';
    await scene.fade(restarting, 1, 200);
    await scene.wait(1100);
    await scene.fade(restarting, 0, 200);
    await scene.move(lid, [{ scale: '1 1' }, { scale: '1 0' }], 360, 'ease-out');
    lid.style.scale = '1 0';
  };
  const due = async (name) => {
    lines[name].classList.remove('arch-quiet', 'arch-edited');
    await blink(0);
    await read();
    lines[name].classList.add('arch-found');
  };
  const rest = async () => {
    await read();
    await look(middle, 300);
    await scene.move(lid, [{ scale: '1 0' }, half], 700, 'ease-in-out');
    lid.style.scale = '1 0.55';
  };
  return { who, due, call, wake, restart, read, rest };
}

// Seen on the board: Clippy does its line, says it is done and sleeps,
// telling no one, as forgetful as in the handoff before. Its change is the
// signal: the eye sees Otto's line come due, and calls Otto.
async function seen(scene) {
  const { due, call, wake, rest } = room(scene);
  await scene.wait(900);
  await due('Clippy');
  await call('Clippy');
  await wake('Clippy', 'Done!');
  await due('Otto');
  await call('Otto');
  await wake('Otto');
  await rest();
  await scene.wait(2400);
}

// Reconciled from state: Clippy's edit leaves Otto's line due, so Otto is
// next: nobody wires that. Otto sleeps through the call, and the runtime
// restarts: its eye shuts, it forgets all it knew, and on opening reads the
// board afresh. Otto's line is still lit, so it calls Otto again. Pip, with
// nothing due, sleeps all through.
async function state(scene) {
  const { due, call, wake, restart, read, rest } = room(scene);
  await scene.wait(900);
  // someone asks Clippy on the board: the eye opens, reads, and calls Clippy
  await due('Clippy');
  await call('Clippy');
  await wake('Clippy');
  // Clippy's edit leaves Otto's line due: the eye sees it, and calls Otto,
  // who sleeps through the call; the runtime restarts, reads the board
  // afresh, finds Otto's line still lit, and calls again
  await due('Otto');
  await call('Otto');
  await scene.wait(700);
  await restart();
  await read();
  await call('Otto', true);
  await wake('Otto');
  // nothing due: it reads the board once more, and its lid falls
  await rest();
  await scene.wait(2400);
}

// An architecture as boxes, then arrows drawn in the order a change goes
// round, then its loop played over and over: a trace follows `loop`, the
// arrows by number ([i, true] backwards), and each box it reaches lights up.
// `at` places each box (upright on a phone, else wide); a box in `ink` is
// drawn in ink, as the board is; an arrow's words sit over it if it runs
// across, on it otherwise.
async function diagram(scene, { boxes, at, arrows, loop, ink = [] }) {
  watching(false);
  const s = sketch(scene.stage);
  const place = s.upright ? at.up : at.wide;
  const size = s.upright ? [150, 80] : [168, 72];
  const shown = Object.fromEntries(Object.entries(boxes).map(([key, [name, what]]) => {
    const box = s.place(el('div', ink.includes(key) ? 'arch-node arch-node-ink' : 'arch-node'), place[key], size);
    box.append(el('b', '', name), el('span', '', what));
    box.style.opacity = '0';
    return [key, box];
  }));
  // where the line from box centre `a` to `b` leaves `a`, a little clear of it
  const edge = ([x, y], [tx, ty]) => {
    const [dx, dy] = [tx - x, ty - y];
    const t = Math.min(size[0] / 2 / Math.abs(dx || 1e-9), size[1] / 2 / Math.abs(dy || 1e-9));
    const k = 8 / Math.hypot(dx, dy);
    return [x + dx * (t + k), y + dy * (t + k)];
  };
  const head = ([x0, y0], [x1, y1]) => {
    const k = Math.hypot(x1 - x0, y1 - y0);
    const [ux, uy] = [(x1 - x0) / k, (y1 - y0) / k];
    const wing = (side) => `${f(x1 - ux * 10 + side * uy * 6)} ${f(y1 - uy * 10 - side * ux * 6)}`;
    return `M${wing(1)} L${f(x1)} ${f(y1)} L${wing(-1)}`;
  };

  const revealed = new Set();
  const reveal = async (key) => {
    if (revealed.has(key)) return;
    revealed.add(key);
    await scene.fade(shown[key], 1, 240);
  };
  const ends = []; // each arrow's two ends
  for (const [a, b, words, both] of arrows) {
    await reveal(a);
    const [from, to] = [edge(place[a], place[b]), edge(place[b], place[a])];
    const line = s.ink(`M${f(from[0])} ${f(from[1])} L${f(to[0])} ${f(to[1])}`);
    await scene.draw(line, 380);
    const forward = s.ink(head(from, to));
    const reverse = both ? s.ink(head(to, from)) : null;
    ends.push({ from, to, forward, reverse });
    const across = Math.abs(to[1] - from[1]) < 1;
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - (across ? 14 : 0)];
    const label = s.place(el('span', across ? 'arch-label arch-label-over' : 'arch-label', words), mid);
    await Promise.all([scene.fade(label, 1, 200), reveal(b)]);
  }
  if (still) return;

  // Trace each handoff along its wire, including the return trip.
  for (;;) {
    for (const [i, back] of loop) {
      const { from, to, forward, reverse } = ends[i];
      const [start, end] = back ? [to, from] : [from, to];
      const trace = s.ink(`M${start.join(' ')}L${end.join(' ')}`, 'arch-ink arch-flow');
      const tip = back ? reverse : forward;
      const destination = shown[arrows[i][back ? 0 : 1]];
      await scene.draw(trace, 650);
      tip.classList.add('arch-flow');
      destination.classList.add('arch-node-on');
      await scene.wait(280);
      await scene.fade(trace, 0, 150);
      trace.remove();
      tip.classList.remove('arch-flow');
      destination.classList.remove('arch-node-on');
    }
    await scene.wait(1200);
  }
}

// The common way: events in a queue, an orchestrator that wires who handles
// what, agents each with a session and memory of their own, results handed
// back to be merged.
function eventsArchitecture(scene) {
  return diagram(scene, {
    boxes: {
      people: ['You', 'webhooks, a clock'],
      queue: ['Event queue', 'messages in flight'],
      orchestrator: ['Orchestrator', 'wires who handles what'],
      a: ['Agent A', 'its own session and memory'],
      b: ['Agent B', 'its own session and memory'],
      results: ['Results', 'one per agent, merged by hand'],
    },
    at: {
      wide: { people: [110, 80], queue: [380, 80], orchestrator: [650, 80], a: [245, 228], b: [515, 228], results: [380, 368] },
      up: { people: [95, 55], queue: [305, 55], orchestrator: [305, 190], a: [95, 325], b: [305, 325], results: [200, 460] },
    },
    arrows: [
      ['people', 'queue', 'event'],
      ['queue', 'orchestrator', 'delivers'],
      ['orchestrator', 'a', 'triggers'],
      ['orchestrator', 'b', 'triggers'],
      ['a', 'queue', 'emits an event'],
      ['a', 'results', 'hands back'],
      ['b', 'results', 'hands back'],
    ],
    // an event, to the orchestrator, to A; A's event, back round to B; both hand back
    loop: [[0], [1], [2], [4], [1], [3], [6]],
  });
}
eventsArchitecture.once = true;

// The blackboard: who changes the board and who reads it. You edit; the
// writer lands it on the board; the runtime reads the board and starts a
// run; the run gives its agent program its view and proposes the edits back.
function architecture(scene) {
  return diagram(scene, {
    boxes: {
      people: ['You', 'and outside programs'],
      writer: ['Writer', 'the only one that changes the board'],
      board: ['Board', 'the state, all there is'],
      runtime: ['Runtime', 'reads the board, starts who is due'],
      run: ['Run', 'one agent, once'],
      program: ['Agent program', 'Claude Code, Codex…'],
    },
    at: {
      wide: { people: [110, 90], writer: [380, 90], board: [650, 90], program: [110, 320], run: [380, 320], runtime: [650, 320] },
      up: { people: [95, 55], writer: [305, 55], board: [305, 185], runtime: [305, 315], run: [95, 315], program: [95, 455] },
    },
    arrows: [
      ['people', 'writer', 'edit'],
      ['writer', 'board', 'lands, in order'],
      ['board', 'runtime', 'reads'],
      ['runtime', 'run', 'starts'],
      ['run', 'program', 'view in, edits out', true],
      ['run', 'writer', 'proposes'],
    ],
    // you edit; it lands; the runtime reads it and starts a run; the run's
    // program works and the run proposes; that lands, and the runtime reads again
    loop: [[0], [1], [2], [3], [4], [4, true], [5], [1], [2]],
    ink: ['board'],
  });
}
architecture.once = true;

// The common ways to run many agents, as docs/runtime-vision.md compares
// them: [the way, who uses it], then a row per difference.
const WAYS = [
  ['Orchestrator and handoffs', 'Claude Code subagents, OpenAI Agents SDK, CrewAI'],
  ['Graph', 'LangGraph'],
  ['Group chat', 'AutoGen'],
  ['Blackboard', 'Ponjo'],
];
const DIFFERENCES = [
  ['1 · Working at once', 'In parallel, each on its own copy; the lead merges', 'Branches in one step, merged by reducers', 'One speaker at a time', 'Everyone at once; the writer lands each change in order and refuses stale ones'],
  ['1 · People', 'Give the task, review the result', 'Answer while the graph waits', 'Take a turn in the chat', 'Members, acting while agents act'],
  ['2 · Who acts next', 'An LLM: the lead, or an agent handing on', 'The edges you wire, some routed by an LLM', 'A selector: in turn, or an LLM picks', 'Code, reading the board: the same answer every time'],
];

function approachMark(role) {
  const problem = role === 'problem';
  const mark = el('span', 'arch-mark arch-mark-' + role, problem ? '×' : '✓');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', problem ? 'Pain point' : 'Proposed solution');
  return mark;
}

// The ways side by side, in the design system's table (.pj-usage-table), a row at a time.
async function summary(scene) {
  scene.stage.classList.add('arch-summary');
  const table = el('table', 'pj-usage-table arch-compare');
  const head = el('tr');
  head.append(el('th'), ...WAYS.map(([way, who]) => {
    const cell = el('th', '', way);
    cell.append(el('span', 'arch-who', who));
    return cell;
  }));
  head.lastChild.prepend(approachMark('solution'));
  const rows = DIFFERENCES.map((cells) => {
    const row = el('tr');
    row.append(...cells.map((words) => el('td', '', words)));
    row.style.opacity = '0';
    return row;
  });
  table.append(el('thead'), el('tbody'));
  table.tHead.append(head);
  table.tBodies[0].append(...rows);
  scene.stage.append(table);
  for (const row of rows) {
    await scene.fade(row, 1, 190);
  }
}
summary.once = true;

// What comes of it: three things that emerge, then the numbers from Ponjo's
// own runtime, shown together once the outcomes are in place.
async function outcome(scene) {
  scene.stage.classList.add('arch-outcome');
  const GETS = [
    ['Parallel work on one board, with no branches.', 'Many agents and people edit at once; nothing to merge back.'],
    ['Coordination with no orchestrator.', 'One agent’s change is the next one’s cue.'],
    ['Always on, with no jobs.', 'Agents act whenever the board changes, whoever changed it. When nothing changes, nothing runs.'],
  ];
  const list = el('ul', 'arch-gets');
  const items = GETS.map(([what, why]) => {
    const item = el('li');
    item.append(el('b', '', what), ' ', el('span', '', why));
    item.style.opacity = '0';
    return item;
  });
  list.append(...items);
  const STATS = [
    ['0', 'actions lost'],
    ['1', 'runs per action, from 3.4'],
    ['0.25 s', 'per action, from 5.2 s'],
  ];
  const stats = el('div', 'arch-stats');
  for (const [value, what] of STATS) {
    const tile = el('div', 'arch-stat');
    tile.append(el('b', '', value), el('span', '', what));
    stats.append(tile);
  }
  const foot = el('p', 'arch-note', 'Open-card Hold’em on Ponjo’s runtime, with scripted agents. The ');
  const link = el('a', '', 'poker page');
  link.href = 'poker.html';
  const werewolf = el('a', '', 'Werewolf');
  werewolf.href = 'werewolf.html';
  const spy = el('a', '', 'Who’s the Spy');
  spy.href = 'spy.html';
  foot.append(link, ', built apart with a small runtime of its own, came to the same shape: a pure plan, a view per player, a writer that refuses stale moves. It now runs on this runtime, as do ', werewolf, ' and ', spy, ', where each seat sees only its own cards or role.');
  const body = el('div', 'arch-outcome-body');
  body.append(list, stats, foot);
  stats.style.opacity = foot.style.opacity = '0';
  scene.stage.append(body);

  for (const item of items) {
    await scene.fade(item, 1, 300);
  }
  await scene.fade(stats, 1, 380);
  await scene.fade(foot, 1, 240);
}
outcome.once = true;

// [eyebrow, the idea in a line, the scene]
// [the part it is in, its title, the idea in a line, the scene]
const CHAPTERS = [
  ['', '', '', cover],
  ['Difference 1 of 2', '', '', point('People and agents work on one board, at the same time,', 'instead of each on its own copy, taking turns.')],
  ['Difference 1: one board, at the same time', 'Each on its own copy', 'Each agent works on its own copy. Run two at once and one builds on a stale copy, so to stay correct they take turns: wait, review, redo.', delegate, 'problem'],
  ['Difference 1: one board, at the same time', 'One board', 'Everyone works on one board at once. Agents propose, and one writer lands each change in order; a change made on a stale board is refused, and the agent tries again on the new one.', blackboard, 'solution'],
  ['Difference 2 of 2', '', '', point('The board decides who acts next,', 'instead of an LLM handing on, or a chain of events.')],
  ['Difference 2: who acts next', 'Handed on by an LLM', 'With handoffs or a lead agent, an LLM decides who goes next: sometimes it forgets, or picks the wrong one. Nothing was lost. It was never sent.', handoff, 'problem'],
  ['Difference 2: who acts next', 'Seen on the board', 'An agent only does its own work. The change is the signal: code reads the board and finds who is due, the same every time.', seen, 'solution'],
  ['Difference 2: who acts next', 'Triggered by events', 'Pip is asleep when the baton comes. Miss one handoff, and the race stops. A durable queue keeps the baton, but someone still wires who runs next.', events, 'problem'],
  ['Difference 2: who acts next', 'Reconciled from state', 'The runtime watches the board and calls only whoever is due, again until it is done, as a thermostat reads the room. Nobody wires who goes next, and a missed call or a restart costs nothing: the board still shows who is due.', state, 'solution'],
  ['How it is built: both in one loop', 'Event-triggered, the common way', 'State lives in messages in flight and in each agent’s memory. Lose a message and the work is lost, and someone has to wire who triggers whom.', eventsArchitecture, 'problem'],
  ['How it is built: both in one loop', 'Blackboard', 'One board, one writer: people and agents propose changes, and the writer lands them in order (difference 1). The runtime reads the board to start whoever is due (difference 2).', architecture, 'solution'],
  ['Compared', 'The common ways to run many agents', '', summary],
  ['Outcome', 'What you get', 'What emerges when the board is the only state, and the runtime decides from it.', outcome],
];

// ---- the story: a chapter at a time, with Back, Next and a dot for each ----

const stage = document.querySelector('[data-stage]');
const caption = document.querySelector('[data-say]');
const kicker = document.querySelector('[data-kicker]');
const heading = document.querySelector('[data-heading]');
const back = document.querySelector('[data-back]');
const next = document.querySelector('[data-next]');
const dots = CHAPTERS.map(([name], i) => {
  const dot = button('', 'arch-dot');
  dot.setAttribute('aria-label', [name, CHAPTERS[i][1]].filter(Boolean).join(': ') || 'Start');
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
  const [part, name, idea, play, role] = CHAPTERS[i];
  kicker.textContent = part;
  heading.textContent = name;
  if (role) heading.prepend(approachMark(role));
  caption.textContent = idea;
  dots.forEach((dot, j) => dot.toggleAttribute('aria-current', i === j));
  back.disabled = i === 0;
  next.textContent = i === 0 ? 'Start' : i === CHAPTERS.length - 1 ? 'Start over' : 'Next';
  const run = (scene = new Scene(stage));
  try {
    do {
      fitting = null;
      stage.replaceChildren();
      stage.className = 'arch-stage';
      await play(run);
    } while (!still && !play.once);
  } catch (error) {
    if (error !== STOPPED) throw error;
  }
}

// On a screen wider than tall, the story is a slide, 1280×720, scaled to the
// window (site.css); otherwise it runs down the page as it is.
const deck = document.querySelector('.arch-story');
const portrait = window.matchMedia('(max-aspect-ratio: 6/5), (max-width: 720px)');
function fitDeck() {
  const header = document.querySelector('.site-header').offsetHeight;
  deck.style.setProperty('--header-height', `${header}px`);
  deck.style.setProperty('--fit', portrait.matches ? 1 : Math.min((window.innerWidth - 32) / 1280, (window.innerHeight - header - 16) / 720));
  fitting?.();
}
window.addEventListener('resize', fitDeck);
motionPreference.addEventListener('change', () => {
  still = motionPreference.matches;
  open(current);
});
fitDeck();

back.addEventListener('click', () => open(current - 1));
next.addEventListener('click', () => open((current + 1) % CHAPTERS.length));
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') next.click();
  if (e.key === 'ArrowLeft' && current > 0) open(current - 1);
});

open(0);
