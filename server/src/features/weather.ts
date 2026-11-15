// The weather where you are, for the sky on Today.
//
// From Open-Meteo (open-meteo.com): free, no key and no account. Only the coordinates
// are sent, rounded to about a kilometre, and each place is looked up at most every ten
// minutes. If a lookup fails, the last known weather for the place is used for a while.

import { Invalid } from '../store.ts';
import type { Weather, WeatherHour, WeatherKind } from '../../../shared/types.ts';
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
const pct = (n: number | undefined) => Math.max(0, Math.min(100, n ?? 0));

interface OpenMeteo {
  current?: {
    time?: string;
    weather_code?: number;
    cloud_cover?: number;
    precipitation?: number;
    wind_speed_10m?: number;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    is_day?: number;
  };
  hourly?: {
    time?: string[];
    weather_code?: (number | null)[];
    cloud_cover?: (number | null)[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    is_day?: (number | null)[];
  };
}

/** The hours that start after the current reading, up to five. */
function hoursAfter(h: OpenMeteo['hourly'], observedAt: string): WeatherHour[] {
  if (!h?.time) return [];
  const now = Date.parse(observedAt);
  const out: WeatherHour[] = [];
  h.time.forEach((t, i) => {
    const at = `${t}:00Z`;
    const code = h.weather_code?.[i];
    const temperature = h.temperature_2m?.[i];
    if (Date.parse(at) <= now || typeof code !== 'number' || typeof temperature !== 'number' || out.length >= 5) return;
    out.push({ at, kind: weatherKind(code, pct(h.cloud_cover?.[i] ?? 0)), code, temperature, rainChance: pct(h.precipitation_probability?.[i] ?? 0), isDay: h.is_day?.[i] !== 0 });
  });
  return out;
}

async function lookUp(lat: number, lng: number): Promise<Weather> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('current', 'weather_code,cloud_cover,precipitation,wind_speed_10m,temperature_2m,apparent_temperature,relative_humidity_2m,is_day');
  url.searchParams.set('hourly', 'weather_code,cloud_cover,temperature_2m,precipitation_probability,is_day');
  // This hour and the next six.
  url.searchParams.set('forecast_hours', '7');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', 'UTC');
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const body = (await res.json()) as OpenMeteo;
  const cur = body.current;
  if (!cur || typeof cur.weather_code !== 'number') throw new Error('Open-Meteo sent no current weather');
  const cloudCover = pct(cur.cloud_cover);
  const observedAt = cur.time ? `${cur.time}:00Z` : new Date().toISOString();
  const temperature = cur.temperature_2m ?? 0;
  return {
    kind: weatherKind(cur.weather_code, cloudCover),
    code: cur.weather_code,
    cloudCover,
    precipitation: Math.max(0, cur.precipitation ?? 0),
    windKmh: Math.max(0, cur.wind_speed_10m ?? 0),
    temperature,
    feelsLike: cur.apparent_temperature ?? temperature,
    humidity: pct(cur.relative_humidity_2m),
    isDay: cur.is_day !== 0,
    hours: hoursAfter(body.hourly, observedAt),
    observedAt,
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
