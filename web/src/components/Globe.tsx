// A dotted globe for a trip's flights, after the flight-search pattern: the globe spins to the
// departure airport, then turns to frame the whole route as the arrival appears, the route draws
// itself, and a plane flies it, climbing a little (it grows) and settling as it lands. Then the
// next flight, on a loop. North stays up; the Earth spins rather than tilts.
//
// Drawn on a canvas so the globe can turn smoothly: the sphere and its dots are redrawn only
// while it turns and blitted otherwise; the route, markers, labels and plane are drawn on top
// each frame. It pauses when off screen or in a background tab. Land comes from a 1° grid shipped
// with the app (land.ts); nothing is fetched. With reduced motion it shows the first flight still.

import { useEffect, useMemo, useRef, useState } from 'react';
import { LAND } from '../land.ts';
import { planePaint, type PlanePaint } from './Tails.tsx';

export interface GlobeLeg {
  from: { code: string; lat: number; lon: number };
  to: { code: string; lat: number; lon: number };
  /** Scheduled time in the air, for the caption. */
  minutes?: number;
  /** The operating airline's code, to paint the plane in its livery. */
  carrier?: string;
  /** The booking it comes from, to find the flight that's in the air. */
  id?: string;
}

/** A flight in the air now: which leg, and when it really left and lands (ms). The globe tracks it. */
export interface GlobeLive {
  leg: number;
  start: number;
  end: number;
}

type V3 = [number, number, number];
const RAD = Math.PI / 180;
const vec = (lat: number, lon: number): V3 => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const latLon = (p: V3): [number, number] => [Math.asin(Math.max(-1, Math.min(1, p[2]))) / RAD, Math.atan2(p[1], p[0]) / RAD];

/** The point a fraction t of the way along the great circle from a to b. */
function slerp(a: V3, b: V3, t: number): V3 {
  const w = angle(a, b);
  if (w < 1e-6) return a;
  const s = Math.sin(w);
  const k1 = Math.sin((1 - t) * w) / s;
  const k2 = Math.sin(t * w) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}

/** Great-circle distance in kilometres. */
export const distanceKm = (l: GlobeLeg) => Math.round(angle(vec(l.from.lat, l.from.lon), vec(l.to.lat, l.to.lon)) * 6371);

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

// ── The dot grid, as unit vectors: land cells, and the sea between them ─────────

const { LAND_POINTS, SEA_POINTS } = (() => {
  const raw = atob(LAND.bits);
  const bits = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bits[i] = raw.charCodeAt(i);
  const land: number[] = [];
  const sea: number[] = [];
  for (let r = 0; r < LAND.rows; r++)
    for (let c = 0; c < LAND.cols; c++) {
      const i = r * LAND.cols + c;
      const p = vec(LAND.lat0 - r - 0.5, -180 + c + 0.5);
      // The sea a little sparser than the land, so the coastlines carry the picture.
      if ((bits[i >> 3]! >> (i & 7)) & 1) land.push(p[0], p[1], p[2]);
      else if ((r + c) % 2 === 0) sea.push(p[0], p[1], p[2]);
    }
  return { LAND_POINTS: new Float32Array(land), SEA_POINTS: new Float32Array(sea) };
})();

// ── The view: where the globe faces and how big it is ───────────────────────────

interface View {
  centre: V3;
  R: number;
}

/** North-up axes for a view centred on c. */
function axes(c: V3): { e: V3; n: V3 } {
  let e = cross([0, 0, 1], c);
  if (Math.hypot(...e) < 1e-6) e = [0, 1, 0];
  e = norm(e);
  return { e, n: cross(c, e) };
}

const DEFAULT_H = 210;
const TOP = 14;

/** Face a point, turning the globe so it sits at a given height on the card (north stays up). */
function facing(p: V3, R: number, y: number): View {
  const cy = TOP + R;
  const lift = Math.asin(Math.max(-0.95, Math.min(0.95, (cy - y) / R))) / RAD;
  const [lat, lon] = latLon(p);
  return { centre: vec(Math.max(-80, Math.min(80, lat - lift)), lon), R };
}

