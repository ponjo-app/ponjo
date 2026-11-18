// Life: how a face shows what it is doing, and keeps looking alive while it does.
//
// One expression per state, the same on every face (faces.js draws them):
//
//   here / ready  facing you: eyes open, a small smile; it looks about and blinks
//   working       absorbed: eyes wide and bright, down on the doc, reading
//                 along the line, a small round mouth, the head dipping as it
//                 types; now and then ^ ^ at what it wrote
//   away          asleep: eyes shut ‿ ‿, the head low, breathing slow
//   failed        a wince > < and a shake of the head, then a sulk, eyes
//                 down and lip out, that eases back to its state
//
// And a few moments, each a whole small expression rather than a twitch:
// a smile (^ ^ and an open mouth), a tilt of the head, a glance at you, a
// look up to think (an o), a nod along. Finishing work, it looks up at you,
// pleased. Few, so each one reads.
//
// A buddy that watches the doc is a watcher, whatever its state: it wears its
// glasses throughout, and when ready it now and then reads over the doc, a
// line at a time, then looks up again.
//
// A face you can click (a button or a name card that is just the face) can be
// poked: pressed, it squashes; let go, it springs back and reacts as its state
// would. Ready, it hops and smiles ^ ^ at you; working, it looks up at you,
// pleased, and goes back to work; asleep, it starts awake, wide-eyed, and
// dozes off again.
//
// The body barely moves: a breath and the head's slow lean, from the neck.
// The eyes lead and the head follows a beat later, turning most of the way:
// the head shifts and rolls toward where it looks, and its features slide
// farther than its outline, so it reads as a round head turning, not a mask
// sliding. As the head catches up the eyes come back toward its middle. Every number is a damped
// spring, so moods blend; the eyes' shape (open, ^, > <) changes behind a
// blink and pops open in the new shape.
//
// One requestAnimationFrame loop drives every face on the page; faces off
// screen or detached are skipped. With reduced motion a face still shows its
// state's expression, but goes there at once and holds still. Faces read
// their state from the nearest [data-presence] and a failed run from
// .pj-failed on their .pj-avatar, so callers change nothing. A face in a
// [data-follow] looks at the pointer wherever it is on the page.
//
// Lengths are in the face's 100×100 box; angles in degrees.

const DT = 1 / 120; // springs step at a fixed 120 Hz, whatever the frame rate

const spring = (x = 0) => ({ x, v: 0, t: x });

// [stiffness (rad/s), damping ratio]. The lids pop (under 1); the head is slow.
const TUNE = {
  gazeX: [26, 0.95], gazeY: [26, 0.95],
  headX: [6.5, 0.8], headY: [6.5, 0.8], // a touch of overshoot, as a real head settles
  tilt: [3.5, 0.9], nod: [4.5, 0.9],
  lid: [30, 0.5], size: [12, 0.55],
  curve: [9, 0.85], open: [11, 0.75], round: [12, 1], width: [9, 0.85], mx: [6, 1],
  down: [5, 0.9], // the face lowered to the doc
  hat: [6, 0.45],
  squash: [16, 0.3], // pressed; let go, it bounces
};

