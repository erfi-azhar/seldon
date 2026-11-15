// Journey: a travel day as it happens, the route you took, and the settings behind both.
// - NowPanel (Today, inside the travel card): what you need right now in the day's current phase.
// - RouteCard (a trip's page): where your phone says you went, day by day.
// - TravelNotifications and RouteRecording (Settings): lock-screen notifications on this device,
//   and the OwnTracks app that reports your location while a trip is on.

import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, Check, Clock, KeyRound, MapPin, Navigation, Plane, Route as RouteIcon, Send, Sofa } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { boardsAt, checkInCloses, clock, delayOf, departs, lands, leaveBy, reachAirportBy, span, type Journey as JourneyT } from '../../../shared/journey.ts';
import type { JourneyStatus, Segment, Trip, TripTrack } from '../../../shared/types.ts';
import { api, travelWrite, useWrite, write } from '../api.ts';
import { cx, plural } from '../lib.ts';
import { layoverPlan } from '../layover.ts';
import { welcomeIn } from '../../../shared/welcome.ts';

const MIN = 60_000;
const flightName = (f: Segment) => `${f.carrier} ${f.number}`.trim();
const city = (f: Segment, end: 'from' | 'to') => (end === 'from' ? f.fromCity || f.fromName || f.fromCode : f.toCity || f.toName || f.toCode);
const mapsTo = (place: string) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`;

// ── Today: what you need right now ──────────────────────────────────────────

/** The travel day's current phase, as what to do now. Shown at the top of Today's travel card. */
export function NowPanel({ journey, focus, now, trips, home, onLounges }: { journey: JourneyT; focus: number; now: number; trips: Trip[]; home: string; onLounges: (c: { from: Segment; to: Segment }) => void }) {
  const phase = journey.phases[focus]!;
  const leg = journey.legs[phase.leg]!;
  const next = journey.legs[phase.leg + 1];
  const last = journey.legs[journey.legs.length - 1]!;
  // Checked in is kept with the flight on the server, so every device sends you to the gate.
  const checkIn = useWrite((on: boolean) => travelWrite.post(`/segments/${leg.id}/checkin`, { checkedIn: on }));
  // Show the tap at once; once the server's answer arrives, it speaks for itself again.
  const checkedIn = checkIn.isPending || checkIn.isSuccess ? !!checkIn.variables : !!leg.checkedInAt;
  const { reset } = checkIn;
  useEffect(() => reset(), [leg.checkedInAt, reset]);

  if (phase.kind === 'before') {
    const airport = leg.fromName || leg.fromCode;
    return (
      <div className="journey-now">
        <b className="jn-title">
          Reach {leg.fromTerminal ? `Terminal ${leg.fromTerminal}` : airport} by {clock(reachAirportBy(leg), leg.startTz)}
        </b>
        <span className="jn-sub" title={`Set off by ${clock(leaveBy(leg), leg.startTz)}`}>
          {now < leaveBy(leg) ? (
            <>
              Leave in <b className="num">{span((leaveBy(leg) - now) / MIN)}</b>
            </>
          ) : (
            <>
              <b>Leave now</b> · {span((reachAirportBy(leg) - now) / MIN)} to get there
            </>
          )}
          {leg.fromTerminal && ` · ${airport}`}
        </span>
        <a className="jn-btn" href={mapsTo(`${airport} Airport${leg.fromTerminal ? ` Terminal ${leg.fromTerminal}` : ''}, ${city(leg, 'from')}`)} target="_blank" rel="noreferrer">
          <Navigation size={14} aria-hidden /> Directions
        </a>
      </div>
    );
  }

  // At the airport: check in before it closes, then get to the gate before boarding.
  if (phase.kind === 'airport') {
    const terminal = leg.fromTerminal ? `Terminal ${leg.fromTerminal}` : leg.fromName || leg.fromCode;
    if (!checkedIn) {
      const closes = checkInCloses(leg);
      return (
        <div className="journey-now">
          <b className="jn-title">{now < closes ? `Check in within ${span((closes - now) / MIN)}` : `Check-in closed at ${clock(closes, leg.startTz)}`}</b>
          <span className="jn-sub">
            {now < closes ? `Check-in closes ${clock(closes, leg.startTz)}` : 'Ask at the counter; some airlines still take you'} · {terminal}
          </span>
          <button type="button" className="jn-btn" disabled={checkIn.isPending} onClick={() => checkIn.mutate(true)}>
            <Check size={14} aria-hidden /> Check in
          </button>
        </div>
      );
    }
    const boards = boardsAt(leg);
    return (
      <div className="journey-now">
        <b className="jn-title">
          {now < boards ? `Be at the gate in ${span((boards - now) / MIN)}` : `${flightName(leg)} is boarding`}
          {delayOf(leg) > 0 && <span className="jn-delay">Delayed {span(delayOf(leg) / MIN)}</span>}
        </b>
        <span className="jn-sub">
          Boards around {clock(boards, leg.startTz)} · leaves {clock(departs(leg), leg.startTz)}
          {leg.seat && ` · seat ${leg.seat}`}
        </span>
        <button type="button" className="jn-btn is-done" aria-pressed="true" title="Not checked in after all? Tap to undo" disabled={checkIn.isPending} onClick={() => checkIn.mutate(false)}>
          <Check size={14} aria-hidden /> Checked in
        </button>
      </div>
    );
  }

  if (phase.kind === 'flight') {
    const late = delayOf(leg);
    return (
      <div className={cx('journey-now is-flight', late > 0 && 'is-late')}>
        <b className="jn-title">
          {span((lands(leg) - now) / MIN)} to arrival
          {late > 0 && <span className="jn-delay">Delayed {span(late / MIN)}</span>}
        </b>
        <FlightArc start={departs(leg)} end={lands(leg)} late={late > 0} />
        <div className="jn-ends">
          <span>
            <FlightTime at={departs(leg)} booked={Date.parse(leg.startUtc)} tz={leg.startTz} />
            <small>{leg.fromCode}</small>
          </span>
          <span className="jn-dur">{span((lands(leg) - departs(leg)) / MIN)}</span>
          <span className="is-end">
            <FlightTime at={lands(leg)} booked={Date.parse(leg.endUtc)} tz={leg.endTz} />
            <small>{leg.toCode}</small>
          </span>
        </div>
      </div>
    );
  }

  if (phase.kind === 'connection' && next)
    return (
      <div className="journey-now">
        <b className="jn-title">
          {span((Date.parse(next.startUtc) - now) / MIN)} in {city(leg, 'to')}
        </b>
        <span className="jn-sub">
          {flightName(next)} to {city(next, 'to')} leaves {clock(Date.parse(next.startUtc), next.startTz)} · boards around {clock(boardsAt(next), next.startTz)}
        </span>
        <span className="jn-line">
          <Clock size={13} aria-hidden /> It’s {clock(now, next.startTz)} here
        </span>
        {(() => {
          const out = layoverPlan(leg, next, home);
          return out.verdict === 'out' ? (
            <span className="jn-line">
              <MapPin size={13} aria-hidden /> {out.atHome ? 'Time to go home' : `Time to see ${out.guide?.city ?? city(leg, 'to')}`}: back at the airport by {clock(out.backBy, next.startTz)}
            </span>
          ) : null;
        })()}
        <button type="button" className="jn-btn" onClick={() => onLounges({ from: leg, to: next })}>
          <Sofa size={14} aria-hidden /> {layoverPlan(leg, next, home).verdict === 'out' ? 'Lounges and what to do' : 'Lounges'}
        </button>
      </div>
    );

  // Arrived: the local time, and the way to where you're staying.
  const day = last.endLocal.slice(0, 10);
  // A hotel on the same trip as the flight in, covering the day you land.
  const stay = trips
    .find((x) => x.id === last.tripId)
    ?.segments.find((s) => s.kind === 'stay' && s.startLocal.slice(0, 10) <= day && s.endLocal.slice(0, 10) > day);
  return (
    <div className="journey-now">
      <WelcomeTitle tz={last.endTz} city={city(last, 'to')} />
      <span className="jn-sub">
        It’s {clock(now, last.endTz)} · landed {clock(Date.parse(last.endUtc), last.endTz)}
      </span>
      {stay ? (
        <a className="jn-btn" href={mapsTo(stay.address || stay.title)} target="_blank" rel="noreferrer">
          <Navigation size={14} aria-hidden /> Directions to {stay.title.split(',')[0]}
        </a>
      ) : (
        <span className="jn-line">No hotel on the trip yet.</span>
      )}
    </div>
  );
}

/** "ようこそ to Tokyo": welcome in the language where you've landed (by the place's zone); how to say it on hover. */
export function WelcomeTitle({ tz, city: place }: { tz: string | null | undefined; city: string }) {
  const w = welcomeIn(tz);
  if (!w) return <b className="jn-title">Welcome to {place}</b>;
  return (
    <b className="jn-title" title={`${w.roman || w.word}: welcome in ${w.language}`}>
      <span className="jn-welcome">{w.word}</span> to {place}
    </b>
  );
}

/** A time on the flight, and when it's late the booked time struck through beside it. */
function FlightTime({ at, booked, tz }: { at: number; booked: number; tz: string }) {
  if (at === booked) return <b className="num">{clock(at, tz)}</b>;
  return (
    <b className="num">
      <s className="jn-was" aria-label={`booked ${clock(booked, tz)}`}>
        {clock(booked, tz)}
      </s>{' '}
      <span className="jn-now-time">{clock(at, tz)}</span>
    </b>
  );
}

// A shallow arc from P0 (8, 46) to P2 (312, 46) in a 320 × 56 drawing, bent by P1 (160, -18).
const P0 = [8, 46] as const;
const P1 = [160, -18] as const;
const P2 = [312, 46] as const;
const mix = (a: readonly [number, number], b: readonly [number, number], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
const fmt = (p: readonly [number, number]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;

/** Where you are on the flight right now, 0 to 1, ticking each second. */
function useFlightProgress(start: number, end: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
}

/** On first show, the plane sweeps out from the start to where it is; then it follows the clock. */
function useIntro(ms = 1400): number {
  const [k, setK] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : 0));
  useEffect(() => {
    if (k >= 1) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const x = Math.min(1, (t - t0) / ms);
      setK(1 - (1 - x) ** 3);
      if (x < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []); // Only once, on mount.
  return k;
}

/**
 * The flight as a live tracker over the horizon: the way flown drawn solid up to the plane, the
 * way left marching on ahead of it, the plane nose-along the arc at the real share of the flight.
 */
function FlightArc({ start, end, late = false }: { start: number; end: number; late?: boolean }) {
  // The drawing stretches to the card's width, so the plane sits over it, placed and turned in real pixels.
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 320, h: 56 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setBox({ w: e.contentRect.width || 320, h: e.contentRect.height || 56 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const t = useFlightProgress(start, end) * useIntro();
  // Split the curve at t (de Casteljau): the part flown and the part left are curves of their own.
  const a = mix(P0, P1, t);
  const b = mix(P1, P2, t);
  const at = mix(a, b, t);
  const flown = `M${fmt(P0)} Q${fmt(a)} ${fmt(at)}`;
  const left = `M${fmt(at)} Q${fmt(b)} ${fmt(P2)}`;
  // The arc's direction here, in the drawing as it's stretched on screen.
  const heading = (Math.atan2((b[1] - a[1]) * (box.h / 56), (b[0] - a[0]) * (box.w / 320)) * 180) / Math.PI;
  return (
    <div ref={ref} className={cx('jn-arc', late && 'is-late')} role="img" aria-label={`${Math.round(t * 100)}% of the way`}>
      <svg viewBox="0 0 320 56" preserveAspectRatio="none" aria-hidden>
        <path className="jn-arc-left" d={left} fill="none" vectorEffect="non-scaling-stroke" />
        <path className="jn-arc-flown" d={flown} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* Lucide's plane points up and to the right, so it turns 45° more than the heading. */}
      <span className="jn-plane" aria-hidden style={{ left: `${(at[0] / 320) * 100}%`, top: `${(at[1] / 56) * 100}%`, transform: `translate(-50%, -50%) rotate(${heading + 45}deg)` }}>
        <Plane size={18} fill="currentColor" strokeWidth={1.25} />
      </span>
    </div>
  );
}

// ── A trip's page: the route you took ───────────────────────────────────────

/** Where your phone says you went on this trip, a day at a time. Nothing until there is a route. */
export function RouteCard({ trip }: { trip: Trip }) {
  const { data } = useQuery({ queryKey: ['track', trip.id], queryFn: () => api<TripTrack>('GET', `/journey/trips/${trip.id}/track`) });
  const [pick, setPick] = useState<string | null>(null);
  if (!data || data.points === 0) return null;
  const day = data.days.find((d) => d.date === pick) ?? data.days[data.days.length - 1]!;
  return (
    <section className="card trip-section route-card">
      <div className="card-head">
        <h2 className="card-title">
          <RouteIcon size={15} /> Your route
        </h2>
        <span className="trip-section-count">
          {day.km} km · {plural(day.points.length, 'point')}
        </span>
      </div>
      <div className="trip-section-body">
        {data.days.length > 1 && (
          <div className="route-days">
            {data.days.map((d) => (
              <button key={d.date} type="button" className={cx('chip', d.date === day.date ? 'chip-on' : 'chip-outline')} onClick={() => setPick(d.date)}>
                {new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
              </button>
            ))}
          </div>
        )}
        <RouteSketch points={day.points} />
      </div>
    </section>
  );
}

/**
 * The day's path on a plain dotted ground: no map tiles, so where you went stays between your
 * phone and your server. Jumps of more than 50 km (a flight with the phone off) are dashed.
 */
function RouteSketch({ points }: { points: [number, number, number][] }) {
  const W = 600;
  const H = 300;
  const pad = 28;
  const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const xs = points.map((p) => p[1]);
  const ys = points.map((p) => merc(p[0]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Degrees of longitude and mercator units share a scale (radians), so the shape stays true.
  const sx = (x1 - x0) * (Math.PI / 180);
  const sy = y1 - y0;
  const scale = Math.min((W - 2 * pad) / Math.max(sx, 1e-6), (H - 2 * pad) / Math.max(sy, 1e-6));
  const ox = (W - sx * scale) / 2;
  const oy = (H - sy * scale) / 2;
  const at = (p: [number, number, number]) => [ox + (p[1] - x0) * (Math.PI / 180) * scale, H - (oy + (merc(p[0]) - y0) * scale)] as const;
  const far = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180)) * 111 > 50;
  const solid: string[] = [];
  const dashed: string[] = [];
  let run = '';
  points.forEach((p, i) => {
    const [x, y] = at(p);
    if (i > 0 && far(points[i - 1]!, p)) {
      const [px, py] = at(points[i - 1]!);
      dashed.push(`M${px.toFixed(1)} ${py.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}`);
      if (run) solid.push(run);
      run = '';
    }
    run += `${run ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  if (run) solid.push(run);
  const [sx0, sy0] = at(points[0]!);
  const [ex, ey] = at(points[points.length - 1]!);
  return (
    <svg className="route-sketch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Route with ${points.length} recorded points`}>
      <defs>
        <pattern id="route-dots" width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="1" fill="currentColor" opacity="0.14" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#route-dots)" />
      {dashed.map((d) => (
        <path key={d} d={d} className="route-jump" />
      ))}
      {solid.map((d) => (
        <path key={d} d={d} className="route-path" />
      ))}
      <circle cx={sx0} cy={sy0} r="5" className="route-start" />
      <circle cx={ex} cy={ey} r="6.5" className="route-end" />
      <circle cx={ex} cy={ey} r="2.5" fill="#fff" />
    </svg>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

const useJourneyStatus = () => useQuery({ queryKey: ['journey-status'], queryFn: () => api<JourneyStatus>('GET', '/journey/status') });

/** The VAPID public key as the bytes PushManager wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const deviceLabel = () => {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'This device';
};

/** Lock-screen notifications for travel days, on this device. */
export function TravelNotifications() {
  const { data: status } = useJourneyStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [here, setHere] = useState<boolean | null>(null);
  const test = useWrite(() => write.post('/journey/push/test'));
  const unsubscribe = useWrite((endpoint: string) => write.post('/journey/push/unsubscribe', { endpoint }));
  const subscribe = useWrite((sub: PushSubscriptionJSON) => write.post('/journey/push/subscribe', { ...sub, label: deviceLabel() }));
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iosBrowser = typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent) && !(window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone);

  // Whether this device is one of the subscribed ones.
  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration().then(async (reg) => setHere(!!(await reg?.pushManager.getSubscription())));
  }, [supported]);

  const turnOn = async () => {
    setError('');
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for Terminus. Allow them in this device’s settings, then try again.');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status!.push.publicKey) });
      await subscribe.mutateAsync(sub.toJSON());
      setHere(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await unsubscribe.mutateAsync(sub.endpoint);
      await sub.unsubscribe();
    }
    setHere(false);
  };

  const devices = status?.push.devices ?? [];
  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="brain-icon">
          <Bell size={18} />
        </span>
        <div className="grow">
          <b>Travel notifications</b>
          <span className="hint" style={{ display: 'block' }}>
            On travel days, your lock screen tells you when to leave for the airport, when you board, when you land on the way, and when you arrive.
          </span>
        </div>
      </div>
      {!supported ? (
        <p className="hint">This browser can’t receive notifications.</p>
      ) : iosBrowser ? (
        <p className="hint">On iPhone, add Terminus to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn this on in its Settings.</p>
      ) : (
        <div className="row-wrap">
          {here ? (
            <>
              <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate(undefined)}>
                <Send size={14} /> Send a test
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void turnOff()}>
                <BellOff size={14} /> Turn off on this device
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={busy || !status} onClick={() => void turnOn()}>
              <Bell size={14} /> Turn on for this device
            </button>
          )}
        </div>
      )}
      {devices.length > 0 && <p className="hint">On for {devices.map((d) => d.label || 'a device').join(', ')}.</p>}
      {(error || test.error) && <p className="error-text">{error || test.error?.message}</p>}
    </div>
  );
}

