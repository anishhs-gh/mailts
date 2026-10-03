import type { EmailOptions, SendResult } from '../types/core.js';
import type { QueueJob } from '../types/queue.js';

/**
 * Callbacks for metrics and alerting (`MailTs({ telemetry })`). Called synchronously —
 * keep them fast and never throw; hand heavy work to your metrics client.
 */
export interface TelemetryHooks {
  /** After a message was delivered to the server or provider. Failures go to `onError`. */
  onSend?:              (opts: EmailOptions, result: SendResult, latencyMs: number) => void;
  /** A failure, with where it happened (e.g. `'send'`, `'saveToSent'`). */
  onError?:             (err: Error, phase: string) => void;
  /** A job entered the queue. */
  onQueueEnqueue?:      (job: QueueJob) => void;
  /** A queued job was delivered. */
  onQueueSuccess?:      (job: QueueJob) => void;
  /** A queued job exhausted its retries and moved to the dead-letter queue. */
  onQueueDead?:         (job: QueueJob) => void;
  /** A queued job failed and will retry after `delayMs`. */
  onQueueRetry?:        (job: QueueJob, attempt: number, delayMs: number) => void;
  /** A queued job was cancelled. */
  onQueueCancelled?:    (job: QueueJob) => void;
  /** A running job was interrupted and requeued. */
  onQueueInterrupted?:  (job: QueueJob) => void;
}
