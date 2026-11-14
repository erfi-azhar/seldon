// The welcome stage: a monolith made of particles hangs over a hill. Unlock, and it drops
// onto the hill and opens on a core of light; carry on, and the same particles gather into
// a hooded figure — Seldon, as a presence. One canvas lives outside React so the particles
// carry on, unbroken, from sign-in through every onboarding step.
//
// Pages mark where the scene sits with <VaultAnchor>; the canvas follows that box as the
// page scrolls. With reduced motion, every scene is shown at rest.

import { useEffect, useRef } from 'react';

export type VaultScene = 'hover' | 'open' | 'figure';

type V3 = [number, number, number];

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const easeIn = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * t);

// ── Shapes, in world units (y up; the anchor box is about 3.4 units tall) ───────────────

const WAIST = 0.12;
const TOP = 1.02;
const BOTTOM = -1.38;
const RADIUS = 0.44;
const HOVER_Y = 0.42;
const HILL_TOP = -1.62;

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
function monolith(n: number): { points: V3[]; upper: boolean[]; seam: boolean[] } {
  const ring = hexRing(RADIUS, WAIST, Math.PI / 6);
  const top: V3 = [0, TOP, 0];
  const bottom: V3 = [0, BOTTOM, 0];
  const points: V3[] = [];
  const upper: boolean[] = [];
  const seam: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % 6;
    const a = ring[k]!;
    const b = ring[(k + 1) % 6]!;
    const roll = Math.random();
    let p: V3;
    let s = false;
    if (roll < 0.1) {
      p = lerp3(a, b, Math.random()); // the seam
      s = true;
    } else if (roll < 0.34) {
      p = Math.random() < 0.4 ? lerp3(top, a, Math.random()) : lerp3(a, bottom, Math.random()); // the edges, for crisp facets
    } else {
      p = Math.random() < 0.38 ? onTriangle(top, a, b) : onTriangle(bottom, a, b);
    }
    points.push(p);
    upper.push(p[1] >= WAIST);
    seam.push(s);
  }
  return { points, upper, seam };
}

/**
 * A robed, hooded figure, head and shoulders: a peaked hood with a shadowed opening, a
 * cowl at the neck, and a mantle that falls from broad shoulders. No face: a presence.
 */
function figure(n: number): V3[] {
  const out: V3[] = [];
  const BASE = 0.12;
  while (out.length < n) {
    const roll = Math.random();
    if (roll < 0.4) {
      // Hood: narrows from the cowl to a peak tipped slightly back.
      const h = Math.random();
      const r = 0.43 * Math.pow(1 - h, 0.62) + 0.015;
      const a = rand(0, Math.PI * 2);
      const front = Math.cos(a - Math.PI / 2); // 1 = facing us
      if (front > 0.62 && h > 0.08 && h < 0.72) continue; // the opening
      out.push([Math.cos(a) * r, BASE + h * 1.02, Math.sin(a) * r * 0.92 - h * h * 0.12]);
    } else if (roll < 0.47) {
      // The rim of the opening, a little brighter for the eye to find.
      const t = rand(-0.95, 0.95);
      const h = 0.08 + (1 - Math.abs(t)) * 0.64;
      const r = 0.43 * Math.pow(1 - h, 0.62) + 0.015;
      const a = Math.PI / 2 + t * 0.9;
      out.push([Math.cos(a) * r, BASE + h * 1.02, Math.sin(a) * r * 0.92 - h * h * 0.12 + 0.02]);
    } else if (roll < 0.53) {
      // The cowl: folds of cloth gathered at the neck.
      const a = rand(0, Math.PI * 2);
      const r = 0.46 + Math.sin(a * 5) * 0.025;
      out.push([Math.cos(a) * r, BASE + rand(-0.06, 0.04), Math.sin(a) * r * 0.62]);
    } else {
      // Mantle: broad shoulders, then a straight fall, open in a seam down the front.
      const h = Math.random();
      const y = BASE - 0.02 - h * 1.45;
      // Shoulders slope away from the neck, then the cloth falls nearly straight.
      const rx = 0.36 + 0.78 * Math.pow(Math.min(1, h / 0.55), 0.75) + Math.max(0, h - 0.55) * 0.18;
      const a = rand(0, Math.PI * 2);
      if (Math.abs(Math.cos(a - Math.PI / 2) - 1) < 0.004 && Math.random() < 0.5) continue;
      out.push([Math.cos(a) * rx, y, Math.sin(a) * rx * 0.5]);
    }
  }
  return out;
}

