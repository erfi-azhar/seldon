// The welcome stage: a dark shard hovering over a hill, under the sky where you are, in
// the Today sky's dot matrix (drawn by ../hill.ts). A traveller with a lantern stands on
// the near slope. Unlock, and the shard comes down to rest on the hilltop; where it
// touches, a ring of light runs out across the ground and the screen washes to light.
// Through first-run setup the shard stays there, a little open and lit from within, and
// the traveller climbs a little with each step until they stand beside it.
//
// One canvas lives outside React, so the scene carries on unbroken from sign-in through
// every setup step. Pages mark where the hill goes with <VaultAnchor>: the sky fills the
// box, the crest sits a third of the way up from its bottom, and the near slope fades into
// the page below it. The scene follows that box as the page scrolls, and eases to a new
// box when the page changes. With reduced motion it holds still.

import { useEffect, useRef } from 'react';
import { cellFor, crestAt, drawHill, HOVER, pageColor, REST, starsOut, streakAlive, streakAt, unlockPose, UNLOCK_PEAK, type HillView, type Pose, type Streak } from '../hill.ts';
import { useSun, useSunTick, type SunState } from '../sun.ts';

export type VaultScene = 'hover' | 'open';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How long an unlock takes, in ms. */
const UNLOCK_MS = 4200;
/** Where the traveller stands on each setup step, from low on the slope (0) to the top (1). */
const CLIMB = [0.1, 0.5, 1];
/** The anchor box, in scene units: its top is just below v = 0, and its bottom (where the page's text starts) at this v. */
const BOX_TOP = 0.03;
const BOX_BOTTOM = 0.69;
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [role="button"], .field, .pick';

interface Box {
  /** Top, in document coordinates (so scrolling moves it exactly, while layout changes ease). */
  top: number;
  h: number;
  cx: number;
}

interface Engine {
  canvas: HTMLCanvasElement;
  flash: HTMLDivElement;
  scene: VaultScene;
  step: number;
  sun: SunState | null;
  clock: number | null;
  anchor: HTMLElement | null;
  box: Box | null;
  view: HillView | null;
  spin: number;
  drift: number;
  pulse: number;
  travel: number;
  /** When the unlock started (performance.now()), while one plays. */
  unlockAt: number | null;
  streaks: Streak[];
  nextStar: number;
  mounts: number;
  raf: number;
  drawnAt: number;
  prev: number;
  hideTimer: number;
}

let E: Engine | null = null;

function engine(): Engine {
  if (E) return E;
  const canvas = document.createElement('canvas');
  canvas.className = 'vault-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const flash = document.createElement('div');
  flash.className = 'vault-flash';
  flash.setAttribute('aria-hidden', 'true');
  E = {
    canvas,
    flash,
    scene: 'hover',
    step: 0,
    sun: null,
    clock: null,
    anchor: null,
    box: null,
    view: null,
    spin: Math.random() * 6,
    drift: Math.random() * 10,
    pulse: 0,
    travel: 0,
    unlockAt: null,
    streaks: [],
    nextStar: 6,
    mounts: 0,
    raf: 0,
    drawnAt: -Infinity,
    prev: performance.now(),
    hideTimer: 0,
  };
  return E;
}

function frame(now: number) {
  const e = E!;
  e.raf = requestAnimationFrame(frame);
  if (document.hidden || !e.sun) return;
  const still = reduced();
  const t = now / 1000;
  const dt = Math.min(0.2, (now - e.prev) / 1000);
  e.prev = now;

  // The box, eased toward the anchor's: scrolling moves it at once, layout changes glide.
  const W = innerWidth;
  const H = innerHeight;
  let settling = false;
  const r = e.anchor?.isConnected ? e.anchor.getBoundingClientRect() : null;
  const goal: Box = r ? { top: r.top + scrollY, h: r.height, cx: r.left + r.width / 2 } : { top: scrollY + H * 0.04, h: H * 0.62, cx: W / 2 };
  if (!e.box || still) e.box = goal;
  else {
    const k = Math.min(1, dt * 5);
    const b = e.box;
    settling = Math.abs(goal.top - b.top) + Math.abs(goal.h - b.h) + Math.abs(goal.cx - b.cx) > 0.5;
    e.box = { top: b.top + (goal.top - b.top) * k, h: b.h + (goal.h - b.h) * k, cx: b.cx + (goal.cx - b.cx) * k };
  }

  // The traveller walks to where this step puts them.
  const target = e.scene === 'open' ? CLIMB[Math.min(e.step, CLIMB.length - 1)] : 0;
  const walking = Math.abs(target - e.travel) > 0.001;
  e.travel = still ? target : e.travel + Math.sign(target - e.travel) * Math.min(Math.abs(target - e.travel), dt * 0.14);

  let pose: Pose = e.scene === 'open' ? REST : HOVER;
  if (e.unlockAt !== null) {
    const p = (now - e.unlockAt) / UNLOCK_MS;
    if (p >= 1) e.unlockAt = null;
    else pose = unlockPose(p);
  }
  e.flash.style.opacity = pose.flash > 0.001 ? String(Math.min(1, pose.flash * 1.15)) : '0';

  // Smooth while something moves; otherwise a slow drift is enough.
  const busy = e.unlockAt !== null || e.pulse > 0 || e.streaks.length > 0 || walking || settling;
  if (now - e.drawnAt < (still ? 1000 : busy ? 33 : 90)) return;
  const step = Math.min(0.25, (now - e.drawnAt) / 1000);
  e.drawnAt = now;
  if (!still) {
    e.spin += step * 0.16;
    e.drift += step * 0.03;
  }
  e.pulse = Math.max(0, e.pulse - step * 1.4);

  const unit = e.box.h / (BOX_BOTTOM - BOX_TOP);
  const view: HillView = {
    unit,
    top: e.box.top - scrollY - BOX_TOP * unit,
    cx: e.box.cx,
    shardY: 0.26,
    shardSize: 0.19,
    fadeBottom: [0.5, 0.9],
    cell: cellFor(W),
  };
  e.view = view;

  // Now and then after dark, a shooting star.
  e.streaks = e.streaks.filter((s) => streakAlive(s, t));
  if (!still && starsOut(e.sun) && t > e.nextStar) {
    const half = W / 2 / unit;
    e.streaks.push(streakAt(t, (Math.random() - 0.5) * half * 1.2, 0.05 + Math.random() * 0.15));
    e.nextStar = t + 8 + Math.random() * 10;
  }

  drawHill(e.canvas, W, H, Math.min(2, devicePixelRatio || 1), view, {
    sun: e.sun,
    t,
    still,
    spin: e.spin,
    drift: e.drift,
    pose,
    pulse: e.pulse,
    traveller: e.travel,
    streaks: e.streaks,
    clock: e.clock ?? undefined,
  }, pageColor());
}

