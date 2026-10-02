/**
 * IMAP response framing — splits the server byte stream into complete
 * responses (tagged, untagged, continuation). A response may span several
 * lines when it carries literals (`{N}\r\n` followed by exactly N bytes).
 *
 * Framing is byte-exact: the literal byte count is tracked independently of
 * the accumulated prefix, and incoming chunks are kept as a Buffer list so
 * large literals are copied once (O(n)) instead of re-concatenated per chunk.
 */
import { tokenize, isNil, tokList, tokStr } from './ImapTokenizer.js';
import { LimitError } from '../errors.js';

/** Size limits applied while framing server responses (all in bytes). */
export interface ImapLimits {
  /** Largest single literal (message body / section). @default 64 MiB */
  maxLiteralBytes?: number;
  /** Largest complete response, literals included. @default 128 MiB */
  maxResponseBytes?: number;
  /** Longest line outside literals. @default 1 MiB */
  maxLineBytes?: number;
}

export const DEFAULT_IMAP_LIMITS: Required<ImapLimits> = {
  maxLiteralBytes: 64 * 1024 * 1024,
  maxResponseBytes: 128 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
};

export type ImapResponseType = 'tagged' | 'untagged' | 'continuation';

export interface ImapResponse {
  type: ImapResponseType;
  tag?: string;
  status?: 'OK' | 'NO' | 'BAD' | 'PREAUTH' | 'BYE';
  /**
   * Response payload as a binary (latin1) string: text after `* ` for untagged,
   * after the status for tagged. Literals are inline as `{N}\r\n<bytes>`.
   */
  data: string;
  raw: string;
}

export interface ImapParserEvents {
  response: (r: ImapResponse) => void;
  error: (e: Error) => void;
}

const LITERAL_AT_END = /~?\{(\d+)\+?\}$/;
const CRLF = Buffer.from('\r\n');

export class ImapParser {
  private readonly limits: Required<ImapLimits>;
  /** Bytes accumulated for the response being assembled. */
  private responseBytes = 0;

  constructor(limits: ImapLimits = {}) {
    this.limits = { ...DEFAULT_IMAP_LIMITS, ...limits };
  }

  /** Unconsumed input. */
  private pending: Buffer[] = [];
  private pendingLen = 0;
  /** Segments (lines + literal bytes) of the response being assembled. */
  private parts: Buffer[] = [];
  /** Literal bytes still owed by the server for the current response. */
  private literalRemaining = 0;

  /**
   * Feed raw bytes; returns every response completed by this chunk.
   * @throws LimitError when a literal, line or response exceeds `limits` — the
   *   stream cannot be resynchronised afterwards, so the connection must close.
   */
  feed(chunk: string | Buffer): ImapResponse[] {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    if (buf.length) { this.pending.push(buf); this.pendingLen += buf.length; }
    const responses: ImapResponse[] = [];

    for (;;) {
      if (this.literalRemaining > 0) {
        if (this.pendingLen < this.literalRemaining) break;
        this.parts.push(this.take(this.literalRemaining));
        this.literalRemaining = 0;
        continue;
      }

      const line = this.takeLine();
      if (line === null) {
        if (this.pendingLen > this.limits.maxLineBytes) {
          throw new LimitError(`IMAP line exceeds ${this.limits.maxLineBytes} bytes without CRLF`);
        }
        break;
      }
      if (line.length > this.limits.maxLineBytes) {
        throw new LimitError(`IMAP line of ${line.length} bytes exceeds ${this.limits.maxLineBytes}`);
      }
      this.responseBytes += line.length + 2;

      const text = line.toString('latin1');
      const lit = LITERAL_AT_END.exec(text);
      if (lit) {
        const size = Number(lit[1]);
        // Checked before any literal byte is buffered
        if (size > this.limits.maxLiteralBytes) {
          throw new LimitError(`IMAP literal of ${size} bytes exceeds maxLiteralBytes (${this.limits.maxLiteralBytes})`);
        }
        if (this.responseBytes + size > this.limits.maxResponseBytes) {
          throw new LimitError(`IMAP response exceeds maxResponseBytes (${this.limits.maxResponseBytes})`);
        }
        this.responseBytes += size;
        this.parts.push(line, CRLF);
        this.literalRemaining = size;
        continue;
      }

      this.parts.push(line);
      const full = this.parts.length === 1 ? text : Buffer.concat(this.parts).toString('latin1');
      this.parts = [];
      this.responseBytes = 0;
      const parsed = parseLine(full);
      if (parsed) responses.push(parsed);
    }

    return responses;
  }

  /** Remove and return exactly `n` bytes from the pending list. */
  private take(n: number): Buffer {
    const out: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.pending[0]!;
      if (head.length <= need) {
        out.push(head);
        this.pending.shift();
        need -= head.length;
      } else {
        out.push(head.subarray(0, need));
        this.pending[0] = head.subarray(need);
        need = 0;
      }
    }
    this.pendingLen -= n;
    return out.length === 1 ? out[0]! : Buffer.concat(out, n);
  }

  /** Remove and return the next line (without CRLF), or null if incomplete. */
  private takeLine(): Buffer | null {
    if (this.pendingLen === 0) return null;
    if (this.pending.length > 1) {
      this.pending = [Buffer.concat(this.pending, this.pendingLen)];
    }
    const head = this.pending[0]!;
    const idx = head.indexOf(CRLF);
    if (idx === -1) return null;
    const line = head.subarray(0, idx);
    const rest = head.subarray(idx + 2);
    this.pending = rest.length ? [rest] : [];
    this.pendingLen = rest.length;
    return line;
  }
}

