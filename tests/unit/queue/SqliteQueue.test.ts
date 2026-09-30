import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, existsSync } from 'fs';
import { resolveQueueDbPath, SqliteQueue } from '../../../src/queue/SqliteQueue.js';
import { homedir } from 'os';

const NODE_MAJOR = parseInt(process.version.slice(1).split('.')[0]!);
const HAS_SQLITE = NODE_MAJOR >= 22;

const baseOpts = { to: 'u@example.com', subject: 'S', text: 'T' };
const ok = { ok: true as const, messageId: 'mid', accepted: [], rejected: [] };

// ── resolveQueueDbPath ────────────────────────────────────────────────────────

describe('resolveQueueDbPath', () => {
  it('returns custom path for string arg', () => {
    expect(resolveQueueDbPath('/my/queue.db')).toBe('/my/queue.db');
  });

  it('returns default ~/.mailts/queue.db for true', () => {
    expect(resolveQueueDbPath(true)).toBe(join(homedir(), '.mailts', 'queue.db'));
  });
});

// ── Node < 22: throws clear error ─────────────────────────────────────────────

describe.skipIf(HAS_SQLITE)('SqliteQueue on Node < 22', () => {
  it('throws a clear error when node:sqlite is unavailable', () => {
    expect(() => new SqliteQueue('/tmp/noop.db')).toThrow('node:sqlite requires Node.js 22+');
  });

  it('static readStats throws on Node < 22', () => {
    expect(() => SqliteQueue.readStats('/tmp/noop.db')).toThrow('node:sqlite requires Node.js 22+');
  });
});

// ── Node 22+: full behaviour ───────────────────────────────────────────────────

