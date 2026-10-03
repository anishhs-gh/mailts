/**
 * Plan §4 shutdown matrix: drain / keep / cancel × in-memory / SQLite × with / without timeout.
 * None may hang (vitest timeout), and mail is only discarded with `cancel`.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { MailQueue } from '../../../src/queue/MailQueue.js';
import { SqliteQueue } from '../../../src/queue/SqliteQueue.js';
import type { ShutdownPendingMode } from '../../../src/types/queue.js';

const ok = { ok: true as const, messageId: 'm', accepted: [], rejected: [] };
const opts = { to: 'a@x.com', text: 't' };

type Kind = 'memory' | 'sqlite';
const kinds: Kind[] = ['memory', 'sqlite'];

for (const kind of kinds) {
  for (const pending of ['drain', 'keep', 'cancel'] as ShutdownPendingMode[]) {
    for (const timeoutMs of [undefined, 40]) {
      it(`${kind} · ${pending} · ${timeoutMs ? 'timeout' : 'no timeout'}`, async () => {
        const db = join(tmpdir(), `mailts-matrix-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
        let sent = 0;
        // The first job runs until the test releases it (or the queue aborts it), so slow setup —
        // synchronous SQLite writes on a busy CI disk — can never let it finish early. The rest are fast.
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const send = async (_opts: unknown, signal?: AbortSignal) => {
          const n = ++sent;
          if (n === 1) {
            await Promise.race([gate, new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }))]);
          } else {
            await new Promise(r => setTimeout(r, 5));
          }
          return ok;
        };
        const q: MailQueue = kind === 'sqlite' ? new SqliteQueue(db, { concurrency: 1 }, undefined, send) : new MailQueue({ concurrency: 1 });
        if (kind === 'memory') q.setSendFn(send);
        const started = new Promise(r => q.once('started', r));
        for (let i = 0; i < 3; i++) q.enqueue(opts);
        await started; // first job running, the other two pending

        const t0 = Date.now();
        const shutdown = q.shutdown({ pending, timeoutMs });
        // Without a timeout the slow job must finish on its own; with one, the queue interrupts it.
        if (!timeoutMs) setTimeout(release, 50);
        const res = await shutdown;
        const took = Date.now() - t0;

        if (pending === 'cancel') {
          expect(res.cancelled).toBe(2);
          expect(res.remaining).toBe(timeoutMs ? 1 : 0); // slow job interrupted back to pending
        } else if (pending === 'drain' && !timeoutMs) {
          expect(sent).toBe(3);
          expect(res).toEqual({ cancelled: 0, remaining: 0 });
        } else {
          expect(res.cancelled).toBe(0);              // nothing discarded
          expect(res.remaining).toBeGreaterThanOrEqual(1);
        }
        if (timeoutMs) expect(took).toBeLessThan(1_000);

        if (kind === 'sqlite') {
          const st = SqliteQueue.readStats(db);
          // Whatever was not delivered or cancelled is still pending in the database
          expect(st.pending).toBe(res.remaining);
          expect(st.running).toBe(0);
          rmSync(db, { force: true });
          rmSync(`${db}-wal`, { force: true });
          rmSync(`${db}-shm`, { force: true });
        }
      }, 10_000);
    }
  }
}

describe('shutdown timeout timer', () => {
  it('still fires when the timer runs before Date.now() reaches the deadline (blocked event loop)', async () => {
    // After a long synchronous stretch, timers run on libuv's stale loop clock and can fire
    // before Date.now() has reached the deadline. Freeze Date.now() to reproduce that exactly.
    const realNow = Date.now.bind(Date);
    const frozenAt = realNow();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (realNow() - frozenAt < 200 ? frozenAt : realNow()));
    try {
      const q = new MailQueue({ concurrency: 1 });
      q.setSendFn((_o, signal) => new Promise(r => signal?.addEventListener('abort', () => r(ok), { once: true })));
      const started = new Promise(r => q.once('started', r));
      q.enqueue(opts);
      await started;
      const res = await q.shutdown({ pending: 'keep', timeoutMs: 40 });
      expect(res.remaining).toBe(1);   // the never-ending job was interrupted back to pending
    } finally {
      now.mockRestore();
    }
  }, 3_000);
});
