// Dates and formatting. All "days" are local calendar dates, YYYY-MM-DD.

import type { CSSProperties } from 'react';

export function todayStr(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD as a local date at noon, safe from DST edges. */
export function parseDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12);
}

export function addDays(date: string, n: number): string {
  const d = parseDay(date);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

export function daysFrom(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

export const weekdayLong = (date: string): string => parseDay(date).toLocaleDateString(undefined, { weekday: 'long' });
export const monthDay = (date: string): string => parseDay(date).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
export const shortDay = (date: string): string => parseDay(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "today", "tomorrow", "Fri", "Nov 28", "3d late". */
export function dueLabel(date: string, today: string): { text: string; late: boolean } {
  const diff = daysFrom(today, date);
  if (diff < 0) return { text: diff === -1 ? 'yesterday' : `${-diff}d late`, late: true };
  if (diff === 0) return { text: 'today', late: false };
  if (diff === 1) return { text: 'tomorrow', late: false };
  if (diff < 7) return { text: parseDay(date).toLocaleDateString(undefined, { weekday: 'short' }), late: false };
  return { text: shortDay(date), late: false };
}

/** "in 6 weeks", "in 3 days", "2 weeks ago". */
export function relativeDay(date: string, today: string): string {
  const diff = daysFrom(today, date);
  const abs = Math.abs(diff);
  if (diff === 0) return 'today';
  const unit = abs < 14 ? [abs, 'day'] : abs < 70 ? [Math.round(abs / 7), 'week'] : abs < 730 ? [Math.round(abs / 30.4), 'month'] : [Math.round(abs / 365), 'year'];
  const phrase = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return diff > 0 ? `in ${phrase}` : `${phrase} ago`;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86_400);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function greeting(d: Date = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 1 });
}

export const pct = (n: number): string => `${Math.round(n * 100)}%`;

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Inline style that hands a sphere's hue to CSS. */
export const hueStyle = (hue: number): CSSProperties => ({ '--h': hue }) as CSSProperties;
