// The time of day where you are, and the theme that follows it.
//
// The day is cut into four phases from the sun at your location, using the same prayer
// calculation as the Faith pill: dawn from Fajr to an hour after sunrise, day until 45
// minutes before Maghrib, dusk until Isha, evening until Fajr. The location is this
// device's (asked for once) or, failing that, the one saved for prayer times. The clock
// is always the device's, so it moves by itself when you land somewhere new.
//
// With the "Follow the sun" theme the whole interface takes each phase's colours; the
// Today sky follows the phase whatever the theme.

import { CalculationMethod, Coordinates, PrayerTimes, type CalculationParameters } from 'adhan';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useFaith } from './api.ts';

export type Phase = 'dawn' | 'day' | 'dusk' | 'evening';
export type ThemePref = 'sun' | 'system' | 'light' | 'dark';
export const PHASES: Phase[] = ['dawn', 'day', 'dusk', 'evening'];
const SCHEME: Record<Phase, 'light' | 'dark'> = { dawn: 'light', day: 'light', dusk: 'dark', evening: 'dark' };
/** Each phase's page colour, for the browser's own bar. Matches --bg in styles.css. */
const PAGE_BG: Record<Phase, string> = { dawn: '#f5ede9', day: '#eef0f4', dusk: '#121820', evening: '#0b0c10' };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** How long the sky takes to blend from one phase into the next, centred on the change. */
const FADE = 20 * MIN;

// ── Storage ─────────────────────────────────────────────────────────────────

const PREF_KEY = 'terminus.theme';
/** Today's phase changes, so the page can colour itself before any script loads (index.html). */
const MARKS_KEY = 'terminus.sky.marks';
/** The last place used, so the first frame after a reload is already right. */
const PLACE_KEY = 'terminus.sky.place';
/** A fix from this device: { lat, lng, at }. Kept only in this browser. */
const DEVICE_KEY = 'terminus.sky.device';
const ASKED_KEY = 'terminus.sky.asked';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is off (private window): it all still works, it just isn't remembered.
  }
}
function getJson<T>(key: string): T | null {
  try {
    const raw = get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function readThemePref(): ThemePref {
  const t = get(PREF_KEY) ?? get('lifeos.theme');
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'sun';
}

// ── Astronomy ───────────────────────────────────────────────────────────────
// Low-precision positions of the sun and moon (good to a fraction of a degree), after
// the formulas in the Astronomy Answers articles at aa.quae.nl. Azimuth is measured
// from south, positive toward the west.

const RAD = Math.PI / 180;
const OBLIQUITY = RAD * 23.4397;
const toDays = (ms: number) => ms / DAY - 0.5 + 2440588 - 2451545;
const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const siderealTime = (d: number, lw: number) => RAD * (280.16 + 360.9856235 * d) - lw;

function sunCoords(d: number) {
  const m = RAD * (357.5291 + 0.98560028 * d);
  const l = m + RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)) + RAD * 102.9372 + Math.PI;
  return { ra: rightAscension(l, 0), dec: declination(l, 0) };
}

function moonCoords(d: number) {
  const l0 = RAD * (218.316 + 13.176396 * d);
  const m = RAD * (134.963 + 13.064993 * d);
  const f = RAD * (93.272 + 13.22935 * d);
  const l = l0 + RAD * 6.289 * Math.sin(m);
  const b = RAD * 5.128 * Math.sin(f);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(m) };
}

export interface SkyPosition {
  azimuth: number;
  altitude: number;
}

function horizontal(ra: number, dec: number, d: number, lat: number, lng: number): SkyPosition {
  const phi = RAD * lat;
  const h = siderealTime(d, RAD * -lng) - ra;
  return {
    azimuth: Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)),
  };
}

export function sunPosition(ms: number, lat: number, lng: number): SkyPosition {
  const d = toDays(ms);
  const c = sunCoords(d);
  return horizontal(c.ra, c.dec, d, lat, lng);
}

