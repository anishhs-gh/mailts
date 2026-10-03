/**
 * examples/queue-driver-postgres.ts against a real Postgres engine (PGlite, in-process).
 * Run with: npm run test:integration
 *
 * PGlite has one connection, so statements are serialised: this proves the SQL and the
 * driver/worker contract (priority, dedupe, leases, crash recovery, retry cap), not
 * SKIP LOCKED under true concurrency.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createSchema, enqueue, PostgresDriver, type Db } from '../../examples/queue-driver-postgres.js';
import { MailWorker } from '../../src/queue/MailWorker.js';
import type { Transport } from '../../src/transports/Transport.js';

const RUN = process.env['MAILTS_IT'] === '1';

describe.skipIf(!RUN)('Postgres queue driver (PGlite)', () => {
  let db: Db;
  const rows = async () =>
    (await db.query<{ id: string; status: string; attempts: number; last_error: string | null }>(
      'SELECT id::text, status, attempts, last_error FROM mail_jobs ORDER BY id')).rows;
  const row = async (id: string | null) => (await rows()).find(r => r.id === id)!;

  beforeEach(async () => {
    const pg = new PGlite();
    db = { query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await pg.query<R>(sql, params)).rows }) };
    await createSchema(db);
    await createSchema(db); // idempotent
  });

  it('claims by priority, dedupes idempotency keys and keeps Buffer attachments', async () => {
    const low = await enqueue(db, { to: 'a@x.com', text: 'low' }, { priority: 'low' });
    const crit = await enqueue(db, { to: 'a@x.com', text: 'c', attachments: [{ filename: 'b', content: Buffer.from([0, 255, 1]) }] },
      { priority: 'critical', idempotencyKey: 'k1' });
    expect(await enqueue(db, { to: 'a@x.com', text: 'dup' }, { idempotencyKey: 'k1' })).toBeNull();
    const norm = await enqueue(db, { to: 'a@x.com', text: 'n' });

    const d = new PostgresDriver(db);
    const m1 = (await d.dequeue())!;
    expect(m1).toMatchObject({ id: crit, priority: 'critical', idempotencyKey: 'k1' });
    expect([...(m1.data.attachments![0]!.content as Buffer)]).toEqual([0, 255, 1]);
    expect((await d.dequeue())!.id).toBe(norm);
    expect((await d.dequeue())!.id).toBe(low);
    expect(await d.dequeue()).toBeNull();
  });

  it('ack / nack / release / cancel set the right state; late acks are harmless', async () => {
    const ids = [await enqueue(db, { to: 'a@x.com', text: '1' }), await enqueue(db, { to: 'a@x.com', text: '2' }),
      await enqueue(db, { to: 'a@x.com', text: '3' }), await enqueue(db, { to: 'a@x.com', text: '4' })];
    const d = new PostgresDriver(db);
    for (let i = 0; i < 4; i++) await d.dequeue();
    await d.ack(ids[0]!);
    await d.nack(ids[1]!, new Error('550 no such user'));
    await d.release(ids[2]!);
    await d.cancel(ids[3]!);
    expect((await rows()).map(r => r.status)).toEqual(['sent', 'dead', 'pending', 'cancelled']);
    expect((await row(ids[1]!)).last_error).toBe('550 no such user');
    expect((await row(ids[2]!)).attempts).toBe(0);
    await d.ack(ids[0]!);
    await d.nack(ids[0]!);
    expect((await row(ids[0]!)).status).toBe('sent');
  });

  it("reclaims a crashed instance's job after its lease, and dead-letters it after maxAttempts", async () => {
    const id = await enqueue(db, { to: 'a@x.com', text: 'crashy' });
    const crashing = new PostgresDriver(db, { leaseSeconds: 0, maxAttempts: 3 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await crashing.dequeue())?.id).toBe(id); // claimed, then the "worker" dies
      await new Promise(r => setTimeout(r, 5));
    }
    expect(await crashing.dequeue()).toBeNull();
    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 3 });
    expect((await row(id)).last_error).toMatch(/lease expired 3 times/);
  });

  it('several MailWorkers drain the queue exactly once, including a job from a worker that died mid-send', async () => {
    const delivered: string[] = [];
    const transport: Transport = {
      name: 'mem',
      async send(msg, opts) {
        delivered.push(opts.subject!);
        return { messageId: msg.messageId, accepted: msg.to, rejected: [] };
      },
    };
    for (let i = 0; i < 20; i++) await enqueue(db, { from: 's@x.com', to: 'r@x.com', subject: `m${i}`, text: 'x' });

    // A worker that claims one job and dies before sending (lease 0 → immediately reclaimable).
    const orphan = await new PostgresDriver(db, { leaseSeconds: 0 }).dequeue();
    expect(orphan).not.toBeNull();
    await new Promise(r => setTimeout(r, 5));

    const workers = [1, 2, 3].map(() => new MailWorker(new PostgresDriver(db), { transport, idleDelayMs: 10, queue: { concurrency: 2 } }));
    await Promise.all(workers.map(w => w.start()));
    for (let i = 0; i < 300 && delivered.length < 20; i++) await new Promise(r => setTimeout(r, 10));
    await Promise.all(workers.map(w => w.shutdown(1_000)));

    expect([...delivered].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`).sort());
    expect(new Set(delivered).size).toBe(20);
    const states = await rows();
    expect(states.every(r => r.status === 'sent')).toBe(true);
    expect(states.find(r => r.id === orphan!.id)!.attempts).toBe(2);
  });
});