function hill(n: number): V3[] {
  return Array.from({ length: n }, () => {
    const x = rand(-6, 6);
    const z = rand(0, 2.2);
    const y = HILL_TOP - x * x * 0.32 * 0.16 - z * 0.55 - 0.02;
    return [x, y, z] as V3;
  });
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
  seam: boolean[];
  mono: V3[];
  fig: V3[];
  hillPts: V3[];
  dust: Float32Array;
  scene: VaultScene;
  sceneAt: number;
  /** Where the monolith sits (drop) and how far it has opened (0–1). */
  drop: number;
  open: number;
  core: number;
  hillAlpha: number;
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
  const n = innerWidth < 640 ? 1400 : 2400;
  const m = monolith(n);
  const fig = figure(Math.round(n * 0.8));
  const pos = new Float32Array(n * 3);
  const still = reduced();
  for (let i = 0; i < n; i++) {
    // Start scattered, so the shard gathers out of the air.
    const p = still ? m.points[i]! : ([rand(-6, 6), rand(-3, 4), rand(-5, 3)] as V3);
    pos.set(still ? [p[0], p[1] + HOVER_Y, p[2]] : p, i * 3);
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
    seam: m.seam,
    mono: m.points,
    fig,
    hillPts: hill(innerWidth < 640 ? 500 : 900),
    dust: new Float32Array(innerWidth < 640 ? 500 : 900),
    scene: 'hover',
    sceneAt: performance.now(),
    drop: 0,
    open: 0,
    core: 0,
    hillAlpha: 1,
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
    ink: v('--vault-ink', '#e8ecff'),
    glow: v('--vault-glow', '#ffd9a0'),
    glowEdge: v('--vault-glow-edge', 'rgb(255 217 160 / 0)'),
    seam: v('--vault-seam', '#ffc66e'),
    hill: v('--vault-hill', 'rgb(20 24 32)'),
    hillDeep: v('--vault-hill-deep', 'rgb(8 10 14)'),
    additive: v('--vault-blend', 'lighter') === 'lighter',
  };
}

let palette: ReturnType<typeof colors> | null = null;

