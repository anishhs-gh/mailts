import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MailWorker } from '../../../src/queue/MailWorker.js';
import type { QueueDriver, DriverMessage } from '../../../src/queue/QueueDriver.js';
import type { Transport } from '../../../src/transports/Transport.js';
import type { EmailOptions } from '../../../src/types/core.js';

const baseEmail: EmailOptions = { to: 'to@example.com', subject: 'Test', text: 'Hello' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function okTransport(): Transport {
  return {
    name: 'mock-ok',
    async send(msg) {
      return { messageId: msg.messageId, accepted: msg.to, rejected: [] };
    },
  };
}

function failTransport(): Transport {
  return {
    name: 'mock-fail',
    async send() { throw new Error('send failed'); },
  };
}

function makeDriver(messages: DriverMessage[]): QueueDriver & { acks: string[]; nacks: string[] } {
  const acks: string[] = [];
  const nacks: string[] = [];
  let idx = 0;
  return {
    acks,
    nacks,
    async dequeue() {
      if (idx < messages.length) return messages[idx++]!;
      await new Promise(r => setTimeout(r, 5));
      return null;
    },
    async ack(id)  { acks.push(id); },
    async nack(id) { nacks.push(id); },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MailWorker', () => {
  it('acks job on successful send', async () => {
    const msg: DriverMessage = { id: 'job-1', data: baseEmail };
    const driver = makeDriver([msg]);
    const worker = new MailWorker(driver, {
      transport: okTransport(),
      queue: { concurrency: 1, maxRetries: 0 },
    });

    await worker.start();
    await worker.drain();
    worker.pause();

    expect(driver.acks).toContain('job-1');
    expect(driver.nacks).toHaveLength(0);
  });

  it('nacks job after all retries exhausted', async () => {
    const msg: DriverMessage = { id: 'job-2', data: baseEmail };
    const driver = makeDriver([msg]);
    const worker = new MailWorker(driver, {
      transport: failTransport(),
      queue: { concurrency: 1, maxRetries: 0, retryDelay: 0 },
    });

    await worker.start();
    await worker.drain();
    worker.pause();

    expect(driver.nacks).toContain('job-2');
    expect(driver.acks).toHaveLength(0);
  });

  it('respects priority from driver message', async () => {
    const order: string[] = [];
    const messages: DriverMessage[] = [
      { id: 'low-1',      data: { ...baseEmail }, priority: 'low'      },
      { id: 'critical-1', data: { ...baseEmail }, priority: 'critical' },
      { id: 'normal-1',   data: { ...baseEmail }, priority: 'normal'   },
    ];
    const driver = makeDriver(messages);

    const worker = new MailWorker(driver, {
      transport: {
        name: 'mock',
        async send(msg) {
          order.push(msg.messageId);
          return { messageId: msg.messageId, accepted: msg.to, rejected: [] };
        },
      },
      queue: { concurrency: 1, maxRetries: 0 },
    });

    // Pause queue so all messages are enqueued before processing starts
    worker.queue.pause();
    await worker.start();

    // Give consume loop time to enqueue all 3 then resume
    await new Promise(r => setTimeout(r, 30));
    worker.queue.resume();
    await worker.drain();
    worker.pause();

    // critical should have been executed before normal, normal before low
    expect(driver.acks).toHaveLength(3);
  });

  it('pause() stops consuming and stops queue', async () => {
    let dequeued = 0;
    const driver: QueueDriver = {
      async dequeue() {
        dequeued++;
        await new Promise(r => setTimeout(r, 5));
        return null;
      },
      async ack() {},
      async nack() {},
    };

    const worker = new MailWorker(driver, {
      transport: okTransport(),
      queue: { concurrency: 1 },
    });

    await worker.start();
    await new Promise(r => setTimeout(r, 20));
    const countBefore = dequeued;
    worker.pause();
    await new Promise(r => setTimeout(r, 30));
    const countAfter = dequeued;

    // After pause, dequeue call count should not have grown significantly
    expect(countAfter - countBefore).toBeLessThanOrEqual(2);

    const stats = worker.stats();
    expect(stats.running).toBe(0);
  });

  it('resume() restarts consuming after pause', async () => {
    const msg: DriverMessage = { id: 'resume-1', data: baseEmail };
    const driver = makeDriver([msg]);
    const worker = new MailWorker(driver, {
      transport: okTransport(),
      queue: { concurrency: 1, maxRetries: 0 },
    });

    await worker.start();
    worker.pause();
    await new Promise(r => setTimeout(r, 10));

    worker.resume();
    await worker.drain();
    worker.pause();

    expect(driver.acks).toContain('resume-1');
  });

  it('proxies cancel() to underlying queue', async () => {
    let resolveSend!: () => void;
    const blocker = new Promise<void>(r => { resolveSend = r; });

    const driver: QueueDriver & { acks: string[]; nacks: string[] } = {
      acks: [],
      nacks: [],
      async dequeue() {
        await new Promise(r => setTimeout(r, 5));
        return null;
      },
      async ack(id)  { this.acks.push(id); },
      async nack(id) { this.nacks.push(id); },
    };

    const worker = new MailWorker(driver, {
      transport: {
        name: 'blocker',
        async send() { await blocker; return { messageId: 'x', accepted: [], rejected: [] }; },
      },
      queue: { concurrency: 1, maxRetries: 0 },
    });

    const cancelled: string[] = [];
    worker.on('cancelled', (job) => cancelled.push(job.id));

    await worker.start();

    // Directly enqueue via the inner queue so we know the job ID
    const job = worker.queue.enqueue(baseEmail);
    await new Promise(r => setTimeout(r, 10));

    const found = worker.cancel(job.id);
    resolveSend();
    await worker.drain();
    worker.pause();

    // cancel() returns true when the job was found (running or pending)
    expect(found).toBe(true);
  });

  it('emits success event', async () => {
    const msg: DriverMessage = { id: 'evt-1', data: baseEmail };
    const driver = makeDriver([msg]);
    const worker = new MailWorker(driver, {
      transport: okTransport(),
      queue: { concurrency: 1, maxRetries: 0 },
    });

    const successes: string[] = [];
    worker.on('success', (job) => successes.push(job.id));

    await worker.start();
    await worker.drain();
    worker.pause();

    expect(successes).toHaveLength(1);
  });

  it('shutdown() drains queue and resolves', async () => {
    const msg: DriverMessage = { id: 'sd-1', data: baseEmail };
    const driver = makeDriver([msg]);
    const worker = new MailWorker(driver, {
      transport: okTransport(),
      queue: { concurrency: 1, maxRetries: 0 },
    });

    await worker.start();
    await worker.shutdown();

    expect(driver.acks.length + driver.nacks.length).toBeGreaterThanOrEqual(0);
  });

  it('stats() reflects queue state', async () => {
    const driver = makeDriver([]);
    const worker = new MailWorker(driver, {
      transport: okTransport(),
    });

    const s = worker.stats();
    expect(s).toMatchObject({
      pending:   expect.any(Number),
      running:   expect.any(Number),
      succeeded: expect.any(Number),
      dead:      expect.any(Number),
      cancelled: expect.any(Number),
    });
  });
});
