// A dotted globe with a trip's flights drawn on it as great-circle arcs, a plane flying each
// leg in turn on a loop. The globe turns so the first flight runs left to right across the top
// of the dome, and zooms so a short hop fills the card as well as a long haul does. Land comes
// from a 1° grid shipped with the app (land.ts); nothing is fetched. With reduced motion the
// plane rests part-way along the first flight.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LAND } from '../land.ts';

export interface GlobeLeg {
  from: { code: string; lat: number; lon: number };
  to: { code: string; lat: number; lon: number };
}

type V3 = [number, number, number];
const RAD = Math.PI / 180;
const vec = (lat: number, lon: number): V3 => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/** Points along the great circle from a to b. */
function arc(a: V3, b: V3, n = 64): V3[] {
  const w = angle(a, b);
  if (w < 1e-6) return [a, b];
  const s = Math.sin(w);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return add(scale(a, Math.sin((1 - t) * w) / s), b, Math.sin(t * w) / s);
  });
}

/** Great-circle distance in kilometres. */
export const distanceKm = (l: GlobeLeg) => Math.round(angle(vec(l.from.lat, l.from.lon), vec(l.to.lat, l.to.lon)) * 6371);

const landBits = (() => {
  const raw = atob(LAND.bits);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
})();
const isLand = (r: number, c: number) => {
  const i = r * LAND.cols + c;
  return (landBits[i >> 3]! >> (i & 7)) & 1;
};

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const H = 190;

/**
 * Legs grouped into views: consecutive legs share a view while all their airports sit within
 * 55° of the view's centre. Singapore and São Paulo are nearly opposite, so such a trip is shown
 * a part at a time, the globe fading from one view to the next as the plane goes.
 */
function views(legs: GlobeLeg[]): GlobeLeg[][] {
  const out: GlobeLeg[][] = [];
  for (const leg of legs) {
    const cur = out[out.length - 1];
    const trial = cur ? [...cur, leg] : [leg];
    const ends = trial.flatMap((l) => [vec(l.from.lat, l.from.lon), vec(l.to.lat, l.to.lon)]);
    const centre = norm(ends.reduce((s, p) => add(s, p), [0, 0, 0] as V3));
    if (cur && ends.every((p) => angle(p, centre) <= 55 * RAD)) cur.push(leg);
    else out.push([leg]);
  }
  return out;
}

