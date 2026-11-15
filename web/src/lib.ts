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
/** The Monday that starts the calendar week holding this date. */
export function weekMonday(date: string): string {
  return addDays(date, -((parseDay(date).getDay() + 6) % 7));
}

/** ISO 8601 week number (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date: string): number {
  const thursday = parseDay(addDays(weekMonday(date), 3));
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1.getTime()) / 86_400_000 / 7) + 1;
}

/** "Nov 9–15", or across months "Nov 30 – Dec 6": the Monday-to-Sunday week holding a date. */
export function weekRange(date: string): string {
  const a = parseDay(weekMonday(date));
  const b = parseDay(addDays(weekMonday(date), 6));
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  return a.getMonth() === b.getMonth() ? `${month(a)} ${a.getDate()}–${b.getDate()}` : `${month(a)} ${a.getDate()} – ${month(b)} ${b.getDate()}`;
}

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

// This browser's decimal separator.
const DECIMAL = (1.5).toLocaleString().replace(/\d/g, '') || '.';

/**
 * A number as typed, in either convention: "78,4" and "78.4" are both 78.4, "1,234.5"
 * and "1.234,5" are both 1234.5. A lone separator followed by exactly three digits is
 * read the way this browser's locale writes numbers. NaN when it is not a number.
 */
export function parseNumber(raw: string): number {
  const s = raw.trim().replace(/[\s\u00a0\u202f']/g, '');
  if (!/^[-+]?[\d.,]*\d[\d.,]*$/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimal: string | null;
  if (lastComma >= 0 && lastDot >= 0) decimal = lastComma > lastDot ? ',' : '.';
  else if (lastComma < 0 && lastDot < 0) decimal = null;
  else {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    // Repeated, it can only be grouping; once, it is grouping only when three digits follow.
    decimal = parts.length > 2 || (sep !== DECIMAL && parts[1]!.length === 3) ? null : sep;
  }
  const [int, frac, extra] = decimal ? s.split(decimal) : [s];
  if (extra !== undefined) return NaN;
  // Anything left is grouping, and groups are three digits.
  const groups = int!.split(/[.,]/);
  if (groups.slice(1).some((g) => g.length !== 3)) return NaN;
  return Number(frac === undefined ? groups.join('') : `${groups.join('')}.${frac}`);
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