function step(s, [freq, damp], dt) {
  s.v += (-2 * damp * freq * s.v - freq * freq * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t;
    s.v = 0;
  }
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const side = () => (Math.random() < 0.5 ? -1 : 1);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const bump = (e, dur) => (e < 0 || e > dur ? 0 : Math.sin((e / dur) * Math.PI)); // 0 → 1 → 0

const FACE = { shape: 'open', lid: 1, size: 1, curve: 0.55, open: 0, round: 0, width: 6, mx: 0, down: 0, tilt: 0, nod: 0 };

// Each state: its expression, how often it blinks, where it looks, its moments.
const STATES = {
  idle: {
    face: FACE,
    blink: [2600, 6000],
    gaze: () => (Math.random() < 0.4 ? { x: 0, y: 0, hold: [1600, 4000] } : { x: rand(-4.5, 4.5), y: rand(-2.5, 1), hold: [1100, 3200] }),
    moments: ['smile', 'tilt', 'glance'],
    every: [5000, 10000],
  },
  working: {
    // absorbed in the doc: eyes wide and bright, down on what it writes,
    // reading along the line, a small round mouth, the head dipping as it types
    face: { ...FACE, size: 1.4, curve: 0.1, open: 0.3, round: 0.75, width: 3, down: 2.5, nod: 0.6 },
    blink: [3200, 6500],
    typing: true,
    // reading as it writes: short steps along a line, then back to its start
    gaze: (face) => {
      face.line = (face.line ?? -2.5) + rand(1, 1.8);
      if (face.line > 2.5) face.line = -2.5;
      return { x: face.line, y: 3.5, hold: [260, 580] };
    },
    moments: ['pleased', 'think', 'nod'],
    every: [3500, 7000],
  },
  away: {
    face: { ...FACE, lid: 0, curve: 0.25, width: 3.5, tilt: 5, nod: 3 },
    blink: null,
    gaze: () => ({ x: 0, y: 1, hold: [4000, 8000] }),
    moments: [],
    every: [1e9, 1e9],
  },
};

// What each moment does while it lasts (e: seconds in, d: its side).
const MOMENTS = {
  smile: { dur: 1.8, at: (x, e) => { const k = bump(e, 1.8); if (k > 0.25) x.shape = 'happy'; x.curve += 0.4 * k; x.open += 0.45 * k; x.width += 1 * k; } },
  tilt: { dur: 1.9, at: (x, e, d) => { x.tilt += 8 * d * bump(e, 1.9); x.gaze = { x: 3.5 * d, y: -1 }; } },
  glance: { dur: 1.6, at: (x, e) => { x.gaze = { x: 0, y: -0.5 }; x.curve += 0.3 * bump(e, 1.6); } },
  pleased: { dur: 1.5, at: (x, e) => { const k = bump(e, 1.5); if (k > 0.25) x.shape = 'happy'; x.curve += 0.55 * k; x.open += 0.4 * k; x.width += 1.5 * k; x.mx *= 1 - k; x.down *= 1 - 0.5 * k; } },
  think: { dur: 2.2, at: (x, e, d) => { const k = bump(e, 2.2); x.gaze = { x: 4 * d, y: -4 }; x.tilt += 4 * d * k; x.nod -= 1.5 * k; x.curve *= 1 - k; x.open += 0.4 * k; x.round += k; x.width -= 2 * k; x.down *= 1 - k; } },
  // a watcher reading over the doc: along a line in small steps, the face lowered to it
  read: { dur: 3, at: (x, e, d) => {
    const k = Math.min(1, e / 0.4, (3 - e) / 0.4);
    x.gaze = { x: -3.5 + Math.floor(e / 0.45) * 1.2, y: 3 };
    x.down += 1.5 * k; x.tilt += 2 * d * k; x.curve -= 0.15 * k;
  } },
  nod: { dur: 0.8, at: (x, e) => { x.nod += 2.4 * bump(e, 0.4) + 1.2 * bump(e - 0.4, 0.4); } },
  // when its state changes
  settle: { dur: 0.9, at: (x, e) => { x.nod += 1.6 * bump(e, 0.9); } },
  done: { dur: 1.9, at: (x, e) => { const k = bump(e, 1.9); if (k > 0.2) x.shape = 'happy'; x.gaze = { x: 0, y: -0.5 }; x.curve += 0.45 * k; x.open += 0.55 * k; x.width += 1.5 * k; } },
  // poked
  poke: { dur: 1.3, at: (x, e) => {
    const k = bump(e, 1.3);
    if (k > 0.2) x.shape = 'happy';
    x.gaze = { x: 0, y: -0.5 };
    x.curve += 0.5 * k; x.open += 0.5 * k; x.width += 1.5 * k;
    x.down *= 1 - k; x.round *= 1 - k; x.mx *= 1 - k; // working, it looks up from the doc
    x.nod -= 5 * bump(e, 0.4); // a hop
  } },
  startle: { dur: 1.6, at: (x, e) => {
    const k = bump(e, 1.6);
    x.lid = k > 0.1 ? 1 : x.lid;
    x.gaze = { x: 0, y: -0.5 };
    x.size += 0.35 * k; x.round += k; x.open += 0.4 * k; x.curve *= 1 - k; x.width = 3;
    x.nod -= 3 * k + 3 * bump(e, 0.35); x.tilt *= 1 - k; // the head comes up with a jolt, then sinks back
  } },
  wake: { dur: 1.4, at: (x, e) => { const k = bump(e, 1.4); x.lid += 0.2 * k; x.open += 0.35 * k; x.round += k; x.curve *= 1 - k; x.width = 3; } },
  // a failed run: a wince and a shake of the head, then a frown that eases
  oops: { dur: 3, at: (x, e) => {
    if (e < 0.9) {
      const k = 1 - e / 0.9;
      x.shape = 'wince';
      x.tilt += Math.sin(e * 16) * 8 * k;
    }
    const k = e < 2 ? 1 : 1 - (e - 2) / 1; // a sulk of a second or so, then it eases
    x.curve = x.curve * (1 - k) - k;
    x.width = x.width * (1 - k) + 4 * k;
    x.open = x.open * (1 - k) + 0.08 * k;
    if (e >= 0.9) { x.gaze = { x: 0, y: 2.5 }; x.nod += 1.5 * k; }
  } },
};

const faces = new Set();
let pointer = null;
let running = false;
let last = 0;
let reduce = false;

const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
if (motion) {
  reduce = motion.matches;
  motion.addEventListener?.('change', (e) => { reduce = e.matches; wake(); });
}

const seen = new WeakMap(); // svg → whether it is on screen
const watcher = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => { for (const e of entries) seen.set(e.target, e.isIntersecting); })
  : null;

