import { randomBytes } from 'crypto';
import type { EmailOptions, Attachment } from '../types/core.js';
import { parseAddressList, formatAddressList, extractEmails, formatAddress } from './Address.js';
import { resolveAttachment, type AttachmentPathPolicy } from './Attachment.js';
import { htmlToText } from './HtmlToText.js';
import { applyRichContent } from './RichContent.js';
import { buildICalString } from './ICal.js';
import {
  checkContentType,
  checkHeaderName,
  encodeUnstructured,
  foldHeader,
  formatRfc5322Date,
  normalizeMsgId,
  sanitizeHeaderValue,
  withParams,
} from './Headers.js';
import { MimeError } from '../errors.js';
import { unsubscribeHeaders } from './Unsubscribe.js';

/** A fully built RFC 5322 message — what `mail.build()` / `buildMessage()` return and transports send. */
export interface BuiltMessage {
  /** Raw RFC 5322 message as a Buffer. */
  raw: Buffer;
  /** Envelope from (bare email). */
  from: string;
  /** Envelope recipients (bare emails, de-duplicated). */
  to: string[];
  /** Message-ID header value, with angle brackets. */
  messageId: string;
  /** `true` when an address needs SMTPUTF8 (non-ASCII local part or domain). */
  requiresSmtpUtf8: boolean;
  /** `true` when a part uses `8bit` transfer encoding (needs 8BITMIME). */
  requires8BitMime: boolean;
}

/** Options for `buildMessage()`. */
export interface BuildOptions {
  /** Policy for `path` attachments. Unset rejects them (same as `'deny'`). */
  attachmentPolicy?: AttachmentPathPolicy;
}

/** A MIME entity: headers plus either a body or child entities. */
interface Entity {
  headers: Array<[string, string]>;
  body?: Buffer;
  children?: Entity[];
  boundary?: string;
}

function boundary(): string {
  return `----=_Part_${randomBytes(16).toString('hex')}`;
}

/** Generate an RFC 5322 Message-ID using the sender's domain. */
export function generateMessageId(from: string): string {
  const domain = (from.split('@')[1] ?? '').replace(/[^A-Za-z0-9.-]/g, '') || 'mailts.local';
  return `<${randomBytes(12).toString('hex')}@${domain}>`;
}

// eslint-disable-next-line no-control-regex
const needsUtf8 = (addr: string) => /[^\x00-\x7f]/.test(addr);

/**
 * Build a complete RFC 5322 message. The output is 7-bit clean (headers
 * RFC 2047/2231-encoded, text quoted-printable, binaries base64) unless an
 * attachment explicitly asks for `8bit`, or an address needs SMTPUTF8.
 */
