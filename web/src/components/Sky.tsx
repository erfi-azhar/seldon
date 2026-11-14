// The sky above Today: a dot-matrix dither of the sky where you are, right now.
//
// The colours follow the phase of the day (blending over twenty minutes at each change),
// and the sun and moon sit where they really are: left to right by how far east or west
// they are, up and down by how high. The moon is drawn in its real phase. Clouds drift
// and stars twinkle; a click sends a shooting star after dark, or a few birds by day.
// When a trip is under two weeks away a small plane crosses now and then.
//
// It draws a coarse grid (a dot every 5px, 3px on a phone), slowly when nothing is moving, and not at
// all while hidden or scrolled away. With reduced motion it holds still.

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { moonPhase, moonPosition, sunPosition, useSun, type Blend, type Phase, type SunState } from '../sun.ts';

type RGB = [number, number, number];

interface Palette {
  top: RGB;
  mid: RGB;
  low: RGB;
  glow: RGB;
  core: RGB;
  glowSize: number;
  glowStrength: number;
  cloud: RGB;
  cloudShade: RGB;
  clouds: number;
  stars: number;
  /** Birds and the plane. */
  ink: RGB;
  /** How plainly the moon shows. */
  moon: number;
  /** How fast the clouds drift, as a share of the daytime speed. */
  wind: number;
}

const PALETTES: Record<Phase, Palette> = {
  dawn: { top: [40, 42, 96], mid: [178, 108, 146], low: [248, 190, 146], glow: [255, 160, 120], core: [255, 172, 84], glowSize: 0.34, glowStrength: 0.6,
    cloud: [255, 200, 186], cloudShade: [130, 86, 128], clouds: 0.5, stars: 0.3, ink: [52, 36, 66], moon: 0.7, wind: 1 },
  day: { top: [54, 120, 212], mid: [122, 182, 238], low: [214, 236, 252], glow: [255, 250, 228], core: [255, 255, 246], glowSize: 0.22, glowStrength: 0.45,
    cloud: [255, 255, 255], cloudShade: [186, 208, 236], clouds: 0.62, stars: 0, ink: [36, 54, 86], moon: 0.4, wind: 1 },
  // Steel blue warming to peach, the same dusk as the hill at the foot of the page (hill.ts).
  dusk: { top: [52, 72, 104], mid: [128, 142, 160], low: [250, 186, 140], glow: [255, 150, 90], core: [255, 214, 160], glowSize: 0.36, glowStrength: 0.85,
    cloud: [255, 196, 168], cloudShade: [92, 100, 126], clouds: 0.3, stars: 0.12, ink: [28, 34, 46], moon: 0.85, wind: 0.8 },
  evening: { top: [4, 6, 16], mid: [12, 20, 48], low: [30, 46, 90], glow: [140, 160, 224], core: [236, 232, 214], glowSize: 0.13, glowStrength: 0.3,
    cloud: [108, 120, 162], cloudShade: [30, 36, 68], clouds: 0.75, stars: 1, ink: [226, 230, 242], moon: 1, wind: 0.5 },
};

const STAR: RGB = [255, 250, 238];
const MOON_LIT: RGB = [236, 232, 214];
const MOON_GLOW: RGB = [140, 160, 224];
const BEACON: RGB = [255, 96, 84];

/** Where the horizon sits, as a fraction of the band's height. */
const HZ = 0.66;
/** The bottom of the band dissolves into the page over this fraction of its height. */
const FADE = 0.42;
/** Dot spacing in CSS pixels: finer on a phone, where the band is small. */
const CELL = 5;
const CELL_PHONE = 3;
const PHONE_WIDTH = 720;
const SUN_R = 0.08;
const MOON_R = 0.11;

// ── Maths ─────────────────────────────────────────────────────────────────────

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (a: RGB, b: RGB, t: number): RGB => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
const mul = (a: RGB, t: number): RGB => [a[0] * t, a[1] * t, a[2] * t];
const lum = (c: RGB) => clamp((0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255);
const css = (c: RGB, a = 1) => `rgba(${clamp(c[0], 0, 255) | 0},${clamp(c[1], 0, 255) | 0},${clamp(c[2], 0, 255) | 0},${a})`;

function hash(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  return 0.5 * noise(x, y) + 0.25 * noise(x * 2.03, y * 2.03) + 0.125 * noise(x * 4.1, y * 4.1) + 0.0625 * noise(x * 8.3, y * 8.3);
}
const B4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((x) => (x + 0.5) / 16));

