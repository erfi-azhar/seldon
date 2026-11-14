// The interactive demo: the real welcome-stage engine, with a mock of the screens around it.
import { mountVault, playUnlock, setVaultAnchor, setVaultScene, type VaultScene } from '../../web/src/components/Vault.tsx';

type Step = 'signin' | 'names' | 'spheres';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let step: Step = 'signin';
let busy = false;

function show(next: Step) {
  step = next;
  for (const el of document.querySelectorAll<HTMLElement>('[data-step]')) el.hidden = el.dataset.step !== next;
  const anchor = document.querySelector<HTMLElement>(`[data-step="${next}"] .anchor`);
  setVaultAnchor(anchor);
  const scene: VaultScene = next === 'signin' ? 'hover' : next === 'names' ? 'open' : 'figure';
  setVaultScene(scene);
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

// Theme: follow the device, or pick one here.
const root = document.documentElement;
function theme(t: 'system' | 'dark' | 'light') {
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-pick]')) b.setAttribute('aria-pressed', String(b.dataset.themePick === t));
  try {
    localStorage.setItem('vault-theme', t);
  } catch {
    /* fine without */
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-pick]')) b.addEventListener('click', () => theme(b.dataset.themePick as 'system' | 'dark' | 'light'));
let saved: string | null = null;
try {
  saved = localStorage.getItem('vault-theme');
} catch {
  /* fine without */
}
theme(saved === 'dark' || saved === 'light' ? saved : 'system');

$('#panel-toggle').addEventListener('click', () => {
  const panel = $('#panel');
  const open = panel.dataset.open !== 'true';
  panel.dataset.open = String(open);
  $('#panel-toggle').setAttribute('aria-expanded', String(open));
});