export async function buildMessage(options: EmailOptions, buildOpts: BuildOptions = {}): Promise<BuiltMessage> {
  const policy = buildOpts.attachmentPolicy;
  const fromList = parseAddressList(options.from, options.fromName);
  const toList = parseAddressList(options.to, options.toName);
  const ccList = parseAddressList(options.cc, options.ccName);
  if (toList.length === 0) throw new MimeError('At least one recipient (to) is required');

  for (const a of [...fromList, ...toList, ...ccList, ...parseAddressList(options.bcc)]) checkAddress(a.email);
  if (options.replyTo) {
    for (const a of parseAddressList(Array.isArray(options.replyTo) ? options.replyTo : [options.replyTo])) checkAddress(a.email);
  }

  const envelopeFrom = fromList[0]?.email ?? '';
  const envelopeTo = dedupe([
    ...extractEmails(options.to),
    ...extractEmails(options.cc),
    ...extractEmails(options.bcc),
  ]);

  const messageId = options.messageId ? normalizeMsgId(options.messageId) : generateMessageId(envelopeFrom);

  // ── Top-level headers ─────────────────────────────────────────────────────
  const headers: Array<[string, string]> = [];
  if (fromList.length) headers.push(['From', formatAddressList(fromList)]);
  headers.push(['To', formatAddressList(toList)]);
  if (ccList.length) headers.push(['Cc', formatAddressList(ccList)]);
  if (options.replyTo) {
    const list = Array.isArray(options.replyTo) ? options.replyTo : [options.replyTo];
    headers.push(['Reply-To', list.map(formatAddress).join(', ')]);
  }
  headers.push(['Subject', encodeUnstructured(options.subject ?? '(no subject)')]);
  headers.push(['Date', formatRfc5322Date(options.date ?? new Date())]);
  headers.push(['Message-ID', messageId]);
  if (options.inReplyTo) headers.push(['In-Reply-To', normalizeMsgId(options.inReplyTo)]);
  const refs = options.references === undefined ? [] : (Array.isArray(options.references) ? options.references : options.references.split(/\s+/)).filter(Boolean);
  if (refs.length) headers.push(['References', refs.map(normalizeMsgId).join(' ')]);
  headers.push(['MIME-Version', '1.0']);

  if (options.priority === 'high') {
    headers.push(['X-Priority', '1'], ['X-MSMail-Priority', 'High'], ['Importance', 'High']);
  } else if (options.priority === 'low') {
    headers.push(['X-Priority', '5'], ['X-MSMail-Priority', 'Low'], ['Importance', 'Low']);
  }

  if (options.unsubscribe) headers.push(...unsubscribeHeaders(options.unsubscribe));

  const reserved = new Set([
    'content-type', 'content-transfer-encoding', 'mime-version',
    // Set via `unsubscribe` (validated); a hand-written header is still accepted when `unsubscribe` is unused
    ...(options.unsubscribe ? ['list-unsubscribe', 'list-unsubscribe-post'] : []),
  ]);
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    const name = checkHeaderName(k.trim());
    if (reserved.has(name.toLowerCase())) throw new MimeError(`Header "${name}" is managed by the builder`);
    headers.push([name, encodeUnstructured(v)]);
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  options = applyRichContent(options);
  const text = options.text ?? (options.html ? htmlToText(options.html) : undefined);
  const html = options.html;
  const attachments = options.attachments ?? [];
  const inline = attachments.filter(a => a.cid && a.rfc822 === undefined);
  const regular = attachments.filter(a => !a.cid || a.rfc822 !== undefined);

  if (!text && !html && attachments.length === 0 && !options.ical) {
    throw new MimeError('Email must have at least text, html, an attachment or a calendar invite');
  }

  let requires8Bit = false;
  const buildAttachment = async (att: Attachment): Promise<Entity> => {
    const e = await attachmentEntity(att, policy);
    if (e.headers.some(([k, v]) => k === 'Content-Transfer-Encoding' && v === '8bit')) requires8Bit = true;
    return e;
  };

  // Content: text / html / alternative, wrapped in related when CIDs exist
  let content: Entity | null = null;
  if (text && html) {
    // AMP sits between text and html: clients pick the last part they support, so html stays the fallback.
    const amp = options.amp !== undefined ? [textEntity('text/x-amp-html', options.amp)] : [];
    content = { headers: [['Content-Type', 'multipart/alternative']], children: [textEntity('text/plain', text), ...amp, textEntity('text/html', html)] };
  } else if (html) {
    content = textEntity('text/html', html);
  } else if (text) {
    content = textEntity('text/plain', text);
  }

  if (inline.length) {
    if (!content) throw new MimeError('Inline (cid) attachments require an html body');
    content = {
      headers: [['Content-Type', 'multipart/related']],
      children: [content, ...(await Promise.all(inline.map(buildAttachment)))],
    };
  }

  const calendar = options.ical ? calendarEntity(options) : null;
  let root: Entity;
  if (!content && calendar && regular.length === 0) {
    root = calendar.part; // invite-only message
  } else {
    const mixedChildren: Entity[] = [];
    if (content) mixedChildren.push(content);
    for (const att of regular) mixedChildren.push(await buildAttachment(att));
    if (calendar) mixedChildren.push(calendar.file);
    root = mixedChildren.length === 1 && !calendar && regular.length === 0
      ? mixedChildren[0]!
      : { headers: [['Content-Type', 'multipart/mixed']], children: mixedChildren };
  }

  const raw = Buffer.concat([serializeHeaders(headers), serializeEntity(root)]);
  const allAddresses = [envelopeFrom, ...envelopeTo, ...toList.map(a => a.email), ...ccList.map(a => a.email)];

  return {
    raw,
    from: envelopeFrom,
    to: envelopeTo,
    messageId,
    requiresSmtpUtf8: allAddresses.some(needsUtf8),
    requires8BitMime: requires8Bit,
  };
}

/**
 * Structural address check: one `@`, no whitespace, brackets, quotes or
 * separators. Deliberately permissive otherwise (non-ASCII allowed for SMTPUTF8).
 */
