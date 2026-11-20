// Avatars: a face drawn from the id (a person's, the name): a body, each a
// little uneven as if drawn by hand, and a colour. Every face has the same
// eyes and mouth, so an expression means the same thing on every face; what
// it shows is how it is (life.js), not who it is. People are round, wear a hat that says
// who they are on the project (the owner a crown, a teammate a top hat) and
// keep their face everywhere. Buddies in a doc take bodies as unlike each
// other's as can be (setBuddies), and a colour no other buddy there has
// (colorSlots); people there take the colours the buddies left (setPeople).
//
// Everything is drawn in a 100×100 box. Strokes and dots are sized to stay
// legible down to the 18px faces in a thread's footer; below 24px the
// extras and the tilt go (app.css), so a face stays plain.

import { colorSlots } from '../src/core/buddies.js';
import { liven } from './life.js';

const NS = 'http://www.w3.org/2000/svg';
/** The ink of every face's features. */
export const INK = '#1f1d24';
const STROKE = 5.5;
const GOLD = '#f5b301'; // the owner's crown

// [lightness, chroma, hue] in OKLCH: eight hues evenly apart, sunflower
// first, a touch lighter so it reads as yellow.
const COLORS = [[0.84, 0.17, 85], ...[135, 180, 225, 270, 315, 0, 45].map((hue) => [0.78, 0.14, hue])];
let slots = colorSlots([]);
let looks = new Map();

let names = new Map(); // buddy id → its name now
let watchers = new Set(); // the ids of the buddies watching this doc
let buddyIds = [];
let people = []; // the names of the people in this doc
let owner = null; // the owner's id: the one person with a crown

/** The owner's id, so their face wears the crown and everyone else's a top hat. */
export function setOwner(id) {
  owner = id;
}

export const isOwner = (id) => id === owner;

/** The buddies in this doc ([{ id, name, watching }]), so their faces and colours differ, and watchers wear glasses. */
export function setBuddies(buddies) {
  names = new Map(buddies.map((b) => [b.id, b.name]));
  watchers = new Set(buddies.filter((b) => b.watching).map((b) => b.id.toLowerCase()));
  buddyIds = buddies.map((b) => b.id);
  looks = spread([...colorSlots(buddyIds).keys()]);
  recolor();
}

/**
 * The names of the people in this doc, so their colours differ from each
 * other's and the buddies'; whether any of their colours changed.
 */
export function setPeople(list) {
  const before = people.map((name) => slots.get(name.toLowerCase()));
  people = list;
  recolor();
  return people.length !== before.length || people.some((name, i) => slots.get(name.toLowerCase()) !== before[i]);
}

// The buddies keep theirs, so their edits keep their colour; people take what is left.
function recolor() {
  const own = colorSlots(buddyIds);
  slots = new Map([...own, ...colorSlots(people, new Set(own.values()))]);
}

/** Buddy `id`'s name now; `fallback` (the name in a comment) when it is not here. */
export const nameOf = (id, fallback = id) => names.get(id) ?? fallback;

/** Buddy `id`'s colour (a person's: the name), a little lighter (`lift` > 0) or darker. */
export function buddyColor(id, lift = 0) {
  const [lightness, chroma, hue] = colorOf(id);
  return `oklch(${(lightness + lift).toFixed(2)} ${chroma} ${hue})`;
}

function colorOf(name) {
  const key = name.toLowerCase();
  return COLORS[slots.get(key) ?? colorSlots([key]).get(key)];
}

let ids = 0; // gradient ids, unique per page

/** @param {string} id @param look its parts, when not the ones it draws (the site's mascot wears the logo's) */
export const agentFace = (id, look = looks.get(id.toLowerCase()) ?? drawn(id)) => face(id, look, look.body, null, () => watchers.has(id.toLowerCase()));

/** @param {string} name @param {string} id */
export const personFace = (name, id = name) => face(name, drawn(name), 'circle', isOwner(id) ? 'crown' : 'tophat');

