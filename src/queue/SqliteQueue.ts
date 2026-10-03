import { createRequire } from 'module';
import { homedir, hostname } from 'os';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { MailQueue, type SendFn } from './MailQueue.js';
import { encodeOptions, decodeOptions, encodeErrors, decodeErrors } from './JobCodec.js';
import type { QueueOptions, QueueJob, QueueStats, JobPriority, ShutdownOptions, ShutdownResult } from '../types/queue.js';
import { QueueError } from '../errors.js';
import type { Logger } from '../logger/Logger.js';

// node:sqlite types — flagged before Node 22.13, typed as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseSync = any;

function loadSqlite(): { DatabaseSync: new (path: string, opts?: unknown) => DatabaseSync } {
  try {
    const req = createRequire(import.meta.url);
    return req('node:sqlite');
  } catch {
    throw new Error('node:sqlite requires Node.js 22.13+. Upgrade Node or remove queue.persist from config.');
  }
}

/** File used for `queue.persist`: the given path, or `~/.mailts/queue.db` for `true`. */
export function resolveQueueDbPath(persist: string | boolean): string {
  if (typeof persist === 'string') return persist;
  return join(homedir(), '.mailts', 'queue.db');
}

/** Schema version stored in `PRAGMA user_version`. */
const SCHEMA_VERSION = 3;
/** A claim expires when its owner stops renewing it (crash, kill -9). */
const LEASE_MS = 30_000;
const POLL_MS = 5_000;

interface Row {
  id: string;
  options: string;
  status: QueueJob['status'];
  priority: string;
  attempts: number;
  created_at: string;
  last_attempt_at: string;
  errors: string;
  cancelled_at: string | null;
  not_before: string | null;
  owner: string | null;
  lease_until: number | null;
  idempotency_key: string | null;
}

function rowToJob(row: Row): QueueJob {
  const job: QueueJob = {
    id: row.id,
    options: decodeOptions(row.options),
    status: row.status,
    priority: (row.priority as JobPriority) ?? 'normal',
    attempts: row.attempts,
    errors: decodeErrors(row.errors),
    createdAt: new Date(row.created_at),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : null,
  };
  if (row.cancelled_at) job.cancelledAt = new Date(row.cancelled_at);
  if (row.not_before) job.notBefore = new Date(row.not_before);
  if (row.idempotency_key) job.idempotencyKey = row.idempotency_key;
  return job;
}

function openDatabase(dbPath: string): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