/** One view of the globe: its dots, its legs' arcs and its airports, in card pixels. */
function scene(legs: GlobeLeg[], w: number) {
  const ends = legs.flatMap((l) => [vec(l.from.lat, l.from.lon), vec(l.to.lat, l.to.lon)]);
  const centre = norm(ends.reduce((s, p) => add(s, p), [0, 0, 0] as V3));
  // North stays up: the map turns by at most 35° towards the route, so coastlines read the right way round.
  const east = norm(cross([0, 0, 1], centre));
  const north = cross(centre, east);
  const dir = add(vec(legs[0]!.to.lat, legs[0]!.to.lon), vec(legs[0]!.from.lat, legs[0]!.from.lon), -1);
  let tilt = Math.atan2(dot(dir, north), dot(dir, east));
  if (tilt > Math.PI / 2) tilt -= Math.PI; // a westbound flight flies right to left
  if (tilt < -Math.PI / 2) tilt += Math.PI;
  tilt = Math.max(-35 * RAD, Math.min(35 * RAD, tilt));
  const t = add(scale(east, Math.cos(tilt)), north, Math.sin(tilt));
  const n = cross(centre, t);
  // The view for a globe of radius R: the dome's top just inside the card, the route's centre a
  // little above mid-height.
  const cx = w / 2;
  const frame = (R: number) => {
    const cy = 16 + R;
    const theta = Math.asin(Math.min(0.97, (cy - H * 0.52) / R));
    const up = add(scale(n, Math.cos(theta)), centre, Math.sin(theta));
    const view = add(scale(centre, Math.cos(theta)), n, -Math.sin(theta));
    return { cy, up, view };
  };
  // Zoom in as far as every airport, as drawn, still fits with room for its label.
  const fits = (R: number) => {
    const f = frame(R);
    return ends.every((p) => {
      const x = cx + R * dot(p, t);
      const y = f.cy - R * dot(p, f.up);
      return dot(p, f.view) > 0.05 && x >= 44 && x <= w - 44 && y >= 30 && y <= H - 34;
    });
  };
  let lo = H * 1.2;
  let hi = 1600;
  if (fits(hi)) lo = hi;
  else for (let i = 0; i < 24; i++) (fits((lo + hi) / 2) ? (lo = (lo + hi) / 2) : (hi = (lo + hi) / 2));
  const R = lo;
  const { cy, up, view } = frame(R);
  const project = (p: V3) => ({ x: cx + R * dot(p, t), y: cy - R * dot(p, up), z: dot(p, view) });

  // Dots: each land cell, split into k×k dots when zoomed in so the land stays dense.
  const cellPx = R * RAD;
  const k = Math.max(1, Math.min(4, Math.round(cellPx / 6.5)));
  const dots: { x: number; y: number; o: number }[] = [];
  for (let r = 0; r < LAND.rows; r++) {
    const latTop = LAND.lat0 - r;
    for (let c = 0; c < LAND.cols; c++) {
      if (!isLand(r, c)) continue;
      const mid = project(vec(latTop - 0.5, -180 + c + 0.5));
      if (mid.z <= 0 || mid.x < -cellPx || mid.x > w + cellPx || mid.y < -cellPx || mid.y > H + cellPx) continue;
      for (let i = 0; i < k; i++)
        for (let j = 0; j < k; j++) {
          const p = k === 1 ? mid : project(vec(latTop - (i + 0.5) / k, -180 + c + (j + 0.5) / k));
          if (p.z <= 0.02 || p.x < 0 || p.x > w || p.y < 0 || p.y > H) continue;
          // Fade towards the limb and towards the bottom of the card.
          dots.push({ x: p.x, y: p.y, o: Math.min(1, p.z * 2.2) * Math.max(0, 1 - Math.max(0, p.y - H * 0.66) / (H * 0.34)) });
        }
    }
  }
  const paths = legs.map((l) =>
    arc(vec(l.from.lat, l.from.lon), vec(l.to.lat, l.to.lon))
      .map(project)
      .map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' '),
  );
  const airports = new Map<string, { code: string; x: number; y: number }>();
  for (const l of legs)
    for (const e of [l.from, l.to]) {
      const p = project(vec(e.lat, e.lon));
      airports.set(e.code, { code: e.code, x: p.x, y: p.y });
    }
  return { R, cx, cy, dots, paths, airports: [...airports.values()], origin: legs[0]!.from.code };
}

