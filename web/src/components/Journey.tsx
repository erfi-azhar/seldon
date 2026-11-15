// Journey: a travel day as it happens, the route you took, and the settings behind both.
// - NowPanel (Today, inside the travel card): what you need right now in the day's current phase.
// - RouteCard (a trip's page): where your phone says you went, day by day.
// - TravelNotifications and RouteRecording (Settings): lock-screen notifications on this device,
//   and the OwnTracks app that reports your location while a trip is on.

import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, Clock, KeyRound, MapPin, Navigation, Route as RouteIcon, Send, Sofa } from 'lucide-react';
import { useEffect, useState } from 'react';
import { boardsAt, clock, leaveBy, reachAirportBy, span, type Journey as JourneyT } from '../../../shared/journey.ts';
import type { JourneyStatus, Segment, Trip, TripTrack } from '../../../shared/types.ts';
import { api, useWrite, write } from '../api.ts';
import { cx, plural } from '../lib.ts';
import { layoverPlan } from '../layover.ts';

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

  if (phase.kind === 'before')
    return (
      <div className="journey-now">
        <b className="jn-title">Reach the airport by {clock(reachAirportBy(leg), leg.startTz)}</b>
        <span className="jn-sub">
          Set off by {clock(leaveBy(leg), leg.startTz)} · {leg.fromName || leg.fromCode}
        </span>
        <a className="jn-btn" href={mapsTo(`${leg.fromName || leg.fromCode} Airport, ${city(leg, 'from')}`)} target="_blank" rel="noreferrer">
          <Navigation size={14} aria-hidden /> Directions
        </a>
      </div>
    );

  if (phase.kind === 'airport')
    return (
      <div className="journey-now">
        <b className="jn-title">
          {flightName(leg)} boards around {clock(boardsAt(leg), leg.startTz)}
        </b>
        <span className="jn-sub">
          To {city(leg, 'to')}, leaving {clock(Date.parse(leg.startUtc), leg.startTz)}
          {leg.seat && ` · seat ${leg.seat}`}
        </span>
        {leg.lounges[0] && (
          <span className="jn-line">
            <Sofa size={13} aria-hidden /> {leg.lounges[0].access}
          </span>
        )}
        <span className="jn-line">
          <Clock size={13} aria-hidden /> It’s {clock(now, leg.startTz)} at {leg.fromCode}
        </span>
      </div>
    );

  if (phase.kind === 'flight') {
    const total = Date.parse(leg.endUtc) - Date.parse(leg.startUtc);
    const done = Math.min(1, Math.max(0, (now - Date.parse(leg.startUtc)) / total));
    return (
      <div className="journey-now is-flight">
        <b className="jn-title">{span((Date.parse(leg.endUtc) - now) / MIN)} to arrival</b>
        <FlightArc progress={done} />
        <div className="jn-ends">
          <span>
            <b className="num">{clock(Date.parse(leg.startUtc), leg.startTz)}</b>
            <small>{leg.fromCode}</small>
          </span>
          <span className="jn-dur">{span(total / MIN)}</span>
          <span className="is-end">
            <b className="num">{clock(Date.parse(leg.endUtc), leg.endTz)}</b>
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
      <b className="jn-title">Welcome to {city(last, 'to')}</b>
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

/** The flight as an arc over the horizon, a light where the plane is now. */
function FlightArc({ progress }: { progress: number }) {
  // A shallow arc from (8, 46) to (312, 46), peaking at y 14.
  const at = (t: number) => {
    const x = 8 + 304 * t;
    const y = 46 - 128 * t * (1 - t);
    return [x, y] as const;
  };
  const [px, py] = at(progress);
  return (
    <svg className="jn-arc" viewBox="0 0 320 56" preserveAspectRatio="none" aria-hidden>
      <defs>
        <radialGradient id="jn-glow">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M8 46 Q160 -18 312 46" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
      <path d="M8 46 Q160 -18 312 46" fill="none" stroke="currentColor" strokeWidth="2" pathLength={1} strokeDasharray={`${progress} 1`} />
      <circle cx={px} cy={py} r="10" fill="url(#jn-glow)" />
      <circle cx={px} cy={py} r="3" fill="currentColor" />
    </svg>
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
