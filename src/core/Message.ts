import { randomBytes } from 'crypto';
import type { EmailOptions } from '../types/core.js';
import { parseAddressList, formatAddressList, extractEmails, formatAddress } from './Address.js';
import { resolveAttachment } from './Attachment.js';
import { htmlToText } from './HtmlToText.js';
import { buildICalString } from './ICal.js';
import { MimeError } from '../errors.js';

/** Generate a MIME boundary — random, unpredictable. */
function boundary(): string {
  return `----=_Part_${randomBytes(16).toString('hex')}`;
}

/** Generate a Message-ID in RFC 5322 format. */
function generateMessageId(from: string): string {
  const local = randomBytes(12).toString('hex');
  const domain = from.split('@')[1] ?? 'mailts.local';
  return `<${local}@${domain}>`;
}

/** Fold a header value at 78 chars per RFC 5322 §2.1.1. */
function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  // Simple fold: insert CRLF+WSP before words that would exceed the limit
  const words = value.split(' ');
  let result = `${name}: `;
  let col = result.length;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (i > 0 && col + 1 + word.length > 78) {
      result += '\r\n\t';
      col = 1;
    } else if (i > 0) {
      result += ' ';
      col++;
    }
    result += word;
    col += word.length;
  }
  return result;
}

/** Sanitize header values — strip CR/LF to prevent injection. */
function sanitize(value: string): string {
  return value.replace(/[\r\n]/g, '').trim();
}

export interface BuiltMessage {
  /** Raw RFC 5322 message as a Buffer. */
  raw: Buffer;
  /** Envelope from (bare email). */
  from: string;
  /** Envelope recipients (bare emails). */
  to: string[];
  messageId: string;
}

