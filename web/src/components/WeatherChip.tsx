// The weather where you are, in the top bar on Today: the temperature in a chip beside
// Settings, opening a card with how it feels, wind, humidity, cloud and the next few
// hours. The same reading the sky shows (from Open-Meteo, through the server).

import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Cloudy, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WeatherKind } from '../../../shared/types.ts';
import { useWeather } from '../api.ts';
import { cx } from '../lib.ts';
import { useSun } from '../sun.ts';
import { degrees, onTempUnit, readTempUnit, weatherLabel } from '../weather.ts';

export function weatherIcon(kind: WeatherKind, isDay: boolean): LucideIcon {
  switch (kind) {
    case 'clear':
      return isDay ? Sun : Moon;
    case 'cloudy':
      return isDay ? CloudSun : CloudMoon;
    case 'overcast':
      return Cloudy;
    case 'fog':
      return CloudFog;
    case 'drizzle':
      return CloudDrizzle;
    case 'rain':
    case 'showers':
      return CloudRain;
    case 'snow':
      return CloudSnow;
    case 'storm':
      return CloudLightning;
    default:
      return Cloud;
  }
}

const hour = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function WeatherChip() {
  const sun = useSun();
  const { data: w } = useWeather(sun.source === 'guess' ? null : sun.place);
  const unit = useSyncExternalStore(onTempUnit, readTempUnit);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      wrap.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!w) return null;
  const Icon = weatherIcon(w.kind, w.isDay);
  const label = weatherLabel(w.code);
  const place = sun.source === 'device' ? 'Where you are' : 'Your prayer-times location';

  return (
    <div className="wx" ref={wrap}>
      <button
        type="button"
        className={cx('icon-btn wx-chip', open && 'active')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}, ${degrees(w.temperature, unit)}. Weather details`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{degrees(w.temperature, unit)}</span>
      </button>
      {open && (
        <div className="wx-card card" role="dialog" aria-label="Weather">
          <div className="wx-head">
            <b>{label}</b>
            <span>{place}</span>
          </div>
          <div className="wx-now">
            <span className="wx-temp">{degrees(w.temperature, unit)}</span>
            <span>feels {degrees(w.feelsLike, unit)}</span>
          </div>
          <dl className="wx-facts">
            <div>
              <dt>Wind</dt>
              <dd>{Math.round(w.windKmh)} km/h</dd>
            </div>
            <div>
              <dt>Humidity</dt>
              <dd>{Math.round(w.humidity)}%</dd>
            </div>
            <div>
              <dt>Cloud</dt>
              <dd>{Math.round(w.cloudCover)}%</dd>
            </div>
          </dl>
          {w.hours.length > 0 && (
            <ol className="wx-hours" aria-label="The next few hours">
              {w.hours.map((h) => {
                const HourIcon = weatherIcon(h.kind, h.isDay);
                return (
                  <li key={h.at} title={weatherLabel(h.code)}>
                    <span className="wx-hour">{hour(h.at)}</span>
                    <HourIcon size={16} aria-label={weatherLabel(h.code)} />
                    <span>{degrees(h.temperature, unit)}</span>
                    <span className="wx-rain">{h.rainChance >= 20 ? `${Math.round(h.rainChance)}%` : ''}</span>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="wx-source">From Open-Meteo · updated {clock(w.observedAt)}</p>
        </div>
      )}
    </div>
  );
}
