import { describe, it, expect, vi } from 'vitest';
import { MailQueue } from '../../../src/queue/MailQueue.js';
import type { SendResult } from '../../../src/types/core.js';
import { SmtpAuthError, SmtpConnError } from '../../../src/errors.js';

const baseOptions = { to: 'to@example.com', subject: 'Test', text: 'Hello' };

describe('MailQueue', () => {
  it('processes a job successfully', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 1 });
    const result: SendResult = { ok: true, messageId: 'abc', accepted: ['to@example.com'], rejected: [] };
    q.setSendFn(async () => result);

    const successes: unknown[] = [];
    q.on('success', (job, r) => successes.push(r));

    q.enqueue(baseOptions);
    await q.drain();

    expect(successes).toHaveLength(1);
    expect(successes[0]).toEqual(result);
  });

  it('retries transient failures and eventually succeeds', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 3, retryDelay: 10 });
    let calls = 0;
    q.setSendFn(async () => {
      calls++;
      if (calls < 3) {
        return { ok: false, error: new SmtpConnError('transient'), attempts: calls };
      }
      return { ok: true, messageId: 'mid', accepted: [], rejected: [] };
    });

    const retries: number[] = [];
    q.on('retry', (_job, attempt: number) => retries.push(attempt));

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(3);
    expect(retries).toHaveLength(2);
  });

  it('moves to DLQ after exhausting retries', async () => {
    // maxRetries: 2 → 1 initial + 2 retries = 3 total attempts before DLQ
    const q = new MailQueue({ concurrency: 1, maxRetries: 2, retryDelay: 10 });
    let calls = 0;
    q.setSendFn(async () => {
      calls++;
      return { ok: false, error: new SmtpConnError('always fails'), attempts: calls };
    });

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
      await new Promise(r => setTimeout(r, 200)); // always exceeds 50ms timeout
      return { ok: true, messageId: 'x', accepted: [], rejected: [] };
    });

    const retries: number[] = [];
    q.on('retry', (_job, attempt: number) => retries.push(attempt));
    q.on('dead', () => {});

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(2);           // initial + 1 retry
    expect(retries).toHaveLength(1);
    expect(q.dlq.size).toBe(1);      // timed out every time → DLQ
  });

  it('does not retry non-retryable errors', async () => {
    const q = new MailQueue({ concurrency: 1, maxRetries: 5, retryDelay: 10 });
    let calls = 0;
    q.setSendFn(async () => {
      calls++;
      return { ok: false, error: new SmtpAuthError('bad auth', 535, []), attempts: 1 };
    });

    q.enqueue(baseOptions);
    await q.drain();

    expect(calls).toBe(1); // no retries
    expect(q.dlq.size).toBe(1);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const q = new MailQueue({ concurrency: 2, maxRetries: 1, retryDelay: 10 });
    q.setSendFn(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 20));
      running--;
      return { ok: true, messageId: 'x', accepted: [], rejected: [] };
    });

    for (let i = 0; i < 6; i++) q.enqueue(baseOptions);
    await q.drain();

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('emits drained event', async () => {
    const q = new MailQueue({ concurrency: 1 });
    q.setSendFn(async () => ({ ok: true, messageId: 'x', accepted: [], rejected: [] }));

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
    const q = new MailQueue({ concurrency: 1 });
    q.setSendFn(async () => ({ ok: true, messageId: 'x', accepted: [], rejected: [] }));

    q.enqueue(baseOptions);
    q.enqueue(baseOptions);

    const stats = q.stats();
    expect(stats.pending + stats.running).toBe(2);
  });
});
