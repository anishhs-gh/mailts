import { decodeRfc2047, decodeBytes, parseEnvelopeAddresses } from './ImapParser.js';
import type { ImapEnvelope, ImapMessage, ImapAttachment } from '../types/imap.js';

/** Parse a FETCH response data string into an ImapMessage. */
export function parseFetchResponse(seq: number, data: string): Partial<ImapMessage> {
  const msg: Partial<ImapMessage> = { seq };

  const uidMatch = data.match(/\bUID\s+(\d+)/i);
  if (uidMatch) msg.uid = parseInt(uidMatch[1]!, 10);

  const flagsMatch = data.match(/\bFLAGS\s+\(([^)]*)\)/i);
  if (flagsMatch) {
    msg.flags = flagsMatch[1]!.trim().split(/\s+/).filter(Boolean);
  }

  const sizeMatch = data.match(/\bRFC822\.SIZE\s+(\d+)/i);
  if (sizeMatch) msg.size = parseInt(sizeMatch[1]!, 10);

  const dateMatch = data.match(/\bINTERNALDATE\s+"([^"]+)"/i);
  if (dateMatch) msg.internalDate = new Date(dateMatch[1]!);

  const envMatch = data.match(/\bENVELOPE\s+(\([\s\S]+)/i);
  if (envMatch) {
    const envStr = extractParenGroup(envMatch[1]!);
    msg.envelope = parseEnvelope(envStr);
  }

  // ── RFC822 (full raw email: headers + blank line + body) ─────────────────
  const rfc822Match = data.match(/\bRFC822\s+\{(\d+)\}\r\n([\s\S]+)/i);
  if (rfc822Match) {
    const len = parseInt(rfc822Match[1]!, 10);
    const raw = rfc822Match[2]!.slice(0, len);

    // Split headers from body at the first blank line (CRLF CRLF or LF LF)
    const blankLineIdx = raw.search(/\r?\n\r?\n/);
    const headerSection = blankLineIdx >= 0 ? raw.slice(0, blankLineIdx) : raw;
    const bodySection = blankLineIdx >= 0 ? raw.slice(blankLineIdx).replace(/^\r?\n\r?\n/, '') : '';

    // Parse envelope from raw headers if not already set from ENVELOPE token
    if (!msg.envelope) {
      msg.envelope = parseHeadersToEnvelope(headerSection);
    }

    // Extract content-type and boundary from raw headers (handles folded headers)
    const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
    const ctHeader = extractHeader(unfolded, 'content-type') ?? 'text/plain';
    const contentType = ctHeader.split(';')[0]!.trim().toLowerCase();
    const boundary = extractBoundary(ctHeader);
    const charset = extractCharset(ctHeader);
    const encoding = (extractHeader(unfolded, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();

    if (bodySection) {
      msg.body = parseMimeBody(bodySection, contentType, boundary, encoding, charset);
    } else {
      msg.body = { attachments: [] };
    }
  }

  // ── Fallback: BODY[HEADER] for envelope (no body) ────────────────────────
  const bodyHeaderMatch = data.match(/\bBODY\[HEADER\][^{]*\{(\d+)\}\r\n([\s\S]+)/i);
  if (bodyHeaderMatch && !msg.envelope) {
    const len = parseInt(bodyHeaderMatch[1]!, 10);
    const headerRaw = bodyHeaderMatch[2]!.slice(0, len);
    msg.envelope = parseHeadersToEnvelope(headerRaw);
  }

  return msg;
}

/**
 * Extract raw bytes for a specific BODY[section] from a FETCH response data string.
 * Returns null if the section is not present in this response.
 */
export function parseSectionResponse(data: string, section: string): Buffer | null {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\bBODY(?:\\.PEEK)?\\[${escaped}\\][^{]*\\{(\\d+)\\}\\r?\\n([\\s\\S]+)`, 'i');
  const m = data.match(re);
  if (!m) return null;
  const len = parseInt(m[1]!, 10);
  return Buffer.from(m[2]!.slice(0, len), 'binary');
}

// ── MIME body parser ───────────────────────────────────────────────────────

interface ParsedBody {
  text?: string;
  html?: string;
  attachments: ImapAttachment[];
}

function parseMimeBody(
  raw: string,
  contentType: string,
  boundary: string | undefined,
  encoding: string,
  charset = 'utf-8',
): ParsedBody {
  const result: ParsedBody = { attachments: [] };
  const ct = contentType.toLowerCase();

  if (ct.startsWith('multipart/')) {
    if (!boundary) return result;
    const parts = splitMultipart(raw, boundary);

    for (const part of parts) {
      const { headers, body } = splitPartHeadersAndBody(part);
      const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
      const rawPartCt = extractHeader(unfolded, 'content-type') ?? 'text/plain';
      const partCt = rawPartCt.split(';')[0]!.trim().toLowerCase();
      const partBoundary = extractBoundary(rawPartCt);
      const partCharset = extractCharset(rawPartCt);
      const partEncoding = (extractHeader(unfolded, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
      const partDisposition = (extractHeader(unfolded, 'content-disposition') ?? '').toLowerCase();
      const filename = extractFilename(unfolded);
      const contentId = extractContentId(unfolded);

      // ── message/rfc822 (forwarded / bounced email) ───────────────────────
      if (partCt === 'message/rfc822') {
        const nestedBlank = body.search(/\n\n/);
        const nestedHeaders = nestedBlank >= 0 ? body.slice(0, nestedBlank) : body;
        const nestedBody = nestedBlank >= 0 ? body.slice(nestedBlank + 2) : '';
        const nestedUnfolded = nestedHeaders.replace(/\r?\n[ \t]+/g, ' ');
        const nestedCtHeader = extractHeader(nestedUnfolded, 'content-type') ?? 'text/plain';
        const nestedCt = nestedCtHeader.split(';')[0]!.trim().toLowerCase();
        const nestedBoundary = extractBoundary(nestedCtHeader);
        const nestedCharset = extractCharset(nestedCtHeader);
        const nestedEncoding = (extractHeader(nestedUnfolded, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
        result.attachments.push({
          filename: filename ?? extractHeader(unfolded, 'content-description') ?? 'forwarded-message.eml',
          contentType: 'message/rfc822',
          size: body.length,
          content: Buffer.from(body, 'latin1'),
          contentId,
          inline: partDisposition.startsWith('inline'),
          nestedMessage: {
            envelope: parseHeadersToEnvelope(nestedHeaders),
            body: nestedBody ? parseMimeBody(nestedBody, nestedCt, nestedBoundary, nestedEncoding, nestedCharset) : { attachments: [] },
          },
        });
        continue;
      }

      // ── Explicit download attachment ──────────────────────────────────────
      if (partDisposition.startsWith('attachment')) {
        const content = decodeContent(body, partEncoding);
        result.attachments.push({ filename: filename ?? 'attachment', contentType: partCt, size: content.length, content, contentId, inline: false });
        continue;
      }

      // ── Inline disposition ────────────────────────────────────────────────
      if (partDisposition.startsWith('inline')) {
        if (filename || contentId) {
          // Named inline resource (embedded image referenced by cid:) — expose as attachment
          const content = decodeContent(body, partEncoding);
          result.attachments.push({ filename: filename ?? 'inline', contentType: partCt, size: content.length, content, contentId, inline: true });
          continue;
        }
        // Unnamed inline — fall through to content-type routing below
      }

      // ── Content-type routing (no explicit attachment disposition) ─────────
      if (partCt.startsWith('multipart/')) {
        const nested = parseMimeBody(body, partCt, partBoundary, partEncoding, partCharset);
        if (nested.text && !result.text) result.text = nested.text;
        if (nested.html && !result.html) result.html = nested.html;
        result.attachments.push(...nested.attachments);
      } else if (partCt === 'text/plain' && !result.text) {
        const decoded = decodeBytes(decodeContent(body.trimEnd(), partEncoding), partCharset);
        if (decoded.trim()) result.text = decoded;
      } else if (partCt === 'text/html' && !result.html) {
        const decoded = decodeBytes(decodeContent(body.trimEnd(), partEncoding), partCharset);
        if (decoded.trim()) result.html = decoded;
      } else if (!partDisposition.startsWith('inline')) {
        // Unknown content-type with no inline disposition — treat as unnamed attachment
        const content = decodeContent(body, partEncoding);
        result.attachments.push({ filename: filename ?? 'attachment', contentType: partCt, size: content.length, content, contentId, inline: false });
      }
    }
  } else if (ct === 'text/html') {
    result.html = decodeBytes(decodeContent(raw.trimEnd(), encoding), charset);
  } else {
    result.text = decodeBytes(decodeContent(raw.trimEnd(), encoding), charset);
  }

  return result;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const close = `--${boundary}--`;
  const parts: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[] = [];
  let inPart = false;

  for (const line of lines) {
    if (line.trimEnd() === close) break;
    if (line.trimEnd() === delimiter) {
      if (inPart && current.length > 0) {
        parts.push(current.join('\n'));
        current = [];
      }
      inPart = true;
    } else if (inPart) {
      current.push(line);
    }
  }
  if (inPart && current.length > 0) parts.push(current.join('\n'));
  return parts;
}

function splitPartHeadersAndBody(part: string): { headers: string; body: string } {
  // splitMultipart normalises line endings to \n, so the blank-line separator
  // between headers and body is always exactly \n\n.  Using \n\s*\n would
  // incorrectly treat a whitespace-only continuation line as a separator.
  const blankLine = part.search(/\n\n/);
  if (blankLine === -1) return { headers: part, body: '' };
  return { headers: part.slice(0, blankLine), body: part.slice(blankLine + 2) };
}

function extractHeader(unfolded: string, name: string): string | undefined {
  const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im');
  const m = unfolded.match(re);
  return m ? m[1]!.trim() : undefined;
}

function extractBoundary(ct: string): string | undefined {
  const m = ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
  return m ? m[1]!.trim() : undefined;
}

function extractFilename(unfolded: string): string | undefined {
  const cd = extractHeader(unfolded, 'content-disposition') ?? '';
  const ct = extractHeader(unfolded, 'content-type') ?? '';
  const m = (cd + ' ' + ct).match(/(?:filename|name)\s*=\s*"?([^";\r\n]+)"?/i);
  return m ? decodeRfc2047(m[1]!.trim()) : undefined;
}

function extractCharset(ct: string): string {
  const m = ct.match(/charset\s*=\s*"?([^";\r\n\s]+)"?/i);
  return m ? m[1]!.trim() : 'utf-8';
}

function extractContentId(unfolded: string): string | undefined {
  const v = extractHeader(unfolded, 'content-id');
  if (!v) return undefined;
  return v.replace(/^<|>$/g, '').trim();
}

function decodeContent(raw: string, encoding: string): Buffer {
  switch (encoding) {
    case 'base64':
      return Buffer.from(raw.replace(/\s+/g, ''), 'base64');
    case 'quoted-printable':
      return Buffer.from(decodeQP(raw), 'latin1');
    default:
      // latin1 preserves the raw byte values 1-to-1; the caller applies
      // TextDecoder with the correct charset afterwards.
      return Buffer.from(raw, 'latin1');
  }
}

function decodeQP(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ── Envelope helpers ───────────────────────────────────────────────────────

function extractParenGroup(str: string): string {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') { depth--; if (depth === 0) return str.slice(0, i + 1); }
  }
  return str;
}

function parseEnvelope(raw: string): ImapEnvelope {
  const inner = raw.slice(1, -1);
  const parts = splitEnvelopeParts(inner);
  return {
    date: parseEnvelopeDate(parts[0]),
    subject: parts[1] && parts[1].toUpperCase() !== 'NIL' ? decodeRfc2047(unquote(parts[1])) : '',
    from: parseEnvelopeAddresses(parts[2] ?? 'NIL'),
    sender: parseEnvelopeAddresses(parts[3] ?? 'NIL'),
    replyTo: parseEnvelopeAddresses(parts[4] ?? 'NIL'),
    to: parseEnvelopeAddresses(parts[5] ?? 'NIL'),
    cc: parseEnvelopeAddresses(parts[6] ?? 'NIL'),
    bcc: parseEnvelopeAddresses(parts[7] ?? 'NIL'),
    inReplyTo: parts[8] && parts[8].toUpperCase() !== 'NIL' ? unquote(parts[8]) : null,
    messageId: parts[9] && parts[9].toUpperCase() !== 'NIL' ? unquote(parts[9]) : null,
  };
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s;
}

function parseEnvelopeDate(raw: string | undefined): Date | null {
  if (!raw || raw.toUpperCase() === 'NIL') return null;
  const d = new Date(unquote(raw));
  return isNaN(d.getTime()) ? null : d;
}

function splitEnvelopeParts(str: string): string[] {
  const parts: string[] = [];
  let i = 0, depth = 0, current = '', inQuote = false;
  while (i < str.length) {
    const c = str[i]!;
    if (c === '"' && str[i - 1] !== '\\') { inQuote = !inQuote; current += c; }
    else if (!inQuote && c === '(') { depth++; current += c; }
    else if (!inQuote && c === ')') { depth--; current += c; }
    else if (!inQuote && c === ' ' && depth === 0) { parts.push(current.trim()); current = ''; }
    else { current += c; }
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseHeadersToEnvelope(raw: string): ImapEnvelope {
  const headers: Record<string, string> = {};
  const lines = raw.split(/\r\n|\n/);
  let current = '';
  for (const line of lines) {
    if (/^\s/.test(line)) { current += ' ' + line.trim(); }
    else {
      if (current) {
        const colon = current.indexOf(':');
        if (colon !== -1) headers[current.slice(0, colon).trim().toLowerCase()] = current.slice(colon + 1).trim();
      }
      current = line;
    }
  }
  if (current) {
    const colon = current.indexOf(':');
    if (colon !== -1) headers[current.slice(0, colon).trim().toLowerCase()] = current.slice(colon + 1).trim();
  }

  const parseAddr = (h: string) => {
    const v = headers[h]; if (!v) return [];
    return [{ email: v.replace(/.*<([^>]+)>.*/, '$1').trim(), name: v.replace(/<[^>]+>/, '').trim() || undefined }];
  };

  return {
    date: headers['date'] ? new Date(headers['date']) : null,
    subject: headers['subject'] ? decodeRfc2047(headers['subject']) : '',
    from: parseAddr('from'), sender: parseAddr('sender'), replyTo: parseAddr('reply-to'),
    to: parseAddr('to'), cc: parseAddr('cc'), bcc: parseAddr('bcc'),
    inReplyTo: headers['in-reply-to'] ?? null, messageId: headers['message-id'] ?? null,
  };
}
