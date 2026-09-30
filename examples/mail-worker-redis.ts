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

import { MailWorker, encodeOptions, decodeOptions } from '@mailts/core';
import type { QueueDriver, DriverMessage } from '@mailts/core';
import type { EmailOptions } from '@mailts/core';

// ── Redis driver ────────────────────────────────────────────────────────────
// Requires: npm install ioredis

import Redis from 'ioredis';

const PENDING  = 'mail:pending';
const INFLIGHT = 'mail:inflight';
const DLQ_KEY  = 'mail:dlq';

interface Envelope { id: string; priority?: DriverMessage['priority']; data: string }

class RedisDriver implements QueueDriver {
  private readonly redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  /** Driver id → exact raw element in the inflight list (LREM needs the element, not the id). */
  private readonly inflight = new Map<string, string>();

  async dequeue(): Promise<DriverMessage | null> {
    // BRPOPLPUSH: atomic move pending → inflight; survives a crash (recover from
    // INFLIGHT on start-up). Blocks up to 1 s, so the worker never spins.
    const raw = await this.redis.brpoplpush(PENDING, INFLIGHT, 1);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope;
    this.inflight.set(env.id, raw);
    // encodeOptions/decodeOptions keep Buffer attachments and Dates intact
    return { id: env.id, priority: env.priority, data: decodeOptions(env.data) };
  }

  async ack(id: string): Promise<void> {
    await this.finish(id);
  }

  async nack(id: string, reason?: Error): Promise<void> {
    await this.finish(id, DLQ_KEY);
    console.error(`[nack] ${id} → ${DLQ_KEY}: ${reason?.message ?? 'failed'}`);
  }

  /** Worker shutdown: hand unstarted messages back so another worker takes them now. */
  async release(id: string): Promise<void> {
    await this.finish(id, PENDING);
  }

  private async finish(id: string, moveTo?: string): Promise<void> {
    const raw = this.inflight.get(id);
    if (!raw) return;
    this.inflight.delete(id);
    const tx = this.redis.multi();
    tx.lrem(INFLIGHT, 1, raw);
    if (moveTo) tx.rpush(moveTo, raw);
    await tx.exec();
  }

  /** Producer side. */
  async enqueue(data: EmailOptions, opts?: { priority?: DriverMessage['priority'] }): Promise<string> {
    const env: Envelope = { id: crypto.randomUUID(), priority: opts?.priority, data: encodeOptions(data) };
    await this.redis.lpush(PENDING, JSON.stringify(env));
    return env.id;
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
  prefetch: 5,          // hold at most concurrency + 5 messages; the rest stay in Redis
  idleDelayMs: 500,     // back-off when Redis is empty
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
worker.on('error',       (err) => console.error('driver error:', err.message)); // ack/nack/dequeue failures

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  console.log('SIGTERM — shutting down (5 s timeout)…');
  await worker.shutdown(5_000);   // unstarted messages are released back to PENDING
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
