import { describe, it, expect, vi } from 'vitest';
import { MailQueue } from '../../../src/queue/MailQueue.js';
import type { SendResult } from '../../../src/types/core.js';
import { SmtpAuthError, SmtpConnError } from '../../../src/errors.js';

const baseOptions = { to: 'to@example.com', subject: 'Test', text: 'Hello' };
const okResult: SendResult = { ok: true, messageId: 'abc', accepted: ['to@example.com'], rejected: [] };

// ── Existing behaviour ────────────────────────────────────────────────────────

describe('MailQueue — existing behaviour', () => {
  it('processes a job successfully', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 1 });
    q.setSendFn(async () => okResult);

    const successes: unknown[] = [];
    q.on('success', (_job, r) => successes.push(r));

    q.enqueue(baseOptions);
    await q.drain();

    expect(successes).toHaveLength(1);
    expect(successes[0]).toEqual(okResult);
  });

  it('retries transient failures and eventually succeeds', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 3, retryDelay: 10 });
    let calls = 0;
    q.setSendFn(async () => {
      calls++;
      if (calls < 3) return { ok: false, error: new SmtpConnError('transient'), attempts: calls };
      return okResult;
    });

    const retries: number[] = [];
    q.on('retry', (_job, attempt: number) => retries.push(attempt));

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(3);
    expect(retries).toHaveLength(2);
  });

  it('moves to DLQ after exhausting retries', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 2, retryDelay: 10 });
    let calls = 0;
    q.setSendFn(async () => ({ ok: false, error: new SmtpConnError('fail'), attempts: ++calls }));

    const dead: unknown[] = [];
    q.on('dead', (job) => dead.push(job));

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(dead).toHaveLength(1);
    expect(q.dlq.size).toBe(1);
  });

  it('aborts a hung send after jobTimeout and retries', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 1, retryDelay: 10, jobTimeout: 50 });
    let calls = 0;
    q.setSendFn(async () => {
      calls++;
      await new Promise(r => setTimeout(r, 200));
      return okResult;
    });

    const retries: number[] = [];
    q.on('retry', (_job, attempt: number) => retries.push(attempt));
    q.on('dead', () => {});

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(2);
    expect(retries).toHaveLength(1);
    expect(q.dlq.size).toBe(1);
  });

  it('does not retry non-retryable errors', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 5, retryDelay: 10 });
    let calls = 0;
    q.setSendFn(async () => ({ ok: false, error: new SmtpAuthError('bad auth', 535, []), attempts: ++calls }));

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(1);
    expect(q.dlq.size).toBe(1);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const q = new MailQueue({ concurrency: 2, maxRetries: 1 });
    q.setSendFn(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 20));
      running--;
      return okResult;
    });

    for (let i = 0; i < 6; i++) q.enqueue(baseOptions);
    await q.drain();

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('emits drained event', async () => {
    const q = new MailQueue({ concurrency: 1 });
    q.setSendFn(async () => okResult);

    let drained = false;
    q.on('drained', () => { drained = true; });

    q.enqueue(baseOptions);
    await q.drain();

    expect(drained).toBe(true);
  });

  it('drain() resolves immediately when queue is empty', async () => {
    const q = new MailQueue();
    await expect(q.drain()).resolves.toBeUndefined();
  });

  it('reports correct stats', () => {
    const q = new MailQueue({ concurrency: 0 }); // paused — nothing starts
    q.setSendFn(async () => okResult);
    q.enqueue(baseOptions);
    q.enqueue(baseOptions);
    const stats = q.stats();
    expect(stats.pending).toBe(2);
    expect(stats.running).toBe(0);
    expect(stats.cancelled).toBe(0);
  });
});

// ── Priority scheduling ───────────────────────────────────────────────────────

