// The hill: a dark shard hovering over a rounded hill, under the sky where you are, drawn
// as a dot matrix like the Today sky. One renderer for two places: the welcome stage
// (components/Vault.tsx), where unlocking brings the shard down to rest on the hill, and
// the band that closes the Today page (components/Hill.tsx).
//
// The scene is laid out in "scene units": 1 is the height of a notional screen, with the
// horizon at HZ. A caller says where that notional screen sits on its canvas (the unit
// in pixels, and where v = 0 and the centre line fall) and which part of it fades into the
// page. The sky's colours follow the phase of the day, and the sun and moon sit where
// they really are, as on Today, and the weather where you are shows too (weather.ts).

import type { Weather } from '../../shared/types.ts';
import { moonPhase, moonPosition, sunPosition, type Blend, type Phase, type SunState } from './sun.ts';
import { closeIn, discShows, fallPainter, FLASH as LIGHTNING, flashLevel, greyed, hazeOf, lookOf, precipitation, weatherSky, type Look } from './weather.ts';

export type RGB = [number, number, number];
type V3 = [number, number, number];

// ── Colours ───────────────────────────────────────────────────────────────────

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
  /** How plainly the moon shows. */
  moon: number;
  /** Distant ranges, the hill's crest, its near slope, and frost on the slope. */
  far: RGB;
  crest: RGB;
  ground: RGB;
  frost: RGB;
}

// The Today sky's colours (components/Sky.tsx); dusk is steel blue warming to peach.
const PALETTES: Record<Phase, Palette> = {
  dawn: { top: [40, 42, 96], mid: [178, 108, 146], low: [248, 190, 146], glow: [255, 160, 120], core: [255, 230, 196], glowSize: 0.34, glowStrength: 0.6,
    cloud: [255, 200, 186], cloudShade: [130, 86, 128], clouds: 0.4, stars: 0.25, moon: 0.7, far: [86, 66, 102], crest: [38, 32, 58], ground: [62, 56, 88], frost: [156, 136, 168] },
  day: { top: [54, 120, 212], mid: [122, 182, 238], low: [214, 236, 252], glow: [255, 250, 228], core: [255, 255, 246], glowSize: 0.22, glowStrength: 0.45,
    cloud: [255, 255, 255], cloudShade: [186, 208, 236], clouds: 0.55, stars: 0, moon: 0.4, far: [112, 142, 172], crest: [54, 78, 96], ground: [80, 106, 120], frost: [204, 218, 228] },
  dusk: { top: [52, 72, 104], mid: [128, 142, 160], low: [250, 186, 140], glow: [255, 150, 90], core: [255, 214, 160], glowSize: 0.36, glowStrength: 0.85,
    cloud: [255, 196, 168], cloudShade: [92, 100, 126], clouds: 0.3, stars: 0.12, moon: 0.85, far: [46, 48, 60], crest: [20, 24, 30], ground: [38, 56, 66], frost: [104, 126, 136] },
  evening: { top: [4, 6, 16], mid: [12, 20, 48], low: [30, 46, 90], glow: [140, 160, 224], core: [236, 232, 214], glowSize: 0.13, glowStrength: 0.3,
    cloud: [72, 82, 124], cloudShade: [20, 26, 52], clouds: 0.26, stars: 1, moon: 1, far: [14, 18, 34], crest: [6, 8, 16], ground: [18, 24, 40], frost: [58, 70, 98] },
};

const STAR: RGB = [255, 250, 238];
const MOON_LIT: RGB = [236, 232, 214];
const MOON_GLOW: RGB = [140, 160, 224];
/** The seam, and the light inside the shard. */
const SEAM: RGB = [255, 242, 222];
const LANTERN: RGB = [255, 196, 120];
const FLASH: RGB = [255, 248, 238];

/** The horizon, in scene units from the top. */
export const HZ = 0.56;
const SUN_R = 0.04;
const MOON_R = 0.032;

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
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (a: V3, t: number): V3 => [a[0] * t, a[1] * t, a[2] * t];

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

/** The phase's colours under the weather: the sky as on Today, and the land greyer and dimmer with it. */
function weathered(p: Palette, w: Look): Palette {
  if (w.cover < 0) return p;
  const g = w.grey;
  const land = (c: RGB): RGB => mul(greyed(c, g * 0.5), 1 - 0.1 * g);
  return { ...weatherSky(p, w), far: land(p.far), crest: land(p.crest), ground: land(p.ground), frost: land(p.frost) };
}

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

