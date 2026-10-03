/**
 * IMAP response tokenizer (RFC 3501 §9 / RFC 9051 §9).
 *
 * Input is a "binary" (latin1) string where every char is one byte, exactly
 * as framed by `ImapParser`. Literals appear inline as `{N}\r\n<N bytes>` and
 * are consumed by length — never scanned — so their content can contain any
 * byte sequence (parens, quotes, CRLF, `{5}`, …) without confusing the parser.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export type ImapToken =
  | { type: 'atom'; value: string }
  /** `value` is a byte string (latin1). `literal` is true for `{N}` literals. */
  | { type: 'string'; value: string; literal: boolean }
  | { type: 'nil' }
  | { type: 'list'; items: ImapToken[] };

const ATOM_END = new Set([' ', '(', ')', '\r', '\n']);

/**
 * Tokenize a response data string into a flat token sequence. Lists nest.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function tokenize(input: string, start = 0): ImapToken[] {
  const t = new Tokenizer(input, start);
  const out: ImapToken[] = [];
  while (!t.eof()) {
    const tok = t.next();
    if (tok) out.push(tok);
  }
  return out;
}

class Tokenizer {
  private i: number;
  constructor(private readonly s: string, start: number) { this.i = start; }

  eof(): boolean {
    this.skipSpace();
    return this.i >= this.s.length;
  }

  private skipSpace(): void {
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\r' || this.s[this.i] === '\n')) this.i++;
  }

  next(): ImapToken | null {
    this.skipSpace();
    const c = this.s[this.i];
    if (c === undefined) return null;
    if (c === '(') return this.list();
    if (c === ')') { this.i++; return null; } // stray close — tolerate
    if (c === '"') return this.quoted();
    if (c === '{' || (c === '~' && this.s[this.i + 1] === '{')) {
      const lit = this.literal();
      if (lit) return lit;
    }
    return this.atom();
  }

  private list(): ImapToken {
    this.i++; // (
    const items: ImapToken[] = [];
    for (;;) {
      this.skipSpace();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] === ')') { this.i++; break; }
      const tok = this.next();
      if (tok) items.push(tok);
    }
    return { type: 'list', items };
  }

  private quoted(): ImapToken {
    this.i++; // opening quote
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '\\' && this.i + 1 < this.s.length) { out += this.s[this.i + 1]; this.i += 2; continue; }
      if (c === '"') { this.i++; break; }
      out += c;
      this.i++;
    }
    return { type: 'string', value: out, literal: false };
  }

  private literal(): ImapToken | null {
    const m = /^~?\{(\d+)\+?\}\r\n/.exec(this.s.slice(this.i, this.i + 32));
    if (!m) return null;
    const len = Number(m[1]);
    const begin = this.i + m[0].length;
    const value = this.s.slice(begin, begin + len);
    this.i = begin + len;
    return { type: 'string', value, literal: true };
  }

  private atom(): ImapToken {
    const begin = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      // Section spec: BODY[HEADER.FIELDS (A B)] — brackets may contain spaces/parens
      if (c === '[') depth++;
      else if (c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && ATOM_END.has(c)) break;
      this.i++;
    }
    const value = this.s.slice(begin, this.i);
    if (value.toUpperCase() === 'NIL') return { type: 'nil' };
    return { type: 'atom', value };
  }
}

// ── Token accessors ─────────────────────────────────────────────────────────

/** String value of an atom or string token; `undefined` for NIL / lists. */
export function tokStr(t: ImapToken | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type === 'atom' || t.type === 'string') return t.value;
  return undefined;
}

export function tokNum(t: ImapToken | undefined): number | undefined {
  const s = tokStr(t);
  if (s === undefined || !/^\d+$/.test(s)) return undefined;
  return Number(s);
}

export function tokList(t: ImapToken | undefined): ImapToken[] | undefined {
  return t?.type === 'list' ? t.items : undefined;
}

export function isNil(t: ImapToken | undefined): boolean {
  return !t || t.type === 'nil';
}

// ── Command-side encoding ───────────────────────────────────────────────────

/** A command argument that must be sent as an IMAP literal. */
export class Literal {
  constructor(readonly data: Buffer) {}
}

/** A command is a list of text fragments and literals, joined by the client. */
export type CommandPart = string | Literal;

/**
 * Encode `value` as an IMAP string argument: quoted when it is plain 7-bit
 * text, a literal when it contains 8-bit bytes, CR/LF or NUL.
 */
export function astring(value: string): CommandPart {
  // eslint-disable-next-line no-control-regex
  if (/[^\x01-\x7f]|[\r\n]/.test(value)) return new Literal(Buffer.from(value, 'utf8'));
  return `"${value.replace(/[\\"]/g, m => `\\${m}`)}"`;
}

/** Encode a mailbox name (modified UTF-7, RFC 3501 §5.1.3) as an IMAP argument. */
export function mailboxArg(name: string): CommandPart {
  return astring(encodeMailboxName(name));
}

/**
 * RFC 3501 §5.1.3 modified UTF-7 encoder.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function encodeMailboxName(name: string): string {
  let out = '';
  let pending = '';
  const flush = () => {
    if (!pending) return;
    const utf16 = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) utf16.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += '&' + utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    pending = '';
  };
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else {
      pending += ch;
    }
  }
  flush();
  return out;
}

/**
 * RFC 3501 §5.1.3 modified UTF-7 decoder. Invalid sequences are left as-is.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function decodeMailboxName(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (whole, b64: string) => {
    if (b64 === '') return '&';
    const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    if (buf.length % 2 !== 0) return whole;
    let s = '';
    for (let i = 0; i < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  });
}

/**
 * Compress UIDs into an IMAP sequence set (`1:5,9,12:20`), split into chunks
 * whose textual form stays under `maxLen` bytes so commands never exceed
 * server line limits.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function uidSets(uids: readonly number[], maxLen = 4_000): string[] {
  const sorted = [...new Set(uids)].filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    ranges.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  const out: string[] = [];
  let cur = '';
  for (const r of ranges) {
    if (cur && cur.length + 1 + r.length > maxLen) { out.push(cur); cur = ''; }
    cur = cur ? `${cur},${r}` : r;
  }
  if (cur) out.push(cur);
  return out;
}
