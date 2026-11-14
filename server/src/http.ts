// Small helpers shared by the core API and feature routes.

import type { Context } from 'hono';
import { z } from 'zod';
import { Invalid, localDate } from './store.ts';

/** Parse and validate a JSON body; a bad body becomes a 400 with the reason. */
export async function read<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const json: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Invalid(z.prettifyError(parsed.error));
  return parsed.data;
}

/** The client's local date from ?date=, else the server's. */
export const today = (c: Context): string => {
  const d = c.req.query('date');
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : localDate();
};
