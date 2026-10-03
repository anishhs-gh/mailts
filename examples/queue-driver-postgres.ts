/**
 * Durable mail queue shared by many instances (Cloud Run, Kubernetes, several VMs) on Postgres.
 *
 * SqliteQueue only coordinates processes on one disk. Across instances, put the jobs in a
 * shared database and run a MailWorker in every instance:
 *
 *   - `FOR UPDATE SKIP LOCKED` hands each job to exactly one instance at a time.
 *   - A lease (`locked_until`) returns jobs of an instance that died mid-send.
 *   - A unique `idempotency_key` stops the same email being enqueued twice by different instances.
 *
 * Delivery is at-least-once: if an instance dies after the SMTP server accepted a message but
 * before `ack`, the lease expires and another instance sends it again. Keep `leaseSeconds`
 * above your worst-case send time including retries (see `queue.maxRetries` / backoff).
 *
 * Works with Cloud SQL / AlloyDB / any Postgres 9.5+. Requires: npm install pg
 *
 * Run (every instance runs the same code):
 *   DATABASE_URL=postgres://… SMTP_HOST=… SMTP_USER=… SMTP_PASS=… npx tsx examples/queue-driver-postgres.ts
 */
import { pathToFileURL } from 'url';
import pg from 'pg';
import { MailWorker, encodeOptions, decodeOptions } from '@mailts/core';
import type { QueueDriver, DriverMessage, EmailOptions } from '@mailts/core';

/** Anything with pg's `query` shape: `pg.Pool`, `pg.Client`, or a test double. */
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

type Priority = NonNullable<DriverMessage['priority']>;

export async function createSchema(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mail_jobs (
      id              bigserial PRIMARY KEY,
      payload         text        NOT NULL,              -- encodeOptions(): keeps Buffers and Dates
      priority        smallint    NOT NULL DEFAULT 2,    -- 0 critical · 1 high · 2 normal · 3 low
      idempotency_key text        UNIQUE,
      status          text        NOT NULL DEFAULT 'pending', -- pending | sending | sent | dead | cancelled
      attempts        int         NOT NULL DEFAULT 0,
      locked_until    timestamptz,
      last_error      text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS mail_jobs_ready ON mail_jobs (priority, id)
      WHERE status IN ('pending', 'sending')`);
}

const PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];

/**
 * Enqueue from any instance (API handler, cron…). Returns the job id, or `null` when a job
 * with the same `idempotencyKey` already exists.
 */
export async function enqueue(
  db: Db,
  email: EmailOptions,
  opts: { priority?: Priority; idempotencyKey?: string } = {},
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mail_jobs (payload, priority, idempotency_key) VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [encodeOptions(email), PRIORITIES.indexOf(opts.priority ?? 'normal'), opts.idempotencyKey ?? null],
  );
  return rows[0] ? String(rows[0].id) : null;
}

export class PostgresDriver implements QueueDriver {
  constructor(private readonly db: Db, private readonly leaseSeconds = 300) {}

  async dequeue(): Promise<DriverMessage | null> {
    // One statement: claim the best ready job (or one whose lease expired) and lease it.
    const { rows } = await this.db.query<{ id: string; payload: string; priority: number; idempotency_key: string | null }>(
      `UPDATE mail_jobs
          SET status = 'sending', attempts = attempts + 1, updated_at = now(),
              locked_until = now() + make_interval(secs => $1)
        WHERE id = (
          SELECT id FROM mail_jobs
           WHERE status = 'pending' OR (status = 'sending' AND locked_until < now())
           ORDER BY priority, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
       RETURNING id, payload, priority, idempotency_key`,
      [this.leaseSeconds],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      data: decodeOptions(row.payload),
      priority: PRIORITIES[row.priority] ?? 'normal',
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    };
  }

  ack(id: string): Promise<void> {
    return this.finish(id, 'sent');
  }

  nack(id: string, reason?: Error): Promise<void> {
    return this.finish(id, 'dead', reason?.message ?? 'failed');
  }

  cancel(id: string): Promise<void> {
    return this.finish(id, 'cancelled');
  }

  /** Worker shutdown: give unstarted jobs back now instead of waiting for the lease. */
  async release(id: string): Promise<void> {
    await this.db.query(
      `UPDATE mail_jobs SET status = 'pending', locked_until = NULL, attempts = attempts - 1, updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [id],
    );
  }

  private async finish(id: string, status: 'sent' | 'dead' | 'cancelled', error?: string): Promise<void> {
    await this.db.query(
      `UPDATE mail_jobs SET status = $2, locked_until = NULL, last_error = $3, updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [id, status, error ?? null],
    );
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 5 });
  await createSchema(db);

  const worker = new MailWorker(new PostgresDriver(db), {
    smtp: {
      host: process.env['SMTP_HOST']!,
      port: 587,
      auth: { type: 'plain', user: process.env['SMTP_USER']!, pass: process.env['SMTP_PASS']! },
    },
    queue: { concurrency: 4, maxRetries: 3 },
  });
  worker.on('dead', (job: { id: string }) => console.error(`[dead] ${job.id}`));
  worker.on('error', (err: Error) => console.error('[driver]', err.message));
  await worker.start();

  // Any instance can enqueue; the key makes a retried HTTP request harmless.
  await enqueue(db, { from: process.env['SMTP_USER']!, to: 'customer@example.com', subject: 'Welcome', text: 'Hi!' },
    { idempotencyKey: 'welcome:customer@example.com' });

  // Cloud Run sends SIGTERM and allows ~10 s: stop taking jobs, finish running ones, release the rest.
  process.once('SIGTERM', async () => {
    await worker.shutdown(8_000);
    await db.end();
    process.exit(0);
  });
}
