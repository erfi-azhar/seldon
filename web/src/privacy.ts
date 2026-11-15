// Hide amounts: one switch, remembered on this device, that masks money across the Finances
// sphere (and the crypto card on Today). For a glance at the app in public or on a shared screen.

import { useSyncExternalStore } from 'react';

const KEY = 'terminus:hide-amounts';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let hidden = read();

export const amountsHidden = (): boolean => hidden;

export function setAmountsHidden(next: boolean): void {
  hidden = next;
  try {
    if (next) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode or blocked storage: it still holds for this visit.
  }
  for (const l of listeners) l();
}

/** Whether amounts are hidden, and a way to flip it. Components that call it redraw on a flip. */
export function useAmountsHidden(): [boolean, () => void] {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => hidden,
    () => false,
  );
  return [value, () => setAmountsHidden(!hidden)];
}

/** The same mask for every amount, so its length gives nothing away. */
export const MASK = '•••••';

/**
 * Mask the digits of a formatted amount, keeping its sign and currency: "SGD 276,838" → "SGD •••••".
 * A compact amount's K, M or B goes too, since it would give the size away.
 */
export const maskAmount = (formatted: string): string => formatted.replace(/(?:\d[\d.,\s\u00a0\u202f]*\d|\d)[KMBT]?/g, MASK);

/** Mask amounts inside a sentence (the plan's reasons, written by the server): "SGD 4,219", "S$24", "$1,351". */
export const maskAmountsIn = (text: string): string =>
  text.replace(/((?:[A-Z]{2,3}|S\$|US\$|\$)[\s\u00a0]?[+\u2212-]?)\d[\d,]*(?:\.\d+)?/g, `$1${MASK}`);
