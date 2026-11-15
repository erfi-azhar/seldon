// The weather where you are, as the dot-matrix skies show it: the band at the top of
// Today (components/Sky.tsx) and the hill at its foot (hill.ts). The reading itself comes
// from the server (/api/weather, from Open-Meteo); this turns it into how a sky looks.
//
// Cloud cover sets how much cloud there is. Overcast, wet, foggy and snowy skies turn
// greyer and dimmer, their clouds run together into one layer, the stars hide and the sun
// and moon are veiled. Rain falls in slanted streaks, snow drifts down, fog drifts in banks
// (with a moon halo and a warm town glow after dark), and storms add an occasional soft lightning glow (a slow
// fade, seconds apart, never a strobe). Wind speeds the clouds up.

import type { Weather } from '../../shared/types.ts';

type RGB = [number, number, number];

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (a: RGB, b: RGB, t: number): RGB => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
const mul = (a: RGB, t: number): RGB => [a[0] * t, a[1] * t, a[2] * t];
const lum = (c: RGB) => clamp((0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255);

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
const fbm = (x: number, y: number) => 0.5 * noise(x, y) + 0.25 * noise(x * 2.03, y * 2.03) + 0.125 * noise(x * 4.1, y * 4.1) + 0.0625 * noise(x * 8.3, y * 8.3);

// Fog drifts in banks that open and close, so it greys the sky less than its cloud cover
// would and lets some stars through the gaps (see fogPainter).
const FOG_STARS = 0.3;
const FOG_GREY = 0.4;
/** How much fog's cloud cover adds to the grey, as a share of what it would. */
const FOG_CLOUD_GREY = 0.6;

export interface Look {
  /** Share of the sky under cloud, 0–1; below 0 when the weather isn't known. */
  cover: number;
  /** How grey the sky has turned: overcast, wet, foggy or snowy. */
  grey: number;
  fog: number;
  rain: number;
  snow: number;
  storm: boolean;
  /** Drizzle: fine rain, lighter than a shower. */
  drizzle: boolean;
  /** Cloud speed, as a share of a calm day's. */
  wind: number;
}

export const UNKNOWN: Look = { cover: -1, grey: 0, fog: 0, rain: 0, snow: 0, storm: false, drizzle: false, wind: 1 };

// How rain is drawn. After dark drizzle only veils the sky lightly, so a drizzly night
// stays a deep navy rather than going flat grey; by day, and in heavier rain, the sky
// greys by 0.65. Against a dark sky
// rain is a pale blue-white, and each drop's leading dot glints as if it caught a
// streetlight, with a softer trail behind it. Drizzle has more drops than its share of
// rain alone would give, and longer ones, so it reads as rain.
const DRIZZLE_GREY = 0.25;
/** How much a drizzly night's cloud cover adds to its grey, as a share of what it would. */
const DRIZZLE_CLOUD_GREY = 0.3;
const NIGHT_RAIN: RGB = [176, 192, 224];
const NIGHT_RAIN_STRENGTH = 0.6;
const NIGHT_GLINT = 0.9;
const DRIZZLE_DROPS = 1.6;
const DRIZZLE_LENGTH = 1.5;

export function lookOf(w: Weather | null | undefined): Look {
  if (!w) return UNKNOWN;
  const cover = w.cloudCover / 100;
  const wet = w.kind === 'drizzle' || w.kind === 'rain' || w.kind === 'showers' || w.kind === 'storm';
  const heavy = clamp(0.3 + w.precipitation / 3);
  const nightDrizzle = w.kind === 'drizzle' && !w.isDay;
  return {
    cover,
    grey: Math.max(smooth(0.6, 1, cover) * (nightDrizzle ? DRIZZLE_CLOUD_GREY : w.kind === 'fog' ? FOG_CLOUD_GREY : 1), nightDrizzle ? DRIZZLE_GREY : wet ? 0.65 : 0, w.kind === 'fog' ? FOG_GREY : 0, w.kind === 'snow' ? 0.5 : 0),
    fog: w.kind === 'fog' ? 1 : 0,
    rain: w.kind === 'drizzle' ? 0.3 : w.kind === 'rain' || w.kind === 'showers' ? 0.45 + 0.55 * heavy : w.kind === 'storm' ? 1 : 0,
    snow: w.kind === 'snow' ? 0.4 + 0.6 * heavy : 0,
    storm: w.kind === 'storm',
    drizzle: w.kind === 'drizzle',
    wind: clamp(0.6 + w.windKmh / 20, 0.5, 3),
  };
}

export const greyed = (c: RGB, t: number): RGB => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return mix(c, [l * 0.96, l * 0.98, l * 1.04], t);
};

