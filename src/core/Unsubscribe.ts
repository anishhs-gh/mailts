/**
 * List-Unsubscribe (RFC 2369) and one-click unsubscribe (RFC 8058).
 *
 * Gmail and Yahoo require one-click unsubscribe from bulk senders (2024);
 * mailbox providers honour it only when both headers are DKIM-signed, which the
 * default DKIM header list does.
 */
import { MimeError } from '../errors.js';

/** `EmailOptions.unsubscribe`: List-Unsubscribe targets. At least one of `url` / `mailto` is required. */
export interface UnsubscribeOptions {
  /**
   * HTTPS endpoint. For one-click, mailbox providers POST
   * `List-Unsubscribe=One-Click` (form-encoded) to this exact URL — make it
   * unique per recipient (e.g. a signed token) and unsubscribe without a login.
   */
  url?: string;
  /** Fallback address or full `mailto:` URI (may include `?subject=`). */
  mailto?: string;
  /** Emit `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. @default true when `url` is set */
  oneClick?: boolean;
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\s<>,"\x00-\x1f\x7f]/;

/** Build the header pair for `EmailOptions.unsubscribe`. */
export function unsubscribeHeaders(o: UnsubscribeOptions): Array<[string, string]> {
  const uris: string[] = [];
  if (o.url !== undefined) {
    let u: URL;
    try { u = new URL(o.url); } catch { throw new MimeError(`Invalid unsubscribe url: ${JSON.stringify(o.url)}`); }
    if (u.protocol !== 'https:') throw new MimeError('unsubscribe.url must use https (RFC 8058)');
    if (UNSAFE.test(o.url)) throw new MimeError(`unsubscribe.url contains characters not allowed in a header: ${JSON.stringify(o.url)}`);
    uris.push(`<${o.url}>`);
  }
  if (o.mailto !== undefined) {
    const m = o.mailto.startsWith('mailto:') ? o.mailto : `mailto:${o.mailto}`;
    if (UNSAFE.test(m) || !/^mailto:[^@?]+@[^?]+(\?.*)?$/.test(m)) {
      throw new MimeError(`Invalid unsubscribe mailto: ${JSON.stringify(o.mailto)}`);
    }
    uris.push(`<${m}>`);
  }
  if (uris.length === 0) throw new MimeError('unsubscribe needs a url or a mailto');

  const headers: Array<[string, string]> = [['List-Unsubscribe', uris.join(', ')]];
  if (o.url !== undefined && (o.oneClick ?? true)) {
    headers.push(['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']);
  }
  return headers;
}

/**
 * Detect an RFC 8058 one-click unsubscribe request in your HTTP handler.
 * Providers send `POST` with `List-Unsubscribe=One-Click` as
 * `application/x-www-form-urlencoded` (or `multipart/form-data`).
 *
 * @example
 * ```ts
 * if (isOneClickUnsubscribe({ method: req.method, contentType: req.headers['content-type'], body: rawBody })) {
 *   await unsubscribe(tokenFrom(req.url));   // respond 200; do not require login or confirmation
 * }
 * ```
 */
export function isOneClickUnsubscribe(req: {
  method?: string;
  contentType?: string;
  body: string | Buffer;
}): boolean {
  if ((req.method ?? '').toUpperCase() !== 'POST') return false;
  const body = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
  const ct = (req.contentType ?? '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    return /name="List-Unsubscribe"\s*\r?\n\r?\nOne-Click/i.test(body);
  }
  if (ct === '' || ct.startsWith('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body.trim()).get('List-Unsubscribe') === 'One-Click';
  }
  return false;
}
