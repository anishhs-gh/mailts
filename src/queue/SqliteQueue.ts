import { createRequire } from 'module';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { MailQueue } from './MailQueue.js';
import { MailTsError } from '../errors.js';
import type { QueueOptions, QueueJob, QueueStats, JobPriority } from '../types/queue.js';
import type { Logger } from '../logger/Logger.js';

// node:sqlite types — may not exist on Node < 22, typed as any
type DatabaseSync = any;

function loadSqlite(): { DatabaseSync: new (path: string, opts?: any) => DatabaseSync } {
  try {
    const req = createRequire(import.meta.url);
    return req('node:sqlite');
  } catch {
    throw new Error('node:sqlite requires Node.js 22+. Upgrade Node or remove queue.persist from config.');
  }
}

export function resolveQueueDbPath(persist: string | boolean): string {
  if (typeof persist === 'string') return persist;
  return join(homedir(), '.mailts', 'queue.db');
}

function serializeJob(job: QueueJob): [string, string, string, string, number, string, string, string] {
  return [
    job.id,
    JSON.stringify(job.options),
    job.status,
    job.priority,
    job.attempts,
    job.createdAt.toISOString(),
    job.lastAttemptAt?.toISOString() ?? '',
    JSON.stringify(job.errors.map(e => ({ message: e.message, code: e.code, retryable: e.retryable }))),
  ];
}

function deserializeJob(row: any): QueueJob {
  const errors: MailTsError[] = (JSON.parse(row.errors || '[]') as any[]).map(
    (e: any) => new MailTsError(e.message, e.code, e.retryable),
  );
  return {
    id: row.id,
    options: JSON.parse(row.options),
    status: row.status,
    priority: (row.priority as JobPriority) ?? 'normal',
    attempts: row.attempts,
    errors,
    createdAt: new Date(row.created_at),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : null,
    ...(row.cancelled_at ? { cancelledAt: new Date(row.cancelled_at) } : {}),
  };
}

export class SqliteQueue extends MailQueue {
  private db: DatabaseSync;
  private pendingIds = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval>;