/** The colours a sky palette has, whichever scene it belongs to. */
export interface SkyColors {
  top: RGB;
  mid: RGB;
  low: RGB;
  glowStrength: number;
  cloud: RGB;
  cloudShade: RGB;
  clouds: number;
  stars: number;
  moon: number;
}

/** A phase's sky under the weather: greyer and dimmer as it closes in, cloud as reported. */
export function weatherSky<P extends SkyColors>(p: P, w: Look): P {
  if (w.cover < 0) return p;
  const g = w.grey;
  const cloud = mul(greyed(p.cloud, g * 0.75), 1 - 0.2 * g);
  return {
    ...p,
    top: mul(greyed(p.top, g * 0.6), 1 - 0.12 * g),
    mid: mul(greyed(p.mid, g * 0.6), 1 - 0.12 * g),
    low: greyed(p.low, g * 0.5),
    cloud,
    // As it closes in, the clouds lose their shading and run together into one grey layer.
    cloudShade: mix(mul(greyed(p.cloudShade, g * 0.7), 1 - 0.1 * g), cloud, 0.5 * g),
    clouds: w.cover < 0.5 ? 0.12 + 0.48 * (w.cover / 0.5) : 0.6 + 0.4 * ((w.cover - 0.5) / 0.5),
    stars: p.stars * (1 - smooth(0.3, 0.95, w.cover) * (w.fog > 0 ? 0.4 : 1)) * (1 - w.fog * (1 - FOG_STARS)),
    glowStrength: p.glowStrength * (1 - 0.75 * g),
    moon: p.moon * (1 - 0.7 * g),
  };
}

/** How much a cloud layer's coverage threshold drops as the sky closes in. */
export const closeIn = (w: Look) => 0.42 * w.grey;

/** How plainly the sun's disc shows through the cloud. */
export const discShows = (w: Look) => 1 - 0.65 * w.grey;

/** Fog: a pale haze by day and a dim grey one at night, lighter than the dark sky behind it. */
export const hazeOf = (p: SkyColors): RGB => add(greyed(mix(p.low, p.cloud, 0.5), 0.85), [14, 15, 18], 1);

const CITY_GLOW: RGB = [255, 196, 150];

/** The moon, where a scene has put it, for fog to catch its light. */
export interface FogMoon {
  x: number;
  y: number;
  shows: boolean;
  fraction: number;
}

/**
 * How fog colours a dot at (x, v), in a scene's own units (x across, v down with the
 * horizon near k = 1). Null when there is no fog.
 *
 * Two layers of fog banks drift sideways at different speeds, thicker toward the horizon,
 * opening and closing on the sky behind. After dark the moon wears a wide, soft halo, the
 * way fog scatters its light, and the horizon carries a faint warm glow, like distant
 * streetlights in the mist; both fade out as the sky brightens.
 */
export function fogPainter(w: Look, p: SkyColors, seconds: number, moon: FogMoon): ((c: RGB, x: number, v: number, k: number) => RGB) | null {
  if (w.fog <= 0) return null;
  const haze = hazeOf(p);
  const bright = add(haze, [20, 21, 24], 1);
  const s = seconds;
  // 1 under a night sky, 0 by day: from how dark the top of the sky is.
  const dark = 1 - smooth(0.12, 0.4, lum(p.top));
  const moonLight = moon.shows ? dark * Math.max(0.35, moon.fraction) : 0;
  return (c, x, v, k) => {
    const kk = Math.min(1, k);
    const n1 = fbm(x * 1.1 + s * 0.05, v * 3.2 + 7);
    const n2 = fbm(x * 2.3 - s * 0.03 + 40, v * 5 + 13);
    const bank = smooth(0.42, 0.72, n1) * 0.6 + smooth(0.5, 0.78, n2) * 0.4;
    let out = mix(c, mix(haze, bright, bank), clamp(0.18 + 0.22 * kk + bank * (0.55 + 0.35 * kk)));
    if (moonLight > 0) {
      const d2 = (x - moon.x) ** 2 + (v - moon.y) ** 2;
      out = add(out, [170, 182, 214], (Math.exp(-d2 / 0.09) * 0.32 + Math.exp(-d2 / 0.012) * 0.25) * moonLight);
    }
    if (dark > 0) out = add(out, CITY_GLOW, smooth(0.55, 1.1, k) * 0.16 * dark * (0.85 + 0.15 * Math.sin(s * 0.3 + x * 1.7)));
    return out;
  };
}

export const SNOW: RGB = [244, 247, 252];
export const FLASH: RGB = [236, 240, 255];

const GLINT: RGB = [240, 245, 255];

/**
 * How a falling streak or flake colours a dot, for this frame's sky: rain shows as darker
 * streaks against a pale sky and lighter ones against a dark sky; snow is white. `fell` is
 * the cell's value from precipitation(): above 1 at a drop's glinting head.
 */
