/**
 * Plan §4 shutdown matrix: drain / keep / cancel × in-memory / SQLite × with / without timeout.
 * None may hang (vitest timeout), and mail is only discarded with `cancel`.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { MailQueue } from '../../../src/queue/MailQueue.js';
import { SqliteQueue } from '../../../src/queue/SqliteQueue.js';
import type { ShutdownPendingMode } from '../../../src/types/queue.js';

const HAS_SQLITE = Number(process.versions.node.split('.')[0]) >= 22;
const ok = { ok: true as const, messageId: 'm', accepted: [], rejected: [] };
const opts = { to: 'a@x.com', text: 't' };

type Kind = 'memory' | 'sqlite';
const kinds: Kind[] = HAS_SQLITE ? ['memory', 'sqlite'] : ['memory'];

for (const kind of kinds) {
  for (const pending of ['drain', 'keep', 'cancel'] as ShutdownPendingMode[]) {
    for (const timeoutMs of [undefined, 40]) {
      it(`${kind} · ${pending} · ${timeoutMs ? 'timeout' : 'no timeout'}`, async () => {
        const db = join(tmpdir(), `mailts-matrix-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
        let sent = 0;
        // The first job is slow (exceeds the timeout); the rest are fast.
        const send = async () => {
          const n = ++sent;
          await new Promise(r => setTimeout(r, n === 1 && timeoutMs ? 400 : 5));
          return ok;
        };
        const q: MailQueue = kind === 'sqlite' ? new SqliteQueue(db, { concurrency: 1 }, undefined, send) : new MailQueue({ concurrency: 1 });
        if (kind === 'memory') q.setSendFn(send);
        for (let i = 0; i < 3; i++) q.enqueue(opts);
        await new Promise(r => setTimeout(r, 2)); // first job running

        const t0 = Date.now();
        const res = await q.shutdown({ pending, timeoutMs });
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

describe.skipIf(HAS_SQLITE)('shutdown matrix', () => {
  it('SQLite cases need Node 22+', () => { expect(HAS_SQLITE).toBe(false); });
});