/**
 * Bring a face drawn by faces.js to life. `parts` are its groups: pose (the
 * whole face, hat and all), look (its features), hat (or null), and paint,
 * which redraws its eyes and mouth from an expression. `watches` says
 * whether it is a watcher now.
 */
export function liven(svg, parts, name, watches = () => false) {
  const h = phaseSeed(name);
  const face = {
    svg, ...parts, watches,
    watcher: false,
    phase: [0, 1, 2, 3].map((i) => ((h >>> (i * 6)) & 63) / 63 * Math.PI * 2),
    rate: 0.88 + ((h >>> 26) & 15) / 15 * 0.24,
    s: Object.fromEntries(Object.keys(TUNE).map((k) => [k, spring(k in FACE ? FACE[k] : 0)])),
    shape: 'open', // the eyes' shape now; a new one waits behind a blink
    state: null,
    shut: 0, // until when a blink holds the lids shut
    blinkAt: 0,
    gazeAt: 0,
    gaze: { x: 0, y: 0 },
    momentAt: 0,
    moment: null, // { name, t0, dir }
    wasFailed: false,
    attached: false,
  };
  svg.classList.add('pj-face-live');
  faces.add(face);
  watcher?.observe(svg);
  wake();
  return face;
}

function wake() {
  if (running || typeof requestAnimationFrame !== 'function') return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); // a tab coming back does not leap
  last = now;
  for (const face of faces) {
    if (!face.svg.isConnected) {
      if (face.attached) { faces.delete(face); watcher?.unobserve(face.svg); }
      continue;
    }
    face.attached = true;
    if (seen.get(face.svg) === false) continue;
    tick(face, now, dt);
  }
  if (faces.size) requestAnimationFrame(frame);
  else running = false;
}

function presenceOf(face) {
  const p = face.svg.closest('[data-presence]')?.dataset.presence;
  return p === 'working' || p === 'away' ? p : 'idle';
}

function begin(face, name, now) {
  face.moment = { name, t0: now, dir: side() };
}

