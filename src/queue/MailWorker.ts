import { EventEmitter } from 'events';
import { MailQueue } from './MailQueue.js';
import { MailTs } from '../core/MailTs.js';
import type { QueueDriver } from './QueueDriver.js';
import type { MailTsConfig } from '../core/MailTs.js';
import type { QueueOptions, QueueJob, QueueStats, ShutdownResult } from '../types/queue.js';
import type { Middleware } from '../types/core.js';

/** `MailTsConfig` minus `queue.persist` — persistence is owned by the driver. */
export type MailWorkerConfig = Omit<MailTsConfig, 'queue'> & {
  /** Queue execution options. `persist` is ignored — use the driver for persistence. */
  queue?: Omit<QueueOptions, 'persist'>;
  /**
   * Messages held beyond the running ones (received from the driver but not
   * yet started). Bounds memory and lets other consumers share the backlog.
   * @default queue.concurrency
   */
  prefetch?: number;
  /** Wait after `dequeue()` returns null or throws, in ms. @default 1_000 */
  idleDelayMs?: number;
};

/**
 * Bridges any external queue backend (Redis, SQS, Cloud Tasks, Pub/Sub, Postgres…)
 * with `MailQueue`'s lifecycle controls.
 *
 * - The **driver** owns persistence — dequeue, ack, nack (+ optional release / cancel).
 * - The **worker** owns execution — concurrency, priority, retry, pause/cancel/interrupt/abort.
 * - Backpressure: at most `concurrency + prefetch` messages are held at once.
 * - `devMode` and middleware registered with `worker.use()` apply to every send.
 *
 * Events mirror `MailQueue` plus `error` (driver failures). Without an `error`
 * listener, driver failures are logged instead of thrown.
 */
export class MailWorker extends EventEmitter {
  private readonly mail: MailTs;

  /** The underlying `MailQueue` — attach event listeners directly if needed. */
  readonly queue: MailQueue;

  private consuming = false;
  private loop: Promise<void> | null = null;
  private readonly maxHeld: number;
  private readonly idleDelayMs: number;
  /** Internal job id → driver message id, for every message not yet acked/nacked/released. */
  private readonly idMap = new Map<string, string>();
  private slotWaiter: (() => void) | null = null;

  constructor(private readonly driver: QueueDriver, config: MailWorkerConfig = {}) {
    super();
    const { queue: queueOpts = {}, prefetch, idleDelayMs, ...mailConfig } = config;
    this.mail = new MailTs(mailConfig);
    this.queue = new MailQueue(queueOpts, this.mail.logger);
    this.queue.setSendFn((opts, signal) => this.mail.sendQueued(opts, signal));
    this.maxHeld = (queueOpts.concurrency ?? 3) + (prefetch ?? queueOpts.concurrency ?? 3);
    this.idleDelayMs = idleDelayMs ?? 1_000;

    const settle = (job: QueueJob, action: (driverId: string) => Promise<void>) => {
      const driverId = this.idMap.get(job.id);
      if (driverId === undefined) return;
      this.idMap.delete(job.id);
      this.wakeSlot();
      action(driverId).catch(err => this.fail(err));
    };

    this.queue.on('success', (job: QueueJob, result: unknown) => {
      settle(job, id => this.driver.ack(id));
      this.emit('success', job, result);
    });
    this.queue.on('dead', (job: QueueJob, errors: unknown) => {
      settle(job, id => this.driver.nack(id, job.errors.at(-1)));
      this.emit('dead', job, errors);
    });
    this.queue.on('cancelled', (job: QueueJob) => {
      settle(job, id => (this.driver.cancel ? this.driver.cancel(id) : this.driver.ack(id)));
      this.emit('cancelled', job);
    });
    for (const ev of ['enqueued', 'scheduled', 'started', 'retry', 'interrupted', 'drained']) {
      this.queue.on(ev, (...args: unknown[]) => this.emit(ev, ...args));
    }
  }

  /** Register a middleware that runs before every send. */
  use(middleware: Middleware): this {
    this.mail.use(middleware);
    return this;
  }

  /** Start consuming from the driver and processing jobs. */
  async start(): Promise<void> {
    this.queue.resume();
    this.startLoop();
  }

  /** Stop pulling from the driver AND pause the queue. In-flight jobs finish naturally. */
  pause(): void {
    this.consuming = false;
    this.queue.pause();
    this.wakeSlot();
  }

  /** Resume pulling from the driver and executing pending jobs. */
  resume(): void {
    this.queue.resume();
    this.startLoop();
  }

  private startLoop(): void {
    if (this.consuming) return;
    this.consuming = true;
    // Start polling synchronously; a loop still winding down after pause() exits on its own
    const prev = this.loop;
    this.loop = prev ? prev.then(() => this.consumeLoop()) : this.consumeLoop();
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
   * 2. Let running jobs finish (interrupting stragglers after `timeoutMs`).
   * 3. Hand every unstarted message back via `driver.release` (if implemented).
   * 4. Close SMTP connections.
   */
  async shutdown(timeoutMs?: number): Promise<ShutdownResult> {
    this.consuming = false;
    this.wakeSlot();
    await this.loop?.catch(() => {});
    const result = await this.queue.shutdown({ timeoutMs, pending: 'keep' });
    const held = [...this.idMap.values()];
    this.idMap.clear();
    if (this.driver.release) {
      await Promise.all(held.map(id => this.driver.release!(id).catch(err => this.fail(err))));
    }
    await this.mail.shutdown();
    return result;
  }

  private async consumeLoop(): Promise<void> {
    while (this.consuming) {
      if (this.idMap.size >= this.maxHeld) {
        await new Promise<void>(r => { this.slotWaiter = r; });
        continue;
      }
      try {
        const msg = await this.driver.dequeue();
        if (!this.consuming) {
          if (msg && this.driver.release) await this.driver.release(msg.id).catch(err => this.fail(err));
          break;
        }
        if (!msg) { await this.sleep(this.idleDelayMs); continue; }
        const job = this.queue.enqueue(msg.data, { priority: msg.priority });
        this.idMap.set(job.id, msg.id);
      } catch (err) {
        this.fail(err);
        await this.sleep(this.idleDelayMs);
      }
    }
  }

  private wakeSlot(): void {
    const w = this.slotWaiter;
    this.slotWaiter = null;
    w?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => {
      const t = setTimeout(() => { this.slotWaiter = null; r(); }, ms);
      this.slotWaiter = () => { clearTimeout(t); r(); };
    });
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    if (this.listenerCount('error') > 0) this.emit('error', e);
    else this.mail.logger.error('queue', `MailWorker driver error: ${e.message}`);
  }
}