/** OwnTracks on the phone reports where you are while a trip is on, so the trip keeps your route. */
export function RouteRecording() {
  const { data: status } = useJourneyStatus();
  const [key, setKey] = useState<string | null>(null);
  const make = useWrite(() => write.post<{ key: string }>('/journey/tracking/key'));
  const off = useWrite(() => write.post('/journey/tracking/off'));
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const on = status?.tracking.on;
  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="brain-icon">
          <MapPin size={18} />
        </span>
        <div className="grow">
          <b>Route recording</b>
          <span className="hint" style={{ display: 'block' }}>
            The free OwnTracks app reports where you are in the background, even offline (it sends when you’re back online). Terminus keeps it only while a trip is on, and shows the route on the trip.
          </span>
        </div>
      </div>
      {on && !key && (
        <p className="hint">
          On.{' '}
          {status?.tracking.lastAt
            ? `Last location ${new Date(status.tracking.lastAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
            : 'No location received yet; locations outside a trip are not kept.'}
        </p>
      )}
      {key && (
        <ol className="steps-list">
          <li>
            Install <b>OwnTracks</b> (App Store or Google Play) and allow location <i>Always</i>.
          </li>
          <li>
            In its settings, choose mode <b>HTTP</b> and set the URL to <code>{origin}/api/journey/owntracks</code>.
          </li>
          <li>
            Turn on authentication: user <code>terminus</code>, password <code className="token">{key}</code>
          </li>
          <li>
            For a detailed route, set the monitoring mode to <i>Move</i> while you travel; <i>Significant</i> saves battery but records less.
          </li>
          <li>Your phone must be able to reach this Terminus.</li>
        </ol>
      )}
      <div className="row-wrap">
        <button type="button" className="btn" disabled={make.isPending} onClick={() => make.mutate(undefined, { onSuccess: (r) => setKey(r.key) })}>
          <KeyRound size={14} /> {on ? 'Make a new password' : 'Set up route recording'}
        </button>
        {on && (
          <button type="button" className="btn btn-ghost" disabled={off.isPending} onClick={() => off.mutate(undefined, { onSuccess: () => setKey(null) })}>
            Turn off
          </button>
        )}
      </div>
      {key && <p className="hint">Copy the password now; it is shown once. Making a new one turns the old one off. It can only send locations, nothing else.</p>}
    </div>
  );
}
