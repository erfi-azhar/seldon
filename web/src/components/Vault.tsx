// The welcome stage: a large shard made of particles turns slowly in open space. Unlock,
// and it sinks, opens at its seam on a core of light, and the light carries you in; carry
// on, and the same particles gather into an older man, head and shoulders, turned toward
// you — Seldon, as a presence. One
// canvas lives outside React so the particles carry on, unbroken, from sign-in through
// every onboarding step.
//
// Monochrome, with holographic light: the seam, some edges and the core shift through
// hues as the shard turns. Pages mark where the scene sits with <VaultAnchor>; the canvas
// follows that box as the page scrolls. With reduced motion, every scene is shown at rest.

import { useEffect, useRef } from 'react';

export type VaultScene = 'hover' | 'open' | 'figure';

type V3 = [number, number, number];

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const easeIn = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * t);

// ── Shapes, in world units (y up; the anchor box is about 3.6 units tall) ───────────────

const SCALE = 1.3;
const WAIST = 0.12 * SCALE;
const TOP = 1.02 * SCALE;
const BOTTOM = -1.38 * SCALE;
const RADIUS = 0.44 * SCALE;
/** Hovering, the shard is centred in its box; unlocking lowers it by SINK before it opens. */
const HOVER_Y = -(TOP + BOTTOM) / 2;
const SINK = 0.45;

function hexRing(r: number, y: number, twist = 0): V3[] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + twist;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
}

function onTriangle(a: V3, b: V3, c: V3): V3 {
  let u = Math.random();
  let v = Math.random();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  return [a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]), a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]), a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2])];
}

const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A six-sided shard: a long point below, a shorter one above, and a seam of light at the waist. */
function monolith(n: number): { points: V3[]; upper: boolean[]; accent: boolean[] } {
  const ring = hexRing(RADIUS, WAIST, Math.PI / 6);
  const top: V3 = [0, TOP, 0];
  const bottom: V3 = [0, BOTTOM, 0];
  const points: V3[] = [];
  const upper: boolean[] = [];
  const accent: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % 6;
    const a = ring[k]!;
    const b = ring[(k + 1) % 6]!;
    const roll = Math.random();
    let p: V3;
    let lit = false;
    if (roll < 0.09) {
      p = lerp3(a, b, Math.random()); // the seam
      lit = true;
    } else if (roll < 0.32) {
      // The edges, for crisp facets; a few of them catch the holographic light.
      p = Math.random() < 0.4 ? lerp3(top, a, Math.random()) : lerp3(a, bottom, Math.random());
      lit = Math.random() < 0.22;
    } else {
      p = Math.random() < 0.38 ? onTriangle(top, a, b) : onTriangle(bottom, a, b);
    }
    points.push(p);
    upper.push(p[1] >= WAIST);
    accent.push(lit);
  }
  return { points, upper, accent };
}

// An older man, head and upper shoulders, turned three-quarters toward the viewer: an
// original, anonymous face with close-cropped hair, a short trimmed beard and dark
// clothing that falls away into the background. The face is a sculpted height field
// sampled evenly, with its features traced in fine strokes; the rest of the head is a
// rougher shell. Every point carries a normal, so the face can be lit and its far side
// hidden.

type Kind = 0 | 1 | 2 | 3; // skin and hair, beard, cloth, feature stroke

const HEAD_Y = 0.46;
const HEAD: V3 = [0.56, 0.74, 0.64];

/** A cheap, smooth 0–1 pattern, for weathered unevenness. */
const grain = (x: number, y: number, z: number) => 0.5 + 0.5 * Math.sin(x * 13.1 + y * 7.7) * Math.sin(y * 11.3 - z * 9.1) * Math.sin(z * 8.3 + x * 5.9);

const g = (v: number, w: number) => Math.exp(-((v / w) ** 2));
const g2 = (x: number, y: number, wx: number, wy: number) => Math.exp(-((x / wx) ** 2) - (y / wy) ** 2);

