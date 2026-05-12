import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { RetryPolicy } from './RetryPolicy.js';
import { DeadLetterQueue } from './DeadLetterQueue.js';
import { JobController } from './JobController.js';
import type { QueueJob, QueueOptions, QueueStats, JobPriority, EnqueueOptions } from '../types/queue.js';
import type { EmailOptions, SendResult } from '../types/core.js';
import type { Logger } from '../logger/Logger.js';
import { MailTsError } from '../errors.js';

type SendFn = (options: EmailOptions, signal?: AbortSignal) => Promise<SendResult>;

const PRIORITY_ORDER: JobPriority[] = ['critical', 'high', 'normal', 'low'];

/**
 * Concurrent, retry-aware email send queue backed by a `DeadLetterQueue`.
 *
 * Priority scheduling: jobs enqueued with `'critical'` are picked before `'high'`,
 * `'high'` before `'normal'`, and `'normal'` before `'low'`.
 *
 * Events: `enqueued`, `started`, `success`, `retry`, `dead`, `drained`,
 *         `cancelled`, `interrupted`.
 *
 * @example
 * ```ts
 * const q = mail.queue;
 * q.on('dead', (job, errors) => console.error('Permanently failed', job.id));
 * q.enqueue({ to: 'user@example.com', subject: 'Hi', text: 'Hello!' });
 * q.enqueue({ to: 'vip@example.com',  subject: 'VIP', text: 'Hi VIP!' }, { priority: 'critical' });
 * await q.drain();
 * ```
 */
export class MailQueue extends EventEmitter {
  // Four FIFO buckets — drained critical → high → normal → low
  private readonly pending: Map<JobPriority, QueueJob[]> = new Map([
    ['critical', []],
    ['high',     []],
    ['normal',   []],
    ['low',      []],
  ]);

  private running = 0;
  private succeeded = 0;
  private cancelledCount = 0;
  private readonly policy: RetryPolicy;
  readonly dlq: DeadLetterQueue;
  private readonly concurrency: number;
  private readonly jobTimeout: number;
  private readonly defaultPriority: JobPriority;
  private sendFn: SendFn | null = null;
  private readonly logger: Logger | null;
  private drainResolvers: Array<() => void> = [];
  private concurrencyOverride: number | null = null;

  // Map of jobId → JobController for all currently running jobs
  private readonly controllers = new Map<string, JobController>();

  constructor(opts: QueueOptions = {}, logger?: Logger) {
    super();
    this.concurrency = opts.concurrency ?? 3;
    this.jobTimeout = opts.jobTimeout ?? 30_000;
    this.defaultPriority = opts.defaultPriority ?? 'normal';
    this.logger = logger ?? null;
    this.policy = new RetryPolicy({
      maxRetries: opts.maxRetries ?? 5,
      initialDelay: opts.retryDelay ?? 1_000,
      backoff: opts.retryBackoff ?? 'exponential',
      jitter: opts.jitter ?? true,
    });
    this.dlq = new DeadLetterQueue(opts.deadLetter);

    this.dlq.on('dead', (job: QueueJob, errors: MailTsError[]) => {
      this.emit('dead', job, errors);
    });
  }

  /** Inject the send function — set by MailTs after construction. */
  setSendFn(fn: SendFn): void {
    this.sendFn = fn;
  }

  // ── Internal priority helpers ───────────────────────────────────────────────

  private nextPending(): QueueJob | undefined {
    for (const tier of PRIORITY_ORDER) {
      const arr = this.pending.get(tier)!;
      if (arr.length > 0) return arr.shift();
    }
    return undefined;
  }

  private pushPending(job: QueueJob): void {
    this.pending.get(job.priority)!.push(job);
  }

  private unshiftPending(job: QueueJob): void {
    this.pending.get(job.priority)!.unshift(job);
  }

  private get pendingCount(): number {
    let n = 0;
    for (const tier of PRIORITY_ORDER) n += this.pending.get(tier)!.length;
    return n;
  }

