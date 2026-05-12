import type { EmailOptions } from './core.js';
import type { MailTsError } from '../errors.js';

export type RetryBackoff = 'linear' | 'exponential' | 'fixed';

/** Scheduling priority for a queued job. Higher tiers are drained first. */
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

/** Options passed as the second argument to `queue.enqueue()`. */
export interface EnqueueOptions {
  /** Priority tier for this job. Falls back to `QueueOptions.defaultPriority` then `'normal'`. */
  priority?: JobPriority;
}

export interface RetryPolicyOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoff?: RetryBackoff;
  jitter?: boolean;
}

export interface DeadLetterOptions {
  enabled?: boolean;
  persist?: (job: QueueJob) => Promise<void>;
  maxAge?: number;
}

export interface QueueOptions {
  /** Max parallel send operations. @default 5 */
  concurrency?: number;
  /** Max delivery attempts per job before it moves to the DLQ. @default 3 */
  maxRetries?: number;
  /** Base delay in milliseconds between retry attempts. @default 1_000 */
  retryDelay?: number;
  /** Backoff strategy applied to `retryDelay`. @default 'exponential' */
  retryBackoff?: RetryBackoff;
  /** Add random jitter to retry delays to avoid thundering-herd. @default true */
  jitter?: boolean;
  /**
   * Milliseconds to wait for a single send attempt before treating it as a
   * transient failure and applying retry logic. @default 30_000
   */
  jobTimeout?: number;
  deadLetter?: DeadLetterOptions;
  /** Persist queue state to disk for cross-process visibility and crash recovery.
   *  Pass `true` for `~/.mailts/queue.db` (SQLite, Node 22+) or a custom file path. */
  persist?: string | boolean;
  /** Default priority for jobs enqueued without an explicit priority. @default 'normal' */
  defaultPriority?: JobPriority;
}

export interface QueueJob {
  readonly id: string;
  readonly options: EmailOptions;
  attempts: number;
  errors: MailTsError[];
  createdAt: Date;
  lastAttemptAt: Date | null;
  status: 'pending' | 'running' | 'success' | 'dead' | 'cancelled';
  /** Scheduling priority — higher tiers are picked first by the scheduler. */
  priority: JobPriority;
  /** Set when the job is cancelled (via `cancel()` or `cancelAll()`). */
  cancelledAt?: Date;
}

export interface QueueStats {
  pending: number;
  running: number;
  succeeded: number;
  dead: number;
  /** Jobs removed via `cancel()` / `cancelAll()` since this queue instance started. */
  cancelled: number;
}
