import { EventEmitter } from 'events';
import type { QueueJob, DeadLetterOptions } from '../types/queue.js';

const DEFAULT_MAX_AGE = 86_400_000; // 24h

/**
 * Stores jobs that have exhausted all retries.
 * Emits a `dead` event for each job added.
 * Old entries are garbage-collected after `maxAge` (default 24h).
 */
export class DeadLetterQueue extends EventEmitter {
  private jobs: Map<string, QueueJob> = new Map();
  private readonly options: Required<DeadLetterOptions>;

  constructor(opts: DeadLetterOptions = {}) {
    super();
    this.options = {
      enabled: opts.enabled ?? true,
      persist: opts.persist ?? (() => Promise.resolve()),
      maxAge: opts.maxAge ?? DEFAULT_MAX_AGE,
    };
  }

  /** Mark `job` as dead, store it, emit `dead`, and invoke the persist callback. */
  async add(job: QueueJob): Promise<void> {
    if (!this.options.enabled) return;

    job.status = 'dead';
    this.jobs.set(job.id, job);

    this.emit('dead', job, job.errors);

    // Expire old jobs
    this.gc();

    try {
      await this.options.persist(job);
    } catch {
      // Persist failures must not break the queue
    }
  }

  /** All dead jobs in insertion order. */
  getAll(): QueueJob[] {
    return [...this.jobs.values()];
  }

  /** Look up a dead job by its ID. */
  get(id: string): QueueJob | undefined {
    return this.jobs.get(id);
  }

  /** Remove a single dead job. Returns `true` if it existed. */
  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  /** Remove all dead jobs. */
  clear(): void {
    this.jobs.clear();
  }

  /** Number of dead jobs currently held. */
  get size(): number {
    return this.jobs.size;
  }

  private gc(): void {
    const cutoff = Date.now() - this.options.maxAge;
    for (const [id, job] of this.jobs) {
      if (job.createdAt.getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}
