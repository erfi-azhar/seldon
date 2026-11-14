// The welcome stage: a large shard made of particles turns slowly in open space. Unlock,
// and it sinks, opens at its seam on a core of light, and the light carries you in; carry
// on, and the same particles gather into a man's profile — Seldon, as a presence. One
// canvas lives outside React so the particles carry on, unbroken, from sign-in through
// every onboarding step.
//
// Monochrome, with holographic light: the seam, some edges and the core shift through
// hues as the shard turns. Pages mark where the scene sits with <VaultAnchor>; the canvas
// follows that box as the page scrolls. With reduced motion, every scene is shown at rest.

import { useEffect, useRef } from 'react';

export type VaultScene = 'hover' | 'open' | 'figure';

type V3 = [number, number, number];
type V2 = [number, number];

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

// A man's head and shoulders in profile, facing right: an original, anonymous face with a
// short, light beard along the jaw. x is forward, y up.
const PROFILE: V2[] = [
  [-1.02, -1.62], [-0.76, -1.4], [-0.36, -1.2], [-0.32, -0.8], [-0.4, -0.48], [-0.6, -0.12], [-0.66, 0.26],
  [-0.58, 0.64], [-0.36, 0.9], [-0.06, 1.0], [0.24, 0.96], [0.44, 0.8], [0.53, 0.56], [0.56, 0.34],
  [0.53, 0.22], [0.58, 0.14], [0.72, -0.08], [0.62, -0.16], [0.6, -0.22], [0.63, -0.29], [0.58, -0.34],
  [0.61, -0.4], [0.56, -0.47], [0.6, -0.6], [0.5, -0.74], [0.27, -0.8], [0.19, -0.94], [0.2, -1.18],
  [0.5, -1.38], [0.74, -1.62],
];
/** The jaw, from below the ear to the chin, where the beard grows. */
const JAW: V2[] = [[-0.12, -0.2], [0.05, -0.5], [0.3, -0.7], [0.5, -0.72], [0.6, -0.6], [0.58, -0.45], [0.6, -0.36]];

function inside(p: V2, poly: V2[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function nearPath(p: V2, path: V2[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]!;
    const [bx, by] = path[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

function onPath(path: V2[]): V2 {
  const lengths = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]));
  let d = Math.random() * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (d <= lengths[i]!) {
      const t = d / lengths[i]!;
      return [path[i]![0] + (path[i + 1]![0] - path[i]![0]) * t, path[i]![1] + (path[i + 1]![1] - path[i]![1]) * t];
    }
    d -= lengths[i]!;
  }
  return path[path.length - 1]!;
}

function profile(n: number): { points: V3[]; accent: boolean[] } {
  const points: V3[] = [];
  const accent: boolean[] = [];
  const depth = (y: number) => (y > -1.15 ? 0.32 : 0.55); // the head is narrower than the shoulders
  while (points.length < n) {
    const roll = Math.random();
    if (roll < 0.34) {
      // The outline: brow, nose, lips, chin. Some of it catches the holographic light.
      const p = onPath(PROFILE.slice(2, -2));
      points.push([p[0] + rand(-0.008, 0.008), p[1], rand(-0.03, 0.03)]);
      accent.push(Math.random() < 0.18);
    } else if (roll < 0.5) {
      // A light beard: stubble along the jaw and chin, a little past the outline.
      const p: V2 = [rand(-0.15, 0.68), rand(-0.82, -0.18)];
      const d = nearPath(p, JAW);
      if (d > 0.09 || (!inside(p, PROFILE) && d > 0.035)) continue;
      points.push([p[0], p[1], rand(-0.2, 0.2)]);
      accent.push(Math.random() < 0.12);
    } else if (roll < 0.53) {
      // The ear, and the eye.
      if (Math.random() < 0.7) {
        const a = rand(0, Math.PI * 2);
        points.push([-0.1 + Math.cos(a) * 0.08, 0.06 + Math.sin(a) * 0.14, 0.12]);
      } else {
        points.push([0.43 + rand(-0.025, 0.025), 0.2 + rand(-0.012, 0.012), 0.2]);
      }
      accent.push(false);
    } else {
      // The volume of the head and shoulders, sparser, so the profile reads as a form.
      const p: V2 = [rand(-1.02, 0.74), rand(-1.62, 1.0)];
      if (!inside(p, PROFILE)) continue;
      const w = depth(p[1]);
      points.push([p[0], p[1], rand(-w, w) * 0.6]);
      accent.push(false);
    }
  }
  return { points, accent };
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
  figAccent: boolean[];
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
  const n = innerWidth < 640 ? 1600 : 2800;
  const m = monolith(n);
  const f = profile(Math.round(n * 0.86));
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
    figAccent: f.accent,
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
    // The profile turns a little, as if looking out past the page.
    const sway = still ? 0 : Math.sin(t * 0.25) * 0.22;
    const c = Math.cos(sway);
    const s = Math.sin(sway);
    for (let i = 0; i < e.n; i++) {
      const p = i < e.fig.length ? e.fig[i]! : null;
      if (p) {
        const k = 1.08;
        e.tgt[i * 3] = (p[0] * c + p[2] * s) * k;
        e.tgt[i * 3 + 1] = (p[1] + 0.22) * k + bob * 0.4;
        e.tgt[i * 3 + 2] = (-p[0] * s + p[2] * c) * k;
      } else {
        // Spare particles drift as motes around the head.
        const a = e.phase[i]! + t * 0.05;
        e.tgt[i * 3] = Math.cos(a) * (1.8 + (i % 7) * 0.12);
        e.tgt[i * 3 + 1] = Math.sin(a * 1.7) * 1.4;
        e.tgt[i * 3 + 2] = Math.sin(a) * 1.3;
      }
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
  else if (e.scene === 'figure') e.core = towards(e.core, 0.22, 2);

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
    const [gx, gy] = e.scene === 'figure' ? project(0.45 * 1.08, 0.4, 0.3) : project(0, WAIST + HOVER_Y - SINK * e.drop + 0.24 * e.open, 0);
    const r = unit * (e.scene === 'figure' ? 1.1 : 1.5 + e.open * 0.9);
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
    const lit = figure ? !mote && e.figAccent[i] : e.monoAccent[i];
    ctx.globalAlpha = Math.min(1, (0.38 + (f - 0.8) * 1.2) * tw * (lit ? 1.5 : 1) * (mote ? 0.25 : 1));
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

/** Show the stage behind this page, in a given scene. */
export function VaultStage({ scene }: { scene: VaultScene }) {
  useEffect(() => {
    show();
    return hide;
  }, []);
  useEffect(() => {
    const e = engine();
    if (e.scene === scene) return;
    // Arriving straight into "open" (no sign-in), sink and open at once.
    if (scene === 'open') {
      e.drop = 1;
      e.open = 1;
    }
    e.scene = scene;
  }, [scene]);
  return null;
}

/** The box on the page where the scene is drawn. */
export function VaultAnchor({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const e = engine();
    e.anchor = ref.current;
    return () => {
      if (e.anchor === ref.current) e.anchor = null;
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
