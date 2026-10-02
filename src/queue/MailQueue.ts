import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { RetryPolicy } from './RetryPolicy.js';
import { DeadLetterQueue } from './DeadLetterQueue.js';
import { JobController } from './JobController.js';
import { RateLimiter } from './RateLimiter.js';
import { generateMessageId } from '../core/Message.js';
import { parseAddressList } from '../core/Address.js';
import type {
  QueueJob,
  QueueOptions,
  QueueStats,
  JobPriority,
  EnqueueOptions,
  ShutdownOptions,
  ShutdownResult,
} from '../types/queue.js';
import type { EmailOptions, SendResult } from '../types/core.js';
import type { Logger } from '../logger/Logger.js';
import { MailTsError, QueueError } from '../errors.js';

export type SendFn = (options: EmailOptions, signal?: AbortSignal) => Promise<SendResult>;

const PRIORITY_ORDER: JobPriority[] = ['critical', 'high', 'normal', 'low'];

/**
 * Concurrent, retry-aware email send queue with a dead-letter queue.
 *
 * Job lifecycle:
 * ```
 * pending ─▶ running ─ok─▶ success
 *    ▲          ├─fail─▶ scheduled (retry at notBefore) ─▶ pending
 *    │          └─fatal / retries exhausted─▶ dead
 *    └─ interrupt / shutdown({ pending: 'keep' })            cancelled (explicit only)
 * ```
 * Retries wait in `scheduled` and do **not** hold a concurrency slot.
 *
 * Priority: `critical` → `high` → `normal` → `low`, FIFO within a tier.
 *
 * Events: `enqueued`, `scheduled`, `promoted`, `throttled` (job, waitMs),
 * `started`, `success`, `retry`, `dead`, `drained`, `cancelled`, `interrupted`.
 */
export class MailQueue extends EventEmitter {
  private readonly pending: Map<JobPriority, QueueJob[]> = new Map(PRIORITY_ORDER.map(p => [p, []]));
  private readonly scheduled = new Map<string, QueueJob>();
  private readonly runningJobs = new Map<string, QueueJob>();
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  private succeeded = 0;
  private cancelledCount = 0;
  protected readonly policy: RetryPolicy;
  readonly dlq: DeadLetterQueue;
  private readonly concurrency: number;
  private readonly jobTimeout: number;
  private readonly defaultPriority: JobPriority;
  private sendFn: SendFn | null = null;
  protected readonly logger: Logger | null;
  private drainWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private paused = false;
  private closed = false;

  private readonly controllers = new Map<string, JobController>();
  private readonly limiter: RateLimiter | null;
  protected readonly idempotencyWindowMs: number;
  /** idempotencyKey → job (kept for the window, any state). */
  private readonly idempotent = new Map<string, { job: QueueJob; expires: number }>();
  /** Jobs held back by the rate limiter go back to the front of their tier. */
  private readonly throttled = new Set<string>();

