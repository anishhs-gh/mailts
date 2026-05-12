import type { EmailOptions } from '../types/core.js';
import type { JobPriority } from '../types/queue.js';

/** A message dequeued from an external backend. */
export interface DriverMessage<T = EmailOptions> {
  /** Unique identifier used to ack / nack after processing. */
  id: string;
  /** Email payload to send. */
  data: T;
  /** Optional priority hint forwarded to the `MailQueue` scheduler. */
  priority?: JobPriority;
}

/**
 * Adapter interface for bridging an external queue (Redis, SQS, Cloud Tasks,
 * BullMQ, database poll, …) with `MailWorker`.
 *
 * Implement the three methods for your backend; pass the instance to
 * `new MailWorker(driver, config)`. Lifecycle control (play / pause / cancel /
 * interrupt / abort) is handled automatically by the worker.
 *
 * @example
 * ```ts
 * class RedisDriver implements QueueDriver {
 *   async dequeue() {
 *     const raw = await redis.brpoplpush('mail:pending', 'mail:inflight', 1);
 *     return raw ? JSON.parse(raw) : null;
 *   }
 *   async ack(id: string)  { await redis.lrem('mail:inflight', 1, id); }
 *   async nack(id: string) { await redis.lmove('mail:inflight', 'mail:dlq', 'LEFT', 'RIGHT'); }
 * }
 * ```
 */
export interface QueueDriver<T = EmailOptions> {
  /**
   * Fetch the next message from the external queue.
   * Return `null` when no message is available — the worker will call again
   * immediately (implement long-polling or a short sleep inside this method
   * to avoid a tight spin loop).
   */
  dequeue(): Promise<DriverMessage<T> | null>;

  /**
   * Acknowledge successful delivery — remove the message from the external queue.
   */
  ack(id: string): Promise<void>;

  /**
   * Negative-acknowledge a permanently failed message (exhausted retries / DLQ).
   * The implementation decides whether to delete, dead-letter, or re-enqueue.
   */
  nack(id: string, reason?: Error): Promise<void>;
}
