import type { EmailOptions } from './core.js';
import type { MailTsError } from '../errors.js';

export type RetryBackoff = 'linear' | 'exponential' | 'fixed';

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
}

export interface QueueJob {
  readonly id: string;
  readonly options: EmailOptions;
  attempts: number;
  errors: MailTsError[];
  createdAt: Date;
  lastAttemptAt: Date | null;
  status: 'pending' | 'running' | 'success' | 'dead';
}

export interface QueueStats {
  pending: number;
  running: number;
  succeeded: number;
  dead: number;
}
