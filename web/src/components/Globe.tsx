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

export interface GlobeLeg {
  from: { code: string; lat: number; lon: number };
  to: { code: string; lat: number; lon: number };
  /** Scheduled time in the air, for the caption. */
  minutes?: number;
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

const H = 210;
const TOP = 14;

/** Face a point, turning the globe so it sits at a given height on the card (north stays up). */
function facing(p: V3, R: number, y = H * 0.48): View {
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

export function RouteGlobe({ legs }: { legs: GlobeLeg[] }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(520);
  const [legIndex, setLegIndex] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Each flight's two views: facing its departure, then framing the route.
  const plan = useMemo(() => {
    const R0 = Math.min(w * 0.31, (H - TOP) / 1.25);
    return legs.map((l) => {
      const a = vec(l.from.lat, l.from.lon);
      const b = vec(l.to.lat, l.to.lon);
      const arc = angle(a, b) / RAD;
      // Short hops get a little closer, so the route is not a speck; long hauls stay true to scale.
      // Then shrink, if need be, until both airports sit inside the dome with room for labels.
      const mid = slerp(a, b, 0.5);
      const fits = (R: number) => {
        const v = facing(mid, R);
        return [a, b].every((p) => {
          const q = onCard(p, v, w);
          return q.z > 0.08 && q.x > 34 && q.x < w - 34 && q.y > 40 && q.y < H - 30;
        });
      };
      let R = R0 * Math.max(1, Math.min(1.75, 50 / Math.max(arc, 1)));
      for (let i = 0; i < 30 && !fits(R) && R > R0 * 0.55; i++) R *= 0.94;
      const km = distanceKm(l);
      return { leg: l, a, b, km, focus: facing(a, R, H * 0.5), frame: facing(mid, R), fly: flyTime(km) };
    });
  }, [legs, w]);

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
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.clearRect(0, 0, w, H);
      const g = lctx.createLinearGradient(0, TOP, 0, H);
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
          if (y < 0 || y > H) continue;
          const x = cx + R * (P[i]! * e[0] + P[i + 1]! * e[1] + P[i + 2]! * e[2]);
          if (x < 0 || x > w) continue;
          // Fainter towards the rim and towards the bottom, where the globe fades out.
          lctx.globalAlpha = strength * Math.min(1, z * 2) * (1 - clamp01((y - H * 0.58) / (H * 0.42)));
          lctx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      };
      dots(SEA_POINTS, 0.16);
      dots(LAND_POINTS, 0.7);
      for (const d of rim) {
        const x = cx + Math.cos(d.a) * R * d.r;
        const y = cy + Math.sin(d.a) * R * d.r;
        if (y < 0 || y > H) continue;
        lctx.globalAlpha = d.o * (1 - clamp01((y - H * 0.55) / (H * 0.45)));
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

    const plane = (x: number, y: number, deg: number, scale: number, lift: number) => {
      const draw = (body: string, wing: string, dark: string) => {
        ctx.fillStyle = wing;
        ctx.fill(WINGS);
        ctx.fill(TAIL);
        ctx.fillStyle = dark;
        ctx.fill(ENGINES);
        ctx.fillStyle = body;
        ctx.fill(BODY);
      };
      // Its shadow falls further away the higher it flies.
      ctx.save();
      ctx.translate(x + 4 + 7 * lift, y + 6 + 9 * lift);
      ctx.rotate(deg);
      ctx.scale(scale, scale);
      ctx.globalAlpha *= 0.16;
      draw('#0a1e3c', '#0a1e3c', '#0a1e3c');
      ctx.restore();
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(deg);
      ctx.scale(scale, scale);
      draw('#ffffff', '#ec4a26', '#c23a1c');
      ctx.strokeStyle = 'rgba(20, 30, 50, 0.22)';
      ctx.lineWidth = 0.6 / scale;
      ctx.stroke(BODY);
      ctx.restore();
    };

    // The timeline: every flight in turn, then round again.
    const spans = plan.map((p) => T_FOCUS + T_FRAME + T_DRAW + p.fly + T_HOLD + T_FADE);
    const cycle = spans.reduce((s, d) => s + d, 0);
    let shownLeg = -1;

    const frame = (time: number) => {
      if (time - themeAt > 1000) {
        const next = readTheme(cv);
        if (JSON.stringify(next) !== JSON.stringify(theme)) drawn = null;
        theme = next;
        themeAt = time;
      }
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
        plane(x, y, deg, size * (0.78 + 0.32 * lift), lift);
        ctx.globalAlpha = 1;
      }
    };

    if (reduced()) {
      // Still: the first flight framed, its route drawn, the plane part-way along.
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
  }, [plan, w]);

  const current = plan[Math.min(legIndex, plan.length - 1)];
  const minutes = current?.leg.minutes;
  return (
    <div ref={box} className="route-globe">
      <canvas
        ref={canvas}
        style={{ width: '100%', height: H, display: 'block' }}
        role="img"
        aria-label={`Map of the flights: ${legs.map((l) => `${l.from.code} to ${l.to.code}`).join(', ')}`}
      />
      {current && (
        <div className="rg-caption">
          <span>
            {current.leg.from.code} → {current.leg.to.code} · {current.km.toLocaleString()} km
            {minutes ? ` · ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : ''}
          </span>
          <span className="rg-caption-end">Nonstop</span>
        </div>
      )}
    </div>
  );
}

// A small airliner seen from above, nose to +x, about 40 units long.
const BODY = new Path2D('M19 0 C19 2 16.5 2.7 14 2.7 L-14 2.5 L-19 1.1 L-19 -1.1 L-14 -2.5 L14 -2.7 C16.5 -2.7 19 -2 19 0 Z');
const WINGS = new Path2D('M5 -2.2 L-5 -18 L-9.5 -18 L-4.5 -2.2 Z M5 2.2 L-5 18 L-9.5 18 L-4.5 2.2 Z');
const TAIL = new Path2D('M-12.5 -2 L-17 -8.5 L-19.5 -8.5 L-16.8 -2 Z M-12.5 2 L-17 8.5 L-19.5 8.5 L-16.8 2 Z');
const ENGINES = new Path2D('M0.5 -9.5 L-4.5 -9.5 L-4.5 -7.3 L0.5 -7.3 Z M0.5 7.3 L-4.5 7.3 L-4.5 9.5 L0.5 9.5 Z');