describe('MailQueue — priority scheduling', () => {
  it('drains critical before high before normal before low', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 0 });
    const order: string[] = [];

    // Start paused so all jobs are enqueued before processing begins
    q.pause();
    q.setSendFn(async (_opts) => {
      order.push((_opts.to as string));
      return okResult;
    });

    q.enqueue({ ...baseOptions, to: 'low@x.com' },      { priority: 'low' });
    q.enqueue({ ...baseOptions, to: 'normal@x.com' },   { priority: 'normal' });
    q.enqueue({ ...baseOptions, to: 'critical@x.com' }, { priority: 'critical' });
    q.enqueue({ ...baseOptions, to: 'high@x.com' },     { priority: 'high' });

    q.play();
    await q.drain();

    expect(order).toEqual(['critical@x.com', 'high@x.com', 'normal@x.com', 'low@x.com']);
  });

  it('uses defaultPriority from QueueOptions', () => {
    const q = new MailQueue({ concurrency: 0, defaultPriority: 'high' });
    q.setSendFn(async () => okResult);
    const job = q.enqueue(baseOptions);
    expect(job.priority).toBe('high');
  });

  it('per-job priority overrides defaultPriority', () => {
    const q = new MailQueue({ concurrency: 0, defaultPriority: 'high' });
    q.setSendFn(async () => okResult);
    const job = q.enqueue(baseOptions, { priority: 'low' });
    expect(job.priority).toBe('low');
  });

  it('stats.cancelled is 0 initially', () => {
    const q = new MailQueue({ concurrency: 0 });
    q.setSendFn(async () => okResult);
    expect(q.stats().cancelled).toBe(0);
  });
});

// ── play / pause ──────────────────────────────────────────────────────────────

describe('MailQueue — play / pause', () => {
  it('pause() prevents new jobs from starting', async () => {
    const q = new MailQueue({ concurrency: 3 });
    q.setSendFn(async () => { await new Promise(r => setTimeout(r, 50)); return okResult; });

    q.pause();
    q.enqueue(baseOptions);
    q.enqueue(baseOptions);

    await new Promise(r => setTimeout(r, 20));
    expect(q.stats().running).toBe(0);
    expect(q.stats().pending).toBe(2);

    q.play();
    await q.drain();
    expect(q.stats().pending).toBe(0);
  });

  it('play() is an alias for resume()', async () => {
    const q = new MailQueue({ concurrency: 1 });
    q.setSendFn(async () => okResult);
    q.pause();
    q.enqueue(baseOptions);
    q.play();
    await q.drain();
    expect(q.stats().succeeded).toBe(1);
  });
});

// ── cancel ────────────────────────────────────────────────────────────────────