  constructor(opts: QueueOptions = {}, logger?: Logger) {
    super();
    this.concurrency = opts.concurrency ?? 3;
    this.jobTimeout = opts.jobTimeout ?? 30_000;
    this.defaultPriority = opts.defaultPriority ?? 'normal';
    this.logger = logger ?? null;
    this.policy = new RetryPolicy({
      maxRetries: opts.maxRetries ?? 5,
      initialDelay: opts.retryDelay ?? 1_000,
      maxDelay: opts.maxRetryDelay,
      backoff: opts.retryBackoff ?? 'exponential',
      jitter: opts.jitter ?? true,
    });
    this.dlq = new DeadLetterQueue(opts.deadLetter);
    const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit) : null;
    this.limiter = limiter?.enabled ? limiter : null;
    this.idempotencyWindowMs = opts.idempotencyWindowMs ?? 7 * 86_400_000;
    this.dlq.on('dead', (job: QueueJob, errors: MailTsError[]) => this.emit('dead', job, errors));
  }

  /** Inject the send function. Jobs wait (pending) until one is set. */
  setSendFn(fn: SendFn): void {
    this.sendFn = fn;
    this.tick();
  }

  /** `true` when jobs survive a restart (overridden by persistent queues). */
  get persistent(): boolean {
    return false;
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Add a message to the queue.
   * @returns The created `QueueJob` — use `job.id` to track it via events.
   */
  enqueue(options: EmailOptions, enqueueOpts: EnqueueOptions = {}): QueueJob {
    if (this.closed) throw new QueueError('Queue is shut down');
    if (enqueueOpts.idempotencyKey !== undefined) {
      const existing = this.findIdempotent(enqueueOpts.idempotencyKey);
      if (existing) {
        this.logger?.debug('queue', `Idempotency key ${enqueueOpts.idempotencyKey} → existing job ${existing.id}`);
        return existing;
      }
    }
    // Pin the Message-ID so a resend after a crash carries the same id (clients collapse duplicates)
    if (!options.messageId) {
      options = { ...options, messageId: generateMessageId(parseAddressList(options.from)[0]?.email ?? '') };
    }
    const notBefore = enqueueOpts.sendAt && enqueueOpts.sendAt.getTime() > Date.now() ? enqueueOpts.sendAt : undefined;
    const job: QueueJob = {
      id: enqueueOpts.id ?? randomBytes(8).toString('hex'),
      options,
      attempts: 0,
      errors: [],
      createdAt: new Date(),
      lastAttemptAt: null,
      status: notBefore ? 'scheduled' : 'pending',
      priority: enqueueOpts.priority ?? this.defaultPriority,
      ...(notBefore ? { notBefore } : {}),
      ...(enqueueOpts.idempotencyKey !== undefined ? { idempotencyKey: enqueueOpts.idempotencyKey } : {}),
    };
    if (this.find(job.id)) throw new QueueError(`Duplicate job id: ${job.id}`);
    if (job.idempotencyKey !== undefined) {
      this.idempotent.set(job.idempotencyKey, { job, expires: Date.now() + this.idempotencyWindowMs });
    }
    this.emit('enqueued', job);
    this.logger?.debug('queue', `Enqueued job ${job.id} (priority: ${job.priority})`);
    this.place(job);
    return job;
  }

  /**
   * Look up a job by idempotency key within the window. Persistent queues
   * override this to consult storage as well.
   */
  protected findIdempotent(key: string): QueueJob | undefined {
    const now = Date.now();
    if (this.idempotent.size > 1_000) {
      for (const [k, v] of this.idempotent) if (v.expires <= now) this.idempotent.delete(k);
    }
    const hit = this.idempotent.get(key);
    if (!hit || hit.expires <= now) return undefined;
    return hit.job;
  }

  /**
   * Re-insert a job with its existing id and state (used by persistent queues
   * on restart). Running jobs are treated as pending: the attempt was lost.
   */
  protected restore(job: QueueJob): void {
    if (this.find(job.id)) return;
    if (job.status === 'running') job.status = 'pending';
    this.place(job);
  }

  private place(job: QueueJob): void {
    if (job.status === 'scheduled' && job.notBefore && job.notBefore.getTime() > Date.now()) {
      this.scheduled.set(job.id, job);
      this.armSchedule();
      this.emit('scheduled', job);
    } else {
      job.status = 'pending';
      delete job.notBefore;
      this.pending.get(job.priority)!.push(job);
      this.tick();
    }
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.sendFn) return;
    while (!this.paused && this.runningJobs.size < this.concurrency) {
      const job = this.nextPending();
      if (!job) break;
      if (this.limiter) {
        const wait = this.limiter.waitFor(job);
        if (wait > 0) {
          // Over the limit: wait in `scheduled` (no slot held, no attempt counted)
          job.status = 'scheduled';
          job.notBefore = new Date(Date.now() + wait);
          this.throttled.add(job.id);
          this.scheduled.set(job.id, job);
          this.armSchedule();
          this.emit('scheduled', job);
          this.emit('throttled', job, wait);
          continue;
        }
        this.limiter.record(job);
      }
      this.runningJobs.set(job.id, job);
      void this.execute(job).finally(() => {
        this.runningJobs.delete(job.id);
        this.tick();
        this.checkDrained();
      });
    }
  }

  private nextPending(): QueueJob | undefined {
    for (const tier of PRIORITY_ORDER) {
      const arr = this.pending.get(tier)!;
      if (arr.length > 0) return arr.shift();
    }
    return undefined;
  }

  private armSchedule(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    if (this.scheduled.size === 0) return;
    let next = Infinity;
    for (const j of this.scheduled.values()) next = Math.min(next, j.notBefore!.getTime());
    // setTimeout caps at ~24.8 days; re-arm in steps for far-future sends
    const delay = Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1);
    this.scheduleTimer = setTimeout(() => this.promoteDue(), delay);
  }

  private promoteDue(): void {
    this.scheduleTimer = null;
    const now = Date.now();
    for (const [id, job] of this.scheduled) {
      if (job.notBefore!.getTime() <= now) {
        this.scheduled.delete(id);
        job.status = 'pending';
        delete job.notBefore;
        // Throttled jobs keep their place; retries go to the back of their tier
        if (this.throttled.delete(id)) this.pending.get(job.priority)!.unshift(job);
        else this.pending.get(job.priority)!.push(job);
        this.emit('promoted', job);
      }
    }
    this.armSchedule();
    this.tick();
  }

  /** One send attempt. Retries are re-scheduled, never awaited here. */
  private async execute(job: QueueJob): Promise<void> {
    const ctrl = new JobController();
    this.controllers.set(job.id, ctrl);
    job.status = 'running';
    job.attempts++;
    job.lastAttemptAt = new Date();
    this.emit('started', job);
    this.logger?.debug('queue', `Job ${job.id}: attempt ${job.attempts}`);

    let result: SendResult | undefined;
    let error: MailTsError | undefined;
    try {
      result = await this.sendWithTimeout(job, ctrl.signal);
    } catch (raw) {
      error = raw instanceof MailTsError ? raw : new MailTsError(String((raw as Error)?.message ?? raw), 'EQUEUE', true);
    } finally {
      this.controllers.delete(job.id);
    }

    if (ctrl.reason === 'cancel') {
      this.markCancelled(job);
      return;
    }
    if (ctrl.reason === 'interrupt') {
      job.attempts--;
      job.status = 'pending';
      this.pending.get(job.priority)!.unshift(job);
      this.emit('interrupted', job);
      this.logger?.info('queue', `Job ${job.id}: interrupted — requeued at front of ${job.priority}`);
      return;
    }
    if (ctrl.reason === 'abort') error = new MailTsError('Job aborted by caller', 'EQUEUE', true);

    if (!error && result?.ok) {
      job.status = 'success';
      this.succeeded++;
      this.emit('success', job, result);
      this.logger?.info('queue', `Job ${job.id}: succeeded (messageId: ${result.messageId})`);
      return;
    }

    const err = error ?? (result && !result.ok ? result.error : new MailTsError('Unknown send failure', 'EQUEUE', true));
    job.errors.push(err);
    if (!this.policy.shouldRetry(job.attempts, err)) {
      await this.dlq.add(job);
      this.logger?.error('queue', `Job ${job.id}: moved to DLQ after ${job.attempts} attempt(s): ${err.message}`);
      return;
    }
    // Respect a provider's Retry-After hint (HTTP 429/503) when it asks for longer
    const hinted = (err as { retryAfterMs?: unknown }).retryAfterMs;
    const delay = Math.max(this.policy.delayFor(job.attempts - 1), typeof hinted === 'number' ? hinted : 0);
    job.status = 'scheduled';
    job.notBefore = new Date(Date.now() + delay);
    this.scheduled.set(job.id, job);
    this.armSchedule();
    this.emit('retry', job, job.attempts, delay);
    this.logger?.warn('queue', `Job ${job.id}: retrying in ${delay}ms (attempt ${job.attempts}): ${err.message}`);
  }

  private sendWithTimeout(job: QueueJob, signal: AbortSignal): Promise<SendResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new MailTsError(`Job ${job.id} timed out after ${this.jobTimeout}ms`, 'ETIMEOUT', true));
      }, this.jobTimeout);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new MailTsError('Job stopped', 'EQUEUE', true));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.sendFn!(job.options, signal).then(
        r => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(r); },
        e => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  private markCancelled(job: QueueJob): void {
    job.status = 'cancelled';
    job.cancelledAt = new Date();
    delete job.notBefore;
    this.cancelledCount++;
    this.emit('cancelled', job);
    this.logger?.info('queue', `Job ${job.id}: cancelled`);
  }

  // ── Lifecycle controls ─────────────────────────────────────────────────────

  /** Resume processing after `pause()`. Alias: `play()`. */
  resume(): void {
    if (this.closed) return;
    this.paused = false;
    this.tick();
  }

  play(): void { this.resume(); }

  /** Pause — in-flight jobs finish, no new jobs start. Pending `drain()` calls reject. */
  pause(): void {
    this.paused = true;
    this.checkDrained();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Cancel a job. Pending/scheduled jobs are removed immediately; a running
   * job stops after its current attempt is aborted.
   */
  cancel(jobId: string): boolean {
    const job = this.takeWaiting(jobId);
    if (job) {
      this.markCancelled(job);
      this.checkDrained();
      return true;
    }
    const ctrl = this.controllers.get(jobId);
    if (ctrl) { ctrl.cancel(); return true; }
    return false;
  }

  /** Cancel all pending and scheduled (not running) jobs. Returns the count. */
  cancelAll(): number {
    const jobs = this.waitingJobs();
    for (const tier of PRIORITY_ORDER) this.pending.get(tier)!.length = 0;
    this.scheduled.clear();
    this.armSchedule();
    for (const job of jobs) this.markCancelled(job);
    this.checkDrained();
    return jobs.length;
  }

  /** Return a running job to the front of its tier without counting the attempt. */
  interrupt(jobId: string): boolean {
    const ctrl = this.controllers.get(jobId);
    if (!ctrl) return false;
    ctrl.interrupt();
    return true;
  }

  interruptAll(): number {
    let n = 0;
    for (const ctrl of this.controllers.values()) { ctrl.interrupt(); n++; }
    return n;
  }

  /** Abort a running job — counts as a failed attempt (retry policy / DLQ apply). */
  abort(jobId: string): boolean {
    const ctrl = this.controllers.get(jobId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  abortAll(): void {
    for (const ctrl of this.controllers.values()) ctrl.abort();
  }

  /**
   * Stop the queue.
   *
   * - `pending: 'drain'` — keep sending until everything is delivered (or DLQ'd)
   *   or `timeoutMs` elapses. Default for in-memory queues.
   * - `pending: 'keep'` — stop starting jobs; pending and scheduled jobs are left
   *   untouched (persistent queues resume them after restart). Default when persistent.
   * - `pending: 'cancel'` — cancel pending and scheduled jobs.
   *
   * Running jobs get `timeoutMs` to finish; stragglers are interrupted (back to
   * pending, attempt not counted). Never hangs. Accepts a number for the legacy
   * `shutdown(timeoutMs)` form.
   */
  async shutdown(opts: number | ShutdownOptions = {}): Promise<ShutdownResult> {
    const { timeoutMs, pending = this.persistent ? 'keep' : 'drain' } =
      typeof opts === 'number' ? { timeoutMs: opts } : opts;
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    const cancelledBefore = this.cancelledCount;

    if (pending === 'drain') {
      this.resume();
      await this.waitUntil(() => this.idleCount === 0, deadline);
    }
    this.paused = true;
    this.closed = true;
    if (pending === 'cancel') this.cancelAll();

    await this.waitUntil(() => this.runningJobs.size === 0, deadline);
    if (this.runningJobs.size > 0) {
      this.interruptAll();
      await this.waitUntil(() => this.runningJobs.size === 0, Date.now() + 5_000);
    }
    if (this.scheduleTimer) { clearTimeout(this.scheduleTimer); this.scheduleTimer = null; }
    this.rejectDrainWaiters(new QueueError('Queue was shut down'));

    return {
      cancelled: this.cancelledCount - cancelledBefore,
      remaining: this.waitingJobs().length,
    };
  }

  private get idleCount(): number {
    return this.pendingCount + this.runningJobs.size + this.scheduled.size;
  }

  private waitUntil(cond: () => boolean, deadline: number): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (cond() || Date.now() >= deadline) {
          this.off('_settled', check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = deadline === Infinity ? undefined : setTimeout(check, Math.max(0, deadline - Date.now()));
      this.on('_settled', check);
      check();
    });
  }

  // ── Drain & inspection ─────────────────────────────────────────────────────

  /**
   * Resolves when no job is pending, scheduled or running. Rejects with
   * `QueueError` if the queue is (or becomes) paused while work remains.
   */
  drain(): Promise<void> {
    if (this.idleCount === 0) return Promise.resolve();
    if (this.paused) return Promise.reject(new QueueError('Queue is paused — drain() would never resolve'));
    return new Promise((resolve, reject) => this.drainWaiters.push({ resolve, reject }));
  }

  private checkDrained(): void {
    this.emit('_settled');
    if (this.idleCount === 0) {
      this.emit('drained');
      for (const w of this.drainWaiters.splice(0)) w.resolve();
    } else if (this.paused && this.runningJobs.size === 0 && this.drainWaiters.length) {
      this.rejectDrainWaiters(new QueueError('Queue is paused — drain() would never resolve'));
    }
  }

  private rejectDrainWaiters(err: Error): void {
    for (const w of this.drainWaiters.splice(0)) w.reject(err);
  }

  /** Current queue statistics snapshot. */
  stats(): QueueStats {
    return {
      pending: this.pendingCount,
      scheduled: this.scheduled.size,
      running: this.runningJobs.size,
      succeeded: this.succeeded,
      dead: this.dlq.size,
      cancelled: this.cancelledCount,
    };
  }

  /** Look up a pending, scheduled or running job. */
  get(jobId: string): QueueJob | undefined {
    return this.find(jobId);
  }

  /** All jobs that are not finished (pending, scheduled, running). */
  list(): QueueJob[] {
    return [...this.runningJobs.values(), ...this.waitingJobs()];
  }

  private get pendingCount(): number {
    let n = 0;
    for (const tier of PRIORITY_ORDER) n += this.pending.get(tier)!.length;
    return n;
  }

  private waitingJobs(): QueueJob[] {
    const out: QueueJob[] = [];
    for (const tier of PRIORITY_ORDER) out.push(...this.pending.get(tier)!);
    out.push(...this.scheduled.values());
    return out;
  }

  private find(id: string): QueueJob | undefined {
    return this.runningJobs.get(id) ?? this.scheduled.get(id) ?? this.waitingJobs().find(j => j.id === id);
  }

  private takeWaiting(id: string): QueueJob | undefined {
    const s = this.scheduled.get(id);
    if (s) {
      this.scheduled.delete(id);
      this.armSchedule();
      return s;
    }
    for (const tier of PRIORITY_ORDER) {
      const arr = this.pending.get(tier)!;
      const idx = arr.findIndex(j => j.id === id);
      if (idx !== -1) return arr.splice(idx, 1)[0];
    }
    return undefined;
  }
}