/** Half-width of the head at a height (narrower toward the chin). */
function halfWidth(y: number): number {
  const [RX, RY] = HEAD;
  const base = RX * Math.sqrt(Math.max(0, 1 - (y / RY) ** 2));
  return y < -0.1 ? base * (1 - 0.3 * Math.min(1, (-y - 0.1) / 0.64)) : base;
}

/** The front of the face as depth (z) over x and y, centred on the head. */
function faceZ(x: number, y: number): number {
  const [, RY, RZ] = HEAD;
  const w = Math.max(0.05, halfWidth(y));
  const q = Math.max(0, 1 - (x / w) ** 2 - (y / RY) ** 2 * 0.15);
  let z = RZ * Math.sqrt(q) * (y < -0.1 ? 1 - 0.1 * Math.min(1, (-y - 0.1) / 0.64) : 1);
  const ax = Math.abs(x);
  // Nose: a bridge that rises toward a rounded tip, with wings either side, cut away beneath.
  const bridge = Math.min(1, Math.max(0, (0.2 - y) / 0.32));
  z += 0.15 * g(x, 0.055 + 0.03 * bridge) * bridge * (y > -0.15 ? 1 : g(y + 0.15, 0.035));
  z += 0.045 * g2(x, y + 0.13, 0.055, 0.045);
  z += 0.03 * g2(ax - 0.065, y + 0.155, 0.035, 0.03);
  // Brow ridge and the sockets beneath it, with the eyes themselves.
  z += 0.045 * g(y - 0.27, 0.05) * (ax < 0.36 ? 1 : g(ax - 0.36, 0.05));
  z -= 0.07 * g2(ax - 0.19, y - 0.155, 0.085, 0.055);
  z += 0.035 * g2(ax - 0.19, y - 0.15, 0.05, 0.03);
  // Cheekbones, the folds beside the mouth, the lips and the chin.
  z += 0.035 * g2(ax - 0.29, y + 0.02, 0.09, 0.07);
  z -= 0.015 * g(ax - (0.09 + (-0.16 - y) * 0.4), 0.02) * (y < -0.15 && y > -0.38 ? 1 : 0);
  z += 0.022 * g2(x, y + 0.31, 0.12, 0.025) + 0.025 * g2(x, y + 0.385, 0.1, 0.03);
  z -= 0.012 * g2(x, y + 0.35, 0.12, 0.01);
  z += 0.035 * g2(x, y + 0.56, 0.15, 0.09);
  return z;
}

function faceNormal(x: number, y: number): V3 {
  const e = 0.01;
  const dx = (faceZ(x + e, y) - faceZ(x - e, y)) / (2 * e);
  const dy = (faceZ(x, y + e) - faceZ(x, y - e)) / (2 * e);
  const l = Math.hypot(dx, dy, 1);
  return [-dx / l, -dy / l, 1 / l];
}