function face(name, look, kind = look.body, hat = null, watches = undefined) {
  const body = drawBody(kind, name);
  const svg = node('svg', { viewBox: '0 0 100 100', class: 'pj-face', 'aria-hidden': 'true' });
  const id = `pj-face-${++ids}`;
  const gradient = node('radialGradient', { id, cx: '0.34', cy: '0.28', r: '0.9' });
  const stops = [buddyColor(name, 0.08), buddyColor(name), buddyColor(name, -0.07)];
  gradient.append(...[0, 0.55, 1].map((offset, i) => node('stop', { offset: String(offset), 'stop-color': stops[i] })));
  const defs = node('defs', {});
  defs.append(gradient);

  // The whole face tilts a touch, body and all, a hat a little more. `pose`
  // around it is where life.js moves the face as a whole.
  const pose = node('g', { class: 'pj-face-pose' });
  const tilted = node('g', { class: 'pj-face-tilt', transform: `rotate(${f(look.tilt)} 50 50)` });
  const features = node('g', { class: 'pj-face-look' });
  tilted.append(node('path', { class: 'pj-face-body', d: body.d, fill: `url(#${id})` }), features);
  const lag = hat ? node('g', { class: 'pj-face-hat-lag' }) : null;
  if (hat) {
    lag.append(drawHat(hat, look.tilt));
    tilted.append(lag);
  }
  pose.append(tilted);
  svg.append(defs, pose);
  const parts = drawFace(features, look, body.cy, colorOf(name)[2]);
  liven(svg, { pose, look: features, hat: lag, ...parts }, name, watches);
  return svg;
}

// A crown or a top hat on the head, tipped the way the face leans: a flat
// silhouette, a crown in gold, a top hat in the text's colour so it reads on
// any page.
const HATS = {
  crown: 'M28 28L25 8L38.5 17.5L50 3L61.5 17.5L75 8L72 28Z',
  tophat: 'M35 22L36 3Q50 0 64 3L65 22Q77 23 79 25Q80 30 74 30L26 30Q20 30 21 25Q23 23 35 22Z',
};

// It sits on the crown of the head, a little above the box.
function drawHat(hat, tilt) {
  const tipped = node('g', { class: 'pj-face-tilt', transform: `rotate(${f(tilt * 0.5 + (tilt < 0 ? -6 : 6))} 50 8)` });
  const color = hat === 'crown' ? GOLD : 'currentColor';
  tipped.append(node('path', { class: 'pj-face-hat', d: HATS[hat], fill: color, stroke: color, 'stroke-width': '3', 'stroke-linejoin': 'round', transform: 'translate(50 13) scale(0.68) translate(-50 -30)' }));
  return tipped;
}

// The parts `name` picks, drawn from the name.
function drawn(name) {
  const rand = random(seed(name));
  const body = pick(rand, BODIES);
  const tilt = range(rand, -7, 7);
  return { body, tilt };
}

// The buddies in turn: each takes the body fewest before have, the first
// such from the one its name picks, so faces in a doc differ as much as they can.
function spread(names) {
  const counts = new Map();
  const count = (option) => counts.get(option) ?? 0;
  const result = new Map();
  for (const name of names) {
    const look = { ...drawn(name) };
    const start = BODIES.indexOf(look.body);
    look.body = [...BODIES.slice(start), ...BODIES.slice(0, start)].reduce((best, option) => (count(option) < count(best) ? option : best));
    counts.set(look.body, count(look.body) + 1);
    result.set(name, look);
  }
  return result;
}

// ---- the body ----

// Five shapes far enough apart to tell at 18px. `FACE_Y` is where the face
// sits: lower where the body is wide below.
const UP = -Math.PI / 2;
const BODIES = ['circle', 'square', 'triangle', 'pentagon', 'cloud'];
const FACE_Y = { circle: 52, square: 52, triangle: 60, pentagon: 55, cloud: 52 };

