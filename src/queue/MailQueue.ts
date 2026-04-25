import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { RetryPolicy } from './RetryPolicy.js';
import { DeadLetterQueue } from './DeadLetterQueue.js';
import type { QueueJob, QueueOptions, QueueStats } from '../types/queue.js';
import type { EmailOptions, SendResult } from '../types/core.js';
import type { Logger } from '../logger/Logger.js';
import { MailTsError } from '../errors.js';

type SendFn = (options: EmailOptions) => Promise<SendResult>;

/**
 * Concurrent, retry-aware email send queue backed by a `DeadLetterQueue`.
 *
 * Events: `enqueued`, `started`, `success`, `retry`, `dead`, `drained`.
 *
 * @example
 * ```ts
 * const q = mail.queue;
 * q.on('dead', (job, errors) => console.error('Permanently failed', job.id));
 * q.enqueue({ to: 'user@example.com', subject: 'Hi', text: 'Hello!' });
 * await q.drain();
 * ```
 */
export class MailQueue extends EventEmitter {
  private pending: QueueJob[] = [];
  private running = 0;
  private succeeded = 0;
  private policy: RetryPolicy;
  readonly dlq: DeadLetterQueue;
  private readonly concurrency: number;
  private readonly jobTimeout: number;
  private sendFn: SendFn | null = null;
  private readonly logger: Logger | null;
  private drainResolvers: Array<() => void> = [];

  constructor(opts: QueueOptions = {}, logger?: Logger) {
    super();
    this.concurrency = opts.concurrency ?? 3;
    this.jobTimeout = opts.jobTimeout ?? 30_000;
    this.logger = logger ?? null;
    this.policy = new RetryPolicy({
      maxRetries: opts.maxRetries ?? 5,
      initialDelay: opts.retryDelay ?? 1_000,
      backoff: opts.retryBackoff ?? 'exponential',
      jitter: opts.jitter ?? true,
    });
    this.dlq = new DeadLetterQueue(opts.deadLetter);

    // Propagate DLQ dead events
    this.dlq.on('dead', (job: QueueJob, errors: MailTsError[]) => {
      this.emit('dead', job, errors);
    });
  }

  /** Inject the send function — set by MailTs after construction. */
  setSendFn(fn: SendFn): void {
    this.sendFn = fn;
  }

  /**
   * Add a message to the queue and start processing immediately.
   * @returns The created `QueueJob` — use `job.id` to track it via events.
   */
  enqueue(options: EmailOptions): QueueJob {
    const job: QueueJob = {
      id: randomBytes(8).toString('hex'),
      options,
      attempts: 0,
      errors: [],
      createdAt: new Date(),
      lastAttemptAt: null,
      status: 'pending',
    };
    this.pending.push(job);
    this.emit('enqueued', job);
    this.logger?.debug('queue', `Enqueued job ${job.id}`);
    this.tick();
    return job;
  }

  private tick(): void {
    while (this.running < this.effectiveConcurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.running++;
      this.execute(job).finally(() => {
        this.running--;
        this.tick();
        if (this.running === 0 && this.pending.length === 0) {
          this.emit('drained');
          for (const resolve of this.drainResolvers.splice(0)) resolve();
        }
      });
    }
  }

  private async execute(job: QueueJob): Promise<void> {
    if (!this.sendFn) {
      this.logger?.error('queue', 'No send function configured on queue');
      return;
    }

    job.status = 'running';
    this.emit('started', job);

    while (true) {
      try {
        job.attempts++;
        job.lastAttemptAt = new Date();

        this.logger?.debug('queue', `Job ${job.id}: attempt ${job.attempts}`);
        const result = await this.sendWithTimeout(job.id, job.options);

        if (result.ok) {
          job.status = 'success';
          this.succeeded++;
          this.emit('success', job, result);
          this.logger?.info('queue', `Job ${job.id}: succeeded (messageId: ${result.messageId})`);
          return;
        }

        // result.ok === false
        const err = result.error;
        job.errors.push(err);

        if (!this.policy.shouldRetry(job.attempts, err)) {
          await this.dlq.add(job);
          this.logger?.error('queue', `Job ${job.id}: moved to DLQ after ${job.attempts} attempts`);
          return;
        }

        const delay = this.policy.delayFor(job.attempts - 1);
        this.emit('retry', job, job.attempts, delay);
        this.logger?.warn('queue', `Job ${job.id}: retrying in ${delay}ms (attempt ${job.attempts})`);
        await this.policy.wait(job.attempts - 1);
      } catch (raw) {
        const err = raw instanceof MailTsError
          ? raw
          : new MailTsError(String(raw), 'EQUEUE', true);

        job.errors.push(err);

        if (!this.policy.shouldRetry(job.attempts, err)) {
          await this.dlq.add(job);
          this.logger?.error('queue', `Job ${job.id}: moved to DLQ — ${err.message}`);
          return;
        }

        const delay = this.policy.delayFor(job.attempts - 1);
        this.emit('retry', job, job.attempts, delay);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private sendWithTimeout(jobId: string, options: EmailOptions): Promise<SendResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new MailTsError(`Job ${jobId} timed out after ${this.jobTimeout}ms`, 'ECONN', true));
      }, this.jobTimeout);
      this.sendFn!(options).then(
        result => { clearTimeout(timer); resolve(result); },
        err    => { clearTimeout(timer); reject(err); },
      );
    });
  }

  /** Resolves when all pending and running jobs have completed (or moved to DLQ). */
  drain(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise(resolve => {
      this.drainResolvers.push(resolve);
    });
  }

  /** Current queue statistics snapshot. */
  stats(): QueueStats {
    return {
      pending: this.pending.length,
      running: this.running,
      succeeded: this.succeeded,
      dead: this.dlq.size,
    };
  }

  /** Pause processing — in-flight jobs finish but no new jobs are started. */
  pause(): void {
    this.concurrencyOverride = 0;
  }

  /** Resume processing after a `pause()`. */
  resume(): void {
    this.concurrencyOverride = null;
    this.tick();
  }

  private concurrencyOverride: number | null = null;

  private get effectiveConcurrency(): number {
    return this.concurrencyOverride ?? this.concurrency;
  }
}
