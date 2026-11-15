// Know before you go: a trip's city guides on its page. Each city leads with the numbers to call
// and its safety notes, then the rest as small panels: money, getting around, phone and apps,
// etiquette, halal food and prayer, health, weather, plugs, language, entry. Seldon writes it a
// month ahead (or on asking); a trip of several cities gets a tab for each.

import { Banknote, CloudSun, Handshake, HeartPulse, Info, Languages, Phone, Plug, ShieldAlert, Smartphone, Sparkles, Stamp, TrainFront, UtensilsCrossed } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { GuideSection, Trip } from '../../../shared/types.ts';
import { travelWrite, useWrite } from '../api.ts';
import { useApp } from '../state.tsx';
import { Seg, Spinner } from './ui.tsx';

const ICON: Record<GuideSection['kind'], ReactNode> = {
  safety: <ShieldAlert size={15} aria-hidden />,
  money: <Banknote size={15} aria-hidden />,
  transport: <TrainFront size={15} aria-hidden />,
  apps: <Smartphone size={15} aria-hidden />,
  etiquette: <Handshake size={15} aria-hidden />,
  food: <UtensilsCrossed size={15} aria-hidden />,
  health: <HeartPulse size={15} aria-hidden />,
  weather: <CloudSun size={15} aria-hidden />,
  power: <Plug size={15} aria-hidden />,
  language: <Languages size={15} aria-hidden />,
  entry: <Stamp size={15} aria-hidden />,
};

/** The guide inside its card on the trip page. */
export function TripGuideBody({ trip }: { trip: Trip }) {
  const { agentName } = useApp();
  const write = useWrite(() => travelWrite.post(`/trips/${trip.id}/guide`));
  const [pick, setPick] = useState(0);
  const g = trip.guide;
  if (!g || g.cities.length === 0)
    return (
      <div className="trip-guide-empty">
        <p className="empty">{agentName} writes this a month before the trip: safety, money, getting around, halal food and prayer, and what else to know for each city.</p>
        <button type="button" className="btn btn-sm" disabled={write.isPending} onClick={() => write.mutate(undefined)}>
          {write.isPending ? <Spinner /> : <Sparkles size={13} />} Write it now
        </button>
        {write.error && <p className="error-text">{write.error.message}</p>}
      </div>
    );
  const city = g.cities[Math.min(pick, g.cities.length - 1)]!;
  const safety = city.sections.filter((x) => x.kind === 'safety');
  const rest = city.sections.filter((x) => x.kind !== 'safety');
  return (
    <div className="trip-guide">
      {g.cities.length > 1 && (
        <div className="opt-dir">
          <Seg label="City" value={String(pick)} onChange={(v) => setPick(Number(v))} options={g.cities.map((c, i) => ({ value: String(i), label: c.name }))} />
        </div>
      )}
      {city.emergency.length > 0 && (
        <div className="trip-guide-sos" aria-label="Emergency numbers">
          {city.emergency.map((e) => {
            const num = e.match(/[\d+][\d\s-]{1,14}\d/)?.[0]?.replace(/\s|-/g, '');
            return num ? (
              <a key={e} href={`tel:${num}`} className="trip-guide-sos-chip">
                <Phone size={12} aria-hidden /> {e}
              </a>
            ) : (
              <span key={e} className="trip-guide-sos-chip">
                <Phone size={12} aria-hidden /> {e}
              </span>
            );
          })}
        </div>
      )}
      {safety.map((x) => (
        <section key={x.title} className="trip-guide-sec is-safety">
          <h3>
            {ICON.safety} {x.title}
          </h3>
          <ul>
            {x.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      ))}
      <div className="trip-guide-grid">
        {rest.map((x) => (
          <section key={x.kind + x.title} className="trip-guide-sec">
            <h3>
              {ICON[x.kind] ?? <Info size={15} aria-hidden />} {x.title}
            </h3>
            <ul>
              {x.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="trip-guide-foot">
        Written {new Date(g.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. Check entry rules and anything time-sensitive before you go.{' '}
        <button type="button" className="link" disabled={write.isPending} onClick={() => write.mutate(undefined)}>
          {write.isPending ? 'Rewriting…' : 'Rewrite'}
        </button>
      </p>
      {write.error && <p className="error-text">{write.error.message}</p>}
    </div>
  );
}