function blendPalette({ from, to, t }: Blend): Palette {
  const a = PALETTES[from];
  const b = PALETTES[to];
  if (from === to || t <= 0) return a;
  if (t >= 1) return b;
  const out = {} as Record<keyof Palette, unknown>;
  for (const key of Object.keys(a) as (keyof Palette)[]) {
    const x = a[key];
    const y = b[key];
    out[key] = typeof x === 'number' ? x + ((y as number) - x) * t : mix(x, y as RGB, t);
  }
  return out as unknown as Palette;
}

// ── Where things are in the band (x in band heights from the left, y in band heights) ──

interface Body {
  x: number;
  y: number;
  altitude: number;
}

/** Facing the equator: east on the left, west on the right, the zenith near the top. */
function place(azimuth: number, altitude: number, lat: number, aspect: number): Body {
  let east = Math.sin(azimuth) * Math.cos(altitude);
  if (lat < 0) east = -east;
  return { x: (0.5 + 0.44 * east) * aspect, y: HZ * (1 - 0.82 * Math.sin(altitude)), altitude };
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  /** A bright streak (shooting star), or a dark-on-light shape (birds, the plane). */
  kind: 'light' | 'ink';
  strength: number;
}

type Effect =
  | { kind: 'star'; x: number; y: number; vx: number; vy: number; born: number }
  | { kind: 'birds'; x: number; y: number; dir: 1 | -1; born: number; flock: { ox: number; oy: number; ph: number }[] };

const STAR_LIFE = 1.3;
const BIRD_LIFE = 6;
/** A plane crosses every so often while a trip is near. */
const PLANE_EVERY = 55;
const PLANE_FLIGHT = 18;

function planeAt(seconds: number, aspect: number): { x: number; y: number; t: number } | null {
  const t = ((seconds - 6) % PLANE_EVERY) / PLANE_FLIGHT;
  if (seconds < 6 || t > 1) return null;
  return { x: -0.15 + t * (aspect + 0.3), y: HZ * (0.36 - 0.08 * t), t };
}

function planeSegments(p: { x: number; y: number }, strength: number): Segment[] {
  const s = { width: 0.016, kind: 'ink' as const, strength };
  return [
    { ...s, x1: p.x - 0.06, y1: p.y, x2: p.x + 0.06, y2: p.y },
    { ...s, x1: p.x - 0.06, y1: p.y, x2: p.x - 0.08, y2: p.y - 0.04 },
    { ...s, x1: p.x + 0.01, y1: p.y, x2: p.x - 0.025, y2: p.y + 0.035 },
    { ...s, x1: p.x + 0.01, y1: p.y, x2: p.x - 0.015, y2: p.y - 0.022 },
  ];
}