export async function buildMessage(options: EmailOptions): Promise<BuiltMessage> {
  const fromList = parseAddressList(options.from, options.fromName);
  const toList = parseAddressList(options.to, options.toName);
  const ccList = parseAddressList(options.cc, options.ccName);
  if (toList.length === 0) throw new MimeError('At least one recipient (to) is required');

  const fromAddr = fromList[0];
  const envelopeFrom = fromAddr?.email ?? '';
  const envelopeTo = [
    ...extractEmails(options.to),
    ...extractEmails(options.cc),
    ...extractEmails(options.bcc),
  ];

  const subject = sanitize(options.subject ?? '(no subject)');
  const messageId = options.messageId ?? generateMessageId(envelopeFrom);
  const date = (options.date ?? new Date()).toUTCString();

  const headers: string[] = [];

  const pushHeader = (name: string, value: string) => {
    headers.push(foldHeader(name, value));
  };

  if (envelopeFrom) pushHeader('From', formatAddress(fromAddr ? { email: fromAddr.email, name: fromAddr.name } : envelopeFrom));
  pushHeader('To', formatAddressList(toList));
  if (ccList.length) pushHeader('Cc', formatAddressList(ccList));
  pushHeader('Subject', subject);
  pushHeader('Date', date);
  pushHeader('Message-ID', messageId);
  pushHeader('MIME-Version', '1.0');

  if (options.replyTo) pushHeader('Reply-To', formatAddress(options.replyTo));

  if (options.priority === 'high') {
    headers.push('X-Priority: 1');
    headers.push('X-MSMail-Priority: High');
    headers.push('Importance: High');
  } else if (options.priority === 'low') {
    headers.push('X-Priority: 5');
    headers.push('X-MSMail-Priority: Low');
    headers.push('Importance: Low');
  }

  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      pushHeader(sanitize(k), sanitize(v));
    }
  }

  const parts: Buffer[] = [];

  // Auto-generate plain text from HTML when only html is provided
  const resolvedText = options.text ?? (options.html ? htmlToText(options.html) : undefined);

  // Resolve body
  const hasText = Boolean(resolvedText);
  const hasHtml = Boolean(options.html);
  const attachments = options.attachments ?? [];
  const regularAtts = attachments.filter(a => !a.cid);
  const inlineAtts = attachments.filter(a => a.cid);
  const hasAttachments = regularAtts.length > 0;
  const hasInline = inlineAtts.length > 0;

  let bodyBuffer: Buffer;

  if (!hasText && !hasHtml && attachments.length === 0) {
    throw new MimeError('Email must have at least text, html, or an attachment');
  }

  const hasIcal = Boolean(options.ical);
  const needsMixed = hasAttachments || hasIcal;

  // ── Step 1: build the "content" part (text, html, inline CIDs) ──────────────
  // RFC 2387: when HTML has inline CID resources they must be wrapped together
  // in multipart/related so clients know where to look for referenced images.
  //
  //  multipart/related
  //    multipart/alternative  (or bare text/html)
  //    image/png (cid=...)
  //    image/gif (cid=...)

  let contentPart: Buffer;
  let contentTypeHeader: string;

  if (hasInline) {
    // Resolve all inline (CID) attachments up-front
    const resolvedInline = await Promise.all(inlineAtts.map(async att => {
      const r = await resolveAttachment(att);
      const c = await r.getContent();
      return { r, c };
    }));

    const relB = boundary();

    // Inner body: alternative if both text+html, else bare html
    let innerHeaders: string;
    let innerBody: Buffer;
    if (hasText && hasHtml) {
      const altB = boundary();
      innerHeaders = `Content-Type: multipart/alternative; boundary="${altB}"`;
      innerBody = buildAlternative(altB, resolvedText!, options.html!);
    } else if (hasHtml) {
      innerHeaders = 'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable';
      innerBody = Buffer.from(encodeQP(options.html!), 'ascii');
    } else {
      innerHeaders = 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable';
      innerBody = Buffer.from(encodeQP(resolvedText!), 'ascii');
    }

    const relParts: Buffer[] = [
      Buffer.from(`--${relB}\r\n${innerHeaders}\r\n\r\n`),
      innerBody,
      Buffer.from('\r\n'),
    ];

    for (const { r, c } of resolvedInline) {
      const b64 = c.toString('base64').replace(/.{76}/g, '$&\r\n');
      relParts.push(Buffer.from(
        `--${relB}\r\nContent-Type: ${r.contentType}\r\n` +
        `Content-Disposition: inline; filename="${r.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `Content-ID: <${r.cid ?? ''}>\r\n\r\n${b64}\r\n`,
      ));
    }

    relParts.push(Buffer.from(`--${relB}--\r\n`));
    contentPart = Buffer.concat(relParts);
    contentTypeHeader = `Content-Type: multipart/related; boundary="${relB}"`;
  } else if (hasText && hasHtml) {
    const altB = boundary();
    contentTypeHeader = `Content-Type: multipart/alternative; boundary="${altB}"`;
    contentPart = buildAlternative(altB, resolvedText!, options.html!);
  } else if (hasHtml) {
    contentTypeHeader = 'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable';
    contentPart = Buffer.from(encodeQP(options.html!), 'ascii');
  } else {
    contentTypeHeader = 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable';
    contentPart = Buffer.from(encodeQP(resolvedText!), 'ascii');
  }

  // ── Step 2: wrap in multipart/mixed if there are downloadable attachments ───

  if (!needsMixed) {
    // No outer wrapper — content part is the message body
    headers.push(contentTypeHeader);
    headers.push('');
    bodyBuffer = contentPart;
  } else {
    const outerB = boundary();
    headers.push(`Content-Type: multipart/mixed; boundary="${outerB}"`);
    headers.push('');

    const mixed: Buffer[] = [
      Buffer.from(`--${outerB}\r\n${contentTypeHeader}\r\n\r\n`),
      contentPart,
      Buffer.from('\r\n'),
    ];

    // Regular (downloadable) attachments
    for (const att of regularAtts) {
      // message/rfc822 embedded email — no base64, output raw
      if (att.rfc822 !== undefined) {
        const raw822 = Buffer.isBuffer(att.rfc822) ? att.rfc822 : Buffer.from(att.rfc822, 'utf8');
        mixed.push(Buffer.from(
          `--${outerB}\r\nContent-Type: message/rfc822\r\n` +
          `Content-Disposition: attachment; filename="${sanitize(att.filename)}"\r\n\r\n`,
        ));
        mixed.push(raw822);
        mixed.push(Buffer.from('\r\n'));
        continue;
      }

      const resolved = await resolveAttachment(att);
      const content = await resolved.getContent();
      const b64 = content.toString('base64').replace(/.{76}/g, '$&\r\n');
      mixed.push(Buffer.from(
        `--${outerB}\r\nContent-Type: ${resolved.contentType}; name="${resolved.filename}"\r\n` +
        `Content-Disposition: attachment; filename="${resolved.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`,
      ));
    }

    // iCal
    if (options.ical) {
      const icsContent = buildICalString(options.ical);
      const method = options.ical.method ?? 'REQUEST';
      mixed.push(Buffer.from(
        `--${outerB}\r\nContent-Type: text/calendar; charset=UTF-8; method=${method}\r\n` +
        `Content-Disposition: attachment; filename="invite.ics"\r\n` +
        `Content-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQP(icsContent)}\r\n`,
      ));
    }

    mixed.push(Buffer.from(`--${outerB}--\r\n`));
    bodyBuffer = Buffer.concat(mixed);
  }

  parts.push(Buffer.from(headers.join('\r\n'), 'utf8'));
  parts.push(Buffer.from('\r\n'));
  parts.push(bodyBuffer);

  return {
    raw: Buffer.concat(parts),
    from: envelopeFrom,
    to: envelopeTo,
    messageId,
  };
}

function buildAlternative(b: string, text: string, html: string): Buffer {
  const textPart = `--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQP(text)}\r\n`;
  const htmlPart = `--${b}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQP(html)}\r\n`;
  const tail = `--${b}--\r\n`;
  return Buffer.from(textPart + htmlPart + tail, 'utf8');
}

/** Minimal quoted-printable encoder for UTF-8 text content (RFC 2045). */
function encodeQP(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  let result = '';
  let lineLen = 0;

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    // CR+LF passthrough
    if (byte === 0x0d && buf[i + 1] === 0x0a) {
      result += '\r\n';
      lineLen = 0;
      i++;
      continue;
    }
    // LF alone
    if (byte === 0x0a) {
      result += '\r\n';
      lineLen = 0;
      continue;
    }

    // Printable ASCII (except '=') and whitespace — passthrough
    if ((byte >= 0x20 && byte <= 0x7e && byte !== 0x3d) || byte === 0x09) {
      if (lineLen >= 75) {
        result += '=\r\n';
        lineLen = 0;
      }
      result += String.fromCharCode(byte);
      lineLen++;
    } else {
      // Encode
      const encoded = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      if (lineLen + 3 > 75) {
        result += '=\r\n';
        lineLen = 0;
      }
      result += encoded;
      lineLen += 3;
    }
  }
  return result;
}