describe('MailQueue — cancel', () => {
  it('cancel() removes a pending job', async () => {
    const q = new MailQueue({ concurrency: 0 }); // nothing starts
    q.setSendFn(async () => okResult);

    const cancelled: string[] = [];
    q.on('cancelled', (job) => cancelled.push(job.id));

    const job = q.enqueue(baseOptions);
    const ok = q.cancel(job.id);

    expect(ok).toBe(true);
    expect(cancelled).toEqual([job.id]);
    expect(q.stats().pending).toBe(0);
    expect(q.stats().cancelled).toBe(1);
  });

  it('cancel() returns false for unknown job', () => {
    const q = new MailQueue();
    q.setSendFn(async () => okResult);
    expect(q.cancel('nonexistent')).toBe(false);
  });

  it('cancelAll() removes all pending jobs', async () => {
    const q = new MailQueue({ concurrency: 0 });
    q.setSendFn(async () => okResult);

    const cancelled: string[] = [];
    q.on('cancelled', (job) => cancelled.push(job.id));

    q.enqueue(baseOptions);
    q.enqueue(baseOptions);
    q.enqueue(baseOptions);

    const count = q.cancelAll();
    expect(count).toBe(3);
    expect(cancelled).toHaveLength(3);
    expect(q.stats().pending).toBe(0);
    expect(q.stats().cancelled).toBe(3);
  });

  it('cancelAll() resolves pending drain() promise', async () => {
    const q = new MailQueue({ concurrency: 0 });
    q.setSendFn(async () => okResult);
    q.enqueue(baseOptions);

    const drained = q.drain();
    q.cancelAll();
    await expect(drained).resolves.toBeUndefined();
  });

  it('cancelled job has cancelledAt timestamp', () => {
    const before = new Date();
    const q = new MailQueue({ concurrency: 0 });
    q.setSendFn(async () => okResult);
    const job = q.enqueue(baseOptions);
    q.cancel(job.id);
    expect(job.cancelledAt).toBeInstanceOf(Date);
    expect(job.cancelledAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

// ── interrupt ────────────────────────────────────────────────────────────────

describe('MailQueue — interrupt', () => {
  it('interrupt() requeues a running job without incrementing attempts', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 5, retryDelay: 10 });
    let calls = 0;
    let interruptedOnce = false;

    const interrupted: string[] = [];
    q.on('interrupted', (job) => interrupted.push(job.id));

    q.setSendFn(async (_opts, signal) => {
      calls++;
      if (!interruptedOnce) {
        interruptedOnce = true;
        // Interrupt before we "send"
        q.interrupt(runningJobId);
        // Wait for abort
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(reject, 500);
        });
      }
      return okResult;
    });

    let runningJobId = '';
    q.on('started', (job) => { runningJobId = job.id; });

    const job = q.enqueue(baseOptions);
    await q.drain();

    expect(interrupted).toContain(job.id);
    expect(calls).toBe(2);       // interrupted once → retried → succeeded
    expect(job.attempts).toBe(1); // interrupt undid the first attempt count
  });

  it('interrupt() returns false for unknown job', () => {
    const q = new MailQueue();
    q.setSendFn(async () => okResult);
    expect(q.interrupt('nonexistent')).toBe(false);
  });
});

// ── abort ─────────────────────────────────────────────────────────────────────

describe('MailQueue — abort', () => {
  it('abort() counts as a failure and applies retry policy', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 1, retryDelay: 10 });
    let calls = 0;
    let abortedOnce = false;

    q.setSendFn(async (_opts, signal) => {
      calls++;
      if (!abortedOnce) {
        abortedOnce = true;
        q.abort(runningJobId);
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(reject, 500);
        });
      }
      return okResult;
    });

    let runningJobId = '';
    q.on('started', (job) => { runningJobId = job.id; });
    q.on('dead', () => {});

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(2); // aborted + one retry that succeeded
  });

  it('abort() returns false for unknown job', () => {
    const q = new MailQueue();
    q.setSendFn(async () => okResult);
    expect(q.abort('nonexistent')).toBe(false);
  });
});

// ── shutdown ──────────────────────────────────────────────────────────────────

describe('MailQueue — shutdown', () => {
  it('shutdown() cancels all pending and waits for running', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 0 });
    let sendCalled = 0;
    q.setSendFn(async () => { sendCalled++; await new Promise(r => setTimeout(r, 30)); return okResult; });

    q.enqueue(baseOptions); // this one starts running
    q.enqueue(baseOptions); // this one stays pending
    q.enqueue(baseOptions); // this one stays pending

    // Small delay so the first job starts
    await new Promise(r => setTimeout(r, 5));

    await q.shutdown();

    expect(sendCalled).toBe(1);            // only the first job ran
    expect(q.stats().cancelled).toBe(2);   // the two pending ones were cancelled
    expect(q.stats().succeeded).toBe(1);
  });

  it('shutdown() with timeout aborts running jobs that exceed the deadline', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 0, jobTimeout: 5_000 });
    q.setSendFn(async (_opts, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
      return okResult;
    });
    q.on('dead', () => {});

    q.enqueue(baseOptions);
    await new Promise(r => setTimeout(r, 10)); // let it start

    await q.shutdown(50); // 50ms timeout → should abort the slow job
    // No hanging — test completes
  });
});
