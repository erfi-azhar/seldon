// The shape the Screenings page can draw (shared/types.ts → Screenings). Anything else is
// refused with the field named, rather than saved and left as a blank page.

import { z } from 'zod';

const s = (max = 2000) => z.string().max(max);
const status = z.enum(['ok', 'watch', 'flag', 'na']);
const trend = z.enum(['better', 'worse', 'same', 'new', 'na']);
const num = z.number().finite();
/** Readings are shown as written; a bare number is accepted and kept as text. */
const reading = z.union([z.string().max(60), num.transform(String)]).nullable();
const pair = z.tuple([s(400), s(4000)]);

export const screeningsSchema = z.object({
  title: s(200),
  subtitle: s(400).optional(),
  updated: s(60).optional(),
  visits: z.array(z.object({ label: s(80), date: s(40).optional(), place: s(200).optional() })).min(1).max(2),
  next: s(400).optional(),
  ringNotes: z.object({ watch: s(400).optional(), flag: s(400).optional() }).optional(),
  summary: z.array(s()).max(40).optional(),
  tiles: z
    .array(z.object({ lab: s(80), a: num, b: num, val: s(40), u: s(20), v: z.enum(['better', 'worse', 'watch']), dir: z.enum(['up', 'down']), st: status, stt: s(80), sub: s(200) }))
    .max(24)
    .optional(),
  actions: z.array(z.object({ p: z.enum(['high', 'medium', 'low']), t: s(200), body: s(), also: s().optional(), src: s(400).optional() })).max(40).optional(),
  moved: z.array(z.object({ h: s(200), s: status, items: z.array(z.tuple([s(200), s(200), s(400)])).max(60) })).max(10).optional(),
  slopes: z
    .array(
      z.object({
        n: s(120),
        u: s(20),
        a: num,
        b: num,
        dp: z.number().int().min(0).max(6),
        d: z.tuple([num, num]),
        band: z.tuple([num, num]),
        rng: s(80),
        st: status,
        stt: s(80),
        note: s(400).optional(),
        ref: num.optional(),
        refl: s(80).optional(),
      }),
    )
    .max(40)
    .optional(),
  scans: z
    .array(
      z.object({
        t: s(200),
        tags: z.array(s(60)).max(12),
        s: status,
        lbl: s(80),
        compare: z.tuple([s(), s()]).optional(),
        bars: z.array(z.object({ name: s(80), a: num, b: num })).max(20).optional(),
        barNote: s(400).optional(),
        facts: z.array(pair).max(30).optional(),
        read: s().optional(),
      }),
    )
    .max(20)
    .optional(),
  risks: z.array(z.object({ n: s(120), h: s(400), now: num, avg: num, tgt: num, mult: num })).max(20).optional(),
  riskNote: s().optional(),
  results: z
    .array(
      z.object({
        g: s(120),
        n: s(160),
        sub: s(200).optional(),
        u: s(30).optional(),
        a: reading,
        b: reading,
        lo: num.optional(),
        hi: num.optional(),
        ref: s(120).optional(),
        s25: status.optional(),
        s: status.optional(),
        v: trend.optional(),
        chl: s(200).optional(),
        note: s().optional(),
      }),
    )
    .max(1000),
  notes: z.array(pair).max(60).optional(),
  footer: z.array(s()).max(20).optional(),
});
