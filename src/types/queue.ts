import type { EmailOptions } from './core.js';
import type { MailTsError } from '../errors.js';

export type RetryBackoff = 'linear' | 'exponential' | 'fixed';

/** Scheduling priority for a queued job. Higher tiers are drained first. */
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

/** Options passed as the second argument to `queue.enqueue()`. */
export interface EnqueueOptions {
  /** Priority tier for this job. Falls back to `QueueOptions.defaultPriority` then `'normal'`. */
  priority?: JobPriority;
  /** Do not send before this time (scheduled send). */
  sendAt?: Date;
  /** Use this job id (e.g. an external queue message id). Must be unique. */
  id?: string;
}

/** What `shutdown()` does with jobs that have not started. */
export type ShutdownPendingMode = 'drain' | 'keep' | 'cancel';

export interface ShutdownOptions {
  /** Max time to wait for running jobs (and, with `drain`, for pending ones). */
  timeoutMs?: number;
  /** @default 'keep' for persistent queues, otherwise 'drain' */
  pending?: ShutdownPendingMode;
}

export interface ShutdownResult {
  /** Jobs cancelled by this shutdown. */
  cancelled: number;
  /** Jobs still pending or scheduled (kept for a persistent queue; lost for in-memory). */
  remaining: number;
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
  /** Max parallel send operations. @default 3 */
  concurrency?: number;
  /** Retries after the first attempt before a job moves to the DLQ (so up to N+1 attempts). @default 5 */
  maxRetries?: number;
  /** Base delay in milliseconds between retry attempts. @default 1_000 */
  retryDelay?: number;
  /** Upper bound for a single retry delay. @default 60_000 */
  maxRetryDelay?: number;
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
  status: 'pending' | 'scheduled' | 'running' | 'success' | 'dead' | 'cancelled';
  /** For `scheduled` jobs: not sent before this time (retry backoff or `sendAt`). */
  notBefore?: Date;
  /** Scheduling priority — higher tiers are picked first by the scheduler. */
  priority: JobPriority;
  /** Set when the job is cancelled (via `cancel()` or `cancelAll()`). */
  cancelledAt?: Date;
}

export interface QueueStats {
  pending: number;
  /** Jobs waiting for a retry delay or a `sendAt` time. */
  scheduled: number;
  running: number;
  succeeded: number;
  dead: number;
  /** Jobs removed via `cancel()` / `cancelAll()` since this queue instance started. */
  cancelled: number;
}