/** Where a point lands on the card for a view of width w. */
function onCard(p: V3, v: View, w: number) {
  const { e, n } = axes(v.centre);
  return { x: w / 2 + v.R * dot(p, e), y: TOP + v.R - v.R * dot(p, n), z: dot(p, v.centre) };
}

interface Theme {
  seaTop: string;
  seaBottom: string;
  land: string;
  airport: string;
  halo: string;
  labelBg: string;
  labelFg: string;
  route: string;
  font: string;
}

function readTheme(el: Element): Theme {
  const s = getComputedStyle(el);
  const v = (k: string, d: string) => s.getPropertyValue(k).trim() || d;
  return {
    seaTop: v('--rg-sea-top', '#cfe1f6'),
    seaBottom: v('--rg-sea-bottom', 'rgba(232, 241, 251, 0)'),
    land: v('--rg-land', '#3c6eae'),
    airport: v('--rg-airport', '#2f6fd0'),
    halo: v('--rg-halo', 'rgba(47, 111, 208, 0.16)'),
    labelBg: v('--rg-label-bg', '#ffffff'),
    labelFg: v('--rg-label-fg', '#1b2230'),
    route: v('--rg-route', '#ffffff'),
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
  };
}

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Timeline for one flight, in milliseconds ───────────────────────────────────

const T_FOCUS = 1100; // spin to the departure airport
const T_FRAME = 1200; // turn to frame the route; the arrival appears
const T_DRAW = 800; // the route draws itself
const T_HOLD = 900; // the plane rests at the arrival
const T_FADE = 500; // the route and plane fade before the next flight
const flyTime = (km: number) => Math.min(4200, 2400 + km / 6);

/**
 * The globe and a caption for the flight being drawn. By default it is a dome 210px tall, as on
 * Today's trip card; with `fill` it takes the height its container gives it and shows the whole
 * globe, as on a trip's page. With `live`, it stops touring the flights: it turns once to the one
 * in the air and tracks it, the way flown solid, the way left dashed, the plane where it really is.
 */