/** Where each particle is headed this frame, given the scene, the drop and the opening. */
function retarget(e: Engine, t: number) {
  const bob = reduced() ? 0 : Math.sin(t * 0.9) * 0.05;
  if (e.scene === 'figure') {
    const sway = reduced() ? 0 : Math.sin(t * 0.35) * 0.35;
    const c = Math.cos(sway);
    const s = Math.sin(sway);
    for (let i = 0; i < e.n; i++) {
      const p = i < e.fig.length ? e.fig[i]! : null;
      if (p) {
        const k = 1.22;
        e.tgt[i * 3] = (p[0] * c + p[2] * s) * k;
        e.tgt[i * 3 + 1] = (p[1] - 0.05) * k + bob * 0.5;
        e.tgt[i * 3 + 2] = (-p[0] * s + p[2] * c) * k;
      } else {
        // Spare particles drift as motes around the figure.
        const a = e.phase[i]! + t * 0.08;
        e.tgt[i * 3] = Math.cos(a) * (1.6 + (i % 7) * 0.12);
        e.tgt[i * 3 + 1] = Math.sin(a * 1.7) * 1.2;
        e.tgt[i * 3 + 2] = Math.sin(a) * 1.2;
      }
    }
    return;
  }
  const c = Math.cos(e.spin);
  const s = Math.sin(e.spin);
  // Hovering, then dropped so its point meets the hill.
  const base = HOVER_Y + bob * (1 - e.drop) + (HILL_TOP - BOTTOM - HOVER_Y + 0.06) * e.drop;
  for (let i = 0; i < e.n; i++) {
    const p = e.mono[i]!;
    const up = e.upper[i]!;
    // Opening: the upper part lifts and tips back, the lower part settles into the hill.
    const lift = up ? 0.72 * e.open : -0.12 * e.open;
    const flare = 1 + (up ? 0.18 : 0.06) * e.open;
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
  const box = e.rect ?? { x: 0, y: H * 0.08, w: W, h: H * 0.4 };
  const pal = palette ?? (palette = colors());

  if (!still) e.spin += dt * (e.scene === 'hover' ? 0.32 : 0.12);
  // Ease scene-level values toward their resting state.
  const towards = (cur: number, goal: number, rate: number) => (still ? goal : cur + (goal - cur) * Math.min(1, dt * rate));
  e.hillAlpha = towards(e.hillAlpha, e.scene === 'figure' ? 0 : 1, 2.5);
  if (e.scene === 'open') e.core = towards(e.core, 0.75 + (still ? 0 : Math.sin(t * 1.6) * 0.12), 3);
  else if (e.scene === 'figure') e.core = towards(e.core, 0.32, 2);

  retarget(e, t);

  // Springs: each particle is pulled to its target and damped.
  const k = e.scene === 'figure' ? 5.5 : 7;
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
  for (let i = 0; i < e.dust.length; i++) e.dust[i] = Math.max(0, e.dust[i]! - dt * 0.6);

  // Draw.
  const ctx = e.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const unit = box.h / 3.6;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.5;
  const cam = 7;
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const f = cam / (cam - z);
    return [cx + x * unit * f, cy - y * unit * f, f];
  };

  // The hill: ground that rises to a crest under the shard, filled to the bottom of the screen.
  if (e.hillAlpha > 0.01) {
    ctx.globalAlpha = e.hillAlpha;
    const crest = project(0, HILL_TOP, 0)[1];
    const g = ctx.createLinearGradient(0, crest, 0, H);
    g.addColorStop(0, pal.hill);
    g.addColorStop(1, pal.hillDeep);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-2, H + 2);
    for (let sx = -2; sx <= W + 2; sx += 8) {
      const x = (sx - cx) / unit;
      ctx.lineTo(sx, project(0, HILL_TOP - x * x * 0.32 * 0.16, 0)[1]);
    }
    ctx.lineTo(W + 2, H + 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pal.ink;
    for (let i = 0; i < e.hillPts.length; i++) {
      const p = e.hillPts[i]!;
      const lift = e.dust[i]! * (0.6 + (i % 5) * 0.1);
      const [sx, sy, f] = project(p[0] + lift * 0.2 * Math.sin(i), p[1] + lift, p[2]);
      ctx.globalAlpha = e.hillAlpha * Math.max(0.05, 0.1 + 0.25 * (f - 0.85)) * (1 + lift * 2);
      ctx.fillRect(sx, sy, 1.2, 1.2);
    }
  }

  // The core of light, where the shard opens.
  if (e.core > 0.01) {
    const [gx, gy] = e.scene === 'figure' ? project(0, 0.62 * 1.22, 0.3) : project(0, WAIST + HILL_TOP - BOTTOM + 0.06 + 0.3 * e.open, 0);
    const r = unit * (e.scene === 'figure' ? 0.9 : 1.6 + e.open * 0.9);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, pal.glow);
    g.addColorStop(1, pal.glowEdge);
    // Light adds to whatever is behind it: warm on the dusk, bright on the daylight sky.
    ctx.globalAlpha = Math.min(1, e.core) * (pal.additive ? 1 : 0.85);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
  }

  // The particles, nearer ones larger and brighter.
  ctx.globalCompositeOperation = pal.additive ? 'lighter' : 'source-over';
  for (let i = 0; i < e.n; i++) {
    const [sx, sy, f] = project(e.pos[i * 3]!, e.pos[i * 3 + 1]!, e.pos[i * 3 + 2]!);
    if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
    const tw = still ? 1 : 0.75 + 0.25 * Math.sin(t * 2.2 + e.phase[i]!);
    const seamLit = e.scene !== 'figure' && e.seam[i];
    const mote = e.scene === 'figure' && i >= e.fig.length;
    ctx.globalAlpha = Math.min(1, (0.35 + (f - 0.8) * 1.2) * tw * (seamLit ? 1.6 : 1) * (mote ? 0.3 : 1));
    ctx.fillStyle = seamLit ? pal.seam : pal.ink;
    const size = (seamLit ? 1.9 : 1.4) * f;
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
    // Arriving straight into "open" (no sign-in), drop and open at once.
    if (scene === 'open') {
      e.drop = 1;
      e.open = 1;
    }
    e.scene = scene;
    e.sceneAt = performance.now();
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
 * Unlock: the shard drops onto the hill, opens, and its light fills the screen. Resolves at
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
  const DROP = 950;
  const OPEN = 1200;
  return new Promise((resolve) => {
    let landed = false;
    const step = (now: number) => {
      const t = now - start;
      e.drop = easeIn(t / DROP);
      if (t >= DROP && !landed) {
        landed = true;
        // Dust kicks up around the point where it lands.
        e.hillPts.forEach((p, i) => {
          const d = Math.hypot(p[0], p[2] * 1.4);
          if (d < 1.6) e.dust[i] = (1.6 - d) * rand(0.15, 0.4);
        });
      }
      e.open = ease((t - DROP - 150) / OPEN);
      e.core = Math.max(e.core, ease((t - DROP - 250) / OPEN) * 0.9);
      e.flash.style.opacity = String(ease((t - DROP - OPEN * 0.55) / (OPEN * 0.45)));
      if (t < DROP + OPEN + 150) requestAnimationFrame(step);
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