describe.skipIf(!HAS_SQLITE)('SqliteQueue (Node 22+)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mailts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath);
  });

  it('persists a job on enqueue', async () => {
    const q = new SqliteQueue(dbPath, { concurrency: 1, maxRetries: 0 });
    q.setSendFn(async () => ok);
    q.enqueue(baseOpts);
    await q.drain();
    q.close();

    const stats = SqliteQueue.readStats(dbPath);
    expect(stats.succeeded).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it('moves failed job to DLQ and persists dead status', async () => {
    const q = new SqliteQueue(dbPath, { concurrency: 1, maxRetries: 0 });
    const { SmtpConnError } = await import('../../../src/errors.js');
    q.setSendFn(async () => ({ ok: false, error: new SmtpConnError('fail'), attempts: 1 }));
    q.enqueue(baseOpts);
    await q.drain();
    q.close();

    const stats = SqliteQueue.readStats(dbPath);
    expect(stats.dead).toBe(1);

    const dlq = SqliteQueue.readDlq(dbPath);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.errors[0]!.message).toBe('fail');
  });

  it('restores pending jobs after restart (crash recovery)', async () => {
    // First instance: enqueue but close before draining
    const q1 = new SqliteQueue(dbPath, { concurrency: 0, maxRetries: 0 });
    // concurrency 0 won't process — just enqueue
    q1.setSendFn(async () => ok);

    // Manually insert a pending row to simulate crash
    const { DatabaseSync } = (await import('node:sqlite')) as any;
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY, options TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL DEFAULT '', errors TEXT NOT NULL DEFAULT '[]'
    )`);
    db.prepare(`INSERT INTO queue_jobs (id, options, status, attempts, created_at, last_attempt_at, errors) VALUES (?,?,?,?,?,?,?)`).run(
      'restore-id',
      JSON.stringify(baseOpts),
      'pending',
      0,
      new Date().toISOString(),
      '',
      '[]',
    );
    db.close();
    q1.close();

    // Second instance: should restore and process the pending job
    const q2 = new SqliteQueue(dbPath, { concurrency: 1, maxRetries: 0 });
    q2.setSendFn(async () => ok);
    await q2.drain();
    q2.close();

    const stats = SqliteQueue.readStats(dbPath);
    expect(stats.succeeded).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it('requeueJob moves a dead job back to pending', async () => {
    // Create a dead job directly
    const { DatabaseSync } = (await import('node:sqlite')) as any;
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY, options TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL DEFAULT '', errors TEXT NOT NULL DEFAULT '[]'
    )`);
    db.prepare(`INSERT INTO queue_jobs VALUES (?,?,?,?,?,?,?)`).run(
      'dead-id', JSON.stringify(baseOpts), 'dead', 3,
      new Date().toISOString(), '', '[]',
    );
    db.close();

    const changed = SqliteQueue.requeueJob(dbPath, 'dead-id');
    expect(changed).toBe(true);

    const stats = SqliteQueue.readStats(dbPath);
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(0);
  });

  it('requeueJob returns false for non-existent or non-dead job', async () => {
    const { DatabaseSync } = (await import('node:sqlite')) as any;
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY, options TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL DEFAULT '', errors TEXT NOT NULL DEFAULT '[]'
    )`);
    db.close();

    expect(SqliteQueue.requeueJob(dbPath, 'ghost-id')).toBe(false);
  });

  it('clearDlq removes all dead jobs', async () => {
    const { DatabaseSync } = (await import('node:sqlite')) as any;
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY, options TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL DEFAULT '', errors TEXT NOT NULL DEFAULT '[]'
    )`);
    db.prepare(`INSERT INTO queue_jobs VALUES (?,?,?,?,?,?,?)`).run('d1', JSON.stringify(baseOpts), 'dead', 1, new Date().toISOString(), '', '[]');
    db.prepare(`INSERT INTO queue_jobs VALUES (?,?,?,?,?,?,?)`).run('d2', JSON.stringify(baseOpts), 'dead', 1, new Date().toISOString(), '', '[]');
    db.close();

    SqliteQueue.clearDlq(dbPath);
    expect(SqliteQueue.readDlq(dbPath)).toHaveLength(0);
  });

  it('readStats returns zeros on empty db', async () => {
    const q = new SqliteQueue(dbPath, {});
    q.close();
    const stats = SqliteQueue.readStats(dbPath);
    expect(stats).toEqual({ pending: 0, scheduled: 0, running: 0, succeeded: 0, dead: 0, cancelled: 0 });
  });

  it('delivers a job enqueued before a crash exactly once, under its original id (regression)', async () => {
    const { spawnSync } = await import('child_process');
    const { writeFileSync } = await import('fs');
    const scriptPath = join(tmpdir(), `mailts-crash-${Date.now()}.ts`);
    writeFileSync(scriptPath, `
      import { SqliteQueue } from ${JSON.stringify(join(process.cwd(), 'src/queue/SqliteQueue.ts'))};
      const q = new SqliteQueue(${JSON.stringify(dbPath)}, { concurrency: 1 });
      q.pause();
      const job = q.enqueue({ to: 'u@example.com', subject: 'S', text: 'T',
        attachments: [{ filename: 'a.bin', content: Buffer.from([0, 1, 2, 255]) }],
        date: new Date('2024-01-02T03:04:05Z') });
      process.stdout.write(job.id + '\\n', () => process.kill(process.pid, 'SIGKILL'));
    `);
    const viteNode = join(process.cwd(), 'node_modules/.bin/vite-node');
    const res = spawnSync(viteNode, [scriptPath], { encoding: 'utf8' });
    rmSync(scriptPath);
    const jobId = res.stdout.trim().split('\n').pop()!;
    expect(jobId).toMatch(/^[0-9a-f]{16}$/);

    const sent: Array<{ id?: string; content: Buffer; date: unknown }> = [];
    const q = new SqliteQueue(dbPath, { concurrency: 2 }, undefined, async (opts) => {
      sent.push({ content: opts.attachments![0]!.content as Buffer, date: opts.date });
      return ok;
    });
    await q.drain();
    await q.shutdown();

    expect(sent).toHaveLength(1);
    expect(Buffer.isBuffer(sent[0]!.content)).toBe(true);
    expect([...sent[0]!.content]).toEqual([0, 1, 2, 255]);
    expect(sent[0]!.date).toBeInstanceOf(Date);

    const stats = SqliteQueue.readStats(dbPath);
    expect(stats).toMatchObject({ succeeded: 1, pending: 0, running: 0 });

    // A third start must not send it again
    let again = 0;
    const q3 = new SqliteQueue(dbPath, {}, undefined, async () => { again++; return ok; });
    await q3.drain();
    await q3.shutdown();
    expect(again).toBe(0);
  });

  it('shutdown() keeps pending jobs for the next process instead of cancelling them (regression)', async () => {
    const q1 = new SqliteQueue(dbPath, { concurrency: 1 });
    q1.pause();
    q1.enqueue(baseOpts);
    q1.enqueue(baseOpts);
    const res = await q1.shutdown();
    expect(res).toEqual({ cancelled: 0, remaining: 2 });
    expect(SqliteQueue.readStats(dbPath)).toMatchObject({ pending: 2, cancelled: 0 });

    let sent = 0;
    const q2 = new SqliteQueue(dbPath, { concurrency: 2 }, undefined, async () => { sent++; return ok; });
    await q2.drain();
    await q2.shutdown();
    expect(sent).toBe(2);
  });

  it('two queues on one database never send the same job twice', async () => {
    const seed = new SqliteQueue(dbPath, {});
    seed.pause();
    for (let i = 0; i < 20; i++) seed.enqueue({ ...baseOpts, subject: `m${i}` });
    await seed.shutdown();

    const seen: string[] = [];
    const send = async (o: { subject?: string }) => { seen.push(o.subject!); await new Promise(r => setTimeout(r, 2)); return ok; };
    const a = new SqliteQueue(dbPath, { concurrency: 3 }, undefined, send as never);
    const b = new SqliteQueue(dbPath, { concurrency: 3 }, undefined, send as never);
    await Promise.all([a.drain(), b.drain()]);
    await Promise.all([a.shutdown(), b.shutdown()]);

    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it('rejects stream attachments at enqueue time', async () => {
    const { Readable } = await import('stream');
    const q = new SqliteQueue(dbPath, {});
    q.pause();
    expect(() => q.enqueue({ ...baseOpts, attachments: [{ filename: 'x', content: Readable.from(['a']) }] }))
      .toThrow(/stream/);
    await q.shutdown();
  });

  it('migrates a 0.4 database and delivers its rows once with original ids and attachments', async () => {
    const { DatabaseSync } = (await import('node:sqlite')) as any;
    const db = new DatabaseSync(dbPath);
    // Exact 0.4.0 schema, plus a row written the 0.4 way (JSON.stringify(options))
    db.exec(`CREATE TABLE queue_jobs (
      id TEXT PRIMARY KEY, options TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_attempt_at TEXT NOT NULL DEFAULT '',
      errors TEXT NOT NULL DEFAULT '[]', cancelled_at TEXT
    ); CREATE TABLE queue_control (job_id TEXT PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);`);
    const legacyOptions = JSON.stringify({
      ...baseOpts, date: new Date('2026-01-01T00:00:00Z'),
      attachments: [{ filename: 'a.bin', content: Buffer.from([1, 2, 3]) }],
    });
    db.prepare(`INSERT INTO queue_jobs (id, options, status, priority, attempts, created_at) VALUES (?,?,?,?,?,?)`)
      .run('legacy-1', legacyOptions, 'running', 'high', 1, new Date().toISOString());
    db.close();

    const seen: Array<{ content: unknown; date: unknown }> = [];
    const q = new SqliteQueue(dbPath, {}, undefined, async (o) => {
      seen.push({ content: o.attachments![0]!.content, date: o.date });
      return ok;
    });
    const restored = q.get('legacy-1');
    expect(restored?.priority).toBe('high');
    await q.drain();
    await q.shutdown();

    expect(seen).toHaveLength(1);
    expect([...(seen[0]!.content as Buffer)]).toEqual([1, 2, 3]);
    expect(seen[0]!.date).toBeInstanceOf(Date);
    const check = new DatabaseSync(dbPath);
    expect(check.prepare('PRAGMA user_version').get().user_version).toBe(2);
    expect(check.prepare(`SELECT status, attempts FROM queue_jobs WHERE id='legacy-1'`).get()).toEqual({ status: 'success', attempts: 2 });
    check.close();
  });

  it('applies cross-process cancel requests from the CLI', async () => {
    const q = new SqliteQueue(dbPath, {});
    q.pause();
    const job = q.enqueue(baseOpts);
    SqliteQueue.requestCancel(dbPath, job.id);
    (q as unknown as { poll(): void }).poll();
    expect(job.status).toBe('cancelled');
    expect(SqliteQueue.readStats(dbPath).cancelled).toBe(1);
    await q.shutdown();
  });

  it('keeps retry schedules across restarts', async () => {
    const { SmtpConnError } = await import('../../../src/errors.js');
    const q1 = new SqliteQueue(dbPath, { retryDelay: 60_000, jitter: false }, undefined,
      async () => ({ ok: false, error: new SmtpConnError('down'), attempts: 1 }));
    q1.enqueue(baseOpts);
    await new Promise(r => setTimeout(r, 20));
    expect(q1.stats().scheduled).toBe(1);
    await q1.shutdown();

    const q2 = new SqliteQueue(dbPath, {}, undefined, async () => ok);
    const [job] = q2.list();
    expect(job!.status).toBe('scheduled');
    expect(job!.notBefore!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    await q2.shutdown({ pending: 'keep' });
  });
});
