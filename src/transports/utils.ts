import type { EmailAddress, Attachment, EmailOptions } from '../types/core.js';
import type { BuiltMessage } from '../core/Message.js';
import { resolveAttachment } from '../core/Attachment.js';
import { MimeHeaders } from '../core/MimeParser.js';
import { TransportError } from '../errors.js';
import type { HttpResponse } from './HttpClient.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(value: string | string[] | undefined): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Throw a `TransportError` for a non-2xx provider response. Bodies are
 * truncated so error messages never balloon (or echo large payloads).
 */
export function assertOk(provider: string, res: HttpResponse): void {
  if (res.status >= 200 && res.status < 300) return;
  const body = res.body.length > 500 ? `${res.body.slice(0, 500)}…` : res.body;
  throw new TransportError(
    `${provider} error ${res.status}: ${body}`,
    provider,
    res.status,
    RETRYABLE_STATUS.has(res.status),
    retryAfterMs(res.headers['retry-after']),
  );
}

/** Parse a JSON success body; a malformed body becomes a retryable `TransportError`. */
export function parseJson<T>(provider: string, res: HttpResponse): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new TransportError(`${provider} returned a non-JSON response (HTTP ${res.status})`, provider, res.status, true);
  }
}

/** Wrap network-level failures (DNS, reset, abort) as `TransportError`s. */
export async function request<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TransportError) throw err;
    const e = err as Error & { name?: string };
    const aborted = e.name === 'AbortError';
    throw new TransportError(`${provider} request failed: ${e.message}`, provider, 0, !aborted);
  }
}

/**
 * Headers JSON APIs must receive explicitly, because they build the message
 * themselves: custom headers plus threading and list headers produced by the
 * mailts builder (In-Reply-To, References, List-Unsubscribe…).
 */
export function apiHeaders(options: EmailOptions, message: BuiltMessage): Record<string, string> {
  const out: Record<string, string> = { ...(options.headers ?? {}) };
  const head = message.raw.subarray(0, Math.max(0, message.raw.indexOf('\r\n\r\n'))).toString('utf8');
  const built = new MimeHeaders(head);
  for (const name of ['In-Reply-To', 'References', 'List-Unsubscribe', 'List-Unsubscribe-Post']) {
    const v = built.raw(name);
    if (v && !(name in out)) out[name] = v;
  }
  return out;
}

/** Normalise an EmailAddress (or array) to an array of `"Name <email>"` strings. */
export function toAddressStrings(addr: EmailAddress | EmailAddress[] | undefined): string[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map(a =>
    typeof a === 'string' ? a : a.name ? `${a.name} <${a.email}>` : a.email,
  );
}

/** Normalise to `{ email, name? }` objects — used by SendGrid. */
export function toAddressObjects(addr: EmailAddress | EmailAddress[] | undefined): { email: string; name?: string }[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map(a =>
    typeof a === 'string' ? { email: a } : { email: a.email, name: a.name },
  );
}

export interface ResolvedApiAttachment {
  filename: string;
  contentType: string;
  cid?: string;
  data: Buffer;
}

/**
 * Resolve all attachments to in-memory Buffers for use in HTTP API payloads.
 * `MailTs` resolves `path` attachments under its policy before calling a transport;
 * a transport used directly rejects them (default policy).
 */
export async function resolveApiAttachments(
  attachments: Attachment[],
): Promise<ResolvedApiAttachment[]> {
  return Promise.all(
    attachments
      .filter(a => a.rfc822 === undefined) // rfc822 handled separately per provider
      .map(async (att) => {
        const r = await resolveAttachment(att);
        const data = await r.getContent();
        return { filename: r.filename, contentType: r.contentType, cid: r.cid, data };
      }),
  );
}