  constructor(dbPath: string, opts: QueueOptions = {}, logger?: Logger) {
    super(opts, logger);
    const { DatabaseSync } = loadSqlite();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
    this.migrateSchema();
    this.restoreJobs();
    this.wireEvents();
    this.pollTimer = setInterval(() => this.poll(), 5_000);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_jobs (
        id             TEXT PRIMARY KEY,
        options        TEXT NOT NULL,
        status         TEXT NOT NULL,
        priority       TEXT NOT NULL DEFAULT 'normal',
        attempts       INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL DEFAULT '',
        errors         TEXT NOT NULL DEFAULT '[]',
        cancelled_at   TEXT
      );
      CREATE TABLE IF NOT EXISTS queue_control (
        job_id     TEXT PRIMARY KEY,
        action     TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private migrateSchema(): void {
    // Add columns introduced in 0.3.0 to pre-existing databases
    try { this.db.exec(`ALTER TABLE queue_jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`); } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE queue_jobs ADD COLUMN cancelled_at TEXT`); } catch { /* already exists */ }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS queue_control (
          job_id     TEXT PRIMARY KEY,
          action     TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    } catch { /* already exists */ }
  }

  private restoreJobs(): void {
    const rows: any[] = this.db.prepare(
      `SELECT * FROM queue_jobs WHERE status IN ('pending','running') ORDER BY created_at ASC`,
    ).all();
    for (const row of rows) {
      const job = deserializeJob({ ...row, status: 'pending' });
      this.db.prepare(`UPDATE queue_jobs SET status='pending' WHERE id=?`).run(job.id);
      this.pendingIds.add(job.id);
      super.enqueue(job.options, { priority: job.priority });
    }

    const dead: any[] = this.db.prepare(`SELECT * FROM queue_jobs WHERE status='dead' ORDER BY created_at ASC`).all();
    for (const row of dead) {
      const job = deserializeJob(row);
      this.dlq.add(job).catch(() => {});
    }
  }

  private upsert(job: QueueJob): void {
    const args = serializeJob(job);
    this.db.prepare(`
      INSERT INTO queue_jobs (id, options, status, priority, attempts, created_at, last_attempt_at, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        attempts=excluded.attempts,
        last_attempt_at=excluded.last_attempt_at,
        errors=excluded.errors
    `).run(...args);

    if (job.cancelledAt) {
      this.db.prepare(`UPDATE queue_jobs SET cancelled_at=? WHERE id=?`)
        .run(job.cancelledAt.toISOString(), job.id);
    }
  }

  private wireEvents(): void {
    this.on('enqueued', (job: QueueJob) => {
      this.pendingIds.add(job.id);
      this.upsert(job);
    });
    this.on('started',   (job: QueueJob) => { this.pendingIds.delete(job.id); this.upsert(job); });
    this.on('success',   (job: QueueJob) => { this.upsert(job); });
    this.on('retry',     (job: QueueJob) => { this.upsert(job); });
    this.on('dead',      (job: QueueJob) => { this.upsert(job); });
    this.on('cancelled', (job: QueueJob) => { this.pendingIds.delete(job.id); this.upsert(job); });
    this.on('interrupted', (job: QueueJob) => { this.upsert(job); });
  }

  private poll(): void {
    try {
      // Process cross-process control signals
      const controls: any[] = this.db.prepare(`SELECT job_id, action FROM queue_control`).all();
      for (const { job_id, action } of controls) {
        if (action === 'cancel')    this.cancel(job_id);
        else if (action === 'interrupt') this.interrupt(job_id);
        else if (action === 'abort')     this.abort(job_id);
        this.db.prepare(`DELETE FROM queue_control WHERE job_id=?`).run(job_id);
      }

      // Pick up pending jobs written by another process
      const rows: any[] = this.db.prepare(`SELECT * FROM queue_jobs WHERE status='pending'`).all();
      for (const row of rows) {
        if (!this.pendingIds.has(row.id)) {
          const job = deserializeJob(row);
          this.pendingIds.add(job.id);
          super.enqueue(job.options, { priority: job.priority });
        }
      }
    } catch {
      // non-fatal
    }
  }

  close(): void {
    clearInterval(this.pollTimer);
    this.db.close();
  }

  // ── Static cross-process helpers ──────────────────────────────────────────

  private static openDb(dbPath: string): DatabaseSync {
    const { DatabaseSync } = loadSqlite();
    return new DatabaseSync(dbPath);
  }

  static readStats(dbPath: string): QueueStats {
    const db = SqliteQueue.openDb(dbPath);
    try {
      const row: any = db.prepare(`
        SELECT
          SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status='success'   THEN 1 ELSE 0 END) as succeeded,
          SUM(CASE WHEN status='dead'      THEN 1 ELSE 0 END) as dead,
          SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled
        FROM queue_jobs
      `).get();
      return {
        pending:   Number(row?.pending   ?? 0),
        running:   Number(row?.running   ?? 0),
        succeeded: Number(row?.succeeded ?? 0),
        dead:      Number(row?.dead      ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
      };
    } finally {
      db.close();
    }
  }

  static readDlq(dbPath: string): QueueJob[] {
    const db = SqliteQueue.openDb(dbPath);
    try {
      const rows: any[] = db.prepare(`SELECT * FROM queue_jobs WHERE status='dead' ORDER BY created_at ASC`).all();
      return rows.map(deserializeJob);
    } finally {
      db.close();
    }
  }

  static requeueJob(dbPath: string, jobId: string): boolean {
    const db = SqliteQueue.openDb(dbPath);
    try {
      const result: any = db.prepare(
        `UPDATE queue_jobs SET status='pending', attempts=0, errors='[]' WHERE id=? AND status='dead'`,
      ).run(jobId);
      return (result?.changes ?? 0) > 0;
    } finally {
      db.close();
    }
  }

  static clearDlq(dbPath: string): void {
    const db = SqliteQueue.openDb(dbPath);
    try {
      db.prepare(`DELETE FROM queue_jobs WHERE status='dead'`).run();
    } finally {
      db.close();
    }
  }

  /** Request that the running application cancel a specific job (picked up within 5 s). */
  static requestCancel(dbPath: string, jobId: string): void {
    const db = SqliteQueue.openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO queue_control (job_id, action, created_at) VALUES (?, 'cancel', ?)
         ON CONFLICT(job_id) DO UPDATE SET action='cancel', created_at=excluded.created_at`,
      ).run(jobId, new Date().toISOString());
    } finally {
      db.close();
    }
  }

  /** Request that the running application interrupt a job (return to queue without failure). */
  static requestInterrupt(dbPath: string, jobId: string): void {
    const db = SqliteQueue.openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO queue_control (job_id, action, created_at) VALUES (?, 'interrupt', ?)
         ON CONFLICT(job_id) DO UPDATE SET action='interrupt', created_at=excluded.created_at`,
      ).run(jobId, new Date().toISOString());
    } finally {
      db.close();
    }
  }

  /** Request that the running application abort a job (counts as a failed attempt). */
  static requestAbort(dbPath: string, jobId: string): void {
    const db = SqliteQueue.openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO queue_control (job_id, action, created_at) VALUES (?, 'abort', ?)
         ON CONFLICT(job_id) DO UPDATE SET action='abort', created_at=excluded.created_at`,
      ).run(jobId, new Date().toISOString());
    } finally {
      db.close();
    }
  }
}