/** A tap on open sky after dark sends a shooting star from there. */
function onClick(ev: MouseEvent) {
  const e = E;
  if (!e?.view || !e.sun || ev.defaultPrevented || ev.button !== 0 || reduced() || !starsOut(e.sun)) return;
  if ((ev.target as Element | null)?.closest(INTERACTIVE)) return;
  const x = (ev.clientX - e.view.cx) / e.view.unit;
  const y = (ev.clientY - e.view.top) / e.view.unit;
  if (y > crestAt(x) - 0.03 || y < -0.2) return;
  e.streaks.push(streakAt(performance.now() / 1000, x, y));
}

function show() {
  const e = engine();
  clearTimeout(e.hideTimer);
  e.mounts++;
  if (!e.canvas.isConnected) {
    document.body.prepend(e.canvas, e.flash);
    document.addEventListener('click', onClick);
  }
  e.canvas.classList.remove('is-gone');
  if (!e.raf) {
    e.prev = performance.now();
    e.drawnAt = -Infinity;
    e.raf = requestAnimationFrame(frame);
  }
}

function hide() {
  const e = E;
  if (!e) return;
  e.mounts = Math.max(0, e.mounts - 1);
  // Wait a beat: the next screen may be about to show the stage again.
  e.hideTimer = window.setTimeout(() => {
    if (e.mounts > 0) return;
    e.canvas.classList.add('is-gone');
    window.setTimeout(() => {
      if (e.mounts > 0) return;
      cancelAnimationFrame(e.raf);
      e.raf = 0;
      e.canvas.remove();
      e.flash.remove();
      document.removeEventListener('click', onClick);
    }, 700);
  }, 250);
}

/** Put the stage on screen; returns a function that takes it away again. */
export function mountVault(): () => void {
  show();
  return hide;
}

/** Move the stage to a scene; in "open", the setup step sets how far the traveller has climbed. */
export function setVaultScene(scene: VaultScene, step = 0): void {
  const e = engine();
  e.scene = scene;
  e.step = step;
}

/** The time of day to draw; `clock` puts the sun and moon where they are at that moment instead of now (for demos). */
export function setVaultSun(sun: SunState, clock: number | null = null): void {
  const e = engine();
  e.sun = sun;
  e.clock = clock;
}

/** Draw the hill in this box (or near the top of the screen, with none). */
export function setVaultAnchor(el: HTMLElement | null): void {
  engine().anchor = el;
}

/** A key typed in the passphrase: the seam brightens a little. */
export function pulseVault(): void {
  const e = engine();
  e.pulse = Math.min(1.2, e.pulse + 0.45);
}

/** Show the stage behind this page, in a given scene. */
export function VaultStage({ scene, step = 0 }: { scene: VaultScene; step?: number }) {
  const sun = useSun();
  // Outside the app shell nothing else keeps the time of day moving.
  useSunTick();
  useEffect(() => setVaultSun(sun), [sun]);
  useEffect(() => mountVault(), []);
  useEffect(() => setVaultScene(scene, step), [scene, step]);
  return null;
}

/** The box on the page where the hill goes: sky in its upper part, the crest low down. */
export function VaultAnchor({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    setVaultAnchor(el);
    return () => {
      if (engine().anchor === el) setVaultAnchor(null);
    };
  }, []);
  return <div ref={ref} className={`vault-anchor ${className ?? ''}`} aria-hidden />;
}

/**
 * Unlock: the shard comes down onto the hill, light runs out from where it touches, and
 * the screen washes to light. Resolves at the brightest moment, so the next screen can
 * appear behind the light as it fades.
 */
export function playUnlock(): Promise<void> {
  const e = engine();
  if (reduced()) {
    e.scene = 'open';
    return Promise.resolve();
  }
  e.unlockAt = performance.now();
  return new Promise((resolve) => window.setTimeout(() => {
    e.scene = 'open';
    resolve();
  }, UNLOCK_MS * UNLOCK_PEAK));
}
