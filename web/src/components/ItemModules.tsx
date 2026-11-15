// What a plan item needs, under it in the plan: how to get there (from the stop before, how long,
// when to leave, the steps, a map), then the rest as small modules — hours, cost, booking, what to
// bring or wear, contact, halal food or prayer nearby, heads-ups, tips. A line of chips while
// folded; tap to open.

import { Backpack, Banknote, Car, CarTaxiFront, ChevronDown, Clock, ExternalLink, Footprints, Lightbulb, Moon, Navigation, Phone, Shirt, Ticket, TrainFront, TriangleAlert, UtensilsCrossed } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ItemDetail, ItemRoute, ItineraryItem } from '../../../shared/types.ts';
import { cx } from '../lib.ts';

const MODE: Record<ItemRoute['mode'], { icon: ReactNode; word: string; maps: string }> = {
  walk: { icon: <Footprints size={13} aria-hidden />, word: 'on foot', maps: 'walking' },
  transit: { icon: <TrainFront size={13} aria-hidden />, word: 'by train or bus', maps: 'transit' },
  taxi: { icon: <CarTaxiFront size={13} aria-hidden />, word: 'by taxi', maps: 'driving' },
  drive: { icon: <Car size={13} aria-hidden />, word: 'by car', maps: 'driving' },
};

const KIND: Record<ItemDetail['kind'], ReactNode> = {
  hours: <Clock size={13} aria-hidden />,
  cost: <Banknote size={13} aria-hidden />,
  booking: <Ticket size={13} aria-hidden />,
  bring: <Backpack size={13} aria-hidden />,
  dress: <Shirt size={13} aria-hidden />,
  contact: <Phone size={13} aria-hidden />,
  food: <UtensilsCrossed size={13} aria-hidden />,
  prayer: <Moon size={13} aria-hidden />,
  'heads-up': <TriangleAlert size={13} aria-hidden />,
  tip: <Lightbulb size={13} aria-hidden />,
};

/** "12:00" minus some minutes, as "11:35". */
const minus = (hhmm: string, minutes: number) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const t = (((h * 60 + m - minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const maps = (to: string, from?: string, mode?: string) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}${from ? `&origin=${encodeURIComponent(from)}` : ''}${mode ? `&travelmode=${mode}` : ''}`;

/** The modules under one plan item; `before` is where you'll be just before, for a map without a route. */
export function ItemModules({ item, before }: { item: ItineraryItem; before?: string }) {
  const [open, setOpen] = useState(false);
  const r = item.route;
  const details = item.details ?? [];
  const where = item.place || item.title;
  if (!r && details.length === 0) {
    // Nothing gathered yet: at least the way there on a map.
    return item.place ? (
      <div className="im">
        <a className="im-chip is-link" href={maps(item.place, before)} target="_blank" rel="noreferrer">
          <Navigation size={13} aria-hidden /> Directions
        </a>
      </div>
    ) : null;
  }
  // Leave in time to arrive, with five minutes in hand.
  const leave = r && item.time ? minus(item.time, r.minutes + 5) : null;
  return (
    <div className={cx('im', open && 'is-open')}>
      <button type="button" className="im-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {r && (
          <span className="im-chip is-route">
            {MODE[r.mode].icon} {r.minutes} min {MODE[r.mode].word}
            {leave && <b> · leave {leave}</b>}
          </span>
        )}
        {details.slice(0, open ? 0 : 3).map((d) => (
          <span key={d.label + d.kind} className={cx('im-chip', d.kind === 'heads-up' && 'is-warn')}>
            {KIND[d.kind]} {d.label}
          </span>
        ))}
        {!open && details.length > 3 && <span className="im-chip is-more">+{details.length - 3}</span>}
        <ChevronDown size={14} className="im-chev" aria-hidden />
      </button>
      {open && (
        <div className="im-body">
          {r && (
            <section className="im-route">
              <p className="im-from">
                From <b>{r.from}</b>, about {r.minutes} min {MODE[r.mode].word}
                {leave && (
                  <>
                    {' '}
                    · leave by <b>{leave}</b>
                  </>
                )}
              </p>
              {r.steps.length > 0 && (
                <ol className="im-steps">
                  {r.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              )}
              <a className="im-map" href={maps(where, r.from, MODE[r.mode].maps)} target="_blank" rel="noreferrer">
                <Navigation size={13} aria-hidden /> Open in Maps
              </a>
            </section>
          )}
          {details.length > 0 && (
            <ul className="im-details">
              {details.map((d) => (
                <li key={d.label + d.kind} className={cx(d.kind === 'heads-up' && 'is-warn')}>
                  <span className="im-icon">{KIND[d.kind]}</span>
                  <span>
                    <b>{d.label}</b>
                    {d.text && <span> {d.text}</span>}
                    {d.url && (
                      <a href={d.url} target="_blank" rel="noreferrer" className="im-link">
                        <ExternalLink size={11} aria-hidden /> More
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