const UNTAGGED_STATUS = /^(OK|NO|BAD|PREAUTH|BYE)\b/i;

function parseLine(line: string): ImapResponse | null {
  if (!line.trim()) return null;

  if (line.startsWith('+')) {
    return { type: 'continuation', data: line.slice(1).trim(), raw: line };
  }

  if (line.startsWith('*')) {
    const rest = line.slice(1).trimStart();
    const m = UNTAGGED_STATUS.exec(rest);
    const status = m ? (m[1]!.toUpperCase() as ImapResponse['status']) : undefined;
    return { type: 'untagged', status, data: rest, raw: line };
  }

  const tagMatch = /^(\S+)\s+(OK|NO|BAD)\b\s?(.*)$/is.exec(line);
  if (tagMatch) {
    return {
      type: 'tagged',
      tag: tagMatch[1],
      status: tagMatch[2]!.toUpperCase() as 'OK' | 'NO' | 'BAD',
      data: tagMatch[3] ?? '',
      raw: line,
    };
  }

  return { type: 'untagged', data: line, raw: line };
}

/**
 * Parse an IMAP parenthesized list body into flat string items.
 * Nested lists are returned as their raw text; NIL as `'NIL'`.
 * @deprecated Use `tokenize()` from `ImapTokenizer` for structured parsing.
 */
export function parseList(str: string): string[] {
  const items: string[] = [];
  let i = 0;
  const s = str.trim();

  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }

    if (s[i] === '"') {
      let end = i + 1;
      while (end < s.length && s[end] !== '"') {
        if (s[end] === '\\') end++;
        end++;
      }
      items.push(s.slice(i + 1, end).replace(/\\(.)/g, '$1'));
      i = end + 1;
    } else if (s[i] === '(') {
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
      const [, rawCharset, enc, text] = m;
      const charset = rawCharset!.split('*')[0]!; // RFC 2231 language suffix
      if (enc!.toUpperCase() === 'B') {
        return decodeBytes(Buffer.from(text!, 'base64'), charset);
      }
      // Q-encoding: collect raw bytes, then decode with the declared charset
      const qText = text!.replace(/_/g, ' ');
      const bytes: number[] = [];
      for (let j = 0; j < qText.length; ) {
        if (qText[j] === '=' && /^[0-9A-Fa-f]{2}$/.test(qText.slice(j + 1, j + 3))) {
          bytes.push(parseInt(qText.slice(j + 1, j + 3), 16));
          j += 3;
        } else {
          bytes.push(qText.charCodeAt(j));
          j++;
        }
      }
      return decodeBytes(Buffer.from(bytes), charset);
    }
    // RFC 2047: whitespace between two adjacent encoded words is discarded
    if (i > 0 && i < parts.length - 1 && /^\s+$/.test(part)) return '';
    // Literal segment — server may send raw UTF-8 bytes read as binary (latin1)
    return decodeLatin1Utf8(part);
  });
  return decoded.join('');
}

/**
 * Interpret a latin1 "byte string" as UTF-8 when it is valid UTF-8, otherwise
 * keep it as-is (it was already decoded text).
 */
export function decodeLatin1Utf8(s: string): string {
  // Already-decoded text (chars above 0xFF) must not be reinterpreted
  // eslint-disable-next-line no-control-regex
  if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  const bytes = Buffer.from(s, 'latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

/**
 * Decode a byte buffer with the given charset label using the WHATWG TextDecoder.
 * Node.js 18+ ships with full ICU, so this covers every charset RFC 2047 and
 * MIME may specify (ISO-2022-JP, GBK, Big5, EUC-KR, all Windows-125x, etc.)
 * without any runtime dependencies. Falls back to UTF-8 for unknown labels.
 */
export function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Parse an ENVELOPE address list (`((name adl mailbox host) …)` or NIL). */
export function parseEnvelopeAddresses(raw: string): Array<{ email: string; name?: string }> {
  if (!raw || raw.trim().toUpperCase() === 'NIL') return [];
  const [tok] = tokenize(raw);
  return envelopeAddressesFromTokens(tok);
}

/** Structured variant of `parseEnvelopeAddresses` — skips RFC 3501 group markers. */
export function envelopeAddressesFromTokens(
  tok: import('./ImapTokenizer.js').ImapToken | undefined,
): Array<{ email: string; name?: string }> {
  const list = tokList(tok);
  if (!list) return [];
  const out: Array<{ email: string; name?: string }> = [];
  for (const a of list) {
    const f = tokList(a);
    if (!f) continue;
    const mailbox = tokStr(f[2]);
    const host = tokStr(f[3]);
    if (isNil(f[3]) || !mailbox || !host) continue; // group start/end marker
    const nameRaw = tokStr(f[0]);
    const name = nameRaw ? decodeRfc2047(nameRaw) : undefined;
    out.push({ email: `${decodeLatin1Utf8(mailbox)}@${decodeLatin1Utf8(host)}`, ...(name ? { name } : {}) });
  }
  return out;
}