function tick(face, now, dt) {
  const { s } = face;

  // ---- state ----
  const state = presenceOf(face);
  if (state !== face.state) {
    const from = face.state;
    face.state = state;
    face.line = undefined;
    face.gazeAt = now + 150;
    face.blinkAt = now + rand(...(STATES[state].blink ?? [1e9, 1e9]));
    face.momentAt = now + rand(...STATES[state].every);
    face.moment = null;
    if (from !== null && !reduce) {
      if (state === 'working') begin(face, 'settle', now);
      else if (from === 'working') begin(face, 'done', now);
      else if (from === 'away') begin(face, 'wake', now);
    }
  }
  const watcher = face.watches();
  if (watcher !== face.watcher) face.svg.classList.toggle('pj-face-watcher', (face.watcher = watcher)); // its glasses (app.css)
  const failed = face.svg.closest('.pj-avatar')?.classList.contains('pj-failed') ?? false;
  if (failed && !face.wasFailed && !reduce) begin(face, 'oops', now);
  face.wasFailed = failed;

  const conf = STATES[state];
  const x = { ...conf.face, gaze: null };

  if (reduce) {
    // the state's face, at once and still
    face.gaze = state === 'working' ? { x: 0, y: 3 } : { x: 0, y: 0 };
    face.shape = x.shape;
    aim(face, x, 0, 0);
    for (const k in s) { s[k].x = s[k].t; s[k].v = 0; }
    paint(face, 0);
    return;
  }

  // ---- moments ----
  if (now >= face.gazeAt) {
    const g = conf.gaze(face);
    face.gaze = { x: g.x, y: g.y };
    face.gazeAt = now + rand(...g.hold);
    // a big look is often led by a blink, as people do
    if (conf.blink && Math.hypot(g.x - s.gazeX.x, g.y - s.gazeY.x) > 6 && Math.random() < 0.35) face.shut = now + 90;
  }
  if (conf.blink && now >= face.blinkAt) {
    face.shut = now + 90;
    if (Math.random() < 0.14) face.again = now + 300; // now and then twice
    face.blinkAt = now + rand(...conf.blink);
  }
  if (face.again && now >= face.again) { face.shut = now + 80; face.again = 0; }
  if (!face.moment && now >= face.momentAt && conf.moments.length) {
    begin(face, pick(watcher && state === 'idle' ? [...conf.moments, 'read', 'read'] : conf.moments), now);
    face.momentAt = now + rand(...conf.every);
  }
  if (face.moment) {
    const m = MOMENTS[face.moment.name];
    const e = (now - face.moment.t0) / 1000;
    if (e > m.dur) face.moment = null;
    else m.at(x, e, face.moment.dir);
  }

  // the pointer: a face near it (or one that follows it) looks at you, and smiles a little
  if (pointer && state !== 'away') {
    const r = face.svg.getBoundingClientRect();
    const dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    const near = Math.max(r.width * 3, 140);
    if (d < near || face.svg.closest('[data-follow]')) {
      const warm = Math.max(0, 1 - d / near);
      const pull = Math.min(1, d / (r.width * 0.9));
      if (state !== 'working' || warm > 0.6) x.gaze = { x: (dx / (d || 1)) * 5 * pull, y: (dy / (d || 1)) * 3.5 * pull };
      if (x.shape === 'open') x.curve += 0.3 * warm;
    }
  }

  // the floor: a breath and the head's slow lean, never in step with another face
  const t = now / 1000 * face.rate;
  const [p0, p1, p2, p3] = face.phase;
  const asleep = state === 'away';
  const breath = Math.sin(t * (asleep ? 0.55 : 0.9) + p2) * (asleep ? 1.2 : 0.5);
  if (asleep) x.open += Math.max(0, breath) * 0.12; // a small mouth breathing in its sleep
  const lean = Math.sin(t * 0.5 + p0) * 1.1 + Math.sin(t * 0.17 + p1) * 0.7;
  if (conf.typing) {
    // typing in bursts: a quick dip of the head with each few keys
    const burst = Math.sin(t * 0.8 + p1) > -0.2 ? 1 : 0;
    x.nod += Math.max(0, Math.sin(t * Math.PI * 2 * 2.6 + p3)) * burst * 1.6;
  }
  aim(face, x, lean, breath + Math.sin(t * 0.23 + p3) * 0.3, now);

  for (let n = Math.max(1, Math.ceil(dt / DT)), i = 0; i < n; i++) {
    for (const k in s) step(s[k], TUNE[k], dt / n);
  }
  paint(face, breath);
}