/** Feature lines: brows, lids, nostrils, the mouth, the folds beside it, forehead lines. */
function strokes(): ((t: number) => [number, number])[] {
  const arc = (cx: number, cy: number, w: number, h: number, from = -1, to = 1) => (t: number): [number, number] => {
    const u = from + (to - from) * t;
    return [cx + u * w, cy + (1 - u * u) * h];
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => (t: number): [number, number] => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  const out: ((t: number) => [number, number])[] = [];
  for (const s of [-1, 1]) {
    out.push(arc(s * 0.2, 0.275, 0.12, 0.035)); // brow
    out.push(arc(s * 0.19, 0.16, 0.06, 0.022)); // upper lid
    out.push(arc(s * 0.19, 0.14, 0.05, -0.012)); // lower lid
    out.push(arc(s * 0.06, -0.165, 0.025, 0.01)); // nostril
    out.push(line(s * 0.09, -0.16, s * 0.17, -0.37)); // fold beside the mouth
  }
  out.push(arc(0, -0.35, 0.12, 0.012)); // mouth
  out.push(arc(0, 0.43, 0.24, 0.015)); // forehead lines
  out.push(arc(0, 0.49, 0.2, 0.012));
  return out;
}

function bust(n: number): { points: V3[]; normals: V3[]; kinds: Kind[] } {
  const points: V3[] = [];
  const normals: V3[] = [];
  const kinds: Kind[] = [];
  const [RX, RY, RZ] = HEAD;
  const lines = strokes();
  const inFace = (x: number, y: number) => (x / 0.44) ** 2 + ((y + 0.03) / 0.64) ** 2 < 1;
  while (points.length < n) {
    const roll = Math.random();
    if (roll < 0.46) {
      // The face, sampled evenly over its front.
      const x = rand(-0.44, 0.44);
      const y = rand(-0.67, 0.61);
      if (!inFace(x, y)) continue;
      const N = faceNormal(x, y);
      const z = faceZ(x, y);
      const beard = y < -0.12 && !(y > -0.4 && y < -0.3 && Math.abs(x) < 0.11) && (Math.abs(x) > 0.16 || y < -0.42 || (y > -0.31 && y < -0.24));
      const hairline = y > 0.5 && Math.abs(x) > 0.22; // a little hair at the temples
      if (!beard && Math.random() > 0.72 + 0.28 * grain(x, y, z)) continue;
      const out = beard ? rand(0.008, 0.04) : hairline ? rand(0, 0.015) : 0;
      points.push([x + N[0] * out, y + HEAD_Y + N[1] * out, z + N[2] * out]);
      normals.push(N);
      kinds.push(beard ? 1 : 0);
    } else if (roll < 0.56) {
      // The features, traced in fine strokes on the face.
      const f = lines[Math.floor(Math.random() * lines.length)]!;
      const [x, y] = f(Math.random());
      const N = faceNormal(x, y);
      points.push([x + rand(-0.004, 0.004), y + HEAD_Y + rand(-0.004, 0.004), faceZ(x, y) + 0.006]);
      normals.push(N);
      kinds.push(3);
    } else if (roll < 0.76) {
      // The rest of the head: sides, crown and back, close-cropped, receding at the front.
      const u = rand(-1, 1);
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(1 - u * u);
      const dx = r * Math.cos(a);
      const dy = u;
      const dz = r * Math.sin(a);
      const y = dy * RY;
      const w = halfWidth(y) / RX;
      const x = dx * RX * w;
      const z = dz * RZ * (y < -0.1 ? 1 - 0.1 * Math.min(1, (-y - 0.1) / 0.64) : 1);
      if (dz > 0 && inFace(x, y)) continue; // the face is drawn above
      if (Math.random() > 0.5 + 0.5 * grain(x, y, z)) continue;
      const nl = Math.hypot(x / (RX * RX), y / (RY * RY), z / (RZ * RZ));
      const N: V3 = [x / (RX * RX) / nl, y / (RY * RY) / nl, z / (RZ * RZ) / nl];
      const beard = y < -0.12 && dz > -0.35;
      const hair = dy > 0.25;
      const out = beard ? rand(0.008, 0.045) : hair ? rand(0, 0.025) : 0;
      points.push([x + N[0] * out, y + HEAD_Y + N[1] * out, z + N[2] * out]);
      normals.push(N);
      kinds.push(beard ? 1 : 0);
    } else if (roll < 0.79) {
      // Ears.
      const side = Math.random() < 0.5 ? -1 : 1;
      const a = rand(0, Math.PI * 2);
      const k = Math.sqrt(Math.random());
      points.push([side * (RX * 0.98), HEAD_Y + 0.08 + Math.sin(a) * 0.13 * k, -0.04 + Math.cos(a) * 0.075 * k]);
      normals.push([side, 0, 0]);
      kinds.push(0);
    } else if (roll < 0.85) {
      // Neck.
      const a = rand(0, Math.PI * 2);
      points.push([Math.cos(a) * 0.27, HEAD_Y - rand(0.58, 1.1), Math.sin(a) * 0.25 - 0.04]);
      normals.push([Math.cos(a), 0, Math.sin(a)]);
      kinds.push(0);
    } else {
      // Upper shoulders and a dark collar, sloping from the neck and fading downward.
      const t = Math.random();
      const y = HEAD_Y - 0.86 - t * 0.62;
      const rx = 0.4 + 1.0 * Math.pow(Math.min(1, t / 0.6), 0.7);
      const a = rand(0, Math.PI * 2);
      points.push([Math.cos(a) * rx, y, Math.sin(a) * rx * 0.48]);
      normals.push([Math.cos(a), 0.35, Math.sin(a)]);
      kinds.push(2);
    }
  }
  return { points, normals, kinds };
}

// ── The engine ──────────────────────────────────────────────────────────────

interface Engine {
  canvas: HTMLCanvasElement;
  flash: HTMLDivElement;
  ctx: CanvasRenderingContext2D;
  n: number;
  pos: Float32Array;
  vel: Float32Array;
  tgt: Float32Array;
  phase: Float32Array;
  upper: boolean[];
  monoAccent: boolean[];
  mono: V3[];
  fig: V3[];
  figNormals: V3[];
  figKinds: Kind[];
  /** Per frame, for the figure: how much each point faces the viewer, and how lit it is. */
  figFace: Float32Array;
  figLit: Float32Array;
  scene: VaultScene;
  /** How far the shard has sunk (0–1) and opened (0–1), and the core's brightness. */
  drop: number;
  open: number;
  core: number;
  spin: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  anchor: HTMLElement | null;
  mounts: number;
  raf: number;
  last: number;
  hideTimer: number;
}

let E: Engine | null = null;

function engine(): Engine {
  if (E) return E;
  const canvas = document.createElement('canvas');
  canvas.className = 'vault-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const flash = document.createElement('div');
  flash.className = 'vault-flash';
  flash.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d')!;
  // A theme change (the system's, or the app's own switch) re-reads the colours.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (palette = null));
  new MutationObserver(() => (palette = null)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const n = innerWidth < 640 ? 2400 : 4200;
  const m = monolith(n);
  const f = bust(Math.round(n * 0.92));
  const pos = new Float32Array(n * 3);
  const still = reduced();
  for (let i = 0; i < n; i++) {
    // Start scattered, so the shard gathers out of the air.
    const p = m.points[i]!;
    pos.set(still ? [p[0], p[1] + HOVER_Y, p[2]] : [rand(-6, 6), rand(-3.5, 4), rand(-5, 3)], i * 3);
  }
  E = {
    canvas,
    flash,
    ctx,
    n,
    pos,
    vel: new Float32Array(n * 3),
    tgt: new Float32Array(n * 3),
    phase: Float32Array.from({ length: n }, () => Math.random() * Math.PI * 2),
    upper: m.upper,
    monoAccent: m.accent,
    mono: m.points,
    fig: f.points,
    figNormals: f.normals,
    figKinds: f.kinds,
    figFace: new Float32Array(f.points.length),
    figLit: new Float32Array(f.points.length),
    scene: 'hover',
    drop: 0,
    open: 0,
    core: 0,
    spin: 0,
    rect: null,
    anchor: null,
    mounts: 0,
    raf: 0,
    last: performance.now(),
    hideTimer: 0,
  };
  return E;
}

function colors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    ink: v('--vault-ink', '#eceef2'),
    glow: v('--vault-glow', 'rgb(255 255 255 / 0.95)'),
    glowEdge: v('--vault-glow-edge', 'rgb(255 255 255 / 0)'),
    /** Saturation and lightness of the holographic accents, for this theme. */
    holoS: Number(v('--vault-holo-s', '90')),
    holoL: Number(v('--vault-holo-l', '72')),
    additive: v('--vault-blend', 'lighter') === 'lighter',
  };
}

