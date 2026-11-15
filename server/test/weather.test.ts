import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weatherAt, weatherKind } from '../src/features/weather.ts';

test('WMO codes read as what the sky shows', () => {
  assert.equal(weatherKind(0, 5), 'clear');
  assert.equal(weatherKind(1, 40), 'cloudy');
  assert.equal(weatherKind(2, 10), 'cloudy');
  assert.equal(weatherKind(3, 60), 'overcast');
  assert.equal(weatherKind(0, 92), 'overcast');
  assert.equal(weatherKind(45, 100), 'fog');
  assert.equal(weatherKind(53, 100), 'drizzle');
  assert.equal(weatherKind(63, 100), 'rain');
  assert.equal(weatherKind(81, 80), 'showers');
  assert.equal(weatherKind(73, 100), 'snow');
  assert.equal(weatherKind(86, 100), 'snow');
  assert.equal(weatherKind(95, 100), 'storm');
});

test('weather is looked up once per place every ten minutes, and a stale reading covers a failure', async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  let fail = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify({ current: { time: '2026-11-15T03:00', weather_code: 61, cloud_cover: 95, precipitation: 1.2, wind_speed_10m: 14 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const t0 = Date.UTC(2026, 10, 15, 3);
    const w = await weatherAt(1.35212, 103.81981, t0);
    assert.deepEqual(w, { kind: 'rain', code: 61, cloudCover: 95, precipitation: 1.2, windKmh: 14, observedAt: '2026-11-15T03:00:00Z' });
    // Only rounded coordinates leave the machine.
    assert.match(asked[0]!, /latitude=1\.35&longitude=103\.82/);

    await weatherAt(1.3521, 103.8198, t0 + 5 * 60_000);
    assert.equal(asked.length, 1, 'served from the cache within ten minutes');

    fail = true;
    assert.equal((await weatherAt(1.3521, 103.8198, t0 + 30 * 60_000))?.kind, 'rain', 'the last reading covers a failed lookup');
    assert.equal(await weatherAt(1.3521, 103.8198, t0 + 3 * 60 * 60_000), null, 'but not for ever');
  } finally {
    globalThis.fetch = real;
  }
});
