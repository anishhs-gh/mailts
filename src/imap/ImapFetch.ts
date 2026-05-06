import { decodeRfc2047, parseEnvelopeAddresses } from './ImapParser.js';
import type { ImapEnvelope, ImapMessage } from '../types/imap.js';

/** Parse a FETCH response data string into an ImapMessage. */
export function parseFetchResponse(seq: number, data: string): Partial<ImapMessage> {
  const msg: Partial<ImapMessage> = { seq };

  // Extract UID
  const uidMatch = data.match(/\bUID\s+(\d+)/i);
  if (uidMatch) msg.uid = parseInt(uidMatch[1]!, 10);

  // Extract FLAGS
  const flagsMatch = data.match(/\bFLAGS\s+\(([^)]*)\)/i);
  if (flagsMatch) {
    msg.flags = flagsMatch[1]!.trim().split(/\s+/).filter(Boolean);
  }

  // Extract RFC822.SIZE
  const sizeMatch = data.match(/\bRFC822\.SIZE\s+(\d+)/i);
  if (sizeMatch) msg.size = parseInt(sizeMatch[1]!, 10);

  // Extract INTERNALDATE
  const dateMatch = data.match(/\bINTERNALDATE\s+"([^"]+)"/i);
  if (dateMatch) {
    msg.internalDate = new Date(dateMatch[1]!);
  }

  // Extract ENVELOPE
  const envMatch = data.match(/\bENVELOPE\s+(\([\s\S]+)/i);
  if (envMatch) {
    const envStr = extractParenGroup(envMatch[1]!);
    msg.envelope = parseEnvelope(envStr);
  }

  // Extract BODY[HEADER] or BODY[TEXT]
  const bodyHeaderMatch = data.match(/\bBODY\[HEADER\][^{]*\{(\d+)\}\r\n([\s\S]+)/i);
  if (bodyHeaderMatch) {
    const len = parseInt(bodyHeaderMatch[1]!, 10);
    const headerRaw = bodyHeaderMatch[2]!.slice(0, len);
    if (!msg.envelope) {
      msg.envelope = parseHeadersToEnvelope(headerRaw);
    }
  }

  return msg;
}

function extractParenGroup(str: string): string {
  let depth = 0;
  let i = 0;
  for (; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return str.slice(0, i + 1);
    }
  }
  return str;
}

function parseEnvelope(raw: string): ImapEnvelope {
  // ENVELOPE format: (date subject from sender reply-to to cc bcc in-reply-to message-id)
  const inner = raw.slice(1, -1);
  const parts = splitEnvelopeParts(inner);

  const envelope: ImapEnvelope = {
    date: parseEnvelopeDate(parts[0]),
    subject: parts[1] && parts[1].toUpperCase() !== 'NIL'
      ? decodeRfc2047(unquote(parts[1]))
      : '',
    from: parseEnvelopeAddresses(parts[2] ?? 'NIL'),
    sender: parseEnvelopeAddresses(parts[3] ?? 'NIL'),
    replyTo: parseEnvelopeAddresses(parts[4] ?? 'NIL'),
    to: parseEnvelopeAddresses(parts[5] ?? 'NIL'),
    cc: parseEnvelopeAddresses(parts[6] ?? 'NIL'),
    bcc: parseEnvelopeAddresses(parts[7] ?? 'NIL'),
    inReplyTo: parts[8] && parts[8].toUpperCase() !== 'NIL' ? unquote(parts[8]) : null,
    messageId: parts[9] && parts[9].toUpperCase() !== 'NIL' ? unquote(parts[9]) : null,
  };

  return envelope;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}

function parseEnvelopeDate(raw: string | undefined): Date | null {
  if (!raw || raw.toUpperCase() === 'NIL') return null;
  const d = new Date(unquote(raw));
  return isNaN(d.getTime()) ? null : d;
}

/** Split envelope parts, respecting nested parens and quotes. */
function splitEnvelopeParts(str: string): string[] {
  const parts: string[] = [];
  let i = 0;
  let depth = 0;
  let current = '';
  let inQuote = false;

  while (i < str.length) {
    const c = str[i]!;
    if (c === '"' && str[i - 1] !== '\\') {
      inQuote = !inQuote;
      current += c;
    } else if (!inQuote && c === '(') {
      depth++;
      current += c;
    } else if (!inQuote && c === ')') {
      depth--;
      current += c;
    } else if (!inQuote && c === ' ' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
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
    if (/^\s/.test(line)) {
      current += ' ' + line.trim();
    } else {
      if (current) {
        const colon = current.indexOf(':');
        if (colon !== -1) {
          const key = current.slice(0, colon).trim().toLowerCase();
          const val = current.slice(colon + 1).trim();
          headers[key] = val;
        }
      }
      current = line;
    }
  }

  const parseAddr = (h: string) => {
    const v = headers[h];
    if (!v) return [];
    return [{ email: v.replace(/.*<([^>]+)>.*/, '$1').trim(), name: v.replace(/<[^>]+>/, '').trim() || undefined }];
  };

  return {
    date: headers['date'] ? new Date(headers['date']) : null,
    subject: headers['subject'] ? decodeRfc2047(headers['subject']) : '',
    from: parseAddr('from'),
    sender: parseAddr('sender'),
    replyTo: parseAddr('reply-to'),
    to: parseAddr('to'),
    cc: parseAddr('cc'),
    bcc: parseAddr('bcc'),
    inReplyTo: headers['in-reply-to'] ?? null,
    messageId: headers['message-id'] ?? null,
  };
}