  private maybeResolveDrain(): void {
    if (this.running === 0 && this.pendingCount === 0) {
      this.emit('drained');
      for (const resolve of this.drainResolvers.splice(0)) resolve();
    }
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Add a message to the queue and start processing immediately.
   * @param options   - Email to send.
   * @param enqueueOpts - Optional scheduling options (e.g. `{ priority: 'high' }`).
   * @returns The created `QueueJob` — use `job.id` to track it via events.
   */
  enqueue(options: EmailOptions, enqueueOpts?: EnqueueOptions): QueueJob {
    const job: QueueJob = {
      id: randomBytes(8).toString('hex'),
      options,
      attempts: 0,
      errors: [],
      createdAt: new Date(),
      lastAttemptAt: null,
      status: 'pending',
      priority: enqueueOpts?.priority ?? this.defaultPriority,
    };
    this.pushPending(job);
    this.emit('enqueued', job);
    this.logger?.debug('queue', `Enqueued job ${job.id} (priority: ${job.priority})`);
    this.tick();
    return job;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  private tick(): void {
    while (this.running < this.effectiveConcurrency) {
      const job = this.nextPending();
      if (!job) break;
      this.running++;
      this.execute(job).finally(() => {
        this.running--;
        this.tick();
        this.maybeResolveDrain();
      });
    }
  }

  private async execute(job: QueueJob): Promise<void> {
    if (!this.sendFn) {
      this.logger?.error('queue', 'No send function configured on queue');
      return;
    }

    const ctrl = new JobController();
    this.controllers.set(job.id, ctrl);

    job.status = 'running';
    this.emit('started', job);

    try {
      while (true) {
        job.attempts++;
        job.lastAttemptAt = new Date();

        this.logger?.debug('queue', `Job ${job.id}: attempt ${job.attempts} (priority: ${job.priority})`);

        let sendResult: SendResult | undefined;
        let sendErr: MailTsError | null = null;

        try {
          sendResult = await this.sendWithTimeout(job.id, job.options, ctrl.signal);
        } catch (raw) {
          // Controlled stop (cancel / interrupt) — exit the loop
          if (ctrl.reason === 'cancel' || ctrl.reason === 'interrupt') break;

          if (ctrl.reason === 'abort') {
            // Count as a failed attempt; re-enqueue so the next run gets a fresh JobController.
            // (ctrl.signal is permanently aborted — cannot be reused for retry iterations.)
            const abortErr = new MailTsError('Job aborted by caller', 'EQUEUE', true);
            job.errors.push(abortErr);
            if (!this.policy.shouldRetry(job.attempts, abortErr)) {
              await this.dlq.add(job);
              this.logger?.error('queue', `Job ${job.id}: aborted and moved to DLQ`);
              return;
            }
            const delay = this.policy.delayFor(job.attempts - 1);
            this.emit('retry', job, job.attempts, delay);
            this.logger?.warn('queue', `Job ${job.id}: aborted — retrying in ${delay}ms`);
            await this.policy.wait(job.attempts - 1); // no signal — fresh attempt needs a clean slate
            job.status = 'pending';
            this.pushPending(job);  // back of the priority bucket — normal retry ordering
            return;                 // finally runs → running--, tick() re-starts with fresh controller
          }

          sendErr = raw instanceof MailTsError
            ? raw
            : new MailTsError(String(raw), 'EQUEUE', true);
        }

        if (sendResult !== undefined) {
          // Controlled stop that raced with a successful send
          if (ctrl.reason === 'cancel') break;
          if (ctrl.reason === 'interrupt') break; // decrement handled after the loop

          if (sendResult.ok) {
            job.status = 'success';
            this.succeeded++;
            this.emit('success', job, sendResult);
            this.logger?.info('queue', `Job ${job.id}: succeeded (messageId: ${sendResult.messageId})`);
            return;
          }
          sendErr = sendResult.error;
        }

        if (sendErr) {
          job.errors.push(sendErr);
          if (!this.policy.shouldRetry(job.attempts, sendErr)) {
            await this.dlq.add(job);
            this.logger?.error('queue', `Job ${job.id}: moved to DLQ after ${job.attempts} attempts`);
            return;
          }
          const delay = this.policy.delayFor(job.attempts - 1);
          this.emit('retry', job, job.attempts, delay);
          this.logger?.warn('queue', `Job ${job.id}: retrying in ${delay}ms (attempt ${job.attempts})`);
          await this.policy.wait(job.attempts - 1, ctrl.signal);
        }
      }
    } finally {
      this.controllers.delete(job.id);
    }

    // Reached here via break (cancel or interrupt)
    if (ctrl.reason === 'cancel') {
      job.status = 'cancelled';
      job.cancelledAt = new Date();
      this.cancelledCount++;
      this.emit('cancelled', job);
      this.logger?.info('queue', `Job ${job.id}: cancelled`);
    } else if (ctrl.reason === 'interrupt') {
      job.attempts--; // undo — this attempt did not complete
      job.status = 'pending';
      this.unshiftPending(job);
      this.emit('interrupted', job);
      this.logger?.info('queue', `Job ${job.id}: interrupted — requeued at front of ${job.priority} bucket`);
    }
  }

  private sendWithTimeout(jobId: string, options: EmailOptions, signal: AbortSignal): Promise<SendResult> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }

      const timer = setTimeout(() => {
        reject(new MailTsError(`Job ${jobId} timed out after ${this.jobTimeout}ms`, 'ECONN', true));
      }, this.jobTimeout);

      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      this.sendFn!(options, signal).then(
        result => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(result); },
        err    => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(err); },
      );
    });
  }

  // ── Lifecycle controls ─────────────────────────────────────────────────────

  /** Resume processing after a `pause()`. Alias: `play()`. */
  resume(): void {
    this.concurrencyOverride = null;
    this.tick();
  }

  /** Resume processing — alias for `resume()`. */
  play(): void { this.resume(); }

  /** Pause processing — in-flight jobs finish but no new jobs start. */
  pause(): void {
    this.concurrencyOverride = 0;
  }

  /**
   * Cancel a job by ID.
   * - If the job is **pending**, it is removed immediately.
   * - If the job is **running**, a cancel signal is sent; the job stops after
   *   its current send attempt completes (usually < 1 s).
   * @returns `true` if the job was found and cancelled.
   */
  cancel(jobId: string): boolean {
    // Check pending buckets first
    for (const tier of PRIORITY_ORDER) {
      const arr = this.pending.get(tier)!;
      const idx = arr.findIndex(j => j.id === jobId);
      if (idx !== -1) {
        const [job] = arr.splice(idx, 1) as [QueueJob];
        job.status = 'cancelled';
        job.cancelledAt = new Date();
        this.cancelledCount++;
        this.emit('cancelled', job);
        this.logger?.info('queue', `Job ${job.id}: cancelled (was pending)`);
        this.maybeResolveDrain();
        return true;
      }
    }
    // Check running jobs
    const ctrl = this.controllers.get(jobId);
    if (ctrl) { ctrl.cancel(); return true; }
    return false;
  }

  /**
   * Cancel all pending (not yet started) jobs.
   * Running jobs are not affected.
   * @returns Number of jobs cancelled.
   */
  cancelAll(): number {
    let count = 0;
    for (const tier of PRIORITY_ORDER) {
      const arr = this.pending.get(tier)!;
      for (const job of arr) {
        job.status = 'cancelled';
        job.cancelledAt = new Date();
        this.cancelledCount++;
        this.emit('cancelled', job);
      }
      count += arr.length;
      arr.length = 0;
    }
    this.maybeResolveDrain();
    return count;
  }

  /**
   * Interrupt a running job — the current send attempt is aborted and the job
   * is returned to the **front** of its priority bucket without incrementing
   * the attempt counter.
   * @returns `true` if the job was found and interrupted.
   */
  interrupt(jobId: string): boolean {
    const ctrl = this.controllers.get(jobId);
    if (!ctrl) return false;
    ctrl.interrupt();
    return true;
  }

  /**
   * Interrupt all running jobs, returning them to the front of their
   * respective priority buckets.
   * @returns Number of jobs interrupted.
   */
  interruptAll(): number {
    let count = 0;
    for (const ctrl of this.controllers.values()) { ctrl.interrupt(); count++; }
    return count;
  }

  /**
   * Abort a running job — counts as a failed attempt.
   * Retry policy and DLQ apply normally.
   * @returns `true` if the job was found and aborted.
   */
  abort(jobId: string): boolean {
    const ctrl = this.controllers.get(jobId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** Abort all running jobs (retry policy and DLQ apply to each). */
  abortAll(): void {
    for (const ctrl of this.controllers.values()) ctrl.abort();
  }

  /**
   * Gracefully shut down the queue:
   * 1. `pause()` — no new jobs start.
   * 2. `cancelAll()` — pending jobs are cancelled.
   * 3. Wait for running jobs to finish.
   * 4. If `timeoutMs` is provided and exceeded, abort all remaining running jobs.
   */
  async shutdown(timeoutMs?: number): Promise<void> {
    this.pause();
    this.cancelAll();

    if (this.running === 0) return;

    if (timeoutMs === undefined) {
      await this.drain();
      return;
    }

    const drained = await Promise.race([
      this.drain().then(() => true as const),
      new Promise<false>(r => setTimeout(() => r(false), timeoutMs)),
    ]);

    if (!drained) {
      this.abortAll();
      await this.drain();
    }
  }

  // ── Drain & stats ──────────────────────────────────────────────────────────

  /** Resolves when all pending and running jobs have completed (or moved to DLQ). */
  drain(): Promise<void> {
    if (this.running === 0 && this.pendingCount === 0) return Promise.resolve();
    return new Promise(resolve => {
      this.drainResolvers.push(resolve);
    });
  }

  /** Current queue statistics snapshot. */
  stats(): QueueStats {
    return {
      pending:   this.pendingCount,
      running:   this.running,
      succeeded: this.succeeded,
      dead:      this.dlq.size,
      cancelled: this.cancelledCount,
    };
  }

  private get effectiveConcurrency(): number {
    return this.concurrencyOverride ?? this.concurrency;
  }
}
