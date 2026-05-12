export type ControlReason = 'interrupt' | 'cancel' | 'abort';

/**
 * Reason-aware abort controller attached to each running job.
 * The `reason` is set before `signal` is aborted so `execute()` can
 * distinguish between interrupt (requeue), cancel (discard), and abort (fail).
 */
export class JobController {
  private readonly ac = new AbortController();
  reason: ControlReason | null = null;

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  private trigger(r: ControlReason): void {
    if (this.reason !== null) return;  // first caller wins
    this.reason = r;
    this.ac.abort();
  }

  /** Return this job to the front of its priority bucket; attempt counter is not incremented. */
  interrupt(): void { this.trigger('interrupt'); }

  /** Remove this job permanently — no retry, no DLQ. */
  cancel(): void { this.trigger('cancel'); }

  /** Count this attempt as a failure; retry policy and DLQ apply normally. */
  abort(): void { this.trigger('abort'); }
}
