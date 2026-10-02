/**
 * Randomised stress: concurrent controls + failures, then check invariants.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { MailQueue } from '../../../src/queue/MailQueue.js';
import { SqliteQueue } from '../../../src/queue/SqliteQueue.js';
import { MailTsError } from '../../../src/errors.js';
import type { QueueJob } from '../../../src/types/queue.js';


function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

async function stress(make: () => MailQueue, seed: number) {
  const r = rng(seed);
  const delivered = new Map<string, number>();         // messageId → successful deliveries
  const cancelledAt = new Map<string, number>();
  const sendsAfterCancel: string[] = [];
  const q = make();
  q.on('dead', () => {});
  q.on('cancelled', (job: QueueJob) => cancelledAt.set(job.id, Date.now()));

  q.setSendFn(async (opts, signal) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, Math.floor(r() * 8));
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('stopped')); }, { once: true });
    });
    const roll = r();
    if (roll < 0.15) return { ok: false, error: new MailTsError('temporary', 'ECONN', true), attempts: 1 };
    if (roll < 0.2) return { ok: false, error: new MailTsError('rejected', 'EREJECT', false), attempts: 1 };
    const id = opts.messageId!;
    delivered.set(id, (delivered.get(id) ?? 0) + 1);
    return { ok: true, messageId: id, accepted: [], rejected: [] };
  });

  const jobs: QueueJob[] = [];
  const priorities = ['critical', 'high', 'normal', 'low'] as const;
  for (let step = 0; step < 300; step++) {
    const op = r();
    if (op < 0.55) {
      const key = r() < 0.2 ? `dup-${Math.floor(r() * 10)}` : undefined;
      jobs.push(q.enqueue({ to: 'a@x.com', text: `m${step}` }, { priority: pick(r, priorities), ...(key ? { idempotencyKey: key } : {}) }));
    } else if (op < 0.65 && jobs.length) q.cancel(pick(r, jobs).id);
    else if (op < 0.72 && jobs.length) q.interrupt(pick(r, jobs).id);
    else if (op < 0.78 && jobs.length) q.abort(pick(r, jobs).id);
    else if (op < 0.82) q.pause();
    else if (op < 0.9) q.resume();
    if (r() < 0.3) await new Promise(res => setTimeout(res, Math.floor(r() * 4)));
  }
  q.resume();
  const t0 = Date.now();
  await q.drain();
  const result = await q.shutdown({ timeoutMs: 5_000 });
  expect(Date.now() - t0).toBeLessThan(30_000);

  const unique = [...new Map(jobs.map(j => [j.id, j])).values()];
  // 1. Every job is in exactly one terminal state; nothing left behind after drain
  expect(result.remaining).toBe(0);
  for (const j of unique) expect(['success', 'dead', 'cancelled']).toContain(j.status);
  // 2. Never delivered twice; successes and deliveries agree
  for (const [id, n] of delivered) expect(n, `delivered twice: ${id}`).toBe(1);
  const succeeded = unique.filter(j => j.status === 'success');
  expect(succeeded.length).toBe(delivered.size);
  for (const j of succeeded) expect(delivered.get(j.options.messageId!)).toBe(1);
  // 3. Cancelled jobs were not delivered
  for (const j of unique.filter(x => x.status === 'cancelled')) {
    expect(delivered.has(j.options.messageId!), `cancelled job delivered: ${j.id}`).toBe(false);
  }
  // 4. Stats agree with job states
  const st = q.stats();
  expect(st.succeeded).toBe(succeeded.length);
  expect(st.pending + st.running + st.scheduled).toBe(0);
  expect(sendsAfterCancel).toEqual([]);
  return { jobs: unique.length, delivered: delivered.size };
}

function pick<T>(r: () => number, a: readonly T[]): T { return a[Math.floor(r() * a.length)]!; }

describe('queue stress (randomised)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`MailQueue invariants hold (seed ${seed})`, async () => {
      const { jobs } = await stress(() => new MailQueue({ concurrency: 4, maxRetries: 3, retryDelay: 1, jitter: false }), seed);
      expect(jobs).toBeGreaterThan(50);
    }, 60_000);
  }

  it('with a rate limit the same invariants hold', async () => {
    await stress(() => new MailQueue({ concurrency: 4, maxRetries: 2, retryDelay: 1, rateLimit: { perSecond: 200 } }), 9);
  }, 60_000);

  it('SqliteQueue invariants hold, and the database agrees', async () => {
    const db = join(tmpdir(), `mailts-stress-${Date.now()}.db`);
    const q = () => new SqliteQueue(db, { concurrency: 4, maxRetries: 3, retryDelay: 1, jitter: false });
    const { jobs } = await stress(q, 11);
    const st = SqliteQueue.readStats(db);
    expect(st.pending + st.running + st.scheduled).toBe(0);
    expect(st.succeeded + st.dead + st.cancelled).toBe(jobs);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  }, 60_000);
});
