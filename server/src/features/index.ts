// Every feature is imported here, then mounted onto the app.

import type { Hono } from 'hono';
import { NotFound } from '../store.ts';
import type { IntegrationStatus } from '../../../shared/types.ts';
import { integrationStatus } from './integrations.ts';
import { features, type FeatureContext } from './registry.ts';
import './signals.ts';
import './gmail.ts';
import './faith.ts';
import './capture.ts';
import './health.ts';
import './mcp.ts';
import './gravl.ts';
import './travel.ts';
import './calendar.ts';
import './google-calendar.ts';
import './job-alerts.ts';
import './followups.ts';
import './weather.ts';
import './finance.ts';

/** Mount every feature's routes and register its jobs. */
export function installFeatures(app: Hono, ctx: FeatureContext): void {
  for (const f of features()) {
    f.routes?.(app, ctx);
    for (const job of f.jobs ?? []) ctx.scheduler.register(job);
  }
  app.get('/api/integrations', (c) => {
    const list: IntegrationStatus[] = features().filter((f) => f.integration).map((f) =>
      integrationStatus(ctx.store, f.id, ctx.scheduler.isRunning(f.id), f.integration!.configured),
    );
    return c.json(list);
  });
  app.post('/api/integrations/:id/run', async (c) => {
    const id = c.req.param('id');
    if (!features().some((f) => f.id === id && f.jobs?.length)) throw new NotFound('Integration');
    await ctx.scheduler.runNow(id);
    return c.json(integrationStatus(ctx.store, id, false, features().find((f) => f.id === id)!.integration?.configured ?? (() => true)));
  });
}
