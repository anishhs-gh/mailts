import type { RetryPolicyOptions } from '../types/queue.js';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 60_000;

/**
 * Determines whether a failed job should be retried and how long to wait.
 *
 * `maxRetries: N` means N retry attempts after the initial send, so a job can
 * be attempted at most N+1 times total.
 */
export class RetryPolicy {
  readonly maxRetries: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
  readonly backoff: 'linear' | 'exponential' | 'fixed';
  readonly jitter: boolean;

  constructor(opts: RetryPolicyOptions = {}) {
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialDelay = opts.initialDelay ?? DEFAULT_INITIAL_DELAY;
    this.maxDelay = opts.maxDelay ?? DEFAULT_MAX_DELAY;
    this.backoff = opts.backoff ?? 'exponential';
    this.jitter = opts.jitter ?? true;
  }

  /**
   * Returns `true` when the job should be retried.
   * @param attempts - Total attempts so far (1 = initial attempt just failed).
   * @param err - The error that caused the failure.
   */
  shouldRetry(attempts: number, err: Error): boolean {
    if (attempts > this.maxRetries) return false;

    // Non-retryable errors from our error hierarchy
    if ('retryable' in err && (err as { retryable: boolean }).retryable === false) {
      return false;
    }

    return true;
  }

  /**
   * Returns the delay in milliseconds before the next attempt.
   * @param attempt - Zero-based retry index (0 = first retry delay).
   */
  delayFor(attempt: number): number {
    let delay: number;

    switch (this.backoff) {
      case 'exponential':
        delay = Math.min(this.initialDelay * Math.pow(2, attempt), this.maxDelay);
        break;
      case 'linear':
        delay = Math.min(this.initialDelay * (attempt + 1), this.maxDelay);
        break;
      case 'fixed':
        delay = this.initialDelay;
        break;
    }

    if (this.jitter) {
      // ±30% randomisation
      const jitterRange = delay * 0.3;
      delay = delay - jitterRange + Math.random() * jitterRange * 2;
    }

    return Math.floor(delay);
  }

  /** Resolves after the computed delay for `attempt`. */
  async wait(attempt: number): Promise<void> {
    const ms = this.delayFor(attempt);
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