let palette: ReturnType<typeof colors> | null = null;

/** Where each particle is headed this frame, given the scene, the sink and the opening. */
function retarget(e: Engine, t: number) {
  const still = reduced();
  const bob = still ? 0 : Math.sin(t * 0.7) * 0.05;
  if (e.scene === 'figure') {
    // Turned three-quarters toward the viewer; small, slow movements, as if listening.
    const yaw = 0.44 + (still ? 0 : Math.sin(t * 0.21) * 0.06);
    const nod = still ? 0 : Math.sin(t * 0.33 + 1) * 0.035;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const cs = Math.cos(yaw * 0.45);
    const ss = Math.sin(yaw * 0.45);
    const cn = Math.cos(nod);
    const sn = Math.sin(nod);
    // Light from above, in front, on the side the face turns toward: fixed to the viewer.
    const L: V3 = [0.5, 0.5, 0.71];
    for (let i = 0; i < e.n; i++) {
      if (i >= e.fig.length) {
        // Spare particles drift as faint motes around the figure.
        const a = e.phase[i]! + t * 0.05;
        e.tgt[i * 3] = Math.cos(a) * (1.9 + (i % 7) * 0.12);
        e.tgt[i * 3 + 1] = Math.sin(a * 1.7) * 1.4;
        e.tgt[i * 3 + 2] = Math.sin(a) * 1.3 - 1;
        continue;
      }
      const p = e.fig[i]!;
      const q = e.figNormals[i]!;
      // The shoulders turn less than the head.
      const cloth = e.figKinds[i] === 2;
      const cc = cloth ? cs : c;
      const sc = cloth ? ss : s;
      // Nod the head about the neck, then turn.
      let y = p[1];
      let z = p[2];
      let ny = q[1];
      let nz = q[2];
      if (!cloth) {
        const dy = y - (HEAD_Y - 0.6);
        y = HEAD_Y - 0.6 + dy * cn - z * sn;
        z = dy * sn + z * cn;
        ny = q[1] * cn - q[2] * sn;
        nz = q[1] * sn + q[2] * cn;
      }
      const k = 1.62;
      // Centre the face, not the skull: turning moves it to one side.
      e.tgt[i * 3] = (p[0] * cc + z * sc - 0.16) * k;
      e.tgt[i * 3 + 1] = (y - 0.24) * k + bob * 0.3;
      e.tgt[i * 3 + 2] = (-p[0] * sc + z * cc) * k;
      const rnx = q[0] * cc + nz * sc;
      const rnz = -q[0] * sc + nz * cc;
      e.figFace[i] = rnz;
      e.figLit[i] = Math.max(0, rnx * L[0] + ny * L[1] + rnz * L[2]);
    }
    return;
  }
  const c = Math.cos(e.spin);
  const s = Math.sin(e.spin);
  const base = HOVER_Y + bob * (1 - e.drop) - SINK * e.drop;
  for (let i = 0; i < e.n; i++) {
    const p = e.mono[i]!;
    const up = e.upper[i]!;
    // Opening: the upper part lifts away, the lower part settles a little.
    const lift = up ? 0.62 * e.open : -0.14 * e.open;
    const flare = 1 + (up ? 0.16 : 0.05) * e.open;
    const x = p[0] * flare;
    const z = p[2] * flare;
    e.tgt[i * 3] = x * c + z * s;
    e.tgt[i * 3 + 1] = p[1] + base + lift;
    e.tgt[i * 3 + 2] = -x * s + z * c;
  }
}

