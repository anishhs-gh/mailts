import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { MailQueue } from '../../../src/queue/MailQueue.js';
import { SqliteQueue } from '../../../src/queue/SqliteQueue.js';
import { RateLimiter } from '../../../src/queue/RateLimiter.js';
import type { EmailOptions } from '../../../src/types/core.js';

const ok = { ok: true as const, messageId: 'm', accepted: [], rejected: [] };
const opts: EmailOptions = { from: 'me@x.com', to: 'a@x.com', text: 't' };
const dbFile = () => join(tmpdir(), `mailts-idem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const cleanup = (db: string) => { for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true }); };

describe('idempotency keys (in memory)', () => {
  it('returns the same job for the same key — pending or already sent — and sends once', async () => {
    let sent = 0;
    const q = new MailQueue();
    q.setSendFn(async () => { sent++; return ok; });
    const a = q.enqueue(opts, { idempotencyKey: 'order-1' });
    const b = q.enqueue(opts, { idempotencyKey: 'order-1' });
    expect(b).toBe(a);
    await q.drain();
    expect(q.enqueue(opts, { idempotencyKey: 'order-1' })).toBe(a);
    await q.drain();
    expect(sent).toBe(1);
  });

  it('forgets keys after the window', async () => {
    let sent = 0;
    const q = new MailQueue({ idempotencyWindowMs: 20 });
    q.setSendFn(async () => { sent++; return ok; });
    q.enqueue(opts, { idempotencyKey: 'k' });
    await q.drain();
    await new Promise(r => setTimeout(r, 30));
    q.enqueue(opts, { idempotencyKey: 'k' });
    await q.drain();
    expect(sent).toBe(2);
  });

  it('pins a Message-ID at enqueue so every attempt uses the same one', async () => {
    const ids: string[] = [];
    let n = 0;
    const q = new MailQueue({ retryDelay: 1, jitter: false });
    q.setSendFn(async (o) => {
      ids.push(o.messageId!);
      return ++n === 1 ? { ok: false, error: Object.assign(new Error('x'), { code: 'ECONN', retryable: true }) as never, attempts: 1 } : ok;
    });
    const job = q.enqueue(opts);
    await q.drain();
    expect(job.options.messageId).toMatch(/^<[0-9a-f]+@x\.com>$/);
    expect(ids).toEqual([job.options.messageId, job.options.messageId]);
    expect(q.enqueue({ ...opts, messageId: '<mine@x.com>' }).options.messageId).toBe('<mine@x.com>');
  });
});

describe('idempotency keys (SqliteQueue)', () => {
  it('survive restarts and are shared by processes on one database', async () => {
    const db = dbFile();
    let sent = 0;
    const send = async () => { sent++; return ok; };
    const q1 = new SqliteQueue(db, {}, undefined, send);
    const first = q1.enqueue(opts, { idempotencyKey: 'webhook-42' });
    await q1.drain();
    await q1.shutdown();

    const q2 = new SqliteQueue(db, {}, undefined, send);
    const again = q2.enqueue(opts, { idempotencyKey: 'webhook-42' });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('success');
    await q2.drain();

    const q3 = new SqliteQueue(db, {}, undefined, send);   // concurrent process
    expect(q3.enqueue(opts, { idempotencyKey: 'webhook-42' }).id).toBe(first.id);
    await q3.drain();
    await Promise.all([q2.shutdown(), q3.shutdown()]);
    expect(sent).toBe(1);
    expect(SqliteQueue.readStats(db).succeeded).toBe(1);
    cleanup(db);
  });

  it('releases an expired key for reuse', async () => {
    const db = dbFile();
    let sent = 0;
    const q = new SqliteQueue(db, { idempotencyWindowMs: 20 }, undefined, async () => { sent++; return ok; });
    q.enqueue(opts, { idempotencyKey: 'k' });
    await q.drain();
    await new Promise(r => setTimeout(r, 30));
    (q as unknown as { idempotent: Map<string, unknown> }).idempotent.clear(); // as if a new process
    q.enqueue(opts, { idempotencyKey: 'k' });
    await q.drain();
    await q.shutdown();
    expect(sent).toBe(2);
    cleanup(db);
  });
});

describe('rate limiting', () => {
  it('spreads sends to respect perSecond, without holding slots, and reports throttling', async () => {
    const times: number[] = [];
    const q = new MailQueue({ concurrency: 5, rateLimit: { perSecond: 2 } });
    q.setSendFn(async () => { times.push(Date.now()); return ok; });
    let throttled = 0;
    q.on('throttled', () => { throttled++; });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) q.enqueue(opts);
    await q.drain();
    const rel = times.map(t => t - t0);
    expect(rel.filter(t => t < 900)).toHaveLength(2);        // first second: 2
    expect(rel.filter(t => t >= 900 && t < 1_900)).toHaveLength(2);
    expect(rel.filter(t => t >= 1_900)).toHaveLength(1);
    expect(throttled).toBeGreaterThan(0);
  }, 10_000);

  it('keeps priority order for throttled jobs', async () => {
    const order: string[] = [];
    const q = new MailQueue({ concurrency: 1, rateLimit: { perSecond: 1 } });
    q.setSendFn(async (o) => { order.push(o.subject!); return ok; });
    q.enqueue({ ...opts, subject: 'n1' });
    q.enqueue({ ...opts, subject: 'n2' });
    q.enqueue({ ...opts, subject: 'n3' });
    await new Promise(r => setTimeout(r, 50));
    q.enqueue({ ...opts, subject: 'urgent' }, { priority: 'critical' });
    await q.drain();
    expect(order[0]).toBe('n1');
    expect(order.indexOf('urgent')).toBeLessThan(order.indexOf('n3'));
    expect(order.indexOf('n2')).toBeLessThan(order.indexOf('n3'));
  }, 10_000);

  it('limits per sender and can count recipients', () => {
    const rl = new RateLimiter({ perMinute: 3, by: 'sender', countRecipients: true });
    const job = (from: string, to: string[]) => ({ id: 'x', options: { from, to, text: 't' } } as never);
    const now = 1_000_000;
    expect(rl.waitFor(job('a@x.com', ['1@x', '2@x']), now)).toBe(0);
    rl.record(job('a@x.com', ['1@x', '2@x']), now);
    expect(rl.waitFor(job('a@x.com', ['3@x', '4@x']), now + 10)).toBe(59_990);   // 2 + 2 > 3 → wait until the first use expires
    expect(rl.waitFor(job('a@x.com', ['3@x']), now + 10)).toBe(0);               // 2 + 1 = 3
    expect(rl.waitFor(job('b@x.com', ['1@x', '2@x', '3@x']), now + 10)).toBe(0); // other sender
    expect(new RateLimiter({}).enabled).toBe(false);
  });
});

describe('MailWorker idempotency', () => {
  it('acks a redelivered message with a seen key without sending it again', async () => {
    const { MailWorker } = await import('../../../src/queue/MailWorker.js');
    const deliveries = [
      { id: 'm1', data: { to: 'a@x.com', text: 't' }, idempotencyKey: 'order-9' },
      { id: 'm1-redelivered', data: { to: 'a@x.com', text: 't' }, idempotencyKey: 'order-9' },
    ];
    const acks: string[] = [];
    let sent = 0;
    const w = new MailWorker({
      async dequeue() { return deliveries.shift() ?? null; },
      async ack(id) { acks.push(id); },
      async nack() {},
    }, {
      transport: { name: 't', async send(m) { sent++; await new Promise(r => setTimeout(r, 20)); return { messageId: m.messageId, accepted: m.to, rejected: [] }; } },
      idleDelayMs: 5,
    });
    await w.start();
    await new Promise(r => setTimeout(r, 100));
    await w.shutdown();
    expect(sent).toBe(1);
    expect(acks.sort()).toEqual(['m1', 'm1-redelivered']);
  });
});
