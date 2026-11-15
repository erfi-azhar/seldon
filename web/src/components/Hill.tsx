// The foot of the Today page: the shard from sign-in, hovering over its hill under the
// same sky as the band at the top, with the traveller and their lantern on the near slope.
// The band rises out of the page the way the top sky dissolves into it. Drawn by
// ../hill.ts; slowly when nothing moves, and not at all while hidden or scrolled away.
// After dark a shooting star crosses now and then, and a tap on the sky sends another.
// The weather where you are shows here as it does in the sky at the top.
// With reduced motion it holds still.

import { useEffect, useRef } from 'react';
import { cellFor, crestAt, drawHill, HOVER, pageColor, starsOut, streakAlive, streakAt, type HillView, type Streak } from '../hill.ts';
import { useWeather } from '../api.ts';
import { useSun } from '../sun.ts';
import { lookOf, moving, nextFlashIn } from '../weather.ts';

/** The band shows the scene from FROM (sky, above the shard) down to TO, a little below the crest. */
const FROM = -0.22;
const TO = 0.86;
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, details, [role="button"], [contenteditable="true"], .card, .glass-pill';

export function HillBand() {
  const sun = useSun();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sunRef = useRef(sun);
  sunRef.current = sun;
  // The same reading as the sky at the top (shared, so it is looked up once).
  const { data: weather } = useWeather(sun.source === 'guess' ? null : sun.place);
  const weatherRef = useRef(weather ?? null);
  weatherRef.current = weather ?? null;
  const redraw = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const scene = { spin: Math.random() * 6, drift: Math.random() * 10, streaks: [] as Streak[], nextStar: 5, flashAt: -99, nextFlash: 0 };
    let raf = 0;
    let last = -Infinity;
    let onScreen = true;
    let view: HillView | null = null;

    const draw = (t: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const unit = h / (TO - FROM);
      // The top 40% rises out of the page, as gradually as the sky at the top dissolves into it.
      view = { unit, top: -FROM * unit, cx: w / 2, shardY: 0.33, shardSize: 0.15, fadeTop: [FROM, FROM + 0.4 * (TO - FROM)], cell: cellFor(window.innerWidth) };
      scene.streaks = scene.streaks.filter((s) => streakAlive(s, t));
      drawHill(canvas, w, h, Math.min(2, window.devicePixelRatio || 1), view, {
        sun: sunRef.current,
        t,
        still: still.matches,
        spin: scene.spin,
        drift: scene.drift,
        pose: HOVER,
        pulse: 0,
        traveller: 0,
        streaks: scene.streaks,
        weather: weatherRef.current,
        flashAt: scene.flashAt,
      }, pageColor());
    };
    redraw.current = () => draw(performance.now() / 1000);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const t = now / 1000;
      const look = lookOf(weatherRef.current);
      if (!still.matches && look.storm && t > scene.nextFlash) {
        scene.flashAt = t;
        scene.nextFlash = t + nextFlashIn();
      }
      if (!still.matches && starsOut(sunRef.current, weatherRef.current) && t > scene.nextStar && view) {
        const half = canvas.clientWidth / 2 / view.unit;
        scene.streaks.push(streakAt(t, (Math.random() - 0.5) * half * 1.2, 0.2 + Math.random() * 0.1));
        scene.nextStar = t + 10 + Math.random() * 12;
      }
      // Smooth while a star is falling, steady while rain or snow falls; otherwise a slow drift is enough.
      if (now - last < (scene.streaks.length ? 33 : moving(look) ? 50 : 90)) return;
      const step = Math.min(0.25, (now - last) / 1000);
      last = now;
      scene.spin += step * 0.16;
      scene.drift += step * 0.03 * look.wind;
      draw(t);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (still.matches) redraw.current();
      else if (onScreen) raf = requestAnimationFrame(frame);
    };
    run();

    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      if (onScreen) run();
      else cancelAnimationFrame(raf);
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => still.matches && redraw.current());
    ro.observe(canvas);
    still.addEventListener('change', run);
    // While reduced motion holds it still, keep the sun and moon moving once a minute.
    const minute = setInterval(() => still.matches && redraw.current(), 60_000);

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || still.matches || !view || !starsOut(sunRef.current, weatherRef.current)) return;
      const el = e.target as Element | null;
      if (!el?.closest('.app-main') || el.closest(INTERACTIVE) || window.getSelection()?.toString()) return;
      const r = canvas.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const x = (e.clientX - r.left - view.cx) / view.unit;
      const y = (e.clientY - r.top - view.top) / view.unit;
      if (y < 0.05 || y > crestAt(x) - 0.03) return;
      scene.streaks.push(streakAt(performance.now() / 1000, x, y));
    };
    document.addEventListener('click', onClick);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      still.removeEventListener('change', run);
      clearInterval(minute);
      document.removeEventListener('click', onClick);
    };
  }, []);

  // Redraw a held-still scene when the phase, place or weather changes.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) redraw.current();
  }, [sun, weather]);

  return (
    <div className="hill-band" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