// Body `kind` as `name` draws it: corners a touch off and the outline gently
// uneven, as if by hand, and the same every time.
function drawBody(kind, name) {
  const rand = random(seed(name) + 1);
  let points;
  if (kind === 'circle') {
    points = ring(() => 1);
  } else if (kind === 'cloud') {
    const turn = rand() * Math.PI;
    points = ring((t) => 1 + 0.085 * (2 * Math.abs(Math.cos(3 * (t + turn))) ** 0.5 - 1));
  } else {
    const [sides, start, round, bulge] = { square: [4, Math.PI / 4, 0.32, 0], triangle: [3, UP, 0.36, 0.3], pentagon: [5, UP, 0.3, 0] }[kind];
    const corners = Array.from({ length: sides }, (_, i) => {
      const t = start + (i / sides) * Math.PI * 2 + range(rand, -0.05, 0.05);
      const r = 1 + range(rand, -0.04, 0.04);
      return [r * Math.cos(t), r * Math.sin(t)];
    });
    points = puff(roundCorners(corners, corners.map(() => round + range(rand, -0.04, 0.04))), bulge);
  }
  // Slow waves in the outline, so no side is quite straight and no curve quite even.
  const waves = [2, 3].map((k) => [k, range(rand, 0.006, 0.016), rand() * Math.PI * 2]);
  points = points.map(([x, y]) => {
    const t = Math.atan2(y, x);
    const s = 1 + waves.reduce((sum, [k, amp, phase]) => sum + amp * Math.cos(k * t + phase), 0);
    return [x * s, y * s];
  });
  return { d: outline(points), cy: FACE_Y[kind] };
}

function ring(radius) {
  return Array.from({ length: 160 }, (_, i) => {
    const t = (i / 160) * Math.PI * 2;
    return [radius(t) * Math.cos(t), radius(t) * Math.sin(t)];
  });
}

// Cut each corner `fracs[i]` of the way along its edges and curve through it.
function roundCorners(corners, fracs) {
  const points = [];
  corners.forEach((c, i) => {
    const prev = corners.at(i - 1);
    const next = corners[(i + 1) % corners.length];
    const a = [c[0] + (prev[0] - c[0]) * fracs[i], c[1] + (prev[1] - c[1]) * fracs[i]];
    const b = [c[0] + (next[0] - c[0]) * fracs[i], c[1] + (next[1] - c[1]) * fracs[i]];
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      const w = [(1 - t) ** 2, 2 * (1 - t) * t, t * t];
      points.push([0, 1].map((k) => w[0] * a[k] + w[1] * c[k] + w[2] * b[k]));
    }
  });
  return points;
}

// Push the edges out toward a circle, so straight sides bulge a little.
function puff(points, amount) {
  const max = Math.max(...points.map(([x, y]) => Math.hypot(x, y)));
  return points.map(([x, y]) => {
    const s = 1 - amount + (amount * max) / Math.hypot(x, y);
    return [x * s, y * s];
  });
}

// A closed path through `points`, fitted to the box, centred, with a hair of
// room for anti-aliasing.
function outline(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 96 / Math.max(maxX - minX, maxY - minY);
  const fit = points.map(([x, y]) => `${(50 + (x - (minX + maxX) / 2) * scale).toFixed(1)} ${(50 + (y - (minY + maxY) / 2) * scale).toFixed(1)}`);
  return `M${fit.join('L')}Z`;
}

// ---- the face ----

// One set of eyes and one mouth for every face, drawn from an expression, so
// "asleep" or "pleased" looks the same on all of them. Few shapes, each
// clear down to 18px:
//
//   eyes  open   upright ovals with a glint (the glint goes below 24px)
//         shut   ‿ ‿  resting, asleep, and the middle of a blink
//         happy  ^ ^  pleased
//         wince  > <  it went wrong
//   mouth one curve from corner to corner: up is a smile, down a frown;
//         open, a second curve under it, filled; round, its top lifts into an o.
//
// An open eye never half-closes: lids are open or shut, as in a cartoon, so
// a face never looks sly or bored. Eyes change shape behind a blink (life.js).
//
//   shape  open, happy or wince (an open eye with lid 0 is shut)
//   lid    0 shut … 1 open; a happy or wince eye pops in with it
//   size   how big the open eyes are: 1 as drawn, more wide and eager, with a second glint
//   ex, ey where the eyes look
//   curve  -1 frown … 1 smile;  open 0 … 1;  round 0 … 1;  width;  mx  the mouth to a side
export const REST = Object.freeze({ shape: 'open', lid: 1, size: 1, ex: 0, ey: 0, curve: 0.55, open: 0, round: 0, width: 6, mx: 0 });

const GAP = 13; // from the middle to each eye

