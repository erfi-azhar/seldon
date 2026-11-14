// Open tabs and the installed app keep running the code they loaded, so after a deploy they
// would carry on with the old version until someone reloads by hand. This notices a new
// version and reloads into it at a moment that can't cost anything: when you come back to
// the app, or when you move to another page — never while you are typing or a sheet is open.

import { useEffect, useRef } from 'react';

const EVERY_MS = 10 * 60_000;
const BUILD = /\/assets\/index-[\w-]+\.js/;

/** The built script this page is running, e.g. "/assets/index-Dt1MVNdQ.js". Absent in development. */
function runningBuild(): string | null {
  for (const s of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const m = new URL(s.src, location.href).pathname.match(BUILD);
    if (m) return m[0];
  }
  return null;
}

/** The built script the server would hand out now. Straight from the server (the service worker leaves this alone). */
async function servedBuild(): Promise<string | null> {
  try {
    const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'text/html' } });
    if (!res.ok) return null;
    return (await res.text()).match(BUILD)?.[0] ?? null;
  } catch {
    return null; // Offline or the server is restarting: try again later.
  }
}

/** Typing into a field or working in a sheet: a reload now would lose what's there. */
function busy(): boolean {
  const el = document.activeElement;
  const typing = el instanceof HTMLElement && (el.isContentEditable || (el.matches('input, textarea, select') && !(el as HTMLInputElement).readOnly));
  return typing || document.querySelector('[aria-modal="true"]') !== null;
}

let stale = false;

async function check(): Promise<boolean> {
  if (stale) return true;
  const running = runningBuild();
  if (!running) return false;
  const served = await servedBuild();
  stale = !!served && served !== running;
  return stale;
}

const reloadIfSafe = () => {
  if (stale && !busy()) location.reload();
};

/**
 * Reload into a new version when one is out: on coming back to the app if it can be done safely,
 * otherwise on the next move to another page. `location` is the router's, so a page change is seen.
 */
export function useNewVersionReload(location: string) {
  const first = useRef(true);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const onReturn = () => {
      if (document.visibilityState === 'visible') void check().then(reloadIfSafe);
    };
    const timer = window.setInterval(() => {
      // While it sits open in view, only find out; the reload waits for a quiet moment.
      if (document.visibilityState === 'visible') void check();
    }, EVERY_MS);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // A move to another page is the natural place to pick up the new version.
    reloadIfSafe();
  }, [location]);
}