/** Create or upgrade the schema. Safe to run from several processes. */
function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id              TEXT PRIMARY KEY,
      options         TEXT NOT NULL,
      status          TEXT NOT NULL,
      priority        TEXT NOT NULL DEFAULT 'normal',
      attempts        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL DEFAULT '',
      errors          TEXT NOT NULL DEFAULT '[]',
      cancelled_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS queue_control (
      job_id     TEXT PRIMARY KEY,
      action     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const cols = new Set((db.prepare('PRAGMA table_info(queue_jobs)').all() as Array<{ name: string }>).map(c => c.name));
  const add = (name: string, ddl: string) => { if (!cols.has(name)) db.exec(`ALTER TABLE queue_jobs ADD COLUMN ${ddl}`); };
  add('priority', `priority TEXT NOT NULL DEFAULT 'normal'`);
  add('cancelled_at', 'cancelled_at TEXT');
  add('not_before', 'not_before TEXT');
  add('owner', 'owner TEXT');
  add('lease_until', 'lease_until INTEGER');
  add('idempotency_key', 'idempotency_key TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS queue_jobs_status ON queue_jobs(status)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_idem ON queue_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * `MailQueue` persisted to SQLite (`node:sqlite`, Node 22.13+).
 *
 * - Jobs keep their id across restarts — rows are updated, never duplicated.
 * - Each process claims jobs with a lease; a crashed process's jobs become
 *   claimable after 30 s, and two processes never send the same job.
 * - Attachments (Buffers) and Dates survive via `JobCodec`; streams are rejected.
 * - `shutdown()` defaults to `pending: 'keep'`: unsent jobs stay in the database
 *   and are delivered by the next process.
 *
 * Pass the send function to the constructor (or call `setSendFn()`); restored
 * jobs wait until it is set.
 */
export class SqliteQueue extends MailQueue {
  private db: DatabaseSync;
  /** `host|pid|nonce` — lets a restarted process detect that a local owner died. */
  private readonly owner = `${hostname()}|${process.pid}|${randomBytes(6).toString('hex')}`;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private isClosed = false;

  constructor(readonly dbPath: string, opts: QueueOptions = {}, logger?: Logger, sendFn?: SendFn) {
    super(opts, logger);
    this.db = openDatabase(dbPath);
    this.wireEvents();
    this.loadDead();
    this.restoreJobs();
    if (sendFn) this.setSendFn(sendFn);
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.pollTimer.unref?.();
  }

  override get persistent(): boolean {
    return true;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Insert a newly enqueued job. Job ids are unique for the lifetime of the
   * database: reusing the id of any existing row (pending, sent, dead or
   * cancelled) throws instead of overwriting it — which would re-send mail.
   */
  private insert(job: QueueJob): void {
    const exists = this.db.prepare(`SELECT status FROM queue_jobs WHERE id=?`).get(job.id) as { status: string } | undefined;
    if (exists) throw new QueueError(`Duplicate job id: ${job.id} (already ${exists.status})`);
    try {
      this.insertRow(job);
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) {
        throw new QueueError(/idempotency/i.test((err as Error).message)
          ? `Duplicate idempotency key: ${job.idempotencyKey}`
          : `Duplicate job id: ${job.id}`);
      }
      throw err;
    }
  }

  /** Idempotency lookup that also sees jobs enqueued by earlier runs or other processes. */
  protected override findIdempotent(key: string): QueueJob | undefined {
    const inMemory = super.findIdempotent(key);
    if (inMemory) return inMemory;
    const row = this.db.prepare(`SELECT * FROM queue_jobs WHERE idempotency_key=?`).get(key) as Row | undefined;
    if (!row) return undefined;
    if (Date.parse(row.created_at) < Date.now() - this.idempotencyWindowMs) {
      // Expired: release the key so a new job can use it
      this.db.prepare(`UPDATE queue_jobs SET idempotency_key=NULL WHERE id=?`).run(row.id);
      return undefined;
    }
    return this.get(row.id) ?? rowToJob(row);
  }

  private insertRow(job: QueueJob): void {
    this.db.prepare(`
      INSERT INTO queue_jobs (id, options, status, priority, attempts, created_at, last_attempt_at, errors,
                              cancelled_at, not_before, owner, lease_until, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      encodeOptions(job.options),
      job.status,
      job.priority,
      job.attempts,
      job.createdAt.toISOString(),
      job.lastAttemptAt?.toISOString() ?? '',
      JSON.stringify(encodeErrors(job.errors)),
      job.cancelledAt?.toISOString() ?? null,
      job.notBefore?.toISOString() ?? null,
      this.owner,
      Date.now() + LEASE_MS,
      job.idempotencyKey ?? null,
    );
  }

  private updateStatus(job: QueueJob): void {
    const active = job.status === 'pending' || job.status === 'scheduled' || job.status === 'running';
    this.db.prepare(`
      UPDATE queue_jobs SET status=?, attempts=?, last_attempt_at=?, errors=?, cancelled_at=?, not_before=?,
                            owner=?, lease_until=?
      WHERE id=?
    `).run(
      job.status,
      job.attempts,
      job.lastAttemptAt?.toISOString() ?? '',
      JSON.stringify(encodeErrors(job.errors)),
      job.cancelledAt?.toISOString() ?? null,
      job.notBefore?.toISOString() ?? null,
      active ? this.owner : null,
      active ? Date.now() + LEASE_MS : null,
      job.id,
    );
  }

  private wireEvents(): void {
    const update = (job: QueueJob) => { if (!this.isClosed) this.updateStatus(job); };
    this.on('enqueued', (job: QueueJob) => this.insert(job));
    for (const ev of ['scheduled', 'promoted', 'started', 'success', 'retry', 'dead', 'cancelled', 'interrupted']) {
      this.on(ev, update);
    }
  }

  /** Atomically take ownership of a row; returns false if another live process holds it. */
  private claim(id: string): boolean {
    const res = this.db.prepare(`
      UPDATE queue_jobs SET owner=?, lease_until=?
      WHERE id=? AND status IN ('pending','scheduled','running')
        AND (owner IS NULL OR owner=? OR lease_until IS NULL OR lease_until < ?)
    `).run(this.owner, Date.now() + LEASE_MS, id, this.owner, Date.now()) as { changes: number };
    return Number(res.changes) > 0;
  }

  /**
   * Free rows held by processes on this host that no longer exist (crash,
   * kill -9), so a restart recovers immediately instead of waiting for the lease.
   */
  private releaseDeadLocalOwners(): void {
    const owners = this.db.prepare(`
      SELECT DISTINCT owner FROM queue_jobs
      WHERE owner IS NOT NULL AND owner != ? AND status IN ('pending','scheduled','running')
    `).all(this.owner) as Array<{ owner: string }>;
    for (const { owner } of owners) {
      const [host, pidStr] = owner.split('|');
      const pid = Number(pidStr);
      if (host !== hostname() || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          this.db.prepare(`UPDATE queue_jobs SET owner=NULL, lease_until=NULL WHERE owner=?`).run(owner);
        }
      }
    }
  }

  /** Claim every unowned (or lease-expired) active row and schedule it. */
  private restoreJobs(): void {
    this.releaseDeadLocalOwners();
    const rows = this.db.prepare(`
      SELECT * FROM queue_jobs
      WHERE status IN ('pending','scheduled','running')
        AND (owner IS NULL OR lease_until IS NULL OR lease_until < ?)
      ORDER BY created_at ASC
    `).all(Date.now()) as Row[];

    for (const row of rows) {
      if (this.get(row.id) || !this.claim(row.id)) continue;
      let job: QueueJob;
      try {
        job = rowToJob(row);
      } catch (err) {
        this.logger?.error('queue', `Job ${row.id}: unreadable row, moving to DLQ (${(err as Error).message})`);
        this.db.prepare(`UPDATE queue_jobs SET status='dead', owner=NULL, lease_until=NULL WHERE id=?`).run(row.id);
        continue;
      }
      if (job.status === 'running') {
        // The previous owner died mid-attempt; the attempt may or may not have been delivered.
        this.logger?.warn('queue', `Job ${job.id}: recovered from an interrupted attempt`);
        job.status = 'pending';
      }
      this.dlq.remove(job.id);
      this.restore(job);
      this.updateStatus(job);
    }

  }

  /** Make previously dead jobs visible through `queue.dlq` (no `dead` events). */
  private loadDead(): void {
    const dead = this.db.prepare(`SELECT * FROM queue_jobs WHERE status='dead' ORDER BY created_at ASC`).all() as Row[];
    for (const row of dead) {
      try { this.dlq.load(rowToJob(row)); } catch { /* unreadable dead row — leave in DB */ }
    }
  }

  private poll(): void {
    if (this.isClosed) return;
    try {
      // Renew leases for everything this process holds
      this.db.prepare(`UPDATE queue_jobs SET lease_until=? WHERE owner=? AND status IN ('pending','scheduled','running')`)
        .run(Date.now() + LEASE_MS, this.owner);

      const controls = this.db.prepare(`SELECT job_id, action FROM queue_control`).all() as Array<{ job_id: string; action: string }>;
      for (const { job_id, action } of controls) {
        const handled =
          action === 'cancel' ? this.cancel(job_id)
          : action === 'interrupt' ? this.interrupt(job_id)
          : action === 'abort' ? this.abort(job_id)
          : true;
        // Leave requests for jobs another process owns
        if (handled) this.db.prepare(`DELETE FROM queue_control WHERE job_id=?`).run(job_id);
      }
      // Requests nobody picked up (unknown or finished jobs) expire after a minute
      this.db.prepare(`DELETE FROM queue_control WHERE created_at < ?`).run(new Date(Date.now() - 60_000).toISOString());

      if (!this.isPaused) this.restoreJobs();
    } catch (err) {
      this.logger?.warn('queue', `SqliteQueue poll failed: ${(err as Error).message}`);
    }
  }

  override async shutdown(opts: number | ShutdownOptions = {}): Promise<ShutdownResult> {
    const result = await super.shutdown(opts);
    this.close();
    return result;
  }

  /** Release this process's claims and close the database. Idempotent. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try {
      // Anything still active goes back to the pool for the next process.
      this.db.prepare(`
        UPDATE queue_jobs SET owner=NULL, lease_until=NULL,
          status=CASE WHEN status='running' THEN 'pending' ELSE status END
        WHERE owner=?
      `).run(this.owner);
    } catch { /* ignore */ }
    this.db.close();
  }

  // ── Static cross-process helpers ──────────────────────────────────────────

  private static withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
    const db = openDatabase(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  static readStats(dbPath: string): QueueStats {
    return SqliteQueue.withDb(dbPath, (db) => {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) as scheduled,
          SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status='success'   THEN 1 ELSE 0 END) as succeeded,
          SUM(CASE WHEN status='dead'      THEN 1 ELSE 0 END) as dead,
          SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled
        FROM queue_jobs
      `).get() as Record<string, number | null> | undefined;
      return {
        pending:   Number(row?.['pending']   ?? 0),
        scheduled: Number(row?.['scheduled'] ?? 0),
        running:   Number(row?.['running']   ?? 0),
        succeeded: Number(row?.['succeeded'] ?? 0),
        dead:      Number(row?.['dead']      ?? 0),
        cancelled: Number(row?.['cancelled'] ?? 0),
      };
    });
  }

  static readDlq(dbPath: string): QueueJob[] {
    return SqliteQueue.withDb(dbPath, (db) =>
      (db.prepare(`SELECT * FROM queue_jobs WHERE status='dead' ORDER BY created_at ASC`).all() as Row[]).map(rowToJob));
  }

  /** Move a dead job back to pending (attempts reset). Picked up by a running queue within 5 s. */
  static requeueJob(dbPath: string, jobId: string): boolean {
    return SqliteQueue.withDb(dbPath, (db) => {
      const res = db.prepare(
        `UPDATE queue_jobs SET status='pending', attempts=0, errors='[]', owner=NULL, lease_until=NULL, not_before=NULL
         WHERE id=? AND status='dead'`,
      ).run(jobId) as { changes: number };
      return Number(res.changes) > 0;
    });
  }

  static clearDlq(dbPath: string): void {
    SqliteQueue.withDb(dbPath, (db) => db.prepare(`DELETE FROM queue_jobs WHERE status='dead'`).run());
  }

  private static requestControl(dbPath: string, jobId: string, action: 'cancel' | 'interrupt' | 'abort'): void {
    SqliteQueue.withDb(dbPath, (db) => db.prepare(
      `INSERT INTO queue_control (job_id, action, created_at) VALUES (?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET action=excluded.action, created_at=excluded.created_at`,
    ).run(jobId, action, new Date().toISOString()));
  }

  /** Request that the running application cancel a job (picked up within 5 s). */
  static requestCancel(dbPath: string, jobId: string): void {
    SqliteQueue.requestControl(dbPath, jobId, 'cancel');
  }

  /** Request that the running application interrupt a job (return to queue without failure). */
  static requestInterrupt(dbPath: string, jobId: string): void {
    SqliteQueue.requestControl(dbPath, jobId, 'interrupt');
  }

  /** Request that the running application abort a job (counts as a failed attempt). */
  static requestAbort(dbPath: string, jobId: string): void {
    SqliteQueue.requestControl(dbPath, jobId, 'abort');
  }
}