function frame(now: number) {
  const e = E!;
  e.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - e.last) / 1000);
  e.last = now;
  const t = now / 1000;
  const still = reduced();

  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = innerWidth;
  const H = innerHeight;
  if (e.canvas.width !== Math.round(W * dpr) || e.canvas.height !== Math.round(H * dpr)) {
    e.canvas.width = Math.round(W * dpr);
    e.canvas.height = Math.round(H * dpr);
    palette = colors();
  }
  if (e.anchor?.isConnected) {
    const r = e.anchor.getBoundingClientRect();
    e.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  const box = e.rect ?? { x: 0, y: H * 0.06, w: W, h: H * 0.5 };
  const pal = palette ?? (palette = colors());

  // A slow turn: a full revolution takes about a minute while hovering.
  if (!still) e.spin += dt * (e.scene === 'hover' ? 0.1 : 0.04);
  const towards = (cur: number, goal: number, rate: number) => (still ? goal : cur + (goal - cur) * Math.min(1, dt * rate));
  if (e.scene === 'open') e.core = towards(e.core, 0.7 + (still ? 0 : Math.sin(t * 1.2) * 0.1), 3);
  else if (e.scene === 'figure') e.core = towards(e.core, 0, 2.5);

  retarget(e, t);

  // Springs: each particle is pulled to its target and damped.
  const k = e.scene === 'figure' ? 5 : 6.5;
  const damp = 4.6;
  for (let i = 0; i < e.n * 3; i++) {
    if (still) {
      e.pos[i] = e.tgt[i]!;
      continue;
    }
    const a = (e.tgt[i]! - e.pos[i]!) * k - e.vel[i]! * damp;
    e.vel[i] = e.vel[i]! + a * dt;
    e.pos[i] = e.pos[i]! + e.vel[i]! * dt;
  }

  const ctx = e.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const unit = box.h / 3.6;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.5;
  const cam = 7.5;
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const f = cam / (cam - z);
    return [cx + x * unit * f, cy - y * unit * f, f];
  };
  // The holographic hue drifts with time and the shard's turn.
  const hueBase = (t * 24 + e.spin * 57) % 360;
  const holo = (hue: number, a = 1) => `hsl(${Math.round(((hue % 360) + 360) % 360)} ${pal.holoS}% ${pal.holoL}% / ${a})`;

  // The core of light, where the shard opens: white at the centre, a band of shifting colour.
  if (e.core > 0.01) {
    const [gx, gy] = project(0, WAIST + HOVER_Y - SINK * e.drop + 0.24 * e.open, 0);
    const r = unit * (1.5 + e.open * 0.9);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, pal.glow);
    g.addColorStop(0.35, holo(hueBase, 0.32));
    g.addColorStop(0.62, holo(hueBase + 120, 0.14));
    g.addColorStop(1, pal.glowEdge);
    ctx.globalAlpha = Math.min(1, e.core) * (pal.additive ? 1 : 0.9);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
  }

  // The particles, nearer ones larger and brighter; accents in holographic colour.
  ctx.globalCompositeOperation = pal.additive ? 'lighter' : 'source-over';
  const figure = e.scene === 'figure';
  for (let i = 0; i < e.n; i++) {
    const [sx, sy, f] = project(e.pos[i * 3]!, e.pos[i * 3 + 1]!, e.pos[i * 3 + 2]!);
    if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
    const tw = still ? 1 : 0.75 + 0.25 * Math.sin(t * 2 + e.phase[i]!);
    const mote = figure && i >= e.fig.length;
    if (figure && !mote) {
      // Hide what faces away; shade what faces the light. Cloth fades into the dark below.
      const vis = Math.max(0, Math.min(1, (e.figFace[i]! + 0.18) / 0.5));
      if (vis <= 0.02) continue;
      const kind = e.figKinds[i];
      const shade = 0.2 + 0.95 * e.figLit[i]! ** 1.1;
      const fade = kind === 2 ? Math.max(0, 0.5 - (HEAD_Y - 0.86 - e.fig[i]![1]) * 0.8) : 1;
      // Feature strokes sit a little brighter than the skin around them.
      const accent = kind === 3 ? 1.35 : kind === 1 ? 1.1 : 1;
      ctx.globalAlpha = Math.min(1, (0.46 + (f - 0.8) * 1.2) * tw * vis * shade * fade * accent);
      ctx.fillStyle = pal.ink;
      const size = (kind === 1 ? 1.45 : kind === 3 ? 1.1 : 1.15) * f * (0.85 + 0.3 * ((e.phase[i]! * 3.7) % 1));
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      continue;
    }
    const lit = !figure && e.monoAccent[i];
    ctx.globalAlpha = Math.min(1, (0.38 + (f - 0.8) * 1.2) * tw * (lit ? 1.5 : 1) * (mote ? 0.22 : 1));
    // Hue follows position, so colour sweeps across the shard like light on foil.
    ctx.fillStyle = lit ? holo(hueBase + sy * 0.9 + sx * 1.4) : pal.ink;
    const size = (lit ? 1.8 : 1.35) * f;
    ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function show() {
  const e = engine();
  clearTimeout(e.hideTimer);
  e.mounts++;
  if (!e.canvas.isConnected) document.body.prepend(e.canvas, e.flash);
  e.canvas.classList.remove('is-gone');
  if (!e.raf) {
    e.last = performance.now();
    e.raf = requestAnimationFrame(frame);
  }
}

function hide() {
  const e = E;
  if (!e) return;
  e.mounts = Math.max(0, e.mounts - 1);
  // Wait a beat: the next screen may be about to show the stage again.
  e.hideTimer = window.setTimeout(() => {
    if (e.mounts > 0) return;
    e.canvas.classList.add('is-gone');
    window.setTimeout(() => {
      if (e.mounts > 0) return;
      cancelAnimationFrame(e.raf);
      e.raf = 0;
      e.canvas.remove();
    }, 700);
  }, 250);
}

/** Put the stage on screen; returns a function that takes it away again. */
export function mountVault(): () => void {
  show();
  return hide;
}

/** Move the stage to a scene. */
export function setVaultScene(scene: VaultScene): void {
  const e = engine();
  if (e.scene === scene) return;
  // Arriving straight into "open" (no sign-in), sink and open at once.
  if (scene === 'open') {
    e.drop = 1;
    e.open = 1;
  }
  e.scene = scene;
}

/** Draw the scene in this box (or the top of the screen, with none). */
export function setVaultAnchor(el: HTMLElement | null): void {
  engine().anchor = el;
}

/** Show the stage behind this page, in a given scene. */
export function VaultStage({ scene }: { scene: VaultScene }) {
  useEffect(() => mountVault(), []);
  useEffect(() => setVaultScene(scene), [scene]);
  return null;
}

/** The box on the page where the scene is drawn. */
export function VaultAnchor({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    setVaultAnchor(el);
    return () => {
      if (engine().anchor === el) setVaultAnchor(null);
    };
  }, []);
  return <div ref={ref} className={`vault-anchor ${className ?? ''}`} aria-hidden />;
}

