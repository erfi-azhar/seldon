// The interactive demo: the real welcome-stage engine, with a mock of the screens around it.
import { mountVault, playUnlock, pulseVault, setVaultAnchor, setVaultScene, setVaultSun } from '../../web/src/components/Vault.tsx';
import type { Phase, SunState } from '../../web/src/sun.ts';

type Step = 'signin' | 'names' | 'spheres';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let step: Step = 'signin';
let busy = false;

function show(next: Step) {
  step = next;
  for (const el of document.querySelectorAll<HTMLElement>('[data-step]')) el.hidden = el.dataset.step !== next;
  const anchor = document.querySelector<HTMLElement>(`[data-step="${next}"] .anchor`);
  setVaultAnchor(anchor);
  // The traveller climbs: low on the slope for names, beside the shard on the last step.
  if (next === 'signin') setVaultScene('hover');
  else setVaultScene('open', next === 'names' ? 0 : 2);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-go]')) b.setAttribute('aria-pressed', String(b.dataset.go === next));
  const focus = document.querySelector<HTMLInputElement>(`[data-step="${next}"] input`);
  focus?.focus({ preventScroll: true });
}

async function unlock() {
  if (busy) return;
  busy = true;
  const form = $<HTMLFormElement>('#signin-form');
  form.classList.add('is-opening');
  await playUnlock();
  form.classList.remove('is-opening');
  busy = false;
  show('names');
}

mountVault();
show('signin');

$<HTMLInputElement>('#pass').addEventListener('input', () => pulseVault());
$<HTMLFormElement>('#signin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$<HTMLInputElement>('#pass').value.trim()) {
    $('#pass-hint').textContent = 'Type anything — this demo has no real passphrase.';
    return;
  }
  void unlock();
});
$<HTMLFormElement>('#names-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const you = $<HTMLInputElement>('#you').value.trim();
  const it = $<HTMLInputElement>('#agent').value.trim() || 'Seldon';
  $('#greet').textContent = you ? `${it} is here, ${you}.` : `${it} is here.`;
  show('spheres');
});
$('#back').addEventListener('click', () => show('names'));

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-go]')) {
  b.addEventListener('click', () => {
    if (busy) return;
    const go = b.dataset.go as Step | 'unlock';
    if (go === 'unlock') {
      if (step !== 'signin') location.reload();
      else {
        $<HTMLInputElement>('#pass').value = 'demo';
        void unlock();
      }
    } else show(go);
  });
}
$('#replay').addEventListener('click', () => location.reload());

// Time of day: each phase as it would look in Singapore, with the page's light or dark theme.
const SGT = 8 * 3600_000;
const AT: Record<Phase, [number, number]> = { dawn: [6, 40], day: [14, 10], dusk: [18, 50], evening: [23, 40] };
const root = document.documentElement;
function phase(p: Phase) {
  const d = new Date();
  const clock = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), AT[p][0], AT[p][1]) - SGT;
  const day = (h: number, m: number) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - SGT;
  const sun: SunState = {
    pref: 'sun',
    phase: p,
    blend: { from: p, to: p, t: 0 },
    place: { lat: 1.35, lng: 103.82 },
    source: 'saved',
    marks: { dawn: day(5, 34), day: day(7, 53), dusk: day(18, 12), evening: day(20, 9) },
  };
  setVaultSun(sun, clock);
  root.dataset.theme = p === 'dawn' || p === 'day' ? 'light' : 'dark';
  root.dataset.phase = p;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-phase-pick]')) b.setAttribute('aria-pressed', String(b.dataset.phasePick === p));
  try {
    localStorage.setItem('vault-phase', p);
  } catch {
    /* fine without */
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-phase-pick]')) b.addEventListener('click', () => phase(b.dataset.phasePick as Phase));
let saved: string | null = null;
try {
  saved = localStorage.getItem('vault-phase');
} catch {
  /* fine without */
}
phase(saved === 'dawn' || saved === 'day' || saved === 'evening' ? saved : 'dusk');

$('#panel-toggle').addEventListener('click', () => {
  const panel = $('#panel');
  const open = panel.dataset.open !== 'true';
  panel.dataset.open = String(open);
  $('#panel-toggle').setAttribute('aria-expanded', String(open));
});
