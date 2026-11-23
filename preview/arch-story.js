// The architecture page (site/architecture.html): the blackboard agent
// runtime (docs/runtime/vision.md) as chapters down the page, a screen each,
// each a looping animation with one line under it on the idea it shows; it
// plays while on screen. With reduced motion a chapter shows its last frame
// and holds still. preview/build.js bundles it into dist/preview.

/* global document, window, history, location, IntersectionObserver */

import { INK, agentFace, buddyColor, personFace, setBuddies, setOwner, setPeople } from '../web/faces.js';

const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let still = motionPreference.matches;
const STOPPED = Symbol('stopped');

setBuddies(['Clippy', 'Otto', 'Pip'].map((name) => ({ id: name, name })));
setOwner('You');
setPeople(['You']);

const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const f = (n) => n.toFixed(1);

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

// A board or a page drawn as lines, not words: a title and grey bars.
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
const fitters = new Map(); // a stage's sketch → refit it to the stage
function sketch(stage) {
  const fit = ([w, h]) => Math.min(stage.clientWidth / w, stage.clientHeight / h);
  const [W, H] = fit([400, 520]) > fit([760, 420]) * 1.15 ? [400, 520] : [760, 420];
  const box = el('div', 'arch-sketch');
  box.style.width = `${W}px`;
  box.style.height = `${H}px`;
  const refit = () => {
    box.style.scale = String(fit([W, H]));
  };
  fitters.set(stage, refit);
  refit();
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
// that throw STOPPED once it is over, and take no time with reduced motion
// or when `quiet`, which draws the chapter's last frame at once.
class Scene {
  constructor(stage, quiet = false) {
    this.stage = stage;
    this.quiet = quiet || still;
    this.stopped = false;
    this.timers = new Set();
  }

  check() {
    if (this.stopped) throw STOPPED;
  }

  wait(ms) {
    this.check();
    if (this.quiet) return Promise.resolve();
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
    return node.animate(keyframes, { duration: this.quiet ? 0 : ms, easing, fill: 'forwards' }).finished.then(() => this.check());
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

// Who watches the board wears glasses (faces.js): the buddies on the blackboard.
const watching = (on) => setBuddies(['Clippy', 'Otto', 'Pip'].map((name) => ({ id: name, name, watching: on })));

// A bar of a board, now `name`'s edit, in its colour.
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

// Delegate, with two agents, each in a room of its own: a copy of the board
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
  s.place(paper('Board', [80, 60, 70]), home, SIZE);
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

// One board, and one writer between it and everyone. Each member writes a
// proposal, a card with its line and the version it saw, and hands it to the
// writer; the writer checks it against the board and writes it there, the
// board a version on, or sends it back. Clippy's, made on v1, is written
// (v2); yours, made on v2, too (v3). Otto's, made on v1 while those landed,
// comes in at v3 and is sent back: Otto looks again, proposes on v3, and it
// is written (v4). Nobody but the writer touches the board.
async function blackboard(scene) {
  watching(true);
  const s = sketch(scene.stage);
  const up = s.upright;
  // members, their cards, the writer and the board, in a line: left to right, or bottom to top
  const L = up ? {
    board: [[200, 80], [340, 130]], desk: [[200, 205], [128, 48]], inbox: [200, 270], into: [200, 130],
    at: { Clippy: [75, 430], You: [200, 430], Otto: [325, 430] }, card: (x) => [x, 355],
    wire: ([x, y]) => `M${f(x)} ${f(y - 20)} C${f(x)} ${f(y - 42)} 200 312 200 290`,
    writes: ['M200 181 V145', [232, 163]],
  } : {
    board: [[640, 210], [230, 300]], desk: [[420, 210], [120, 56]], inbox: [300, 210], into: [600, 210],
    at: { Clippy: [60, 95], You: [60, 210], Otto: [60, 325] }, card: (y) => [160, y - 15],
    wire: ([x, y]) => `M${f(x + 45)} ${f(y)} C${f(x + 80)} ${f(y)} 220 210 255 210`,
    writes: ['M480 210 H525', [502, 192]],
  };
  const board = s.place(paper('Board', [85, 60]), ...L.board);
  board.classList.add('arch-board');
  let version = 1;
  const stamp = el('span', 'arch-version', 'v1');
  board.firstChild.append(stamp);
  const writer = s.place(el('div', 'arch-writer'), ...L.desk);
  const check = el('span', '', '');
  writer.append(el('b', '', 'Writer'), check);
  s.ink(L.writes[0], 'arch-ink arch-wire');
  s.place(el('span', 'arch-label', 'writes'), L.writes[1]);
  const who = {};
  const cards = {};
  for (const [name, at] of Object.entries(L.at)) {
    who[name] = actor(name, 'idle');
    s.place(who[name].node, at);
    cards[name] = L.card(up ? at[0] : at[1]);
    s.ink(L.wire(cards[name]), 'arch-ink arch-wire');
  }

  // `name` writes a proposal on the version it sees, on a card beside it
  const propose = async (name, width, ms) => {
    const card = s.place(el('div', 'arch-paper arch-proposal'), cards[name], [90, 40]);
    const line = bar(width);
    paint(line, name);
    card.append(line, el('span', '', `on v${version}`));
    card.on = version;
    card.width = width;
    who[name].face.dataset.presence = 'working';
    pose(who[name], { arms: 'write' });
    if (!still) who[name].parts['arms-write'].animate([{ rotate: '-6deg' }, { rotate: '8deg' }, { rotate: '-6deg' }], { duration: 300, iterations: Math.round(ms / 300) });
    await scene.move(line, [{ width: '0%' }, { width: `${width}%` }], ms, 'ease-in-out');
    who[name].face.dataset.presence = 'idle';
    pose(who[name], {});
    return card;
  };
  // the writer takes it: on the board's version, it writes it; else, back it goes
  let busy = Promise.resolve();
  const hand = (name, card) => (busy = busy.then(async () => {
    await scene.move(card, [s.at(cards[name]), s.at(L.inbox)], 560);
    const fresh = card.on === version;
    check.textContent = fresh ? `v${card.on} = v${version} ✓` : `v${card.on} ≠ v${version} ✕`;
    writer.classList.add(fresh ? 'arch-writer-ok' : 'arch-writer-no');
    await scene.wait(800);
    if (fresh) {
      await Promise.all([scene.move(card, [s.at(L.inbox), s.at(L.into)], 420), scene.fade(card, 0, 260)]);
      card.remove();
      const written = bar(card.width);
      paint(written, name);
      board.append(written);
      version += 1;
      stamp.textContent = `v${version}`;
      await Promise.all([
        scene.move(written, [{ scale: '0 1' }, { scale: '1 1' }], 360, 'ease-out'),
        scene.move(stamp, [{ scale: '1.5' }, { scale: '1' }], 360, SPRING),
      ]);
    } else {
      card.classList.add('arch-refused');
      await scene.move(card, [s.at(L.inbox), s.at(cards[name])], 560);
      await scene.fade(card, 0, 300);
      card.remove();
    }
    check.textContent = '';
    writer.classList.remove('arch-writer-ok', 'arch-writer-no');
    return fresh;
  }));

  await scene.wait(700);
  const otto = propose('Otto', 50, 3600); // made on v1, and slow
  otto.catch(() => {}); // stopped before it is awaited: the await below throws it
  await hand('Clippy', await propose('Clippy', 75, 1000));
  await hand('You', await propose('You', 55, 1000));
  if (!(await hand('Otto', await otto))) {
    pose(who.Otto, { look: 'shocked' });
    await hop(scene, who.Otto, 12, 480);
    pose(who.Otto, {});
    await scene.wait(500);
    await hand('Otto', await propose('Otto', 50, 900));
  }
  await scene.wait(2400);
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
  if (scene.quiet) return;

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
      ['people', 'writer', 'change'],
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

// One runtime, many worlds: three boards, an editor's page, a poker table
// and a werewolf village, and one runtime as an eye under them, a wire to
// each. It looks at each in turn and calls an agent there: on the page Clippy
// writes a line, at the table Otto's card turns up, in the village, asleep
// at night, Pip wakes.
async function worlds(scene) {
  const s = sketch(scene.stage);
  const up = s.upright;
  const size = up ? [106, 104] : [200, 124];
  const spots = up ? [[70, 100], [200, 100], [330, 100]] : [[140, 100], [380, 100], [620, 100]];
  const middle = up ? [200, 360] : [380, 320];
  const page = paper('Editor', [80, 55]);
  const table = paper('Poker', []);
  const cards = el('div', 'arch-cards');
  for (const name of ['Clippy', 'Otto', 'Pip']) {
    const card = el('i', 'arch-card');
    card.style.setProperty('--buddy', buddyColor(name));
    cards.append(card);
  }
  table.append(cards);
  const village = paper('Werewolf', []);
  const folk = el('div', 'arch-village');
  const sleepers = ['Clippy', 'Otto', 'Pip'].map((name) => face(name, { presence: 'away' }));
  folk.append(...sleepers);
  village.append(folk);
  const boards = [page, table, village];
  const wires = boards.map((board, i) => {
    s.place(board, spots[i], size).classList.add('arch-board');
    const [x, y] = [spots[i][0], spots[i][1] + size[1] / 2 + 8];
    return s.ink(`M${f(middle[0])} ${f(middle[1] - 40)} C${f(middle[0])} ${f(middle[1] - 110)} ${f(x)} ${f(y + 70)} ${f(x)} ${f(y)}`, 'arch-ink arch-wire');
  });
  const { node, pupil, lid } = eye();
  s.place(node, middle, [92, 92]);
  s.place(el('span', 'arch-label', 'One runtime'), [middle[0], middle[1] + 52]);
  lid.style.scale = '1 0';
  const look = (to) => {
    const [dx, dy] = [to[0] - middle[0], to[1] - middle[1]];
    const k = 12 / Math.max(1, Math.hypot(dx, dy));
    const translate = `${f(dx * k)}px ${f(dy * k)}px`;
    return scene.move(pupil, [{ translate: pupil.style.translate || '0 0' }, { translate }], 320, 'ease-in-out').then(() => { pupil.style.translate = translate; });
  };
  const call = async (i) => {
    await look(spots[i]);
    const pulse = s.ink(wires[i].getAttribute('d'), 'arch-ink arch-pulse');
    await scene.draw(pulse, 500);
    pulse.remove();
  };

  await scene.wait(700);
  // the editor: Clippy writes a line
  await call(0);
  const line = bar(70);
  paint(line, 'Clippy');
  page.append(line);
  await scene.move(line, [{ width: '0%' }, { width: '70%' }], 900, 'ease-in-out');
  await scene.wait(500);
  // poker: Otto's card turns up
  await call(1);
  const card = cards.children[1];
  await scene.move(card, [{ scale: '1 1' }, { scale: '0 1' }], 180, 'ease-in');
  card.classList.add('arch-up');
  await scene.move(card, [{ scale: '0 1' }, { scale: '1 1' }], 220, 'ease-out');
  await scene.wait(500);
  // werewolf: at night all asleep, Pip wakes
  await call(2);
  sleepers[2].dataset.presence = 'working';
  await scene.move(sleepers[2], [{ translate: '0 0' }, { translate: '0 -6px' }, { translate: '0 0' }], 420, SPRING);
  await scene.wait(900);
  sleepers[2].dataset.presence = 'away';
  await look(middle);
  await scene.wait(1800);
}

// The store, the world's two functions and a member's controller, each
// with what it does, and where the code is.
const CALLS = [
  ['store.commit(change)', 'Lands one change at a time on the board, or refuses it.'],
  ['store.wait(member, rev)', 'Returns once this member’s view has changed.'],
  ['world.view(state, member)', 'What this member may see and do, and what it is due to do.'],
  ['world.apply(state, change)', 'The board after the change, or why not, by the app’s rules.'],
  ['control(client, { program })', 'One per member: hands its tasks to its program, a person’s screen or an agent.'],
];
const SOURCES = ['src/core/store.js', 'src/core/controller.js', 'src/core/ledger.js'];
function calls(scene) {
  scene.stage.classList.add('arch-api');
  const list = el('dl', 'arch-calls');
  for (const [call, what] of CALLS) list.append(el('dt', '', call), el('dd', '', what));
  const sources = el('span', 'arch-source');
  for (const [i, file] of SOURCES.entries()) {
    const source = el('a', 'arch-source', file);
    source.href = `https://github.com/ponjo-app/ponjo/blob/main/${file}`;
    sources.append(...(i ? [' · '] : []), source);
  }
  scene.stage.append(list, sources);
}
calls.once = true;

// The common way, an orchestrator, against Ponjo's controller, as
// docs/runtime/vision.md compares them: [the way, who uses it], then a row
// per difference.
const WAYS = [
  ['Orchestrator', 'Claude Code subagents, OpenAI Agents SDK, CrewAI'],
  ['Controller', 'Ponjo’s runtime'],
];
const DIFFERENCES = [
  ['1 · At once', 'Each agent on its own copy', 'Everyone on one board'],
  ['1 · People', 'Hand off, then review', 'Act beside the agents'],
  ['2 · Who acts next', 'An LLM decides', 'Code reads the board'],
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
    ['Parallel work on one board,', 'with no branches.'],
    ['Coordination', 'with no orchestrator.'],
    ['Always on,', 'with no jobs.'],
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
  const foot = el('p', 'arch-note', 'Hold’em on this runtime, with scripted agents. Play: ');
  const link = el('a', '', 'Poker');
  link.href = 'poker.html';
  const werewolf = el('a', '', 'Werewolf');
  werewolf.href = 'werewolf.html';
  const spy = el('a', '', 'Who’s the Spy');
  spy.href = 'spy.html';
  foot.append(link, ', ', werewolf, ', ', spy, '.');
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
  ['1 · One board, at the same time', 'Each on its own copy', 'Copies go stale, so agents take turns.', delegate, 'problem'],
  ['1 · One board, at the same time', 'One board', 'Agents only propose. One writer changes the board, in order, and sends back a stale proposal.', blackboard, 'solution'],
  ['Difference 2 of 2', '', '', point('The board decides who acts next,', 'instead of an LLM handing on, or a chain of events.')],
  ['2 · Who acts next', 'Handed on by an LLM', 'An LLM decides who goes next. When it forgets, the work stops.', handoff, 'problem'],
  ['2 · Who acts next', 'Seen on the board', 'Code reads the board and finds who is due.', seen, 'solution'],
  ['2 · Who acts next', 'Triggered by events', 'Miss one event, and the race stops.', events, 'problem'],
  ['2 · Who acts next', 'Reconciled from state', 'A missed call, a restart: the board still shows who is due.', state, 'solution'],
  ['How it is built', 'Event-triggered, the common way', 'The state is in messages and agents’ memories. Lose one, lose the work.', eventsArchitecture, 'problem'],
  ['How it is built', 'Blackboard', 'The board is the only state. The runtime reads it and starts whoever is due.', architecture, 'solution'],
  ['How it is built', 'One runtime, many worlds', 'The same runtime, whatever the app.', worlds],
  ['How it is built', 'A store, a world, a controller', 'Write the world’s two functions, and the runtime runs agents in your app.', calls],
  ['Compared', 'Orchestrator or controller', '', summary],
  ['Outcome', 'What you get', '', outcome],
];

// ---- the story: on a wide screen, pages turned one at a time; on a phone, down the page ----

// Each chapter is a section. On a screen wider than tall they are a stack of
// pages: a turn of the wheel or the trackpad, an arrow, PageDown or Space
// turns exactly one, the page on top sliding up off the next (or the one
// before dropping back over it), the same every time; the page on top plays.
// On a phone they run down the page, and a chapter plays once mostly in
// view, until it is out of it. A chapter not playing shows its last frame.
// A bar under the header names the parts and lights the current one; each
// chapter has a link.
const slug = (words) => words.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const main = document.querySelector('.arch-slides');
const partsBar = document.querySelector('[data-parts]');
const parts = new Map(); // the part's name in the bar → its link
const chapters = CHAPTERS.map(([part, name, idea, play, role], i) => {
  const section = el('section', 'arch-frame');
  section.id = i ? slug(name || part) : 'start';
  const story = el('div', 'arch-story');
  const head = el('header', 'arch-head');
  const heading = el('h2', 'arch-heading', name);
  if (role) heading.prepend(approachMark(role));
  head.append(el('p', 'arch-kicker', part), heading);
  const stage = el('div', 'arch-stage');
  story.append(head, stage, el('p', 'arch-say', idea));
  section.append(story);
  main.append(section);
  const label = part.replace(/^Difference (\d) of 2$/, '$1').replace(/^(\d) · .*/, '$1');
  const title = { 1: '1 · One board', 2: '2 · Who acts next' }[label] ?? part;
  if (i && !parts.has(title)) {
    const link = el('a', '', title);
    link.href = `#${section.id}`;
    parts.set(title, link);
    partsBar.append(link);
  }
  return { section, stage, play, title: i ? title : null, scene: null };
});

// Chapter `c`, played over and over (or drawn still, `quiet`) until stopped.
async function show(c, quiet) {
  c.scene?.stop();
  const scene = (c.scene = new Scene(c.stage, quiet));
  try {
    do {
      fitters.delete(c.stage);
      c.stage.replaceChildren();
      c.stage.className = 'arch-stage';
      await c.play(scene);
    } while (!scene.quiet && !c.play.once);
  } catch (error) {
    if (error !== STOPPED) throw error;
  }
}

const portrait = window.matchMedia('(max-aspect-ratio: 6/5), (max-width: 720px)');
const paged = () => !portrait.matches;

// The chapter playing, the others drawn still, and its part lit in the bar.
let playing = null;
function play(c) {
  if (playing === c) return;
  if (playing) show(playing, true);
  playing = c;
  show(c, false);
  for (const [title, link] of parts) link.toggleAttribute('aria-current', title === c.title);
  const lit = parts.get(c.title);
  if (lit) partsBar.scrollTo({ left: lit.offsetLeft - (partsBar.clientWidth - lit.offsetWidth) / 2, behavior: 'smooth' });
}

// Paged: the page on top turns to page `to`, as a sheet of paper.
let current = 0;
let turning = false;
async function turn(to) {
  to = Math.max(0, Math.min(chapters.length - 1, to));
  if (to === current || turning) return;
  turning = true;
  const from = chapters[current];
  const next = chapters[to];
  const forward = to > current;
  current = to;
  history.replaceState(null, '', `#${next.section.id}`);
  play(next);
  next.section.dataset.page = forward ? 'under' : 'over';
  from.section.dataset.page = forward ? 'over' : 'under';
  const off = [{ translate: '0 0' }, { translate: '0 -100%' }];
  const sheet = (forward ? from : next).section.animate(forward ? off : off.reverse(), { duration: still ? 0 : 520, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
  await sheet.finished;
  delete from.section.dataset.page;
  next.section.dataset.page = 'top';
  sheet.cancel();
  turning = false;
}

// One gesture, one page: a burst of wheel events (a trackpad's glide too)
// turns once, and the next turn waits for a pause.
let resting = true;
let rest = null;
window.addEventListener('wheel', (event) => {
  if (!paged() || event.ctrlKey) return;
  event.preventDefault();
  clearTimeout(rest);
  rest = setTimeout(() => { resting = true; }, 220);
  if (!resting || Math.abs(event.deltaY) < 4) return;
  resting = false;
  turn(current + Math.sign(event.deltaY));
}, { passive: false });
const KEYS = { ArrowDown: 1, ArrowRight: 1, PageDown: 1, ArrowUp: -1, ArrowLeft: -1, PageUp: -1 };
document.addEventListener('keydown', (event) => {
  if (!paged() || event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input, textarea, select, button, summary')) return;
  const step = event.key === ' ' ? (event.shiftKey ? -1 : 1) : KEYS[event.key];
  const to = event.key === 'Home' ? 0 : event.key === 'End' ? chapters.length - 1 : step && current + step;
  if (to === undefined) return;
  event.preventDefault();
  turn(to);
});
let touchY = null;
main.addEventListener('touchstart', (event) => { touchY = event.touches[0].clientY; }, { passive: true });
main.addEventListener('touchend', (event) => {
  const dy = touchY - event.changedTouches[0].clientY;
  if (paged() && Math.abs(dy) > 40) turn(current + Math.sign(dy));
});
const byId = (id) => chapters.findIndex((c) => c.section.id === id);
window.addEventListener('hashchange', () => {
  if (paged() && byId(location.hash.slice(1)) >= 0) turn(byId(location.hash.slice(1)));
});
partsBar.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || !paged()) return;
  event.preventDefault();
  turn(byId(link.hash.slice(1)));
});

// Down the page: the chapter mostly in view plays, until it is out of view.
const watcher = new IntersectionObserver((entries) => {
  if (paged()) return;
  for (const { target, intersectionRatio } of entries) {
    const c = chapters.find((chapter) => chapter.section === target);
    if (intersectionRatio >= 0.5) play(c);
    else if (intersectionRatio === 0 && playing === c) {
      playing = null;
      show(c, true);
    }
  }
}, { threshold: [0, 0.5] });
for (const c of chapters) watcher.observe(c.section);

// Pages or the page, as the screen is: the chapter in view stays the one.
function layout() {
  main.classList.toggle('arch-paged', paged());
  for (const c of chapters) delete c.section.dataset.page;
  if (paged()) {
    chapters[current].section.dataset.page = 'top';
    play(chapters[current]);
  } else if (current) {
    chapters[current].section.scrollIntoView();
  }
  fit();
}

// A slide is 1280×720, scaled to the screen left under the header and the
// bar (site.css); on a phone, the page as it is.
function fit() {
  const top = document.querySelector('.site-header').offsetHeight + partsBar.offsetHeight;
  document.documentElement.style.setProperty('--header-height', `${top - partsBar.offsetHeight}px`);
  document.documentElement.style.setProperty('--top', `${top}px`);
  main.style.setProperty('--fit', paged() ? Math.min((window.innerWidth - 32) / 1280, (window.innerHeight - top - 16) / 720) : 1);
  for (const refit of fitters.values()) refit();
}
window.addEventListener('resize', fit);
portrait.addEventListener('change', layout);
motionPreference.addEventListener('change', () => {
  still = motionPreference.matches;
  for (const c of chapters) show(c, c !== playing);
});
for (const c of chapters) show(c, true);
current = Math.max(0, byId(location.hash.slice(1)));
layout();
