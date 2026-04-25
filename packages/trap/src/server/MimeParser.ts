import type { CapturedMessage, CapturedAttachment, ParsedAddress } from '../store/MemoryStore.js';

// ── Header parsing ────────────────────────────────────────────────────────────

function parseHeaderBlock(block: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = block.split('\r\n');
  let current: [string, string] | null = null;

  for (const line of lines) {
    if (line.length === 0) continue;
    if ((line[0] === ' ' || line[0] === '\t') && current) {
      current[1] += ' ' + line.trim();
      continue;
    }
    if (current) {
      const key = current[0].toLowerCase();
      const arr = map.get(key) ?? [];
      arr.push(current[1].trim());
      map.set(key, arr);
    }
    const colon = line.indexOf(':');
    if (colon === -1) { current = null; continue; }
    current = [line.slice(0, colon), line.slice(colon + 1)];
  }
  if (current) {
    const key = current[0].toLowerCase();
    const arr = map.get(key) ?? [];
    arr.push(current[1].trim());
    map.set(key, arr);
  }
  return map;
}

// ── RFC 2047 encoded-word decode ──────────────────────────────────────────────

function decodeEncodedWord(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset: string, encoding: string, text: string) => {
    if (encoding.toUpperCase() === 'B') {
      return Buffer.from(text, 'base64').toString('utf8');
    }
    return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m2, h: string) =>
      String.fromCharCode(parseInt(h, 16)));
  });
}

// ── Address parsing ───────────────────────────────────────────────────────────

function parseAddresses(value: string): ParsedAddress[] {
  if (!value) return [];
  const results: ParsedAddress[] = [];

  // Split on commas not inside angle brackets or quotes
  const parts = value.split(/,(?![^<]*>)/);
  for (const part of parts) {
    const trimmed = decodeEncodedWord(part.trim());
    const angleMatch = trimmed.match(/^(.*?)<([^>]+)>/);
    if (angleMatch) {
      const name = angleMatch[1]!.replace(/^["'\s]+|["'\s]+$/g, '') || null;
      results.push({ name, email: angleMatch[2]!.trim() });
    } else if (trimmed.includes('@')) {
      results.push({ name: null, email: trimmed });
    }
  }
  return results;
}

// ── Content-Type parsing ──────────────────────────────────────────────────────

interface ContentType {
  type: string;
  boundary?: string;
  charset?: string;
  name?: string;
}

function parseContentType(value: string): ContentType {
  const parts = value.split(';').map(p => p.trim());
  const type = (parts[0] ?? '').toLowerCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type, boundary: params['boundary'], charset: params['charset'], name: params['name'] };
}

// ── Body decoding ─────────────────────────────────────────────────────────────

function decodeBody(body: string, encoding: string, charset = 'utf-8'): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'base64') {
    const buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    return buf.toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'latin1');
  }
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function decodeBodyBuffer(body: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const decoded = body
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(decoded, 'binary');
  }
  return Buffer.from(body, 'binary');
}

// ── MIME part ─────────────────────────────────────────────────────────────────

interface MimePart {
  headers: Map<string, string[]>;
  body: string;
}

function splitParts(body: string, boundary: string): MimePart[] {
  const delimiter = `--${boundary}`;
  const parts: MimePart[] = [];
  const lines = body.split('\r\n');
  let inPart = false;
  let partLines: string[] = [];

  for (const line of lines) {
    if (line === delimiter) {
      if (inPart && partLines.length > 0) {
        parts.push(parsePart(partLines.join('\r\n')));
        partLines = [];
      }
      inPart = true;
    } else if (line === `${delimiter}--`) {
      if (inPart && partLines.length > 0) parts.push(parsePart(partLines.join('\r\n')));
      break;
    } else if (inPart) {
      partLines.push(line);
    }
  }
  return parts;
}

function parsePart(raw: string): MimePart {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep === -1) return { headers: new Map(), body: raw };
  return {
    headers: parseHeaderBlock(raw.slice(0, sep)),
    body: raw.slice(sep + 4),
  };
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseMime(
  raw: Buffer,
  partial: Omit<CapturedMessage, 'subject' | 'from' | 'to' | 'cc' | 'headers' | 'text' | 'html' | 'attachments'>,
): CapturedMessage {
  const str = raw.toString('binary');
  const sep = str.indexOf('\r\n\r\n');
  const headerBlock = sep === -1 ? str : str.slice(0, sep);
  const bodyBlock   = sep === -1 ? '' : str.slice(sep + 4);

  const headers = parseHeaderBlock(headerBlock);
  const headersRecord: Record<string, string[]> = {};
  for (const [k, v] of headers) headersRecord[k] = v;

  const subject = decodeEncodedWord(headers.get('subject')?.[0] ?? '');
  const from    = parseAddresses(headers.get('from')?.[0] ?? '');
  const to      = parseAddresses(headers.get('to')?.[0] ?? '');
  const cc      = parseAddresses(headers.get('cc')?.[0] ?? '');

  const ctRaw = headers.get('content-type')?.[0] ?? 'text/plain';
  const ct = parseContentType(ctRaw);
  const transferEncoding = headers.get('content-transfer-encoding')?.[0] ?? '7bit';

  const attachments: CapturedAttachment[] = [];
  let text: string | null = null;
  let html: string | null = null;

  function walkPart(partHeaders: Map<string, string[]>, partBody: string): void {
    const partCt = parseContentType(partHeaders.get('content-type')?.[0] ?? 'text/plain');
    const partEnc = partHeaders.get('content-transfer-encoding')?.[0] ?? '7bit';
    const disposition = partHeaders.get('content-disposition')?.[0] ?? '';
    const cid = (partHeaders.get('content-id')?.[0] ?? '').replace(/^<|>$/g, '');
    const isAttachment = disposition.toLowerCase().startsWith('attachment') || (partCt.name && !cid);

    if (partCt.type.startsWith('multipart/') && partCt.boundary) {
      for (const sub of splitParts(partBody, partCt.boundary)) {
        walkPart(sub.headers, sub.body);
      }
    } else if (partCt.type === 'text/plain' && !isAttachment) {
      text = decodeBody(partBody, partEnc, partCt.charset);
    } else if (partCt.type === 'text/html' && !isAttachment) {
      html = decodeBody(partBody, partEnc, partCt.charset);
    } else {
      const filename = partCt.name ?? (disposition.match(/filename="?([^";]+)"?/)?.[1] ?? 'attachment');
      const content = decodeBodyBuffer(partBody, partEnc);
      attachments.push({
        filename,
        contentType: partCt.type,
        size: content.length,
        cid: cid || null,
        content,
      });
    }
  }

  if (ct.type.startsWith('multipart/') && ct.boundary) {
    for (const part of splitParts(bodyBlock, ct.boundary)) {
      walkPart(part.headers, part.body);
    }
  } else if (ct.type === 'text/html') {
    html = decodeBody(bodyBlock, transferEncoding, ct.charset);
  } else {
    text = decodeBody(bodyBlock, transferEncoding, ct.charset);
  }

  return { ...partial, headers: headersRecord, subject, from, to, cc, text, html, attachments };
}
