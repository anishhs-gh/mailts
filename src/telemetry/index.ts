import type { EmailOptions, SendResult } from '../types/core.js';
import type { QueueJob } from '../types/queue.js';

export interface TelemetryHooks {
  onSend?:              (opts: EmailOptions, result: SendResult, latencyMs: number) => void;
  onError?:             (err: Error, phase: string) => void;
  onQueueEnqueue?:      (job: QueueJob) => void;
  onQueueSuccess?:      (job: QueueJob) => void;
  onQueueDead?:         (job: QueueJob) => void;
  onQueueRetry?:        (job: QueueJob, attempt: number, delayMs: number) => void;
  onQueueCancelled?:    (job: QueueJob) => void;
  onQueueInterrupted?:  (job: QueueJob) => void;
}
