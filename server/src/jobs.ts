// A small scheduler for background work: check mail, look for new job openings,
// sync apps. One job of each kind runs at a time; failures are recorded on the
// integration and retried on the next tick.

import { getIntegration, markRun } from './features/integrations.ts';
import type { Store } from './store.ts';

export interface Job {
  /** The integration id this job belongs to; it only runs while that is enabled. */
  id: string;
  everyMs: number;
  run: (store: Store, signal: AbortSignal) => Promise<void>;
}

export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  register(job: Job): void {
    this.jobs.set(job.id, job);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.jobs.values()].map(async (job) => {
        const rec = getIntegration(this.store, job.id);
        if (!rec.enabled) return;
        const last = rec.lastRunAt ? Date.parse(rec.lastRunAt) : 0;
        if (now - last >= job.everyMs) await this.runNow(job.id).catch(() => undefined);
      }),
    );
  }

  /** Run one job immediately. Resolves when it finishes; rejects with its error. */
  async runNow(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No job called ${id}`);
    if (this.running.has(id)) return;
    this.running.add(id);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5 * 60_000);
    try {
      await job.run(this.store.as('agent'), abort.signal);
      markRun(this.store, id, null);
    } catch (err) {
      markRun(this.store, id, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearTimeout(timeout);
      this.running.delete(id);
    }
  }
}