function effectSegments(effects: Effect[], now: number): Segment[] {
  const out: Segment[] = [];
  for (const e of effects) {
    const age = now - e.born;
    if (e.kind === 'star') {
      const life = 1 - age / STAR_LIFE;
      const hx = e.x + e.vx * age;
      const hy = e.y + e.vy * age;
      const len = Math.min(0.45, 0.05 + age * 0.9);
      const speed = Math.hypot(e.vx, e.vy);
      out.push({ x1: hx, y1: hy, x2: hx - (e.vx / speed) * len, y2: hy - (e.vy / speed) * len, width: 0.022, kind: 'light', strength: life });
    } else {
      const fade = Math.min(1, (BIRD_LIFE - age) / 1.2);
      for (const b of e.flock) {
        const bx = e.x + e.dir * 0.2 * age + b.ox * (1 + age * 0.15);
        const by = e.y - 0.035 * age + b.oy + 0.01 * Math.sin(age * 2.4 + b.ph);
        const flap = 0.022 * Math.sin(age * 11 + b.ph);
        const s = { width: 0.011, kind: 'ink' as const, strength: fade };
        out.push({ ...s, x1: bx, y1: by, x2: bx - 0.032, y2: by - flap - 0.008 });
        out.push({ ...s, x1: bx, y1: by, x2: bx + 0.032, y2: by - flap - 0.008 });
      }
    }
  }
  return out;
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/** The page's background colour as it is now (it changes with the theme and phase). */
function pageColor(): RGB {
  const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [238, 240, 244];
}

interface Scene {
  /** How far the clouds have drifted, added to a little each frame at the phase's wind. */
  drift: number;
  sun: SunState;
  effects: Effect[];
  plane: { x: number; y: number } | null;
}

function draw(canvas: HTMLCanvasElement, scene: Scene, seconds: number): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { sun: s } = scene;
  const pal = blendPalette(s.blend);
  const aspect = w / h;
  const now = Date.now();
  const sunPos = sunPosition(now, s.place.lat, s.place.lng);
  const sun = place(sunPos.azimuth, sunPos.altitude, s.place.lat, aspect);
  const sunGlow = pal.glowStrength * smooth(-0.32, 0.05, Math.sin(sun.altitude)) * 0.55;
  const moonPos = moonPosition(now, s.place.lat, s.place.lng);
  const moon = place(moonPos.azimuth, moonPos.altitude, s.place.lat, aspect);
  const lit = moonPhase(now);
  const moonShows = moon.altitude > -0.02 && lit.fraction > 0.02;
  // The lit side of the moon faces the sun: an evening crescent near the equator lies on its back.
  const toSunX = sun.x - moon.x;
  const toSunY = sun.y - moon.y;
  const toSun = Math.hypot(toSunX, toSunY) || 1;
  const litX = toSunX / toSun;
  const litY = toSunY / toSun;

  const segments = [...effectSegments(scene.effects, seconds), ...(scene.plane ? planeSegments(scene.plane, 1) : [])];
  const beacon = scene.plane && Math.sin(seconds * 6) > 0.6 ? { x: scene.plane.x - 0.075, y: scene.plane.y - 0.035 } : null;

  // Through the fade, the dots and the ground between them turn into the page's own
  // colour, then let go of it at the very edge so the page's ambient tint shows through.
  const page = pageColor();
  const bg = mul(pal.top, 0.4);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, css(bg));
  for (let n = 0; n <= 12; n++) {
    const into = n / 12;
    grad.addColorStop(1 - FADE + FADE * into, css(mix(bg, page, smooth(0, 0.85, into)), 1 - smooth(0.6, 1, into)));
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const cell = w <= PHONE_WIDTH ? CELL_PHONE : CELL;
  // The same number of stars for the area, however fine the grid.
  const starChance = 0.03 * (cell / CELL) ** 2;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const drift = scene.drift;
  for (let j = 0; j < rows; j++) {
    const v = (j + 0.5) / rows;
    const k = v / HZ;
    // 0 above the fade, 1 at the bottom edge.
    const into = (v - (1 - FADE)) / FADE;
    if (into >= 0.995) break;
    const fade = 1 - clamp(into);
    const toPage = smooth(0, 0.85, into);
    const alpha = 1 - smooth(0.6, 1, into);
    const base = k < 0.6 ? mix(pal.top, pal.mid, smooth(0, 0.6, k)) : mix(pal.mid, pal.low, smooth(0.6, 1, k));
    const band = Math.max(0, 1 - Math.abs(k - 0.42) * 1.7);
    for (let i = 0; i < cols; i++) {
      const x = ((i + 0.5) / cols) * aspect;
      let c = base;
      let ink = 0;
      // How much of this dot is the sun's disc, which stays out of the fade into the page.
      let disc = 0;

      // The sun's glow, even from below the horizon.
      const dx = x - sun.x;
      const dy = v - sun.y;
      const d2 = dx * dx + dy * dy;
      if (sunGlow > 0.01) c = add(c, pal.glow, Math.exp(-d2 / (pal.glowSize * pal.glowSize)) * sunGlow);
      const mdx = x - moon.x;
      const mdy = v - moon.y;
      const m2 = mdx * mdx + mdy * mdy;
      if (moonShows) c = add(c, MOON_GLOW, Math.exp(-m2 / 0.03) * 0.3 * lit.fraction * pal.moon * pal.stars);

      if (pal.stars > 0.01 && k < 0.95) {
        const hs = hash(i * 7 + 11, j * 13 + 5);
        if (hs > 1 - starChance * pal.stars) {
          // A soft swell and fade, each star on its own 3–6 second cycle and to its own
          // depth: plainly twinkling, never blinking.
          const own = hash(i + 5, j + 211);
          const depth = 0.45 + 0.45 * hash(i + 9, j + 57);
          const swell = 0.5 + 0.5 * Math.sin(seconds * (1 + 1.1 * own) + own * 40);
          const twinkle = 1 - depth * (1 - swell);
          c = mix(c, STAR, (0.45 + 0.55 * hash(i, j + 99)) * (1 - k) * Math.min(1, pal.stars + 0.3) * twinkle);
        }
      }

      if (pal.clouds > 0.01 && band > 0) {
        const n = fbm(x * 2.1 + drift, v * 6.5 + drift * 0.15);
        const cover = smooth(0.52, 0.74, n * band + 0.16) * pal.clouds;
        if (cover > 0.01) {
          let cloud = mix(pal.cloudShade, pal.cloud, smooth(0.45, 0.85, n));
          // At night, clouds near the moon catch its light.
          if (moonShows) cloud = add(cloud, MOON_GLOW, Math.exp(-m2 / 0.12) * 0.45 * lit.fraction * pal.stars);
          c = mix(c, cloud, cover);
        }
      }

      if (sun.y < HZ + SUN_R) {
        const d = Math.sqrt(d2);
        if (d < SUN_R * 1.05) {
          disc = smooth(SUN_R * 1.05, SUN_R * 0.8, d);
          c = mix(c, pal.core, disc);
        }
      }

      if (moonShows && m2 < MOON_R * MOON_R) {
        const ax = mdx / MOON_R;
        const ay = mdy / MOON_R;
        const nx = ax * litX + ay * litY;
        const ny = ay * litX - ax * litY;
        const half = Math.sqrt(Math.max(0, 1 - ny * ny));
        // Lit beyond the terminator, which sweeps across as the month goes on.
        const on = nx > (1 - 2 * lit.fraction) * half;
        c = mix(c, on ? MOON_LIT : mix(c, MOON_LIT, 0.08), pal.moon);
      }

      for (const sg of segments) {
        const minX = Math.min(sg.x1, sg.x2) - sg.width;
        const maxX = Math.max(sg.x1, sg.x2) + sg.width;
        if (x < minX || x > maxX) continue;
        const minY = Math.min(sg.y1, sg.y2) - sg.width;
        const maxY = Math.max(sg.y1, sg.y2) + sg.width;
        if (v < minY || v > maxY) continue;
        const vx = sg.x2 - sg.x1;
        const vy = sg.y2 - sg.y1;
        const t = clamp(((x - sg.x1) * vx + (v - sg.y1) * vy) / (vx * vx + vy * vy || 1));
        const dist = Math.hypot(x - (sg.x1 + vx * t), v - (sg.y1 + vy * t));
        if (dist > sg.width) continue;
        if (sg.kind === 'light') c = mix(c, STAR, sg.strength * (1 - t * 0.85) * (1 - dist / sg.width));
        else ink = Math.max(ink, sg.strength);
      }
      if (beacon && Math.hypot(x - beacon.x, v - beacon.y) < 0.018) {
        c = BEACON;
        ink = 0;
      }

      const cx = i * cell + cell / 2;
      const cy = j * cell + cell / 2;
      if (ink > 0) {
        ctx.fillStyle = css(pal.ink, Math.min(1, fade * 1.5) * ink);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.44, 0, 6.2832);
        ctx.fill();
        continue;
      }
      const b = B4[j & 3]![i & 3]!;
      // The sun's disc is drawn with full dots, so it reads as one solid shape.
      const r = cell * 0.5 * (clamp(0.16 + 0.92 * Math.sqrt(lum(c)) + (b - 0.5) * 0.22) * (1 - disc) + 0.96 * disc);
      if (r < 0.3) continue;
      const dot = mul(c, 0.9 + 0.25 * b);
      const fadeTo = toPage * (1 - disc);
      ctx.fillStyle = fadeTo > 0 ? css(mix(dot, page, fadeTo), alpha + (1 - alpha) * disc) : css(dot);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 6.2832);
      ctx.fill();
    }
  }
}