// Point the springs at expression `x`.
function aim(face, x, lean, bob, now = 0) {
  const { s } = face;
  const g = x.gaze ?? face.gaze;
  s.gazeX.t = g.x;
  s.gazeY.t = g.y;
  s.headX.t = g.x * 0.8; // the head turns most of the way, later
  s.headY.t = g.y * 0.7;
  s.tilt.t = x.tilt + lean;
  s.nod.t = x.nod + bob;
  // the eyes: a new shape waits for them to shut, then pops open in it
  if (x.shape !== face.shape) {
    s.lid.t = 0;
    if (s.lid.x < 0.15) { face.shape = x.shape; s.lid.x = 0.1; }
  } else s.lid.t = now < face.shut && face.shape === 'open' ? 0 : x.lid;
  for (const k of ['size', 'curve', 'open', 'round', 'width', 'mx', 'down']) s[k].t = x[k];
  s.hat.t = s.tilt.x; // the hat chases the head, late and loose
  s.squash.t = face.pressed && !reduce ? 1 : 0;
}

function paint(face, breath) {
  const { s } = face;
  const hx = s.headX.x, hy = s.headY.x;
  // the head turns from the neck: it shifts and rolls a little toward where
  // it looks and nods; the body only breathes
  face.pose.setAttribute('transform', `translate(${f(hx * 0.6)} ${f(s.nod.x + hy * 0.4)}) rotate(${f(s.tilt.x + hx * 1.2)} 50 70) translate(50 97) scale(${f(1 - breath * 0.004 + s.squash.x * 0.1, 1000)} ${f(1 + breath * 0.006 - s.squash.x * 0.14, 1000)}) translate(-50 -97)`);
  // the features slide farther than the outline, round the front of the head
  face.look.setAttribute('transform', `translate(${f(hx)} ${f(hy * 0.9 + s.down.x)})`);
  face.paint({
    shape: face.shape,
    lid: s.lid.x,
    size: s.size.x,
    ex: clamp(s.gazeX.x - hx, -3.5, 3.5) * 0.8, // the eyes: the rest of the way
    ey: clamp(s.gazeY.x - hy, -3, 3) * 0.7,
    curve: s.curve.x,
    open: Math.max(0, s.open.x),
    round: clamp(s.round.x, 0, 1),
    width: s.width.x,
    mx: s.mx.x,
  });
  if (face.hat) face.hat.setAttribute('transform', `rotate(${f(clamp(s.hat.x - s.tilt.x, -20, 20) * 1.3)} 50 14)`);
}

if (typeof document !== 'undefined') {
  const move = (e) => { pointer = { x: e.clientX, y: e.clientY }; };
  document.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerdown', move, { passive: true });
  document.addEventListener('pointerleave', () => { pointer = null; });

  // a poke: on a face you can click, the press squashes it and the click sets it off
  const poked = (e) => {
    const hit = e.target.closest?.('button, [data-namecard]');
    const avatar = hit?.matches('.pj-avatar') ? hit : hit?.children.length === 1 && hit.firstElementChild.matches('.pj-avatar') ? hit.firstElementChild : null;
    return avatar ? [...faces].filter((face) => avatar.contains(face.svg)) : [];
  };
  const release = () => { for (const face of faces) face.pressed = false; };
  document.addEventListener('pointerdown', (e) => { for (const face of poked(e)) face.pressed = true; }, { capture: true, passive: true });
  document.addEventListener('pointerup', release, { capture: true, passive: true });
  document.addEventListener('pointercancel', release, { capture: true, passive: true });
  document.addEventListener('click', (e) => {
    if (reduce) return;
    for (const face of poked(e)) begin(face, presenceOf(face) === 'away' ? 'startle' : 'poke', performance.now());
  }, { capture: true, passive: true });
}

const f = (n, k = 100) => (Math.round(n * k) / k).toString();

function phaseSeed(name) {
  let h = 0x811c9dc5;
  for (const ch of `life:${name}`.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}