function drawFace(g, look, cy, hue) {
  const eyeY = cy - 6;
  const mouthY = eyeY + 12;

  // Soft cheeks under everything else, every face; gone below 24px (app.css).
  const extras = node('g', { class: 'pj-face-extra' });
  // pink reads warm on warm faces; on cool ones it needs more of itself or it turns grey
  const blush = hue > 320 || hue < 15 ? 'hsl(350 85% 50% / 0.4)' : hue > 120 && hue < 290 ? 'hsl(345 100% 72% / 0.8)' : 'hsl(350 95% 72% / 0.55)';
  const cheeks = [-1, 1].map((side) => node('ellipse', { cx: f(50 + side * (GAP + 6)), cy: f(eyeY + 8), rx: '5', ry: '3', fill: blush }));
  extras.append(...cheeks);
  g.append(extras);

  const eyes = node('g', { class: 'pj-face-eyes' });
  const paintEyes = [-1, 1].map((side) => eyeOf(eyes, 50 + side * GAP, eyeY, side));
  g.append(eyes);

  // Glasses a buddy wears for as long as it watches the doc, whatever it is
  // doing (life.js, app.css), and only then: no face wears glasses of its
  // own. Round lenses on its eyes, apart, with a bridge over the nose.
  const watch = node('g', { class: 'pj-face-watch' });
  const half = 17;
  for (const side of [-1, 1]) watch.append(node('circle', { cx: f(50 + side * half), cy: f(eyeY), r: '12', fill: 'rgba(255,255,255,0.28)', stroke: INK, 'stroke-width': '4' }));
  watch.append(stroke(`M${f(50 - half + 12)} ${f(eyeY - 1.5)}Q50 ${f(eyeY - 7)} ${f(50 + half - 12)} ${f(eyeY - 1.5)}`, 4));
  g.append(watch);

  const paintMouth = mouthOf(g, 50, mouthY, hue);

  const paint = (e) => {
    for (const p of paintEyes) p(e);
    paintMouth(e);
    // a smile lifts the cheeks; they follow the face as it turns
    const lift = Math.max(0, e.curve) * 1.5 + (e.shape === 'happy' ? 1.5 : 0);
    cheeks.forEach((c, i) => {
      c.setAttribute('cy', f(eyeY + 8 - lift));
      c.setAttribute('cx', f(50 + (i ? 1 : -1) * (GAP + 6) + e.ex * 0.3));
    });
  };
  paint(REST);
  return { paint };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const K = 0.5523; // a quarter circle as a cubic

// Half an ellipse from (x - r, y) over to (x + r, y), `h` above the line (below if negative)…
const halfArc = (x, y, r, h) =>
  `C${f(x - r)} ${f(y - K * h)} ${f(x - K * r)} ${f(y - h)} ${f(x)} ${f(y - h)}C${f(x + K * r)} ${f(y - h)} ${f(x + r)} ${f(y - K * h)} ${f(x + r)} ${f(y)}`;
// …and back from the right, `h` below the line.
const halfArcBack = (x, y, r, h) =>
  `C${f(x + r)} ${f(y + K * h)} ${f(x + K * r)} ${f(y + h)} ${f(x)} ${f(y + h)}C${f(x - K * r)} ${f(y + h)} ${f(x - r)} ${f(y + K * h)} ${f(x - r)} ${f(y)}`;

// One eye at x, y (`side` -1 left, 1 right), and how to repaint it.
function eyeOf(g, x, y, side) {
  const oval = node('ellipse', { fill: INK });
  const glint = node('circle', { class: 'pj-face-glint', fill: '#fff' });
  const glint2 = node('circle', { class: 'pj-face-glint', fill: '#fff' }); // a small second one in a big eye
  const line = stroke('', 4.6);
  g.append(oval, glint, glint2, line);
  const show = (el, on) => el.setAttribute('visibility', on ? 'visible' : 'hidden');
  return (e) => {
    const lid = clamp(e.lid, 0, 1.25);
    const cx = x + e.ex, cy = y + e.ey;
    if (e.shape === 'open' && lid > 0.22) {
      // upright and a little tall: it reads as looking at you
      const size = clamp(e.size ?? 1, 0.7, 1.6);
      const rx = 4.4 * size * (1 + Math.max(0, lid - 1) * 0.5), ry = 5.6 * size * lid;
      oval.setAttribute('cx', f(cx));
      oval.setAttribute('cy', f(cy));
      oval.setAttribute('rx', f(rx));
      oval.setAttribute('ry', f(ry));
      glint.setAttribute('cx', f(cx + rx * 0.35));
      glint.setAttribute('cy', f(cy - ry * 0.43));
      glint.setAttribute('r', f(1.7 * Math.sqrt(size)));
      glint2.setAttribute('cx', f(cx - rx * 0.38));
      glint2.setAttribute('cy', f(cy + ry * 0.42));
      glint2.setAttribute('r', f(clamp((size - 1.1) * 3, 0, 1.1)));
      show(oval, true);
      show(glint, lid > 0.6);
      show(glint2, lid > 0.6 && size > 1.15);
      show(line, false);
      return;
    }
    show(oval, false);
    show(glint, false);
    show(glint2, false);
    show(line, true);
    if (e.shape === 'happy') {
      // ^ : pops up from flat as `lid` opens
      const h = 9 * clamp(lid, 0.1, 1.2);
      line.setAttribute('d', `M${f(cx - 5)} ${f(cy + 2)}Q${f(cx)} ${f(cy + 2 - h)} ${f(cx + 5)} ${f(cy + 2)}`);
    } else if (e.shape === 'wince') {
      // > < pointing in, squeezed tight
      const h = 4.6 * clamp(lid, 0.15, 1.2);
      line.setAttribute('d', `M${f(cx - side * 4.5)} ${f(cy - h)}L${f(cx + side * 3)} ${f(cy)}L${f(cx - side * 4.5)} ${f(cy + h)}`);
    } else {
      // shut: ‿, a little lower than the open eye's middle
      line.setAttribute('d', `M${f(cx - 5)} ${f(cy + 1)}Q${f(cx)} ${f(cy + 6)} ${f(cx + 5)} ${f(cy + 1)}`);
    }
  };
}

// The mouth at x, y, and how to repaint it.
function mouthOf(g, x, y, hue) {
  const el = node('path', { stroke: INK, 'stroke-width': '4.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const pink = hue > 320 || hue < 15 ? '#fff' : '#ff7a97';
  const tongue = node('ellipse', { fill: pink });
  g.append(el, tongue);
  return (e) => {
    const w = clamp(e.width, 2, 9);
    const curve = clamp(e.curve, -1, 1);
    const open = clamp(e.open, 0, 1.2);
    const cx = x + e.mx;
    const lift = curve * 1.4;
    const top = curve * 6 - open * e.round * 7; // a quadratic sags half way to its control point
    const depth = open * 13;
    const l = `${f(cx - w)} ${f(y - lift)}`, r = `${f(cx + w)} ${f(y - lift)}`;
    const filled = depth > 0.8;
    // open, it is two half ellipses, so its corners are soft and an o is round
    el.setAttribute('d', filled
      ? `M${l}${halfArc(cx, y - lift, w, -(top + lift) / 2)}${halfArcBack(cx, y - lift, w, (top + lift) / 2 + depth)}Z`
      : `M${l}Q${f(cx)} ${f(y + top)} ${r}`);
    el.setAttribute('fill', filled ? INK : 'none');
    el.setAttribute('stroke-width', filled ? '3' : '4.6');
    // a tongue in a happy open mouth, not in an o or a frown
    const showTongue = filled && curve > 0.2 && open > 0.35 && e.round < 0.5;
    tongue.setAttribute('visibility', showTongue ? 'visible' : 'hidden');
    if (showTongue) {
      tongue.setAttribute('cx', f(cx));
      tongue.setAttribute('cy', f(y - lift + top / 2 + depth * 0.75));
      tongue.setAttribute('rx', f(w * 0.45));
      tongue.setAttribute('ry', f(clamp(depth / 6, 0.5, 2.4)));
    }
  };
}

// ---- helpers ----

function stroke(d, width = STROKE) {
  return node('path', { d, fill: 'none', stroke: INK, 'stroke-width': String(width), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}

function node(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value);
  return n;
}

const f = (n) => (Math.round(n * 10) / 10).toString();
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const range = (rand, lo, hi) => lo + rand() * (hi - lo);

// FNV-1a, so similar names still land far apart.
function seed(name) {
  let h = 0x811c9dc5;
  for (const ch of name.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

// mulberry32
function random(state) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