const ADDRESS_RE = /^[^\s<>()[\],;:"\\@]+@[^\s<>()[\],;:"\\@]+$/;
function checkAddress(email: string): void {
  if (!ADDRESS_RE.test(email)) throw new MimeError(`Invalid email address: ${JSON.stringify(email)}`);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter(a => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Entities ────────────────────────────────────────────────────────────────

function textEntity(type: 'text/plain' | 'text/html' | 'text/x-amp-html', body: string): Entity {
  return {
    headers: [
      ['Content-Type', `${type}; charset=UTF-8`],
      ['Content-Transfer-Encoding', 'quoted-printable'],
    ],
    body: Buffer.from(encodeQP(body), 'ascii'),
  };
}

function calendarEntity(options: EmailOptions): { part: Entity; file: Entity } {
  const ics = buildICalString(options.ical!);
  const method = sanitizeHeaderValue(options.ical!.method ?? 'REQUEST').toUpperCase();
  const body = Buffer.from(encodeQP(ics), 'ascii');
  const type = withParams('text/calendar', { charset: 'UTF-8', method });
  return {
    part: { headers: [['Content-Type', type], ['Content-Transfer-Encoding', 'quoted-printable']], body },
    file: {
      headers: [
        ['Content-Type', type],
        ['Content-Disposition', withParams('attachment', { filename: 'invite.ics' })],
        ['Content-Transfer-Encoding', 'quoted-printable'],
      ],
      body,
    },
  };
}

async function attachmentEntity(att: Attachment, policy: AttachmentPathPolicy | undefined): Promise<Entity> {
  const filename = sanitizeHeaderValue(att.filename || 'attachment');

  if (att.rfc822 !== undefined) {
    const raw = Buffer.isBuffer(att.rfc822) ? att.rfc822 : Buffer.from(att.rfc822, 'utf8');
    return {
      headers: [
        ['Content-Type', 'message/rfc822'],
        ['Content-Disposition', withParams('attachment', { filename })],
      ],
      body: normalizeCrlf(raw),
    };
  }

  const resolved = await resolveAttachment(att, policy);
  const content = await resolved.getContent();
  const contentType = checkContentType(resolved.contentType);
  const name = sanitizeHeaderValue(resolved.filename);
  const disposition = resolved.disposition === 'inline' ? 'inline' : 'attachment';
  const encoding = att.encoding ?? 'base64';

  const headers: Array<[string, string]> = [
    ['Content-Type', withParams(contentType, { name })],
    ['Content-Disposition', withParams(disposition, { filename: name })],
  ];
  if (resolved.cid) headers.push(['Content-ID', `<${sanitizeHeaderValue(resolved.cid).replace(/^<|>$/g, '')}>`]);

  let body: Buffer;
  switch (encoding) {
    case 'base64':
      body = Buffer.from(wrapBase64(content.toString('base64')), 'ascii');
      break;
    case 'quoted-printable':
      body = Buffer.from(encodeQPBytes(content), 'ascii');
      break;
    case '7bit':
    case '8bit': {
      const bad = encoding === '7bit' ? content.some(b => b > 0x7f || b === 0) : content.includes(0);
      if (bad || content.toString('latin1').split(/\r?\n/).some(l => l.length > 998)) {
        throw new MimeError(`Attachment "${name}" cannot be sent as ${encoding}; use base64 or quoted-printable`);
      }
      body = normalizeCrlf(content);
      break;
    }
    default:
      throw new MimeError(`Unsupported attachment encoding: ${String(encoding)}`);
  }
  headers.push(['Content-Transfer-Encoding', encoding]);
  return { headers, body };
}

// ── Serialisation ───────────────────────────────────────────────────────────

function serializeHeaders(headers: Array<[string, string]>): Buffer {
  return Buffer.from(headers.map(([k, v]) => foldHeader(k, v)).join('\r\n') + '\r\n', 'utf8');
}

function serializeEntity(e: Entity): Buffer {
  if (e.children) {
    const b = e.boundary ?? boundary();
    const [ctName, ctValue] = e.headers[0]!;
    const headers: Array<[string, string]> = [[ctName, `${ctValue}; boundary="${b}"`], ...e.headers.slice(1)];
    const chunks: Buffer[] = [serializeHeaders(headers), Buffer.from('\r\n')];
    for (const child of e.children) {
      chunks.push(Buffer.from(`--${b}\r\n`), serializeEntity(child), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${b}--\r\n`));
    return Buffer.concat(chunks);
  }
  return Buffer.concat([serializeHeaders(e.headers), Buffer.from('\r\n'), e.body ?? Buffer.alloc(0)]);
}

function normalizeCrlf(buf: Buffer): Buffer {
  return Buffer.from(buf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '');
}

/** Quoted-printable encoder for UTF-8 text with normalised CRLF line breaks (RFC 2045 §6.7). */
export function encodeQP(text: string): string {
  return encodeQPBytes(Buffer.from(text.replace(/\r?\n/g, '\n'), 'utf8'));
}

function encodeQPBytes(buf: Buffer): string {
  let out = '';
  let line = '';
  const push = (tok: string) => {
    if (line.length + tok.length > 75) {
      out += line + '=\r\n';
      line = '';
    }
    line += tok;
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0x0d && buf[i + 1] === 0x0a) continue; // handled by LF
    if (b === 0x0a) {
      out += line + '\r\n';
      line = '';
      continue;
    }
    const atEol = i + 1 >= buf.length || buf[i + 1] === 0x0a || (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a);
    const printable = (b >= 0x21 && b <= 0x7e && b !== 0x3d) || ((b === 0x20 || b === 0x09) && !atEol);
    // A leading "." or "From " is safe to keep; SMTP dot-stuffing handles dots.
    push(printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  return out + line;
}