// ── The shard: four faces about a long point up and a short one down, split in two ──

const R = 0.36;
const TOP_Y = 1;
const BOTTOM_Y = -0.62;

interface Tri {
  p: V3;
  q: V3;
  r: V3;
  n: V3;
  /** A face of the split itself, hidden until the halves part. */
  cut: boolean;
}
interface Half {
  tris: Tri[];
  off: V3;
  z: number;
}
interface Shard {
  halves: Half[];
  /** The split plane's normal, as seen. */
  normal: V3;
}

function shardGeometry(spin: number, tilt: number, gap: number): Shard {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  const view = (p: V3): V3 => [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  const ring = [0, 1, 2, 3].map((i): V3 => {
    const a = (i * Math.PI) / 2 + spin;
    return [Math.cos(a) * R, 0, Math.sin(a) * R];
  });
  const top: V3 = [0, TOP_Y, 0];
  const bottom: V3 = [0, BOTTOM_Y, 0];
  // The split holds corners 0 and 2 and the axis; its normal points at corner 1.
  const na = Math.PI / 2 + spin;
  const nObj: V3 = [Math.cos(na), 0, Math.sin(na)];
  const parts: [V3, V3, V3, number][] = [
    [ring[0], ring[1], ring[2], 1],
    [ring[2], ring[3], ring[0], -1],
  ];
  const halves = parts
    .map(([a, m, b, side]): Half => {
      const o = scale3(nObj, gap * side);
      const at = (p: V3) => view([p[0] + o[0], p[1] + o[1], p[2] + o[2]]);
      const T = at(top);
      const Bo = at(bottom);
      const A = at(a);
      const M = at(m);
      const Bc = at(b);
      const centre = view([o[0] + m[0] * 0.4, o[1] + 0.1, o[2] + m[2] * 0.4]);
      const faces: [V3, V3, V3, boolean][] = [
        [T, A, M, false],
        [T, M, Bc, false],
        [Bo, M, A, false],
        [Bo, Bc, M, false],
        [T, Bc, Bo, true],
        [T, Bo, A, true],
      ];
      const tris = faces
        .map(([p, q, r, cut]): Tri => {
          let n = cross3(sub3(q, p), sub3(r, p));
          n = scale3(n, 1 / (Math.hypot(n[0], n[1], n[2]) || 1));
          const mid: V3 = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
          if (dot3(n, sub3(mid, centre)) < 0) n = scale3(n, -1);
          return { p, q, r, n, cut };
        })
        .filter((t) => t.n[2] > 1e-4);
      return { tris, off: view(o), z: centre[2] };
    })
    // Nearer half first: the first face found at a point is the one in front.
    .sort((a, b) => b.z - a.z);
  return { halves, normal: view(nObj) };
}

function hitShard(g: Shard, X: number, Y: number): { tri: Tri; p: V3; half: Half } | null {
  for (const half of g.halves) {
    for (const tri of half.tris) {
      const { p, q, r } = tri;
      const d = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
      if (Math.abs(d) < 1e-9) continue;
      const w1 = ((q[1] - r[1]) * (X - r[0]) + (r[0] - q[0]) * (Y - r[1])) / d;
      const w2 = ((r[1] - p[1]) * (X - r[0]) + (p[0] - r[0]) * (Y - r[1])) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
      return { tri, half, p: [p[0] * w1 + q[0] * w2 + r[0] * w3, p[1] * w1 + q[1] * w2 + r[1] * w3, p[2] * w1 + q[2] * w2 + r[2] * w3] };
    }
  }
  return null;
}

// ── Unlocking ─────────────────────────────────────────────────────────────────

/** What the shard is doing: the gap between its halves, its inner light, where it is. */
export interface Pose {
  /** 0 hovering, 1 resting on the hilltop. */
  drop: number;
  gap: number;
  light: number;
  /** 0 to 1: turn so the split faces the viewer. */
  turn: number;
  /** A ring of light running out over the ground, and how far it has gone. */
  ripple: number;
  rippleR: number;
  /** The whole scene washing to light. */
  flash: number;
}

export const HOVER: Pose = { drop: 0, gap: 0, light: 0, turn: 0, ripple: 0, rippleR: 0, flash: 0 };
/** After unlocking: down on the hill, a little open, lit from within. */
export const REST: Pose = { drop: 1, gap: 0.12, light: 0.75, turn: 1, ripple: 0, rippleR: 0, flash: 0 };

/** p of the way (0–1) through an unlock: it lowers onto the hilltop, light runs out from where it touches, then everything washes to light. */
export function unlockPose(p: number): Pose {
  if (p >= 0.76) return { ...REST, flash: smooth(0.6, 0.76, p) * (1 - smooth(0.82, 1, p)) };
  return {
    drop: smooth(0, 0.42, p),
    gap: smooth(0.42, 0.7, p) * REST.gap,
    light: smooth(0.3, 0.5, p) * REST.light,
    turn: smooth(0, 0.4, p),
    ripple: smooth(0.38, 0.44, p) * (1 - smooth(0.62, 0.8, p)),
    rippleR: smooth(0.4, 0.8, p) * 1.1,
    flash: smooth(0.6, 0.76, p),
  };
}
/** The moment of brightest light in an unlock, when the next screen can appear behind it. */
export const UNLOCK_PEAK = 0.78;

// ── A frame ───────────────────────────────────────────────────────────────────

export interface HillView {
  /** One scene unit, in CSS pixels. */
  unit: number;
  /** Where scene v = 0 and the centre line are, in CSS pixels on the canvas. */
  top: number;
  cx: number;
  /** The shard's centre and size, in scene units. */
  shardY: number;
  shardSize: number;
  /** Scene v range over which the scene dissolves into the page, at its top or bottom. */
  fadeTop?: [number, number];
  fadeBottom?: [number, number];
  /** Dot spacing in CSS pixels. */
  cell: number;
}

export interface Streak {
  born: number;
  x: number;
  y: number;
  dir: 1 | -1;
}

export interface HillState {
  sun: SunState;
  /** Seconds, for motion; still holds everything at rest. */
  t: number;
  still: boolean;
  spin: number;
  drift: number;
  pose: Pose;
  /** Extra brightness on the seam, from typing. */
  pulse: number;
  /** The traveller with the lantern: 0 low on the slope to 1 at the top; null for none. */
  traveller: number | null;
  streaks: Streak[];
  /** Where to put the sun and moon: this moment instead of now (for demos). */
  clock?: number;
  /** The weather where you are, when known. */
  weather?: Weather | null;
  /** When the last lightning flash began, in the same seconds as t. */
  flashAt?: number;
}

const STREAK_LIFE = 1.3;
export const streakAlive = (s: Streak, t: number) => t - s.born < STREAK_LIFE;

interface Frame {
  pal: Palette;
  look: Look;
  haze: RGB;
  /** How plainly the sun's disc shows through the cloud, and the lightning glow now. */
  veil: number;
  lightning: number;
  view: HillView;
  st: HillState;
  /** Half the canvas width, in scene units. */
  half: number;
  sun: { x: number; y: number; altitude: number };
  moon: { x: number; y: number; shows: boolean; fraction: number; litX: number; litY: number };
  light: V3;
  shard: Shard;
  shardY: number;
  groundY: number;
  seamW: number;
  traveller: { x: number; y: number; h: number; flicker: number } | null;
  streaks: { x1: number; y1: number; x2: number; y2: number; a: number }[];
}

/** The hill's crest at x (scene units from the centre line). */
export function crestAt(x: number): number {
  return HZ + 0.05 - 0.105 * Math.exp(-((x / 0.42) ** 2)) + 0.003 * Math.sin(x * 23) + 0.002 * Math.sin(x * 41 + 2) + 0.006 * (fbm(x * 4 + 50, 3.3) - 0.5);
}

/** Facing the equator: east on the left, west on the right; the zenith near the top. */
function place(azimuth: number, altitude: number, lat: number, half: number) {
  let east = Math.sin(azimuth) * Math.cos(altitude);
  if (lat < 0) east = -east;
  return { x: 0.88 * east * Math.min(half, 1.1), y: HZ * (1 - 0.82 * Math.sin(altitude)), altitude };
}

function skyAt(f: Frame, x: number, v: number, i: number, j: number): RGB {
  const { pal, st } = f;
  const k = Math.max(0, v) / HZ;
  let c = k < 0.6 ? mix(pal.top, pal.mid, smooth(0, 0.6, k)) : mix(pal.mid, pal.low, smooth(0.6, 1, k));
  const dx = x - f.sun.x;
  const dy = v - f.sun.y;
  const d2 = dx * dx + dy * dy;
  const glow = pal.glowStrength * smooth(-0.32, 0.05, Math.sin(f.sun.altitude)) * 0.55;
  if (glow > 0.01) c = add(c, pal.glow, Math.exp(-d2 / (pal.glowSize * pal.glowSize)) * glow);
  const mdx = x - f.moon.x;
  const mdy = v - f.moon.y;
  const m2 = mdx * mdx + mdy * mdy;
  if (f.moon.shows) c = add(c, MOON_GLOW, Math.exp(-m2 / 0.03) * 0.3 * f.moon.fraction * pal.moon * pal.stars);
  if (pal.stars > 0.01 && k < 0.92 && i >= 0) {
    if (hash(i * 7 + 11, j * 13 + 5) > 1 - 0.03 * pal.stars) {
      const own = hash(i + 5, j + 211);
      const depth = 0.45 + 0.45 * hash(i + 9, j + 57);
      const twinkle = st.still ? 1 : 1 - depth * (1 - (0.5 + 0.5 * Math.sin(st.t * (1 + 1.1 * own) + own * 40)));
      c = mix(c, STAR, (0.45 + 0.55 * hash(i, j + 99)) * (1 - k) * Math.min(1, pal.stars + 0.3) * twinkle);
    }
  }
  let clouded = 0;
  if (pal.clouds > 0.01) {
    // Clouds keep to the middle of the sky, unless it has closed in.
    const band = Math.max(0, 1 - Math.abs(k - 0.38) * 1.8, f.look.grey);
    if (band > 0) {
      const n = fbm(x * 2.1 + st.drift, v * 6.5 + st.drift * 0.15);
      const cover = smooth(0.52, 0.74, n * band + 0.16 + closeIn(f.look)) * pal.clouds;
      clouded = cover;
      if (cover > 0.01) c = mix(c, mix(pal.cloudShade, pal.cloud, smooth(0.45, 0.85, n)), cover);
    }
  }
  if (f.look.fog > 0) c = mix(c, f.haze, f.look.fog * (0.35 + 0.45 * Math.min(1, k)));
  if (f.lightning > 0) c = mix(c, LIGHTNING, f.lightning * (0.05 + 0.4 * clouded));
  const d = Math.sqrt(d2);
  if (d < SUN_R * 1.05) c = mix(c, pal.core, smooth(SUN_R * 1.05, SUN_R * 0.8, d) * f.veil);
  if (f.moon.shows && m2 < MOON_R * MOON_R) {
    const ax = mdx / MOON_R;
    const ay = mdy / MOON_R;
    const nx = ax * f.moon.litX + ay * f.moon.litY;
    const ny = ay * f.moon.litX - ax * f.moon.litY;
    const on = nx > (1 - 2 * f.moon.fraction) * Math.sqrt(Math.max(0, 1 - ny * ny));
    c = mix(c, on ? MOON_LIT : mix(c, MOON_LIT, 0.08), pal.moon);
  }
  for (const s of f.streaks) {
    const vx = s.x2 - s.x1;
    const vy = s.y2 - s.y1;
    const t = clamp(((x - s.x1) * vx + (v - s.y1) * vy) / (vx * vx + vy * vy || 1));
    const dd = Math.hypot(x - (s.x1 + vx * t), v - (s.y1 + vy * t));
    if (dd < 0.012) c = mix(c, STAR, s.a * t * (1 - dd / 0.012));
  }
  return c;
}

/** The land and sky at (x, v), with the shard's light and the lantern over them. */
function world(f: Frame, x: number, v: number, i: number, j: number): RGB {
  const { pal } = f;
  const crest = crestAt(x);
  const far = HZ + 0.03 - 0.075 * Math.exp(-(((x + 0.9 * f.half) / 0.32) ** 2)) - 0.04 * Math.exp(-(((x - 0.84 * f.half) / 0.2) ** 2)) - 0.014 * fbm(x * 3 + 20, 1.7);
  let c: RGB;
  const onGround = v > crest;
  if (onGround) {
    const depth = clamp((v - crest) / 0.5);
    const frost = smooth(0.5, 0.72, fbm(x * 8 + 30, v * 24));
    c = mix(pal.ground, pal.frost, frost * (0.75 - 0.3 * depth));
    c = mix(c, pal.crest, Math.exp(-(v - crest) * 60) * 0.7);
    c = mul(c, 1 - 0.2 * depth);
    // In fog the slope fades into the haze, the far side of it most.
    if (f.look.fog > 0) c = mix(c, f.haze, f.look.fog * 0.4 * (1 - depth));
  } else if (v > far) {
    // Distant ranges, paler with the haze of distance, and all but gone in fog.
    c = mix(pal.far, pal.low, 0.22 * (1 - clamp((v - far) * 10)));
    if (f.look.fog > 0) c = mix(c, f.haze, f.look.fog * 0.8);
  } else c = skyAt(f, x, v, i, j);

  const pose = f.st.pose;
  const size = f.view.shardSize;
  if (pose.light > 0.01) {
    // A bright lens of light between the halves, inside a wide, soft glow.
    const dx = x;
    const dy = v - f.shardY;
    const sx = size * (0.04 + pose.gap * 0.55);
    const sy = size * 0.8;
    const breathe = f.st.still ? 0 : Math.sin(f.st.t * 0.9) * 0.08;
    c = add(c, SEAM, pose.light * (1 + breathe) * (Math.exp(-(dx * dx) / (sx * sx) - (dy * dy) / (sy * sy)) * 0.75 + Math.exp(-(dx * dx + dy * dy) / (size * size * 1.6)) * 0.28));
  }
  if (pose.ripple > 0.01 && onGround) {
    const d = Math.hypot(x, (v - f.groundY) * 5);
    c = add(c, SEAM, pose.ripple * Math.exp(-(((d - pose.rippleR) / 0.03) ** 2)) * 0.9);
  }
  const tv = f.traveller;
  if (tv) {
    const dx = x - tv.x;
    const dy = v - tv.y;
    const h = tv.h;
    // A dark figure, a head and a long coat, holding a lantern out to one side.
    const head = Math.hypot(dx, dy + h * 0.86) < h * 0.13;
    const body = dy < 0 && dy > -h * 0.74 && Math.abs(dx) < h * (0.12 + 0.12 * (1 + dy / (h * 0.74)));
    if (head || body) c = mix(c, [6, 7, 10], 0.9);
    const lx = dx - h * 0.3;
    const ly = dy + h * 0.38;
    const ld = lx * lx + ly * ly;
    c = add(c, LANTERN, (Math.exp(-ld / (h * h * 0.02)) * 1.2 + Math.exp(-ld / (h * h * 0.9)) * 0.25) * tv.flicker);
  }
  return c;
}

function shardColor(f: Frame, tri: Tri, p: V3, half: Half): RGB {
  const { pal, st } = f;
  const pose = st.pose;
  if (tri.cut) return mix([8, 9, 12], SEAM, clamp(pose.light * 1.2));
  // Obsidian: near black, the edge toward the sun or moon catching its light.
  const n = tri.n;
  const lit = Math.max(0, dot3(n, f.light));
  const night = f.sun.altitude < -0.1;
  let c = mix([10, 12, 16], pal.top, 0.08);
  c = add(c, night ? MOON_GLOW : pal.glow, lit ** 4 * (night ? 0.7 : 0.55));
  // After dark its faces hold a little sky light, so it still reads against the stars.
  if (night) c = add(c, MOON_GLOW, 0.1 + 0.1 * Math.max(0, n[1] + 0.3));
  c = add(c, pal.low, Math.max(0, n[0] * Math.sign(f.sun.x || 1)) ** 6 * 0.12);
  // The seam: where the split meets the outside, a thin line of light.
  const local: V3 = [p[0] - half.off[0], p[1] - half.off[1], p[2] - half.off[2]];
  const dist = Math.abs(dot3(local, f.shard.normal));
  const w = Math.max(0.012, f.seamW) * (1 + pose.gap * 6);
  if (dist < w) {
    const breathe = st.still ? 0 : 0.2 * Math.sin(st.t * 0.9);
    c = mix(c, SEAM, clamp((0.55 + breathe + st.pulse + pose.light) * (1 - dist / w) * 1.3));
  }
  return c;
}

function colorAt(f: Frame, x: number, v: number, i: number, j: number): RGB {
  const size = f.view.shardSize;
  const X = x / size;
  const Y = -(v - f.shardY) / size;
  if (X > -0.9 && X < 0.9 && Y > BOTTOM_Y - 0.1 && Y < TOP_Y + 0.1) {
    const hit = hitShard(f.shard, X, Y);
    if (hit) return shardColor(f, hit.tri, hit.p, hit.half);
  }
  return world(f, x, v, i, j);
}

/**
 * Draw the scene into a canvas sized W × H CSS pixels at this pixel ratio. Dots go
 * straight into an image, which is much quicker than drawing each one. `page` is the
 * colour the scene dissolves into.
 */
export function drawHill(canvas: HTMLCanvasElement, W: number, H: number, dpr: number, view: HillView, st: HillState, page: RGB): void {
  const PW = Math.round(W * dpr);
  const PH = Math.round(H * dpr);
  if (!PW || !PH) return;
  if (canvas.width !== PW || canvas.height !== PH) {
    canvas.width = PW;
    canvas.height = PH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { sun: s } = st;
  const look = lookOf(st.weather);
  const pal = weathered(blendPalette(s.blend), look);
  const half = W / 2 / view.unit;
  const now = st.clock ?? Date.now();
  const sp = sunPosition(now, s.place.lat, s.place.lng);
  const mp = moonPosition(now, s.place.lat, s.place.lng);
  const sun = place(sp.azimuth, sp.altitude, s.place.lat, half);
  const moonAt = place(mp.azimuth, mp.altitude, s.place.lat, half);
  const lit = moonPhase(now);
  const toSun = Math.hypot(sun.x - moonAt.x, sun.y - moonAt.y) || 1;
  const night = sun.altitude < -0.1;
  const from = night ? moonAt : sun;
  const lx = clamp(from.x / 0.6, -1.2, 1.2);
  const ly = 0.2 + Math.max(0, Math.sin(from.altitude)) * 1.2;
  const ll = Math.hypot(lx, ly, 0.8);

  const pose = st.pose;
  const groundY = crestAt(0);
  const shardY = view.shardY + (st.still ? 0 : Math.sin(st.t * 0.7) * 0.008) * (1 - pose.drop) + pose.drop * (groundY - view.shardSize * -BOTTOM_Y - view.shardY + 0.004);
  // Turning the split toward the viewer: settle on the nearest angle where it faces front.
  const facing = Math.round((st.spin + Math.PI / 2) / Math.PI) * Math.PI - Math.PI / 2;
  const spin = st.spin + (facing - st.spin) * pose.turn;

  let traveller: Frame['traveller'] = null;
  if (st.traveller !== null) {
    const k = st.traveller;
    const x0 = Math.min(0.16, half * 0.7);
    const x1 = view.shardSize * 0.75;
    const y0 = crestAt(x0) + 0.05;
    const y1 = crestAt(x1) + 0.002;
    traveller = {
      x: x0 + (x1 - x0) * k,
      y: y0 + (y1 - y0) * k,
      h: 0.045 - 0.022 * k + (st.still ? 0 : Math.abs(Math.sin(st.t * 3)) * 0.0015 * Math.min(1, k * 20) * (k < 0.999 ? 1 : 0)),
      flicker: st.still ? 1 : 0.85 + 0.15 * Math.sin(st.t * 9.1) * Math.sin(st.t * 3.7),
    };
  }

  const f: Frame = {
    pal,
    look,
    haze: hazeOf(pal),
    veil: discShows(look),
    lightning: look.storm && !st.still && st.flashAt !== undefined ? flashLevel(st.t - st.flashAt) : 0,
    view,
    st,
    half,
    sun,
    moon: { x: moonAt.x, y: moonAt.y, shows: mp.altitude > -0.02 && lit.fraction > 0.02, fraction: lit.fraction, litX: (sun.x - moonAt.x) / toSun, litY: (sun.y - moonAt.y) / toSun },
    light: [lx / ll, ly / ll, 0.8 / ll],
    shard: shardGeometry(spin, -0.1, pose.gap),
    shardY,
    groundY,
    seamW: ((view.cell / view.unit) / view.shardSize) * 0.7,
    traveller,
    streaks: st.streaks
      .filter((s2) => streakAlive(s2, st.t))
      .map((s2) => {
        const a = st.t - s2.born;
        const hx = s2.x + s2.dir * a * 0.7;
        const hy = s2.y + a * 0.35;
        const len = Math.min(0.3, 0.05 + a * 0.6);
        return { x1: hx - s2.dir * len, y1: hy - len * 0.5, x2: hx, y2: hy, a: 1 - a / STREAK_LIFE };
      }),
  };

  const img = ctx.createImageData(PW, PH);
  const px = img.data;
  const cell = view.cell;
  const pc = cell * dpr;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const bg = mul(pal.top, 0.4);
  const flash = pose.flash;
  // Rain or snow over the whole scene, in front of the land.
  const falling = precipitation(look, st.t, cols, rows, W / H);
  const paintFall = fallPainter(look, pal);
  for (let j = 0; j < rows; j++) {
    const v = (j * cell + cell / 2 - view.top) / view.unit;
    // How far into a fade this row is: 0 is all scene, 1 all page. Into the page below
    // (under the welcome form) the scene gives way quickly; rising out of the page above
    // (the foot of Today) it is as gradual as the Today sky's fade.
    const below = view.fadeBottom ? clamp((v - view.fadeBottom[0]) / (view.fadeBottom[1] - view.fadeBottom[0])) : 0;
    const above = view.fadeTop ? clamp((view.fadeTop[1] - v) / (view.fadeTop[1] - view.fadeTop[0])) : 0;
    const into = Math.max(below, above);
    if (into >= 0.995) continue;
    const toPage = Math.max(smooth(0, 0.6, below), smooth(0, 0.85, above));
    // At the very edge the scene lets go of the page colour too, so the page's own tint shows.
    const alpha = Math.round(255 * (1 - smooth(0.6, 1, into)));
    const ground = mix(bg, page, Math.max(smooth(0, 0.55, below), smooth(0, 0.85, above)));
    const y0 = Math.round(j * pc);
    const y1 = Math.min(PH, Math.round((j + 1) * pc));
    for (let y = y0; y < y1; y++) {
      for (let x = 0, k = y * PW * 4; x < PW; x++, k += 4) {
        px[k] = ground[0];
        px[k + 1] = ground[1];
        px[k + 2] = ground[2];
        px[k + 3] = alpha;
      }
    }
    for (let i = 0; i < cols; i++) {
      const x = (i * cell + cell / 2 - view.cx) / view.unit;
      let c = colorAt(f, x, v, i, j);
      const fell = falling ? falling[j * cols + i]! : 0;
      if (fell > 0) c = paintFall(c, fell);
      if (flash > 0) c = mix(c, FLASH, flash);
      const b = B4[j & 3][i & 3];
      const r = pc * 0.5 * clamp(0.16 + 0.92 * Math.sqrt(lum(c)) + (b - 0.5) * 0.22);
      if (r < 0.35) continue;
      let dotColor = mul(c, 0.9 + 0.25 * b);
      if (toPage > 0) dotColor = mix(dotColor, page, toPage);
      disc(px, PW, PH, (i + 0.5) * pc, y0 + pc / 2, r, dotColor);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** An anti-aliased dot, blended into the image (alpha is left as the row's). */
function disc(px: Uint8ClampedArray, W: number, H: number, cx: number, cy: number, r: number, c: RGB): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const R0 = clamp(c[0], 0, 255);
  const G0 = clamp(c[1], 0, 255);
  const B0 = clamp(c[2], 0, 255);
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0, k = (y * W + x0) * 4; x <= x1; x++, k += 4) {
      const dx = x + 0.5 - cx;
      const a = clamp(r - Math.sqrt(dx * dx + dy * dy) + 0.5);
      if (a <= 0) continue;
      px[k] += (R0 - px[k]) * a;
      px[k + 1] += (G0 - px[k + 1]) * a;
      px[k + 2] += (B0 - px[k + 2]) * a;
    }
  }
}

/** The page's background colour as it is now (it changes with the theme and phase). */
export function pageColor(): RGB {
  const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [238, 240, 244];
}

/** Whether stars are out (and not behind cloud or fog), for shooting stars. */
export function starsOut(sun: SunState, weather?: Weather | null): boolean {
  return weatherSky(blendPalette(sun.blend), lookOf(weather)).stars > 0.3;
}

/** A new shooting star at (x, y) in scene units, heading away from the centre. */
export function streakAt(t: number, x: number, y: number): Streak {
  return { born: t, x, y, dir: x < 0 ? 1 : -1 };
}

/** Dot spacing, as on the Today sky: finer on a phone. */
export const cellFor = (width: number) => (width <= 720 ? 3 : 5);
