/**
 * Byte-exact MIME parser (RFC 2045/2046/2047/2231/5322).
 *
 * Works on a latin1 "byte string" internally (1 char = 1 byte) so that every
 * split is lossless; content is converted back to `Buffer` only at the leaves.
 * No regex ever runs across part bodies except boundary search.
 */
import { decodeRfc2047, decodeLatin1Utf8 } from '../imap/ImapParser.js';
import type { ImapAttachment, ImapEnvelope } from '../types/imap.js';

// ── Headers ─────────────────────────────────────────────────────────────────

export class MimeHeaders {
  /** Header name (lower-case) → raw unfolded values (byte strings), in order. */
  private readonly map = new Map<string, string[]>();
  readonly lines: Array<[name: string, value: string]> = [];

  constructor(block: string) {
    const unfolded = block.replace(/\r?\n(?=[ \t])/g, '');
    for (const line of unfolded.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      this.lines.push([name, value]);
      const key = name.toLowerCase();
      const arr = this.map.get(key);
      if (arr) arr.push(value); else this.map.set(key, [value]);
    }
  }

  /** First raw value (byte string) for `name`. */
  raw(name: string): string | undefined {
    return this.map.get(name.toLowerCase())?.[0];
  }

  /** First value, RFC 2047-decoded to a JS string. */
  get(name: string): string | undefined {
    const v = this.raw(name);
    return v === undefined ? undefined : decodeRfc2047(v);
  }

  getAll(name: string): string[] {
    return (this.map.get(name.toLowerCase()) ?? []).map(v => decodeRfc2047(v));
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }
}

// ── Structured header values ────────────────────────────────────────────────

export interface HeaderValue {
  /** Lower-cased main value, e.g. `text/plain` or `attachment`. */
  value: string;
  /** Lower-cased parameter names → decoded values (RFC 2231 + RFC 2047). */
  params: Record<string, string>;
}

/** Parse `value; a=b; c="d"; e*0*=utf-8''%C3%A9` (RFC 2045 + RFC 2231). */
export function parseHeaderValue(raw: string | undefined): HeaderValue {
  if (!raw) return { value: '', params: {} };
  const segments = splitOutsideQuotes(raw, ';');
  const value = (segments.shift() ?? '').trim().toLowerCase();

  const simple: Record<string, string> = {};
  const extended = new Map<string, Array<{ index: number; value: string; encoded: boolean }>>();

  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    let key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    const m = /^([^*]+)\*(?:(\d+)\*?|)$/.exec(key);
    const star = key.endsWith('*');
    if (m && (star || m[2] !== undefined)) {
      const base = m[1]!;
      const index = m[2] === undefined ? 0 : Number(m[2]);
      const arr = extended.get(base) ?? [];
      arr.push({ index, value: val, encoded: star });
      extended.set(base, arr);
      continue;
    }
    simple[key] = val;
  }

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(simple)) params[k] = decodeRfc2047(v);

  for (const [base, pieces] of extended) {
    pieces.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    pieces.forEach((p, i) => {
      let v = p.value;
      if (p.encoded) {
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (m) { charset = m[1] || charset; v = m[2]!; }
        }
        bytes.push(percentDecode(v));
      } else {
        bytes.push(Buffer.from(v, 'latin1'));
      }
    });
    params[base] = decodeText(Buffer.concat(bytes), charset);
  }

  return { value, params };
}

function percentDecode(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && quoted) { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ── Address lists (RFC 5322 §3.4) ───────────────────────────────────────────

export interface MailAddress { email: string; name?: string }

/** Parse an address-list header value (handles groups, quotes, comments, RFC 2047). */
export function parseAddressHeader(raw: string | undefined): MailAddress[] {
  if (!raw) return [];
  const out: MailAddress[] = [];
  // Tokenize into top-level comma-separated mailboxes, flattening groups.
  let buf = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  const flush = () => {
    const a = parseMailbox(buf);
    if (a) out.push(a);
    buf = '';
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (c === '\\') { buf += c + (raw[i + 1] ?? ''); i++; continue; }
      if (c === '"') quoted = false;
      buf += c;
      continue;
    }
    if (comment > 0) {
      if (c === '(') comment++;
      else if (c === ')') comment--;
      buf += c;
      continue;
    }
    if (c === '"') { quoted = true; buf += c; continue; }
    if (c === '(') { comment++; buf += c; continue; }
    if (c === '<') angle++;
    if (c === '>') angle = Math.max(0, angle - 1);
    if (angle === 0 && c === ':') { buf = ''; continue; } // group display name
    if (angle === 0 && (c === ',' || c === ';')) { flush(); continue; }
    buf += c;
  }
  flush();
  return out;
}

