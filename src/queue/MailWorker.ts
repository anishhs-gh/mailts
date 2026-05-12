import { EventEmitter } from 'events';
import { MailQueue } from './MailQueue.js';
import { MailTs } from '../core/MailTs.js';
import type { QueueDriver } from './QueueDriver.js';
import type { MailTsConfig } from '../core/MailTs.js';
import type { QueueOptions, QueueJob, QueueStats } from '../types/queue.js';

/** `MailTsConfig` minus `queue.persist` — persistence is owned by the driver. */
export type MailWorkerConfig = Omit<MailTsConfig, 'queue'> & {
  /** Queue execution options. `persist` is ignored — use the driver for persistence. */
  queue?: Omit<QueueOptions, 'persist'>;
};

/**
 * Bridges any external queue backend (Redis, SQS, Cloud Tasks, BullMQ, …)
 * with `MailQueue`'s full lifecycle controls.
 *
 * - The **driver** owns persistence — dequeue, ack, nack.
 * - The **worker** owns execution — concurrency, priority, retry, play/pause/cancel/interrupt/abort.
 * - `ack()` is called on the driver when a job succeeds.
 * - `nack()` is called on the driver when a job is permanently dead (DLQ).
 *
 * Events mirror `MailQueue`: `enqueued`, `started`, `success`, `retry`,
 * `dead`, `drained`, `cancelled`, `interrupted`.
 *
 * @example
 * ```ts
 * const worker = new MailWorker(new RedisDriver(), {
 *   smtp: { host: 'smtp.example.com', port: 587,
 *           auth: { type: 'plain', user: '…', pass: '…' } },
 *   queue: { concurrency: 5, maxRetries: 3 },
 * });
 *
 * await worker.start();
 *
 * worker.pause();           // stop pulling + stop executing
 * worker.resume();          // restart both
 * worker.cancel(jobId);     // cancel a specific in-flight job
 * await worker.shutdown();  // graceful drain
 * ```
 */
export class MailWorker extends EventEmitter {
  private readonly mail: MailTs;

  /** The underlying `MailQueue` — attach event listeners directly if needed. */
  readonly queue: MailQueue;

  private consuming = false;
  // Maps internal queue job ID → external driver message ID for ack/nack
  private readonly idMap = new Map<string, string>();

  constructor(private readonly driver: QueueDriver, config: MailWorkerConfig = {}) {
    super();
    const { queue: queueOpts, ...mailConfig } = config;
    this.mail = new MailTs(mailConfig);
    this.queue = new MailQueue(queueOpts ?? {});
    this.queue.setSendFn((opts, signal) => this.mail.dispatch(opts, signal));

    this.queue.on('success', (job: QueueJob) => {
      const driverId = this.idMap.get(job.id) ?? job.id;
      this.idMap.delete(job.id);
      void this.driver.ack(driverId);
      this.emit('success', job);
    });
    this.queue.on('dead', (job: QueueJob) => {
      const driverId = this.idMap.get(job.id) ?? job.id;
      this.idMap.delete(job.id);
      void this.driver.nack(driverId, job.errors.at(-1));
      this.emit('dead', job);
    });
    this.queue.on('cancelled',   (job: QueueJob) => { this.idMap.delete(job.id); this.emit('cancelled',   job); });
    this.queue.on('enqueued',    (job: QueueJob) => this.emit('enqueued',    job));
    this.queue.on('started',     (job: QueueJob) => this.emit('started',     job));
    this.queue.on('retry',       (job: QueueJob, attempt: number, delay: number) => this.emit('retry', job, attempt, delay));
    this.queue.on('interrupted', (job: QueueJob) => this.emit('interrupted', job));
    this.queue.on('drained',     ()              => this.emit('drained'));
  }

  /** Start consuming from the driver and processing jobs. */
  async start(): Promise<void> {
    this.consuming = true;
    this.queue.resume();
    void this.consumeLoop();
  }

  /** Stop pulling from the driver AND pause the queue. In-flight jobs finish naturally. */
  pause(): void {
    this.consuming = false;
    this.queue.pause();
  }

  /** Resume pulling from the driver and executing pending jobs. */
  resume(): void {
    this.queue.resume();
    if (!this.consuming) {
      this.consuming = true;
      void this.consumeLoop();
    }
  }

  // ── Lifecycle proxies ──────────────────────────────────────────────────────

  cancel(jobId: string): boolean    { return this.queue.cancel(jobId); }
  cancelAll(): number               { return this.queue.cancelAll(); }
  interrupt(jobId: string): boolean { return this.queue.interrupt(jobId); }
  interruptAll(): number            { return this.queue.interruptAll(); }
  abort(jobId: string): boolean     { return this.queue.abort(jobId); }
  abortAll(): void                  { this.queue.abortAll(); }
  drain(): Promise<void>            { return this.queue.drain(); }
  stats(): QueueStats               { return this.queue.stats(); }

  /**
   * Gracefully stop the worker:
   * 1. Stop consuming from the driver.
   * 2. Cancel all pending in-memory jobs (they remain safe in the external queue).
   * 3. Wait for in-flight jobs to finish (abort stragglers after `timeoutMs`).
   * 4. Drain the SMTP pool.
   */
  async shutdown(timeoutMs?: number): Promise<void> {
    this.consuming = false;
    await this.queue.shutdown(timeoutMs);
    await this.mail.shutdown();
  }

  private async consumeLoop(): Promise<void> {
    while (this.consuming) {
      try {
        const msg = await this.driver.dequeue();
        if (!msg) continue;
        const job = this.queue.enqueue(msg.data, { priority: msg.priority });
        this.idMap.set(job.id, msg.id);
      } catch {
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
  }
}
