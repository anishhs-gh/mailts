/**
 * IMAP response parser — handles tagged, untagged, and continuation responses.
 * Also handles literal strings: {N}\r\n followed by N bytes.
 */

export type ImapResponseType = 'tagged' | 'untagged' | 'continuation';

export interface ImapResponse {
  type: ImapResponseType;
  tag?: string;
  status?: 'OK' | 'NO' | 'BAD' | 'PREAUTH' | 'BYE';
  data: string;
  raw: string;
}

export interface ImapParserEvents {
  response: (r: ImapResponse) => void;
  error: (e: Error) => void;
}

export class ImapParser {
  private buf = '';
  private literalExpected: number | null = null;
  private literalAccum = '';

  feed(chunk: string): ImapResponse[] {
    this.buf += chunk;
    const responses: ImapResponse[] = [];

    while (true) {
      if (this.literalExpected !== null) {
        const needed = this.literalExpected - this.literalAccum.length;
        if (this.buf.length < needed) break;

        this.literalAccum += this.buf.slice(0, needed);
        this.buf = this.buf.slice(needed);
        this.literalExpected = null;
        // Literal is now in literalAccum — will be appended to next line
        continue;
      }

      const crlf = this.buf.indexOf('\r\n');
      if (crlf === -1) break;

      const line = this.literalAccum + this.buf.slice(0, crlf);
      this.buf = this.buf.slice(crlf + 2);
      this.literalAccum = '';

      // Check for literal spec at end of line: {N}
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        this.literalExpected = parseInt(literalMatch[1]!, 10);
        this.literalAccum = line + '\r\n';
        continue;
      }

      const parsed = parseLine(line);
      if (parsed) responses.push(parsed);
    }

    return responses;
  }
}

function parseLine(line: string): ImapResponse | null {
  if (!line.trim()) return null;

  // Continuation response
  if (line.startsWith('+')) {
    return { type: 'continuation', data: line.slice(1).trim(), raw: line };
  }

  // Untagged response
  if (line.startsWith('*')) {
    const rest = line.slice(2).trim();
    const upperRest = rest.toUpperCase();

    let status: ImapResponse['status'];
    if (upperRest.startsWith('OK')) status = 'OK';
    else if (upperRest.startsWith('NO')) status = 'NO';
    else if (upperRest.startsWith('BAD')) status = 'BAD';
    else if (upperRest.startsWith('PREAUTH')) status = 'PREAUTH';
    else if (upperRest.startsWith('BYE')) status = 'BYE';

    return { type: 'untagged', status, data: rest, raw: line };
  }

  // Tagged response: TAG SP (OK|NO|BAD) SP text
  const tagMatch = line.match(/^(\S+)\s+(OK|NO|BAD)\s+(.*)/i);
  if (tagMatch) {
    return {
      type: 'tagged',
      tag: tagMatch[1],
      status: tagMatch[2]?.toUpperCase() as 'OK' | 'NO' | 'BAD',
      data: tagMatch[3] ?? '',
      raw: line,
    };
  }

  return { type: 'untagged', data: line, raw: line };
}

/** Parse an IMAP parenthesized list, handling quoted strings and literals. */
export function parseList(str: string): string[] {
  const items: string[] = [];
  let i = 0;
  const s = str.trim();

  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }

    if (s[i] === '"') {
      // Quoted string
      let end = i + 1;
      while (end < s.length && s[end] !== '"') {
        if (s[end] === '\\') end++; // skip escaped char
        end++;
      }
      items.push(s.slice(i + 1, end).replace(/\\(.)/g, '$1'));
      i = end + 1;
    } else if (s[i] === '(') {
      // Nested list — find matching close paren
      let depth = 1;
      let end = i + 1;
      while (end < s.length && depth > 0) {
        if (s[end] === '(') depth++;
        else if (s[end] === ')') depth--;
        end++;
      }
      items.push(s.slice(i, end));
      i = end;
    } else if (s[i] === 'N' && s.slice(i, i + 3).toUpperCase() === 'NIL') {
      items.push('NIL');
      i += 3;
    } else {
      // Atom
      let end = i;
      while (end < s.length && s[end] !== ' ' && s[end] !== ')') end++;
      items.push(s.slice(i, end));
      i = end;
    }
  }

  return items;
}

/** Decode RFC 2047 encoded words: =?charset?encoding?text?= */
export function decodeRfc2047(input: string): string {
  // Split on encoded words; odd indices are encoded words, even are literals
  const parts = input.split(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)/g);
  const decoded = parts.map((part, i) => {
    if (i % 2 === 1) {
      const m = part.match(/^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/);
      if (!m) return part;
      const [, , enc, text] = m;
      if (enc!.toUpperCase() === 'B') {
        return Buffer.from(text!, 'base64').toString('utf8');
      }
      // Q-encoding: collect bytes, decode as UTF-8 in one shot
      const qText = text!.replace(/_/g, ' ');
      const bytes: number[] = [];
      for (let j = 0; j < qText.length; ) {
        if (qText[j] === '=' && j + 2 < qText.length) {
          bytes.push(parseInt(qText.slice(j + 1, j + 3), 16));
          j += 3;
        } else {
          bytes.push(qText.charCodeAt(j));
          j++;
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    // RFC 2047: whitespace between two adjacent encoded words is discarded
    if (i > 0 && i < parts.length - 1 && /^\s+$/.test(part)) return '';
    // Literal segment — server may send raw UTF-8 bytes read as binary (latin1)
    return Buffer.from(part, 'binary').toString('utf8');
  });
  return decoded.join('');
}

/** Parse envelope address list from IMAP ENVELOPE format. */
export function parseEnvelopeAddresses(raw: string): Array<{ email: string; name?: string }> {
  if (!raw || raw.toUpperCase() === 'NIL') return [];

  // Strip outer parens
  const inner = raw.slice(1, -1).trim();
  const addrs: Array<{ email: string; name?: string }> = [];

  // Each address is "(name NIL mailbox host)"
  const addrRe = /\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = addrRe.exec(inner)) !== null) {
    const parts = parseList(match[1] ?? '');
    const name = parts[0] && parts[0].toUpperCase() !== 'NIL' ? decodeRfc2047(parts[0]) : undefined;
    const local = parts[2] && parts[2].toUpperCase() !== 'NIL' ? parts[2] : '';
    const host = parts[3] && parts[3].toUpperCase() !== 'NIL' ? parts[3] : '';
    if (local && host) {
      addrs.push({ email: `${local}@${host}`, name });
    }
  }

  return addrs;
}