export function RouteGlobe({ legs }: { legs: GlobeLeg[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(520);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const groups = useMemo(() => views(legs), [legs]);
  // Which view each leg belongs to, and its index within that view.
  const where = useMemo(() => groups.flatMap((g, gi) => g.map((_, li) => ({ view: gi, index: li }))), [groups]);
  const [active, setActive] = useState(0);
  const shown = Math.min(active, groups.length - 1);
  const current = useMemo(() => scene(groups[shown]!, w), [groups, shown, w]);

  // The loop: each leg in turn, the trail drawing behind the plane, a pause, then the next. The
  // clock lives outside the effect, so moving to another view carries on where it was.
  const trail = useRef<(SVGPathElement | null)[]>([]);
  const guide = useRef<(SVGPathElement | null)[]>([]);
  const plane = useRef<SVGGElement>(null);
  const clock = useRef<number | null>(null);
  useEffect(() => {
    const count = groups[shown]!.length;
    const els = guide.current.slice(0, count);
    if (!els.length || els.some((e) => !e) || !plane.current) return;
    const lens = els.map((e) => e!.getTotalLength());
    const place = (index: number, p: number) => {
      const path = els[index]!;
      const L = lens[index]!;
      const a = path.getPointAtLength(L * p);
      const ahead = path.getPointAtLength(Math.min(L, L * p + 1));
      const behind = path.getPointAtLength(Math.max(0, L * p - 1));
      const [from, to] = p > 0.999 ? [behind, a] : [a, ahead];
      const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
      plane.current!.setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${deg.toFixed(1)})`);
      trail.current.slice(0, count).forEach((el, i) => {
        if (!el) return;
        const Li = lens[i]!;
        el.style.strokeDasharray = `${Li}`;
        el.style.strokeDashoffset = `${i < index ? 0 : i > index ? Li : Li * (1 - p)}`;
      });
    };
    if (reduced()) {
      place(0, 0.55);
      return;
    }
    const fly = legs.map((l) => Math.min(5200, 2600 + distanceKm(l) / 4));
    const pause = 900;
    const total = fly.reduce((s, d) => s + d + pause, 0);
    clock.current ??= performance.now();
    let raf = 0;
    const tick = (now: number) => {
      let t = (now - clock.current!) % total;
      let leg = 0;
      while (leg < fly.length - 1 && t > fly[leg]! + pause) t -= fly[leg++]! + pause;
      const at = where[leg]!;
      if (at.view !== shown) {
        setActive(at.view);
        return;
      }
      const p = Math.min(1, t / fly[leg]!);
      // Ease in and out, as a plane does.
      place(at.index, p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [current, groups, shown, where, legs]);

  const { R, cx, cy, dots, paths, airports, origin } = current;
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <div ref={box} className="route-globe">
      <svg width="100%" height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`Map of the flights: ${legs.map((l) => `${l.from.code} to ${l.to.code}`).join(', ')}`}>
        <defs>
          <radialGradient id={`${id}-sea`} cx="50%" cy="0%" r="75%">
            <stop offset="0%" className="rg-sea-top" />
            <stop offset="100%" className="rg-sea-bottom" />
          </radialGradient>
          <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.62" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={`${id}-mask`}>
            <rect width={w} height={H} fill={`url(#${id}-fade)`} />
          </mask>
        </defs>
        <g key={shown} className={cx_(groups.length > 1 && 'rg-view')}>
          <g mask={`url(#${id}-mask)`}>
            <circle cx={cx} cy={cy} r={R + 5} className="rg-halo" />
            <circle cx={cx} cy={cy} r={R} fill={`url(#${id}-sea)`} />
            <g className="rg-land">
              {dots.map((d, i) => (
                <circle key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} r="1.15" opacity={d.o.toFixed(2)} />
              ))}
            </g>
          </g>
          {paths.map((d, i) => (
            <g key={i}>
              <path d={d} className="rg-route" />
              <path d={d} className="rg-trail" ref={(el) => void (trail.current[i] = el)} />
              <path d={d} fill="none" stroke="none" ref={(el) => void (guide.current[i] = el)} />
            </g>
          ))}
          {airports.map((a) => {
            const below = a.y < 40;
            const lx = Math.min(w - 24, Math.max(24, a.x));
            return (
              <g key={a.code}>
                {a.code === origin && <circle cx={a.x} cy={a.y} r="11" className="rg-pulse" />}
                <circle cx={a.x} cy={a.y} r="5.5" className="rg-airport" />
                <g transform={`translate(${lx} ${below ? a.y + 22 : a.y - 22})`}>
                  <rect x="-21" y="-11" width="42" height="22" rx="7" className="rg-label" />
                  <text y="4.5" textAnchor="middle" className="rg-label-text">
                    {a.code}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
        <g ref={plane} className="rg-plane">
          <g transform="translate(3 4)" className="rg-plane-shadow">
            <PlaneShape />
          </g>
          <PlaneShape />
        </g>
      </svg>
    </div>
  );
}

const cx_ = (...c: (string | false)[]) => c.filter(Boolean).join(' ') || undefined;

/** A small airliner seen from above, nose to the right. */
function PlaneShape() {
  return (
    <>
      <path d="M3 -1.6 L-5 -12 L-8.5 -12 L-3.5 -1.6 Z M3 1.6 L-5 12 L-8.5 12 L-3.5 1.6 Z" className="rg-plane-wing" />
      <path d="M-9 -1.2 L-13 -5.5 L-15 -5.5 L-12.5 -1 Z M-9 1.2 L-13 5.5 L-15 5.5 L-12.5 1 Z" className="rg-plane-wing" />
      <path d="M14 0 C14 1.3 12 1.9 10 1.9 L-10 1.9 L-14 0.9 L-14 -0.9 L-10 -1.9 L10 -1.9 C12 -1.9 14 -1.3 14 0 Z" className="rg-plane-body" />
    </>
  );
}
