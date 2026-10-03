import { QueueError, MailTsError, type ErrorCode } from '../errors.js';
import type { EmailOptions } from '../types/core.js';
import type { QueueJob, JobPriority } from '../types/queue.js';

/** Current wire version of encoded jobs. */
export const JOB_CODEC_VERSION = 1;

/**
 * Encode `EmailOptions` for storage or transport (SQLite, Redis, SQS, Pub/Sub …).
 * Buffers become `{ $b64 }` and Dates `{ $date }`, so attachments and
 * calendar invites survive the round-trip. Streams cannot be serialised —
 * use `path` or Buffer `content` for queued attachments.
 */
export function encodeOptions(options: EmailOptions): string {
  return JSON.stringify({ v: JOB_CODEC_VERSION, o: toWire(options, 'options') });
}

/** Inverse of `encodeOptions`. Also accepts plain legacy JSON (rows written by 0.4 and earlier). */
export function decodeOptions(data: string): EmailOptions {
  const parsed = JSON.parse(data) as unknown;
  if (parsed && typeof parsed === 'object' && 'v' in parsed && 'o' in parsed) {
    return fromWire((parsed as { o: unknown }).o) as EmailOptions;
  }
  return reviveLegacyDates(fromWire(parsed) as EmailOptions); // legacy: raw JSON.stringify(options)
}

/** Rows from 0.4 and earlier stored Dates as ISO strings; restore the known Date fields. */
function reviveLegacyDates(o: EmailOptions): EmailOptions {
  const d = (v: unknown) => (typeof v === 'string' ? new Date(v) : v);
  const out = { ...o } as EmailOptions & { date?: unknown };
  if (out.date !== undefined) out.date = d(out.date) as Date;
  if (out.ical) {
    const ical = { ...out.ical } as unknown as Record<string, unknown>;
    for (const k of ['start', 'end', 'created', 'lastModified', 'stamp']) if (k in ical) ical[k] = d(ical[k]);
    out.ical = ical as unknown as EmailOptions['ical'];
  }
  return out;
}

/** Encode a whole job (id, state, options, errors). */
export function encodeJob(job: QueueJob): string {
  return JSON.stringify({
    v: JOB_CODEC_VERSION,
    id: job.id,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    lastAttemptAt: job.lastAttemptAt?.toISOString() ?? null,
    notBefore: job.notBefore?.toISOString() ?? null,
    cancelledAt: job.cancelledAt?.toISOString() ?? null,
    errors: encodeErrors(job.errors),
    o: toWire(job.options, 'options'),
  });
}

/** Inverse of `encodeJob`: restore a `QueueJob` (Buffers, Dates and errors included). */
export function decodeJob(data: string): QueueJob {
  const j = JSON.parse(data) as Record<string, unknown>;
  const job: QueueJob = {
    id: String(j['id']),
    options: fromWire(j['o']) as EmailOptions,
    status: j['status'] as QueueJob['status'],
    priority: (j['priority'] as JobPriority) ?? 'normal',
    attempts: Number(j['attempts'] ?? 0),
    createdAt: new Date(String(j['createdAt'])),
    lastAttemptAt: j['lastAttemptAt'] ? new Date(String(j['lastAttemptAt'])) : null,
    errors: decodeErrors(JSON.stringify(j['errors'] ?? [])),
  };
  if (j['notBefore']) job.notBefore = new Date(String(j['notBefore']));
  if (j['cancelledAt']) job.cancelledAt = new Date(String(j['cancelledAt']));
  return job;
}

export function encodeErrors(errors: readonly MailTsError[]): Array<{ message: string; code: string; retryable: boolean }> {
  return errors.map(e => ({ message: e.message, code: e.code, retryable: e.retryable }));
}

export function decodeErrors(data: string): MailTsError[] {
  const arr = JSON.parse(data || '[]') as Array<{ message: string; code: ErrorCode; retryable: boolean }>;
  return arr.map(e => new MailTsError(e.message, e.code, e.retryable));
}

function toWire(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return { $b64: value.toString('base64') };
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value === 'object' && typeof (value as { pipe?: unknown }).pipe === 'function') {
    throw new QueueError(`Cannot queue a stream at ${path}; use a Buffer or a file path`);
  }
  if (typeof value === 'function') throw new QueueError(`Cannot queue a function at ${path}`);
  if (Array.isArray(value)) return value.map((v, i) => toWire(v, `${path}[${i}]`));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toWire(v, `${path}.${k}`);
    }
    return out;
  }
  return value;
}

function fromWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromWire);
  const o = value as Record<string, unknown>;
  if (typeof o['$b64'] === 'string' && Object.keys(o).length === 1) return Buffer.from(o['$b64'], 'base64');
  if (typeof o['$date'] === 'string' && Object.keys(o).length === 1) return new Date(o['$date']);
  // Legacy rows: Buffer.toJSON() → { type: 'Buffer', data: [...] }
  if (o['type'] === 'Buffer' && Array.isArray(o['data']) && Object.keys(o).length === 2) return Buffer.from(o['data'] as number[]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = fromWire(v);
  return out;
}
