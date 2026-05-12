/**
 * MailWorker + Redis — external persistence, full lifecycle control.
 *
 * Pattern:
 *   Redis owns persistence (pending list, inflight list, DLQ list).
 *   MailWorker owns execution (concurrency, priority, pause/resume/cancel/interrupt/abort).
 *
 * Run:
 *   REDIS_URL=redis://localhost:6379 npx tsx examples/mail-worker-redis.ts
 */

import { MailWorker } from '@mailts/core';
import type { QueueDriver, DriverMessage } from '@mailts/core';
import type { EmailOptions } from '@mailts/core';

// ── Redis driver ────────────────────────────────────────────────────────────
// Requires: npm install ioredis

import Redis from 'ioredis';

const PENDING  = 'mail:pending';
const INFLIGHT = 'mail:inflight';
const DLQ_KEY  = 'mail:dlq';

class RedisDriver implements QueueDriver {
  private readonly redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');

  async dequeue(): Promise<DriverMessage | null> {
    // BRPOPLPUSH: atomic move pending → inflight; survives process crash
    // (message stays in inflight and can be recovered on restart)
    const raw = await this.redis.brpoplpush(PENDING, INFLIGHT, 1);
    if (!raw) return null;
    return JSON.parse(raw) as DriverMessage;
  }

  async ack(id: string): Promise<void> {
    await this.redis.lrem(INFLIGHT, 1, id);
  }

  async nack(id: string, _reason?: Error): Promise<void> {
    // Move from inflight → DLQ; external system handles re-drive
    await this.redis.lmove(INFLIGHT, DLQ_KEY, 'LEFT', 'RIGHT');
    console.error(`[nack] Job ${id} moved to ${DLQ_KEY}`);
  }

  /** Enqueue a message from the producer side. */
  async enqueue(data: EmailOptions, opts?: { priority?: DriverMessage['priority'] }): Promise<string> {
    const id = crypto.randomUUID();
    const msg: DriverMessage = { id, data, priority: opts?.priority };
    await this.redis.lpush(PENDING, JSON.stringify(msg));
    return id;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// ── Worker setup ────────────────────────────────────────────────────────────

const driver = new RedisDriver();

const worker = new MailWorker(driver, {
  smtp: {
    host: process.env['SMTP_HOST'] ?? 'smtp.gmail.com',
    port: 587,
    auth: {
      type:  'plain',
      user:  process.env['SMTP_USER'] ?? 'you@gmail.com',
      pass:  process.env['SMTP_PASS'] ?? '',
    },
  },
  queue: {
    concurrency:  5,
    maxRetries:   3,
    retryDelay:   2_000,
    retryBackoff: 'exponential',
    defaultPriority: 'normal',
  },
});

worker.on('success',     (job) => console.log(`✓  ${job.id}`));
worker.on('dead',        (job) => console.error(`✗  ${job.id} — moved to Redis DLQ`));
worker.on('retry',       (job, attempt) => console.warn(`↺  ${job.id} attempt ${attempt}`));
worker.on('cancelled',   (job) => console.log(`⊘  ${job.id} cancelled`));
worker.on('interrupted', (job) => console.log(`⏸  ${job.id} interrupted → requeued`));

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  console.log('SIGTERM — shutting down (5 s timeout)…');
  await worker.shutdown(5_000);
  await driver.close();
  process.exit(0);
});

// ── Demo: enqueue a few messages then show lifecycle controls ────────────────

async function run(): Promise<void> {
  // Produce some messages
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const priority = i === 1 ? 'critical' : i <= 3 ? 'high' : 'normal';
    const id = await driver.enqueue(
      { to: `user${i}@example.com`, subject: `Email ${i}`, text: `Hello from job ${i}` },
      { priority },
    );
    ids.push(id);
    console.log(`Enqueued ${id} (${priority})`);
  }

  // Start the worker
  await worker.start();
  console.log('Worker started');

  // Pause after 50 ms — some jobs may have already sent
  await new Promise(r => setTimeout(r, 50));
  worker.pause();
  console.log('Paused — remaining jobs stay safely in Redis');

  // Resume after 200 ms
  await new Promise(r => setTimeout(r, 200));
  console.log('Resuming…');
  worker.resume();

  // Wait for everything to finish
  await worker.drain();
  console.log('All done. Stats:', worker.stats());

  await worker.shutdown();
  await driver.close();
}

run().catch(console.error);