function parseMailbox(s: string): MailAddress | null {
  const text = s.trim();
  if (!text) return null;
  const lt = text.lastIndexOf('<');
  const gt = text.lastIndexOf('>');
  if (lt !== -1 && gt > lt) {
    const email = decodeLatin1Utf8(text.slice(lt + 1, gt).trim());
    let name = text.slice(0, lt).trim();
    name = name.replace(/\((?:[^()\\]|\\.)*\)/g, '').trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    name = decodeRfc2047(name).trim();
    return email ? { email, ...(name ? { name } : {}) } : null;
  }
  // addr-spec, possibly with a trailing comment used as the name: a@b (Name)
  const cm = /\(((?:[^()\\]|\\.)*)\)/.exec(text);
  const email = decodeLatin1Utf8(text.replace(/\((?:[^()\\]|\\.)*\)/g, '').trim());
  if (!email) return null;
  const name = cm ? decodeRfc2047(cm[1]!.trim()) : '';
  return { email, ...(name ? { name } : {}) };
}

/** Parse a msg-id list (References / In-Reply-To) into bare ids with angle brackets. */
export function parseMessageIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.match(/<[^<>\s]+>/g) ?? [];
}

// ── Part tree ───────────────────────────────────────────────────────────────

export interface MimePart {
  headers: MimeHeaders;
  /** Lower-cased `type/subtype`; defaults per RFC 2045 (`text/plain`, or `message/rfc822` in digests). */
  contentType: string;
  params: Record<string, string>;
  /** `attachment` | `inline` | undefined */
  disposition?: string;
  dispositionParams: Record<string, string>;
  /** Lower-cased Content-Transfer-Encoding (default `7bit`). */
  encoding: string;
  /** Raw (still transfer-encoded) body bytes as a byte string. */
  rawBody: string;
  /** Child parts for `multipart/*`. */
  parts?: MimePart[];
  /** Parsed inner message for `message/rfc822`. */
  message?: MimePart;
}

const MAX_DEPTH = 32;

/** Parse a full RFC 5322 message (or a MIME entity) into a part tree. */
export function parseMime(raw: Buffer | string, defaultType = 'text/plain', depth = 0): MimePart {
  const s = typeof raw === 'string' ? raw : raw.toString('latin1');
  const { head, body } = splitHeadBody(s);
  const headers = new MimeHeaders(head);
  const ct = parseHeaderValue(headers.raw('content-type'));
  const cd = parseHeaderValue(headers.raw('content-disposition'));
  const contentType = ct.value && ct.value.includes('/') ? ct.value : defaultType;

  const part: MimePart = {
    headers,
    contentType,
    params: ct.params,
    disposition: cd.value || undefined,
    dispositionParams: cd.params,
    encoding: (headers.raw('content-transfer-encoding') ?? '7bit').trim().toLowerCase(),
    rawBody: body,
  };

  if (depth >= MAX_DEPTH) return part;

  if (contentType.startsWith('multipart/') && ct.params['boundary']) {
    const childDefault = contentType === 'multipart/digest' ? 'message/rfc822' : 'text/plain';
    part.parts = splitMultipart(body, ct.params['boundary']).map(p => parseMime(p, childDefault, depth + 1));
  } else if (contentType === 'message/rfc822' || contentType === 'message/global') {
    const inner = ['base64', 'quoted-printable'].includes(part.encoding)
      ? decodeTransfer(body, part.encoding).toString('latin1')
      : body;
    part.message = parseMime(inner, 'text/plain', depth + 1);
  }
  return part;
}

function splitHeadBody(s: string): { head: string; body: string } {
  if (s.startsWith('\r\n')) return { head: '', body: s.slice(2) };
  if (s.startsWith('\n')) return { head: '', body: s.slice(1) };
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: '' };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

/** Split a multipart body into its entities (RFC 2046 §5.1.1). */
export function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  let partStart = -1;
  let pos = 0;

  for (;;) {
    let idx: number;
    if (pos === 0 && body.startsWith(delim)) idx = 0;
    else {
      idx = body.indexOf(`\n${delim}`, pos);
      if (idx === -1) break;
    }
    const lineStart = body[idx] === '\n' ? idx + 1 : idx;
    const after = lineStart + delim.length;
    const isClose = body.startsWith('--', after);
    let eol = body.indexOf('\n', after);
    if (eol === -1) eol = body.length;
    const tail = body.slice(after + (isClose ? 2 : 0), eol).replace(/\r$/, '');
    if (tail.trim() !== '') { pos = after; continue; } // longer token sharing the prefix

    if (partStart >= 0) {
      let end = lineStart === 0 ? 0 : idx;
      if (end > 0 && body[end - 1] === '\r') end--;
      parts.push(body.slice(partStart, Math.max(partStart, end)));
    }
    if (isClose) return parts;
    partStart = Math.min(eol + 1, body.length);
    pos = eol;
  }
  if (partStart >= 0) parts.push(body.slice(partStart)); // unterminated multipart
  return parts;
}

// ── Decoding ────────────────────────────────────────────────────────────────

/** Undo Content-Transfer-Encoding. Input and output are raw bytes. */
export function decodeTransfer(raw: string, encoding: string): Buffer {
  switch (encoding) {
    case 'base64':
      return Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    default:
      return Buffer.from(raw, 'latin1');
  }
}

