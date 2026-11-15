// The weather where you are, as the dot-matrix skies show it: the band at the top of
// Today (components/Sky.tsx) and the hill at its foot (hill.ts). The reading itself comes
// from the server (/api/weather, from Open-Meteo); this turns it into how a sky looks.
//
// Cloud cover sets how much cloud there is. Overcast, wet, foggy and snowy skies turn
// greyer and dimmer, their clouds run together into one layer, the stars hide and the sun
// and moon are veiled. Rain falls in slanted streaks, snow drifts down, fog is a haze that
// thickens toward the horizon, and storms add an occasional soft lightning glow (a slow
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

export interface Look {
  /** Share of the sky under cloud, 0–1; below 0 when the weather isn't known. */
  cover: number;
  /** How grey the sky has turned: overcast, wet, foggy or snowy. */
  grey: number;
  fog: number;
  rain: number;
  snow: number;
  storm: boolean;
  /** Cloud speed, as a share of a calm day's. */
  wind: number;
}

export const UNKNOWN: Look = { cover: -1, grey: 0, fog: 0, rain: 0, snow: 0, storm: false, wind: 1 };

export function lookOf(w: Weather | null | undefined): Look {
  if (!w) return UNKNOWN;
  const cover = w.cloudCover / 100;
  const wet = w.kind === 'drizzle' || w.kind === 'rain' || w.kind === 'showers' || w.kind === 'storm';
  const heavy = clamp(0.3 + w.precipitation / 3);
  return {
    cover,
    grey: Math.max(smooth(0.6, 1, cover), wet ? 0.65 : 0, w.kind === 'fog' || w.kind === 'snow' ? 0.5 : 0),
    fog: w.kind === 'fog' ? 1 : 0,
    rain: w.kind === 'drizzle' ? 0.3 : w.kind === 'rain' || w.kind === 'showers' ? 0.45 + 0.55 * heavy : w.kind === 'storm' ? 1 : 0,
    snow: w.kind === 'snow' ? 0.4 + 0.6 * heavy : 0,
    storm: w.kind === 'storm',
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
    stars: p.stars * (1 - smooth(0.3, 0.95, w.cover)) * (1 - w.fog),
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

export const SNOW: RGB = [244, 247, 252];
export const FLASH: RGB = [236, 240, 255];

/** Rain shows as darker streaks against a pale sky and lighter ones against a dark sky. */
export function fallColor(w: Look, p: SkyColors): RGB {
  if (w.snow > 0) return SNOW;
  return lum(p.cloud) > 0.55 ? mix(p.cloud, [84, 100, 128], 0.6) : mix(p.cloud, [235, 240, 250], 0.35);
}

/** How strongly a falling streak or flake colours a dot. */
export const fallStrength = (w: Look) => (w.snow > 0 ? 0.85 : 0.5);

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
    const drops = Math.round(w.rain * 0.9 * cols);
    for (let d = 0; d < drops; d++) {
      const speed = 1.5 + 0.8 * hash(d, 3);
      const len = 0.05 + 0.07 * hash(d, 4) * w.rain;
      const y = ((hash(d, 2) * 1.4 + seconds * speed) % 1.4) - 0.2;
      const x = hash(d, 1) * (aspect + 0.5) - 0.3 + slant * y;
      const steps = Math.ceil(len * rows) + 1;
      for (let n = 0; n <= steps; n++) {
        const t = n / steps;
        put(x - slant * len * t, y - len * t, 1 - 0.6 * t);
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