export function fallPainter(w: Look, p: SkyColors): (c: RGB, fell: number) => RGB {
  if (w.snow > 0) return (c, fell) => mix(c, SNOW, Math.min(1, fell) * 0.85);
  if (lum(p.cloud) > 0.55) {
    const ink = mix(p.cloud, [84, 100, 128], 0.6);
    return (c, fell) => mix(c, ink, Math.min(1, fell) * 0.5);
  }
  return (c, fell) => {
    const out = mix(c, NIGHT_RAIN, Math.min(1, fell) * NIGHT_RAIN_STRENGTH);
    return fell > 1 ? mix(out, GLINT, Math.min(1, fell - 1)) : out;
  };
}

/**
 * Rain streaks or snowflakes for this frame, laid onto a dot grid of cols × rows over a
 * canvas `aspect` times as wide as it is tall: how strongly each cell is covered, 0–1.
 * Null when nothing is falling.
 */
export function precipitation(w: Look, seconds: number, cols: number, rows: number, aspect: number): Float32Array | null {
  if (w.rain <= 0 && w.snow <= 0) return null;
  const grid = new Float32Array(cols * rows);
  const put = (x: number, y: number, a: number) => {
    const ci = Math.floor((x / aspect) * cols);
    const cj = Math.floor(y * rows);
    if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return;
    const at = cj * cols + ci;
    if (a > grid[at]!) grid[at] = a;
  };
  if (w.rain > 0) {
    const slant = 0.1 + 0.05 * w.wind;
    const drops = Math.round(w.rain * 0.9 * cols * (w.drizzle ? DRIZZLE_DROPS : 1));
    for (let d = 0; d < drops; d++) {
      const speed = 1.5 + 0.8 * hash(d, 3);
      const len = (0.05 + 0.07 * hash(d, 4) * w.rain) * (w.drizzle ? DRIZZLE_LENGTH : 1);
      const y = ((hash(d, 2) * 1.4 + seconds * speed) % 1.4) - 0.2;
      const x = hash(d, 1) * (aspect + 0.5) - 0.3 + slant * y;
      const steps = Math.ceil(len * rows) + 1;
      for (let n = 0; n <= steps; n++) {
        const k = n / steps;
        // The head carries a glint (a value above 1, drawn only against a dark sky); the tail fades behind it.
        put(x - slant * len * k, y - len * k, n === 0 ? 1 + NIGHT_GLINT * (0.5 + 0.5 * hash(d, 5)) : 1 - 0.6 * k);
      }
    }
  }
  if (w.snow > 0) {
    const flakes = Math.round(w.snow * 0.45 * cols);
    for (let d = 0; d < flakes; d++) {
      const speed = 0.08 + 0.08 * hash(d, 13);
      const y = ((hash(d, 12) * 1.3 + seconds * speed) % 1.3) - 0.15;
      const x = hash(d, 11) * (aspect + 0.2) - 0.1 + 0.04 * Math.sin(seconds * (0.5 + 0.4 * hash(d, 14)) + d) + 0.02 * w.wind * y;
      put(x, y, 0.7 + 0.3 * hash(d, 15));
    }
  }
  return grid;
}

/** A soft lightning glow, never a strobe: a quick rise and a slow fade. `age` in seconds since it began. */
export function flashLevel(age: number): number {
  if (age < 0 || age > 1.6) return 0;
  return 0.3 * (age < 0.12 ? age / 0.12 : Math.exp(-(age - 0.12) / 0.35));
}

/** Seconds until the next lightning flash. */
export const nextFlashIn = () => 7 + Math.random() * 12;

/** Whether anything is falling or flashing, so a scene should keep drawing steadily. */
export const moving = (w: Look) => w.rain > 0 || w.snow > 0 || w.storm;

// ── Words and units, for the weather chip ─────────────────────────────────────

/** The WMO weather code in a few plain words. */
export function weatherLabel(code: number): string {
  const words: Record<number, string> = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
  };
  return words[code] ?? 'Unsettled';
}

export type TempUnit = 'c' | 'f';
const UNIT_KEY = 'terminus.units';
const unitListeners = new Set<() => void>();

export function readTempUnit(): TempUnit {
  try {
    return localStorage.getItem(UNIT_KEY) === 'f' ? 'f' : 'c';
  } catch {
    return 'c';
  }
}

export function setTempUnit(unit: TempUnit): void {
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch {
    // Storage is off: the choice holds for this visit only.
  }
  unitListeners.forEach((l) => l());
}

export function onTempUnit(listener: () => void): () => void {
  unitListeners.add(listener);
  return () => unitListeners.delete(listener);
}

/** A °C reading in the chosen unit, rounded, with its degree sign. */
export const degrees = (celsius: number, unit: TempUnit) => `${Math.round(unit === 'f' ? (celsius * 9) / 5 + 32 : celsius)}°`;