export function decodeQuotedPrintable(raw: string): Buffer {
  const s = raw.replace(/[ \t]+(\r?\n)/g, '$1').replace(/=\r?\n/g, '');
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out[n++] = parseInt(s.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = c & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** Decode text bytes with a MIME charset; unknown or us-ascii falls back to UTF-8, then windows-1252. */
export function decodeText(bytes: Buffer, charset: string | undefined): string {
  const cs = (charset ?? '').trim().toLowerCase();
  if (!cs || cs === 'us-ascii' || cs === 'ascii' || cs === 'utf8' || cs === 'utf-8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return cs === 'utf-8' || cs === 'utf8'
        ? new TextDecoder('utf-8').decode(bytes)
        : new TextDecoder('windows-1252').decode(bytes);
    }
  }
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decoded body bytes of a leaf part. */
export function partContent(part: MimePart): Buffer {
  return decodeTransfer(part.rawBody, part.encoding);
}

/** Decoded body of a text part as a string. */
export function partText(part: MimePart): string {
  return decodeText(partContent(part), part.params['charset']);
}

export function partFilename(part: MimePart): string | undefined {
  return part.dispositionParams['filename'] ?? part.params['name'];
}

// ── High-level message view ─────────────────────────────────────────────────

export interface ParsedBody {
  text?: string;
  html?: string;
  attachments: ImapAttachment[];
}

export interface ParsedMessage extends ParsedBody {
  headers: MimeHeaders;
  envelope: ImapEnvelope;
  /** Message-IDs from the References header, oldest first. */
  references: string[];
  /** Root of the MIME tree for advanced inspection. */
  root: MimePart;
}

/**
 * Parse a raw RFC 5322 message into headers, envelope, text/html bodies and
 * attachments. Useful for `.eml` files, `fetchSection(uid, '')`, and forwards.
 */
export function parseMessage(raw: Buffer | string): ParsedMessage {
  const root = parseMime(raw);
  const body = collectBody(root);
  return {
    headers: root.headers,
    envelope: envelopeFromHeaders(root.headers),
    references: parseMessageIds(root.headers.raw('references')),
    root,
    ...body,
  };
}

export function envelopeFromHeaders(h: MimeHeaders): ImapEnvelope {
  const dateRaw = h.raw('date');
  const date = dateRaw ? new Date(dateRaw) : null;
  return {
    date: date && !isNaN(date.getTime()) ? date : null,
    subject: h.get('subject') ?? '',
    from: parseAddressHeader(h.raw('from')),
    sender: parseAddressHeader(h.raw('sender')),
    replyTo: parseAddressHeader(h.raw('reply-to')),
    to: parseAddressHeader(h.raw('to')),
    cc: parseAddressHeader(h.raw('cc')),
    bcc: parseAddressHeader(h.raw('bcc')),
    inReplyTo: h.raw('in-reply-to')?.trim() || null,
    messageId: h.raw('message-id')?.trim() || null,
    references: parseMessageIds(h.raw('references')),
  };
}

/** Walk a MIME tree and pick text/html bodies plus attachments. */
export function collectBody(root: MimePart): ParsedBody {
  const result: ParsedBody = { attachments: [] };
  walk(root, result, true);
  return result;
}

function walk(part: MimePart, out: ParsedBody, isRoot: boolean): void {
  const ct = part.contentType;
  const disp = part.disposition;
  const filename = partFilename(part);
  const cidRaw = part.headers.raw('content-id');
  const contentId = cidRaw ? cidRaw.trim().replace(/^<|>$/g, '') : undefined;

  if (part.parts) {
    for (const child of part.parts) walk(child, out, false);
    return;
  }

  if (part.message && !isRoot) {
    const nested = collectBody(part.message);
    out.attachments.push({
      filename: filename ?? part.headers.get('content-description') ?? 'forwarded-message.eml',
      contentType: ct,
      size: part.rawBody.length,
      content: Buffer.from(part.rawBody, 'latin1'),
      contentId,
      inline: disp === 'inline',
      nestedMessage: { envelope: envelopeFromHeaders(part.message.headers), body: nested },
    });
    return;
  }

  const isText = ct === 'text/plain' || ct === 'text/html';
  const explicitAttachment = disp === 'attachment';
  const namedInline = disp === 'inline' && (filename !== undefined || contentId !== undefined) && !isText;

  if (isText && !explicitAttachment) {
    const key = ct === 'text/plain' ? 'text' : 'html';
    if (out[key] === undefined) {
      const text = partText(part).replace(/\s+$/, '');
      if (text.trim() || isRoot) out[key] = text;
      return;
    }
    // A second body part of the same type (e.g. list footer) — keep it as an attachment
  }

  if (!explicitAttachment && !namedInline && disp === 'inline' && isText) return;

  const content = partContent(part);
  out.attachments.push({
    filename: filename ?? (namedInline || disp === 'inline' ? 'inline' : 'attachment'),
    contentType: ct,
    size: content.length,
    content,
    contentId,
    inline: disp === 'inline',
  });
}