// ── The component ─────────────────────────────────────────────────────────────

export interface SkyTrip {
  id: string;
  label: string;
}

const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [role="button"], [contenteditable="true"], .card, .glass-pill, .hero-date, .hero-line, .hero-day';

export function Sky({ trip }: { trip: SkyTrip | null }) {
  const sun = useSun();
  const [, navigate] = useLocation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene>({ sun, effects: [], plane: null, drift: 0 });
  scene.current.sun = sun;
  const tripRef = useRef(trip);
  tripRef.current = trip;
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const start = performance.now();
    const seconds = () => (performance.now() - start) / 1000;
    let raf = 0;
    let last = -Infinity;
    let lastSec = 0;
    let onScreen = true;

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const sec = seconds();
      const sc = scene.current;
      sc.effects = sc.effects.filter((e) => sec - e.born < (e.kind === 'star' ? STAR_LIFE : BIRD_LIFE));
      const p = tripRef.current ? planeAt(sec, canvas.clientWidth / Math.max(1, canvas.clientHeight)) : null;
      sc.plane = p;
      // Smooth while something is flying; otherwise a slow drift is enough.
      const busy = sc.effects.length > 0 || p !== null;
      if (t - last < (busy ? 33 : 90)) return;
      last = t;
      // Step the clouds on by the time since the last frame (capped, so a tab coming back
      // from the background doesn't jump them), at the wind of the moment.
      sc.drift += Math.min(0.25, sec - lastSec) * 0.03 * blendPalette(sc.sun.blend).wind;
      lastSec = sec;
      draw(canvas, sc, sec);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (still.matches) {
        scene.current.plane = null;
        draw(canvas, scene.current, 0);
      } else if (onScreen) raf = requestAnimationFrame(frame);
    };
    run();

    // While reduced motion holds it still, keep the sun and moon moving once a minute.
    const minute = setInterval(() => still.matches && draw(canvas, scene.current, 0), 60_000);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      if (onScreen) run();
      else cancelAnimationFrame(raf);
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => still.matches && draw(canvas, scene.current, 0));
    ro.observe(canvas);
    still.addEventListener('change', run);

    // Where a pointer is, in band units, if it is over open sky rather than over something.
    const inSky = (e: MouseEvent | PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.top + r.height * (1 - FADE * 0.5)) return null;
      const el = e.target as Element | null;
      if (!el?.closest('.app-main') || el.closest(INTERACTIVE)) return null;
      return { x: (e.clientX - r.left) / r.height, y: (e.clientY - r.top) / r.height, px: e.clientX - r.left, py: e.clientY - r.top };
    };
    const nearPlane = (pt: { x: number; y: number }) => {
      const p = scene.current.plane;
      return p !== null && Math.abs(pt.x - p.x) < 0.12 && Math.abs(pt.y - p.y) < 0.08;
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const pt = inSky(e);
      if (!pt || window.getSelection()?.toString()) return;
      if (tripRef.current && nearPlane(pt)) {
        navigate(`/trips/${tripRef.current.id}`);
        return;
      }
      if (still.matches) return;
      const sec = seconds();
      const sc = scene.current;
      const s = sc.sun;
      const up = sunPosition(Date.now(), s.place.lat, s.place.lng).altitude > 0.02;
      if (up) {
        const dir = pt.x < canvas.clientWidth / canvas.clientHeight / 2 ? 1 : -1;
        const flock = Array.from({ length: 5 }, (_, n) => ({ ox: -dir * n * 0.1 * (0.8 + Math.random() * 0.4), oy: (n % 2 ? 0.05 : -0.03) * Math.ceil(n / 2) + Math.random() * 0.03, ph: Math.random() * 6 }));
        sc.effects.push({ kind: 'birds', x: pt.x, y: pt.y, dir, born: sec, flock });
      } else {
        const angle = (Math.random() < 0.5 ? 0.35 : Math.PI - 0.35) + (Math.random() - 0.5) * 0.3;
        sc.effects.push({ kind: 'star', x: pt.x, y: pt.y, vx: Math.cos(angle) * 0.9, vy: Math.sin(angle) * 0.9, born: sec });
      }
      run();
    };

    let hovering = false;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const pt = inSky(e);
      const over = pt !== null && tripRef.current !== null && nearPlane(pt);
      if (over !== hovering) {
        hovering = over;
        document.body.style.cursor = over ? 'pointer' : '';
      }
      setTip(over && pt ? { x: pt.px, y: pt.py } : null);
    };

    document.addEventListener('click', onClick);
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(minute);
      io.disconnect();
      ro.disconnect();
      still.removeEventListener('change', run);
      document.removeEventListener('click', onClick);
      document.removeEventListener('pointermove', onMove);
      document.body.style.cursor = '';
    };
  }, [navigate]);

  // Redraw a held-still sky when the phase or place changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && matchMedia('(prefers-reduced-motion: reduce)').matches) draw(canvas, scene.current, 0);
  }, [sun]);

  return (
    <div className="sky" aria-hidden="true">
      <canvas ref={canvasRef} />
      {tip && trip && (
        <span className="sky-tip glass-pill" style={{ left: tip.x, top: tip.y }}>
          {trip.label}
        </span>
      )}
    </div>
  );
}