/**
 * Unlock: the shard sinks, opens at its seam, and its light fills the screen. Resolves at
 * the brightest moment, so the next screen can appear behind the light as it fades.
 */
export function playUnlock(): Promise<void> {
  const e = engine();
  if (reduced()) {
    e.drop = 1;
    e.open = 1;
    e.scene = 'open';
    return Promise.resolve();
  }
  const start = performance.now();
  const SINKING = 900;
  const OPEN = 1200;
  return new Promise((resolve) => {
    const step = (now: number) => {
      const t = now - start;
      e.drop = easeIn(t / SINKING);
      e.open = ease((t - SINKING + 100) / OPEN);
      e.core = Math.max(e.core, ease((t - SINKING) / OPEN) * 0.9);
      e.flash.style.opacity = String(ease((t - SINKING - OPEN * 0.5) / (OPEN * 0.5)));
      if (t < SINKING + OPEN + 100) requestAnimationFrame(step);
      else {
        e.scene = 'open';
        resolve();
        // Let the light fall away over the next screen.
        const fadeStart = performance.now();
        const fade = (n2: number) => {
          const k = 1 - ease((n2 - fadeStart) / 1100);
          e.flash.style.opacity = String(k);
          if (k > 0) requestAnimationFrame(fade);
        };
        requestAnimationFrame(fade);
      }
    };
    requestAnimationFrame(step);
  });
}
