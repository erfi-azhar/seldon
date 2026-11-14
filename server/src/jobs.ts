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
  /** Asked to run while already running (settings changed mid-run): run once more after. */
  private readonly again = new Set<string>();
  /** How long a run may take before it is given up on. */
  timeoutMs = 5 * 60_000;
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
        if (!rec.enabled || this.running.has(job.id)) return;
        const last = rec.lastRunAt ? Date.parse(rec.lastRunAt) : 0;
        if (now - last >= job.everyMs) await this.runNow(job.id).catch(() => undefined);
      }),
    );
  }

  /**
   * Run one job immediately. Resolves when it finishes; rejects with its error. If it is already
   * running, it runs again once that run ends, so a change made meanwhile is not left unchecked.
   */
  async runNow(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No job called ${id}`);
    if (this.running.has(id)) {
      this.again.add(id);
      return;
    }
    this.running.add(id);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    // Jobs are asked to stop on abort, but one stuck where it cannot hear that must not hold the
    // job as running for good.
    const gaveUp = new Promise<never>((_, reject) =>
      abort.signal.addEventListener('abort', () => reject(new Error(`Stopped after ${Math.round(this.timeoutMs / 60_000) || 1} min without finishing.`)), { once: true }),
    );
    try {
      await Promise.race([job.run(this.store.as('agent'), abort.signal), gaveUp]);
      markRun(this.store, id, null);
    } catch (err) {
      markRun(this.store, id, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearTimeout(timeout);
      this.running.delete(id);
      if (this.again.delete(id)) void this.runNow(id).catch(() => undefined);
    }
  }
}