export function moonPosition(ms: number, lat: number, lng: number): SkyPosition {
  const d = toDays(ms);
  const c = moonCoords(d);
  return horizontal(c.ra, c.dec, d, lat, lng);
}

/** How much of the moon is lit (0–1), and where it is in its month: 0 new, 0.5 full. */
export function moonPhase(ms: number): { fraction: number; phase: number } {
  const d = toDays(ms);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sunDist = 149598000;
  const elong = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sunDist * Math.sin(elong), m.dist - sunDist * Math.cos(elong));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
}

// ── Phases ──────────────────────────────────────────────────────────────────

export interface Place {
  lat: number;
  lng: number;
  method?: string;
}

/** The four moments the phase changes on a calendar day, as epoch ms. */
export interface Marks {
  dawn: number;
  day: number;
  dusk: number;
  evening: number;
}

function prayerMarks(place: Place, date: Date): Marks | null {
  const methods = CalculationMethod as unknown as Record<string, (() => CalculationParameters) | undefined>;
  const params = (methods[place.method ?? ''] ?? CalculationMethod.MuslimWorldLeague)();
  // adhan reads only the calendar date from this value.
  const pt = new PrayerTimes(new Coordinates(place.lat, place.lng), new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12), params);
  const m = { dawn: pt.fajr.getTime(), day: pt.sunrise.getTime() + HOUR, dusk: pt.maghrib.getTime() - 45 * MIN, evening: pt.isha.getTime() };
  if (Object.values(m).some(Number.isNaN)) return null;
  if (!(m.dawn < m.day && m.day < m.dusk && m.dusk < m.evening)) return null;
  return m;
}

/** A plain clock, for where the sun doesn't rise or set today (or nothing is known). */
function clockMarks(date: Date): Marks {
  const at = (h: number, m: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m).getTime();
  return { dawn: at(5, 30), day: at(8, 0), dusk: at(18, 15), evening: at(20, 15) };
}

/** With no location at all: the equator, at the longitude this device's time zone implies. */
export function guessPlace(): Place {
  return { lat: 0, lng: -new Date().getTimezoneOffset() / 4 };
}

export function marksFor(place: Place | null, date: Date): Marks {
  return (place && prayerMarks(place, date)) || clockMarks(date);
}

export interface Blend {
  from: Phase;
  to: Phase;
  /** 0 is all `from`, 1 all `to`. */
  t: number;
}

export function phaseAt(ms: number, m: Marks): { phase: Phase; blend: Blend } {
  let phase: Phase = 'evening';
  for (const p of PHASES) if (ms >= m[p]) phase = p;
  for (const p of PHASES) {
    const dt = ms - m[p];
    if (Math.abs(dt) < FADE / 2) {
      const prev = PHASES[(PHASES.indexOf(p) + 3) % 4]!;
      return { phase, blend: { from: prev, to: p, t: (dt + FADE / 2) / FADE } };
    }
  }
  return { phase, blend: { from: phase, to: phase, t: 0 } };
}

// ── State ───────────────────────────────────────────────────────────────────

export interface SunState {
  pref: ThemePref;
  phase: Phase;
  blend: Blend;
  /** Where the sun is being worked out for. */
  place: Place;
  source: 'device' | 'saved' | 'guess';
  marks: Marks;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let state: SunState = initialState();

function initialState(): SunState {
  const cached = getJson<Place & { source?: SunState['source'] }>(PLACE_KEY);
  const place = cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lng) ? cached : guessPlace();
  const now = Date.now();
  const marks = marksFor(place, new Date(now));
  return { pref: readThemePref(), ...phaseAt(now, marks), place, source: cached?.source ?? 'guess', marks };
}

function update(next: Partial<SunState>): void {
  const before = state;
  state = { ...state, ...next };
  applyTheme(before);
  listeners.forEach((l) => l());
}

export function useSun(): SunState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function setThemePref(pref: ThemePref): void {
  set('lifeos.theme', null);
  set(PREF_KEY, pref);
  update({ pref });
}

// ── Theme ───────────────────────────────────────────────────────────────────