export function RouteGlobe({ legs, fill = false, live = null }: { legs: GlobeLeg[]; fill?: boolean; live?: GlobeLive | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 520, h: DEFAULT_H });
  const [legIndex, setLegIndex] = useState(0);
  const { w } = size;
  const H = size.h;
  // A dome across the card; or, filling a tall box, the whole globe, centred in a layout band of
  // height L (offset oy from the top) so a tall card does not leave it stranded at the top.
  const R0 = fill ? Math.min(w * 0.42, (H - TOP) / 2.05) : Math.min(w * 0.31, (H - TOP) / 1.25);
  const L = fill ? Math.min(H, Math.round(2 * R0 + TOP * 2 + 10)) : H;
  const oy = Math.round((H - L) / 2);

  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const next = { w: Math.max(240, Math.round(e.contentRect.width)), h: fill ? Math.max(200, Math.round(e.contentRect.height)) : DEFAULT_H };
      setSize((cur) => (cur.w === next.w && cur.h === next.h ? cur : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  // Each flight's two views: facing its departure, then framing the route.
  const plan = useMemo(() => {
    const frameY = (R: number) => (fill ? Math.min(L * 0.55, TOP + R * 0.62) : L * 0.48);
    const focusY = (R: number) => (fill ? Math.min(L * 0.58, TOP + R * 0.7) : L * 0.5);
    // Beside the flight cards the globe's outline stays in view: no closer than about its width.
    const Rmax = fill ? Math.max(R0, w * 0.46) : Infinity;
    return legs.map((l) => {
      const a = vec(l.from.lat, l.from.lon);
      const b = vec(l.to.lat, l.to.lon);
      const arc = angle(a, b) / RAD;
      // Short hops get a little closer, so the route is not a speck; long hauls stay true to scale.
      // Then shrink, if need be, until both airports sit inside the dome with room for labels.
      const mid = slerp(a, b, 0.5);
      const fits = (R: number) => {
        const v = facing(mid, R, frameY(R));
        return [a, b].every((p) => {
          const q = onCard(p, v, w);
          return q.z > 0.08 && q.x > 34 && q.x < w - 34 && q.y > 40 && q.y < L - 30;
        });
      };
      let R = Math.min(Rmax, R0 * Math.max(1, Math.min(1.75, 50 / Math.max(arc, 1))));
      for (let i = 0; i < 30 && !fits(R) && R > R0 * 0.55; i++) R *= 0.94;
      const km = distanceKm(l);
      return { leg: l, a, b, km, focus: facing(a, R, focusY(R)), frame: facing(mid, R, frameY(R)), fly: flyTime(km) };
    });
  }, [legs, w, L, R0, fill]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !plan.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const layer = document.createElement('canvas');
    layer.width = cv.width;
    layer.height = cv.height;
    const lctx = layer.getContext('2d')!;
    let theme = readTheme(cv);
    let themeAt = 0;

    // Loose dots around the rim, fixed relative to the sphere.
    const rim = Array.from({ length: 520 }, () => ({ a: Math.random() * Math.PI * 2, r: 1 + Math.random() ** 2.2 * 0.11 - 0.012, s: 0.6 + Math.random() * 0.9, o: 0.15 + Math.random() * 0.6 }));

    const cx = w / 2;
    let drawn: View | null = null;

    /** Sphere, dots and rim for a view, onto the layer. */
    const paintGlobe = (v: View) => {
      const { R } = v;
      const cy = TOP + R;
      const { e, n } = axes(v.centre);
      lctx.setTransform(dpr, 0, 0, dpr, 0, oy * dpr);
      lctx.clearRect(0, -oy, w, H);
      const g = lctx.createLinearGradient(0, TOP, 0, L);
      g.addColorStop(0, theme.seaTop);
      g.addColorStop(1, theme.seaBottom);
      lctx.fillStyle = g;
      lctx.beginPath();
      lctx.arc(cx, cy, R, 0, Math.PI * 2);
      lctx.fill();
      lctx.fillStyle = theme.land;
      const c = v.centre;
      const size = Math.max(1, Math.min(1.7, R / 190));
      const dots = (P: Float32Array, strength: number) => {
        for (let i = 0; i < P.length; i += 3) {
          const z = P[i]! * c[0] + P[i + 1]! * c[1] + P[i + 2]! * c[2];
          if (z <= 0.02) continue;
          const y = cy - R * (P[i]! * n[0] + P[i + 1]! * n[1] + P[i + 2]! * n[2]);
          if (y < -oy || y > H - oy) continue;
          const x = cx + R * (P[i]! * e[0] + P[i + 1]! * e[1] + P[i + 2]! * e[2]);
          if (x < 0 || x > w) continue;
          // Fainter towards the rim and towards the bottom, where the globe fades out.
          lctx.globalAlpha = strength * Math.min(1, z * 2) * (1 - clamp01((y - L * 0.58) / (L * 0.42)));
          lctx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      };
      dots(SEA_POINTS, 0.16);
      dots(LAND_POINTS, 0.7);
      for (const d of rim) {
        const x = cx + Math.cos(d.a) * R * d.r;
        const y = cy + Math.sin(d.a) * R * d.r;
        if (y < -oy || y > H - oy) continue;
        lctx.globalAlpha = d.o * (1 - clamp01((y - L * 0.55) / (L * 0.45)));
        lctx.fillRect(x - d.s / 2, y - d.s / 2, d.s, d.s);
      }
      lctx.globalAlpha = 1;
      drawn = v;
    };

    const project = (p: V3, v: View) => onCard(p, v, w);

    const marker = (x: number, y: number, alpha: number, halo: number) => {
      if (alpha <= 0) return;
      ctx.globalAlpha = alpha;
      if (halo > 0) {
        ctx.fillStyle = theme.halo;
        ctx.beginPath();
        ctx.arc(x, y, 7 + 9 * halo, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = theme.airport;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    const label = (text: string, x: number, y: number, alpha: number) => {
      if (alpha <= 0) return;
      ctx.globalAlpha = alpha;
      ctx.font = `600 12px ${theme.font}`;
      const tw = ctx.measureText(text).width;
      const bw = tw + 16;
      const below = y < 40;
      const bx = Math.max(4, Math.min(w - bw - 4, x - bw / 2));
      const by = below ? y + 12 : y - 34;
      ctx.shadowColor = 'rgba(20, 40, 80, 0.16)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = theme.labelBg;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 22, 7);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = theme.labelFg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + bw / 2, by + 11.5);
      ctx.globalAlpha = 1;
    };

    /** The route's points on screen, for a view. */
    const routePoints = (a: V3, b: V3, v: View) => Array.from({ length: 81 }, (_, i) => project(slerp(a, b, i / 80), v));

    const plane = (x: number, y: number, deg: number, scale: number, lift: number, look: PlanePaint) => {
      // Its shadow falls further away the higher it flies.
      ctx.save();
      ctx.translate(x + 4 + 7 * lift, y + 6 + 9 * lift);
      ctx.rotate(deg);
      ctx.scale(scale, scale);
      ctx.globalAlpha *= 0.18;
      ctx.fillStyle = '#0a1e3c';
      for (const part of [WINGS, STABS, ENGINES, BODY]) ctx.fill(part);
      ctx.restore();

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(deg);
      ctx.scale(scale, scale);
      const edge = 'rgba(16, 24, 40, 0.35)';
      ctx.lineWidth = 0.5 / scale;
      ctx.lineJoin = 'round';
      // Wings and tailplane: pale grey, a touch darker towards the trailing edge.
      const wing = ctx.createLinearGradient(6, 0, -11, 0);
      wing.addColorStop(0, '#eef1f4');
      wing.addColorStop(1, '#b9c0c9');
      ctx.fillStyle = wing;
      ctx.fill(WINGS);
      ctx.fill(STABS);
      ctx.strokeStyle = edge;
      ctx.stroke(WINGS);
      ctx.stroke(STABS);
      // Winglets in the tail colour, as most liveries have them.
      ctx.fillStyle = look.fin;
      ctx.fill(WINGLETS);
      // Engines hang ahead of the wing, intakes dark.
      ctx.fillStyle = look.engine;
      ctx.fill(ENGINES);
      ctx.stroke(ENGINES);
      ctx.fillStyle = '#2a3140';
      ctx.fill(INTAKES);
      // The fuselage, rounded with light from one side.
      const body = ctx.createLinearGradient(0, -2.4, 0, 2.4);
      body.addColorStop(0, look.body);
      body.addColorStop(0.35, look.body);
      body.addColorStop(1, shade(look.body, 0.78));
      ctx.fillStyle = body;
      ctx.fill(BODY);
      ctx.stroke(BODY);
      // The fin stands up from the spine; it is drawn leaning a little towards the top of the screen,
      // as if seen from slightly off vertical, so the livery on it shows.
      const side = Math.cos(deg) >= 0 ? -1 : 1;
      const fin = new Path2D(`M-12.5 0 L-22.4 0 L-23.4 ${7.4 * side} L-20.4 ${7.4 * side} Z`);
      ctx.fillStyle = look.fin;
      ctx.fill(fin);
      ctx.save();
      ctx.clip(fin);
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-15.5, 0);
      ctx.quadraticCurveTo(-19.6, 2.6 * side, -21.2, 7.6 * side);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = edge;
      ctx.stroke(fin);
      // Cockpit windows.
      ctx.fillStyle = '#1c2533';
      ctx.fill(COCKPIT);
      ctx.restore();
    };

    // The timeline: every flight in turn, then round again.
    const spans = plan.map((p) => T_FOCUS + T_FRAME + T_DRAW + p.fly + T_HOLD + T_FADE);
    const cycle = spans.reduce((s, d) => s + d, 0);
    let shownLeg = -1;

    const tracked = live && plan[live.leg] ? live : null;
    const INTRO = T_FOCUS + T_FRAME + T_DRAW;

    /** Tracking the flight in the air: once in to it, then the plane where it really is, each frame. */
    const liveFrame = (time: number) => {
      const p = plan[tracked!.leg]!;
      if (shownLeg !== tracked!.leg) {
        shownLeg = tracked!.leg;
        setLegIndex(tracked!.leg);
      }
      const t = Math.min(time, INTRO);
      let view: View;
      let destIn = 1;
      if (t < T_FOCUS) {
        view = p.focus;
        destIn = 0;
      } else if (t < T_FOCUS + T_FRAME) {
        const k = easeInOut((t - T_FOCUS) / T_FRAME);
        view = { centre: norm(slerp(p.focus.centre, p.frame.centre, k)), R: p.focus.R + (p.frame.R - p.focus.R) * k };
        destIn = clamp01((t - T_FOCUS - T_FRAME * 0.4) / (T_FRAME * 0.5));
      } else view = p.frame;
      if (!drawn || angle(drawn.centre, view.centre) > 1e-5 || Math.abs(drawn.R - view.R) > 0.01) paintGlobe(view);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, H);
      ctx.drawImage(layer, 0, 0, w, H);
      ctx.setTransform(dpr, 0, 0, dpr, 0, oy * dpr);

      // The share of the flight behind it, by the clock; on the way in it sweeps out to there.
      const drawK = easeOut(clamp01((t - T_FOCUS - T_FRAME) / T_DRAW));
      const real = clamp01((Date.now() - tracked!.start) / Math.max(1, tracked!.end - tracked!.start));
      const k = real * drawK;
      const pts = routePoints(p.a, p.b, view);
      const at = k * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(at));
      const q0 = pts[i]!;
      const q1 = pts[i + 1]!;
      const x = q0.x + (q1.x - q0.x) * (at - i);
      const y = q0.y + (q1.y - q0.y) * (at - i);
      if (drawK > 0) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // The way left: dashed, marching on towards the arrival.
        ctx.strokeStyle = theme.route;
        ctx.globalAlpha = 0.45 * drawK;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 6]);
        ctx.lineDashOffset = -(time / 60) % 9;
        ctx.beginPath();
        ctx.moveTo(x, y);
        pts.slice(i + 1).forEach((q) => ctx.lineTo(q.x, q.y));
        ctx.stroke();
        ctx.setLineDash([]);
        // The way flown: solid, up to the plane.
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.6;
        ctx.shadowColor = 'rgba(15, 45, 95, 0.28)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetY = 1;
        ctx.beginPath();
        pts.slice(0, i + 1).forEach((q, n) => (n ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.shadowColor = 'transparent';
      }
      const A = project(p.a, view);
      const B = project(p.b, view);
      const pulse = 0.5 + 0.5 * Math.sin(time / 380);
      marker(A.x, A.y, 1, 0.6);
      marker(B.x, B.y, destIn, destIn * (0.6 + 0.4 * pulse));
      label(p.leg.from.code, A.x, A.y, 1);
      label(p.leg.to.code, B.x, B.y, destIn);
      if (drawK > 0) {
        const size = Math.max(0.75, Math.min(1.15, view.R / 170));
        plane(x, y, Math.atan2(q1.y - q0.y, q1.x - q0.x), size * 1.02, 0.7, planePaint(p.leg.carrier));
      }
    };

    const frame = (time: number) => {
      if (time - themeAt > 1000) {
        const next = readTheme(cv);
        if (JSON.stringify(next) !== JSON.stringify(theme)) drawn = null;
        theme = next;
        themeAt = time;
      }
      if (tracked) return liveFrame(time);
      let t = ((time % cycle) + cycle) % cycle;
      let li = 0;
      while (li < plan.length - 1 && t >= spans[li]!) t -= spans[li++]!;
      const p = plan[li]!;
      if (li !== shownLeg) {
        shownLeg = li;
        setLegIndex(li);
      }
      const prev = plan[(li - 1 + plan.length) % plan.length]!;

      // Where the globe faces now.
      let view: View;
      let destIn = 0;
      let haloA = 0;
      if (t < T_FOCUS) {
        const k = easeInOut(t / T_FOCUS);
        view = { centre: norm(slerp(prev.frame.centre, p.focus.centre, k)), R: prev.frame.R + (p.focus.R - prev.frame.R) * k };
        haloA = k;
      } else if (t < T_FOCUS + T_FRAME) {
        const k = easeInOut((t - T_FOCUS) / T_FRAME);
        view = { centre: norm(slerp(p.focus.centre, p.frame.centre, k)), R: p.focus.R + (p.frame.R - p.focus.R) * k };
        destIn = clamp01((t - T_FOCUS - T_FRAME * 0.4) / (T_FRAME * 0.5));
        haloA = 1;
      } else {
        view = p.frame;
        destIn = 1;
        haloA = 1;
      }
      if (!drawn || angle(drawn.centre, view.centre) > 1e-5 || Math.abs(drawn.R - view.R) > 0.01) paintGlobe(view);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, H);
      ctx.drawImage(layer, 0, 0, w, H);
      ctx.setTransform(dpr, 0, 0, dpr, 0, oy * dpr);

      const after = t - T_FOCUS - T_FRAME;
      const drawK = clamp01(after / T_DRAW);
      const flyK = clamp01((after - T_DRAW) / p.fly);
      const fade = 1 - clamp01((after - T_DRAW - p.fly - T_HOLD) / T_FADE);
      const pts = routePoints(p.a, p.b, view);

      // The route, drawing itself from the departure.
      if (drawK > 0) {
        const upto = Math.max(1, Math.round(easeOut(drawK) * (pts.length - 1)));
        ctx.globalAlpha = fade;
        ctx.strokeStyle = theme.route;
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = 'rgba(15, 45, 95, 0.28)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetY = 1;
        ctx.beginPath();
        pts.slice(0, upto + 1).forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.globalAlpha = 1;
      }

      const A = project(p.a, view);
      const B = project(p.b, view);
      const pulse = 0.5 + 0.5 * Math.sin(time / 380);
      marker(A.x, A.y, fade, haloA * (0.6 + 0.4 * pulse));
      marker(B.x, B.y, destIn * fade, flyK >= 1 ? 0.6 + 0.4 * pulse : 0);
      label(p.leg.from.code, A.x, A.y, fade);
      label(p.leg.to.code, B.x, B.y, destIn * fade);

      // The plane, once the route is drawn.
      if (after > T_DRAW && fade > 0) {
        const k = easeInOut(flyK);
        const at = k * (pts.length - 1);
        const i = Math.min(pts.length - 2, Math.floor(at));
        const f = at - i;
        const q0 = pts[i]!;
        const q1 = pts[i + 1]!;
        const x = q0.x + (q1.x - q0.x) * f;
        const y = q0.y + (q1.y - q0.y) * f;
        const deg = Math.atan2(q1.y - q0.y, q1.x - q0.x);
        const lift = Math.sin(Math.PI * k);
        const size = Math.max(0.75, Math.min(1.15, view.R / 170));
        ctx.globalAlpha = fade;
        plane(x, y, deg, size * 0.92 * (0.78 + 0.32 * lift), lift, planePaint(p.leg.carrier));
        ctx.globalAlpha = 1;
      }
    };

    if (reduced()) {
      // Still: the flight in the air where it is (redrawn each half minute), or the first flight
      // framed, its route drawn, the plane part-way along.
      if (tracked) {
        frame(INTRO);
        const tick = setInterval(() => frame(INTRO), 30_000);
        return () => clearInterval(tick);
      }
      frame(T_FOCUS + T_FRAME + T_DRAW + plan[0]!.fly * 0.5);
      return;
    }

    let raf = 0;
    let running = false;
    let offset = performance.now(); // keeps the timeline continuous across pauses
    let pausedAt = 0;
    const loop = (now: number) => {
      frame(now - offset);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      if (pausedAt) offset += performance.now() - pausedAt;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      pausedAt = performance.now();
      cancelAnimationFrame(raf);
    };
    let onScreen = true;
    const sync = () => (onScreen && !document.hidden ? start() : stop());
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([e]) => ((onScreen = !!e?.isIntersecting), sync())) : null;
    io?.observe(cv);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      stop();
      io?.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [plan, w, H, L, oy, live?.leg, live?.start, live?.end]);

  const current = plan[Math.min(legIndex, plan.length - 1)];
  const minutes = current?.leg.minutes;
  return (
    <div className={fill ? 'route-globe is-fill' : 'route-globe'}>
      <div ref={stage} className="rg-stage" style={fill ? undefined : { height: DEFAULT_H }}>
        <canvas
          ref={canvas}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
          role="img"
          aria-label={`Map of the flights: ${legs.map((l) => `${l.from.code} to ${l.to.code}`).join(', ')}`}
        />
      </div>
      {current && (
        <div className="rg-caption">
          <span>
            {current.leg.from.code} → {current.leg.to.code} · {current.km.toLocaleString()} km
            {minutes ? ` · ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : ''}
          </span>
          <span className="rg-caption-end">{live && live.leg === legIndex ? `In flight · ${remaining(live.end)} to go` : 'Nonstop'}</span>
        </div>
      )}
    </div>
  );
}

/** "3h 25m" until a moment. */
function remaining(end: number): string {
  const m = Math.max(0, Math.round((end - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// A twin-engined airliner seen from above, nose to +x, about 44 units long and 42 across.
const BODY = new Path2D('M22 0 C22 1.5 20.4 2.3 17.5 2.3 L-11 2.3 C-15.5 2.1 -19.5 1.2 -22 0.45 L-22 -0.45 C-19.5 -1.2 -15.5 -2.1 -11 -2.3 L17.5 -2.3 C20.4 -2.3 22 -1.5 22 0 Z');
const WINGS = new Path2D('M7 -2.1 L-8.2 -20 L-10.6 -20 L-5.6 -6.5 L-4.2 -2.1 Z M7 2.1 L-8.2 20 L-10.6 20 L-5.6 6.5 L-4.2 2.1 Z');
const WINGLETS = new Path2D('M-8.2 -20 L-10.6 -20 L-11 -21.2 L-8.9 -21.2 Z M-8.2 20 L-10.6 20 L-11 21.2 L-8.9 21.2 Z');
const STABS = new Path2D('M-13.5 -1.8 L-19.4 -8.6 L-21.2 -8.6 L-18.6 -1.3 Z M-13.5 1.8 L-19.4 8.6 L-21.2 8.6 L-18.6 1.3 Z');
const ENGINES = new Path2D('M5.8 -9.3 Q6.3 -7.6 5.8 -5.9 L0.6 -6.2 Q0 -7.6 0.6 -9 Z M5.8 9.3 Q6.3 7.6 5.8 5.9 L0.6 6.2 Q0 7.6 0.6 9 Z');
const INTAKES = new Path2D('M5.9 -9 L6.3 -9 L6.3 -6.2 L5.9 -6.2 Z M5.9 9 L6.3 9 L6.3 6.2 L5.9 6.2 Z');
const COCKPIT = new Path2D('M19.3 -1.3 L20.6 -1 L20.6 1 L19.3 1.3 L19.6 0 Z');

/** A colour darkened towards black by a factor (1 = unchanged), for the shaded side of the fuselage. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * k);
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
