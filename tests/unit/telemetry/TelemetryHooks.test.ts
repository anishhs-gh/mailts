import { describe, it, expect, vi } from 'vitest';
import { MailTs } from '../../../src/core/MailTs.js';
import type { TelemetryHooks } from '../../../src/telemetry/index.js';
import type { QueueJob } from '../../../src/types/queue.js';

const baseOpts = { to: 'u@example.com', subject: 'S', text: 'T' };
const ok = { ok: true as const, messageId: 'mid', accepted: [], rejected: [] };

// Mock transport that always succeeds — avoids real SMTP and works with onSend in sendDirect
const mockTransport = {
  name: 'mock',
  send: vi.fn().mockResolvedValue({ messageId: 'mock-mid', accepted: ['u@example.com'], rejected: [] }),
};

function makeMail(hooks: TelemetryHooks) {
  return new MailTs({
    transport: mockTransport,
    queue: { concurrency: 1, maxRetries: 0 },
    telemetry: hooks,
  });
}

describe('TelemetryHooks', () => {
  // ── onSend ────────────────────────────────────────────────────────────────

  it('onSend is called with options, result, and positive latency on success', async () => {
    const onSend = vi.fn();
    const mail = new MailTs({ transport: mockTransport, telemetry: { onSend } });
    await mail.send(baseOpts);
    expect(onSend).toHaveBeenCalledOnce();
    const [opts, result, latency] = onSend.mock.calls[0]!;
    expect(opts).toMatchObject(baseOpts);
    expect(result.ok).toBe(true);
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  it('onError is called when send fails', async () => {
    const onError = vi.fn();
    // Force a failure by pointing at a non-listening port with no pool
    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: 1, pool: false },
      telemetry: { onError },
    });
    await mail.send(baseOpts);
    expect(onError).toHaveBeenCalledOnce();
    const [err, phase] = onError.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect(phase).toBe('send');
  });

  it('onSend is not called when it is not provided', async () => {
    // Should not throw even when no hooks set
    const mail = new MailTs({ devMode: true, telemetry: {} });
    await expect(mail.send(baseOpts)).resolves.toBeDefined();
  });

  // ── Queue hooks ───────────────────────────────────────────────────────────

  it('onQueueEnqueue fires when a job is enqueued', async () => {
    let capturedId: string | undefined;
    let capturedStatus: string | undefined;
    const mail = makeMail({ onQueueEnqueue: (job) => { capturedId = job.id; capturedStatus = job.status; } });
    mail.queue.setSendFn(async () => ok);
    mail.queue.enqueue(baseOpts);
    await mail.queue.drain();
    expect(capturedId).toBeDefined();
    expect(capturedStatus).toBe('pending'); // status at enqueue time, before processing
  });

  it('onQueueSuccess fires when a job succeeds', async () => {
    const onQueueSuccess = vi.fn();
    const mail = makeMail({ onQueueSuccess });
    mail.queue.setSendFn(async () => ok);
    mail.queue.enqueue(baseOpts);
    await mail.queue.drain();
    expect(onQueueSuccess).toHaveBeenCalledOnce();
    const job: QueueJob = onQueueSuccess.mock.calls[0]![0];
    expect(job.status).toBe('success');
  });

  it('onQueueDead fires when a job exhausts retries', async () => {
    const onQueueDead = vi.fn();
    const { SmtpConnError } = await import('../../../src/errors.js');
    const mail = makeMail({ onQueueDead });
    mail.queue.setSendFn(async () => ({
      ok: false,
      error: new SmtpConnError('fail'),
      attempts: 1,
    }));
    mail.queue.enqueue(baseOpts);
    await mail.queue.drain();
    expect(onQueueDead).toHaveBeenCalledOnce();
    const job: QueueJob = onQueueDead.mock.calls[0]![0];
    expect(job.status).toBe('dead');
  });

  it('onQueueRetry fires with correct attempt and delay', async () => {
    const onQueueRetry = vi.fn();
    const { SmtpConnError } = await import('../../../src/errors.js');
    let calls = 0;
    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: 9999 },
      queue: { concurrency: 1, maxRetries: 2, retryDelay: 10, jitter: false },
      telemetry: { onQueueRetry },
    });
    mail.queue.setSendFn(async () => {
      if (++calls < 3) return { ok: false, error: new SmtpConnError('transient'), attempts: calls };
      return ok;
    });
    mail.queue.enqueue(baseOpts);
    await mail.queue.drain();
    expect(onQueueRetry).toHaveBeenCalledTimes(2);
    const [, attempt, delay] = onQueueRetry.mock.calls[0]!;
    expect(attempt).toBe(1);
    expect(delay).toBeGreaterThan(0);
  });

  it('multiple hooks coexist without interfering', async () => {
    const onQueueEnqueue = vi.fn();
    const onQueueSuccess = vi.fn();
    const onSend = vi.fn();
    const mail = new MailTs({
      transport: mockTransport,
      queue: { concurrency: 1, maxRetries: 0 },
      telemetry: { onQueueEnqueue, onQueueSuccess, onSend },
    });
    await mail.send(baseOpts);
    expect(onSend).toHaveBeenCalledOnce();
    // queue hooks only fire when using mail.queue.enqueue
    expect(onQueueEnqueue).not.toHaveBeenCalled();
  });
});