function themeColor(color: string | null): void {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    if (!meta.dataset.original) meta.dataset.original = meta.content;
    meta.content = color ?? meta.dataset.original;
  });
}

function paint(): void {
  const root = document.documentElement;
  const { pref, phase } = state;
  if (pref === 'sun') {
    root.dataset.theme = SCHEME[phase];
    root.dataset.phase = phase;
    themeColor(PAGE_BG[phase]);
  } else {
    delete root.dataset.phase;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
    themeColor(null);
  }
}

/** Repaint when the theme or the phase changed. A phase change while you watch cross-fades. */
function applyTheme(before: SunState | null): void {
  if (before && before.pref === state.pref && (state.pref !== 'sun' || before.phase === state.phase)) return;
  const quietly = !before || before.pref !== state.pref || document.visibilityState !== 'visible' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!quietly && doc.startViewTransition) doc.startViewTransition(paint);
  else paint();
}

applyTheme(null);

// ── Location ────────────────────────────────────────────────────────────────

interface DeviceFix {
  lat: number;
  lng: number;
  at: number;
}

/**
 * This device's location: silently when already allowed, and asked for once otherwise.
 * Rounded to about a kilometre, which is plenty for sunrise and sunset.
 */
function locate(onFix: (fix: DeviceFix) => void): void {
  if (!('geolocation' in navigator)) return;
  const ask = () =>
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const fix = { lat: Math.round(p.coords.latitude * 100) / 100, lng: Math.round(p.coords.longitude * 100) / 100, at: Date.now() };
        set(DEVICE_KEY, JSON.stringify(fix));
        onFix(fix);
      },
      () => undefined,
      { maximumAge: HOUR, timeout: 20_000 },
    );
  const askOnce = () => {
    if (get(ASKED_KEY)) return;
    set(ASKED_KEY, '1');
    ask();
  };
  if (!navigator.permissions?.query) return askOnce();
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((status) => {
      if (status.state === 'granted') ask();
      else if (status.state === 'prompt') askOnce();
    })
    .catch(askOnce);
}

/**
 * Keeps the phase moving where the app shell (and useSunClock) isn't mounted: sign-in and
 * first-run setup. It uses the last place known, without asking for the device's location.
 */
export function useSunTick(): void {
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const marks = new Date(state.marks.day).toDateString() === now.toDateString() ? state.marks : marksFor(state.place, now);
      update({ ...phaseAt(now.getTime(), marks), marks });
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);
}

/** Keeps the phase current: mounted once, in the app shell. */
export function useSunClock(): void {
  const { data: faith } = useFaith();
  const [device, setDevice] = useState<DeviceFix | null>(() => getJson<DeviceFix>(DEVICE_KEY));
  useEffect(() => locate(setDevice), []);

  const s = faith?.settings;
  const savedLat = s?.lat ?? null;
  const savedLng = s?.lng ?? null;
  const method = s?.method;
  const loaded = faith !== undefined;

  useEffect(() => {
    // A fix from the last day counts; an older one may be from before a flight.
    const fresh = device && Date.now() - device.at < DAY ? device : null;
    const saved = savedLat !== null && savedLng !== null ? { lat: savedLat, lng: savedLng } : null;
    const known = fresh ? 'device' : saved ? 'saved' : null;
    // Before the saved location has loaded, keep whatever was used last time.
    if (!known && !loaded) return;
    const place: Place = { ...(fresh ?? saved ?? guessPlace()), method };
    const source: SunState['source'] = known ?? 'guess';
    set(PLACE_KEY, JSON.stringify({ ...place, source }));

    let day = '';
    let marks = state.marks;
    const tick = () => {
      const now = new Date();
      const today = now.toDateString();
      if (today !== day) {
        day = today;
        marks = marksFor(place, now);
        set(MARKS_KEY, JSON.stringify({ ...marks, date: today }));
      }
      update({ ...phaseAt(now.getTime(), marks), place, source, marks });
    };
    tick();
    const timer = setInterval(tick, 30_000);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [device, savedLat, savedLng, method, loaded]);
}
