// The weather where you are, for the sky on Today.
//
// From Open-Meteo (open-meteo.com): free, no key and no account. Only the coordinates
// are sent, rounded to about a kilometre, and each place is looked up at most every ten
// minutes. If a lookup fails, the last known weather for the place is used for a while.

import { Invalid } from '../store.ts';
import type { Weather, WeatherKind } from '../../../shared/types.ts';
import { registerFeature } from './registry.ts';

const FRESH_MS = 10 * 60_000;
/** How long a stale reading is still better than none when Open-Meteo is unreachable. */
const STALE_MS = 2 * 60 * 60_000;
const cache = new Map<string, { at: number; weather: Weather }>();

/** WMO weather interpretation codes (as Open-Meteo reports them), read as what the sky shows. */
export function weatherKind(code: number, cloudCover: number): WeatherKind {
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 80 && code <= 82) return 'showers';
  if (code >= 61 && code <= 67) return 'rain';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code === 45 || code === 48) return 'fog';
  if (code === 3 || cloudCover >= 85) return 'overcast';
  if (code === 2 || cloudCover >= 30) return 'cloudy';
  return 'clear';
}

const round = (n: number) => Math.round(n * 100) / 100;

async function lookUp(lat: number, lng: number): Promise<Weather> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('current', 'weather_code,cloud_cover,precipitation,wind_speed_10m');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', 'UTC');
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const body = (await res.json()) as { current?: { time?: string; weather_code?: number; cloud_cover?: number; precipitation?: number; wind_speed_10m?: number } };
  const cur = body.current;
  if (!cur || typeof cur.weather_code !== 'number') throw new Error('Open-Meteo sent no current weather');
  const cloudCover = Math.max(0, Math.min(100, cur.cloud_cover ?? 0));
  return {
    kind: weatherKind(cur.weather_code, cloudCover),
    code: cur.weather_code,
    cloudCover,
    precipitation: Math.max(0, cur.precipitation ?? 0),
    windKmh: Math.max(0, cur.wind_speed_10m ?? 0),
    observedAt: cur.time ? `${cur.time}:00Z` : new Date().toISOString(),
  };
}

export async function weatherAt(lat: number, lng: number, now = Date.now()): Promise<Weather | null> {
  const key = `${round(lat)},${round(lng)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_MS) return hit.weather;
  try {
    const weather = await lookUp(round(lat), round(lng));
    cache.set(key, { at: now, weather });
    return weather;
  } catch {
    return hit && now - hit.at < STALE_MS ? hit.weather : null;
  }
}

registerFeature({
  id: 'weather',
  routes: (app) => {
    app.get('/api/weather', async (c) => {
      const lat = Number(c.req.query('lat'));
      const lng = Number(c.req.query('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Invalid('A latitude and longitude are needed.');
      const weather = await weatherAt(lat, lng);
      if (!weather) return c.json({ error: 'The weather could not be looked up just now.' }, 503);
      return c.json(weather);
    });
  },
});
