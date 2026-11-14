// The feature registry. Feature modules import this and call registerFeature().

import type { Hono } from 'hono';
import { registerTools, type ToolDef } from '../agent/tools.ts';
import type { Job, Scheduler } from '../jobs.ts';
import { registerDataTable, type Store } from '../store.ts';
import type { SignalAction } from '../../../shared/types.ts';
import type { IntegrationRecord } from './integrations.ts';
import type { MailMessage, MailVerdict } from './mail-types.ts';

export interface FeatureContext {
  store: Store;
  scheduler: Scheduler;
}

export interface Feature {
  id: string;
  routes?: (app: Hono, ctx: FeatureContext) => void;
  jobs?: Job[];
  tools?: ToolDef[];
  /** When the feature is an integration: whether it has what it needs to run. */
  integration?: { configured: (rec: IntegrationRecord) => boolean };
  /** Carry out a suggested action of a given type (a reply becomes a Gmail draft). */
  actions?: Partial<Record<SignalAction['type'], (store: Store, action: SignalAction) => Promise<string>>>;
  /** Sees every new email after triage (travel picks out bookings, for example). */
  mail?: (store: Store, message: MailMessage, verdict: MailVerdict) => Promise<void>;
  /** Tables this feature owns that belong in exports. */
  tables?: string[];
}

const FEATURES: Feature[] = [];

export function registerFeature(f: Feature): void {
  if (FEATURES.some((x) => x.id === f.id)) return;
  FEATURES.push(f);
  if (f.tools) registerTools(f.tools);
  for (const t of f.tables ?? []) registerDataTable(t);
}

export function features(): readonly Feature[] {
  return FEATURES;
}

