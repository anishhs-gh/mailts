/**
 * RFC 5322 / 2047 / 2231 header encoding helpers for the MIME builder.
 * Every value that reaches a header goes through one of these functions, so
 * CR/LF injection is impossible and non-ASCII text is always encoded.
 */
import { MimeError } from '../errors.js';

// eslint-disable-next-line no-control-regex
const CTL = /[\r\n\0]/g;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x20-\x7e\t]/;
const HEADER_NAME = /^[!-9;-~]+$/;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

/** Strip CR, LF and NUL — the only characters that can break header framing. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(CTL, '').trim();
}

export function checkHeaderName(name: string): string {
  if (!HEADER_NAME.test(name)) throw new MimeError(`Invalid header name: ${JSON.stringify(name)}`);
  return name;
}

export function checkContentType(ct: string): string {
  const v = ct.trim().toLowerCase();
  if (!MIME_TYPE.test(v)) throw new MimeError(`Invalid content type: ${JSON.stringify(ct)}`);
  return v;
}

/**
 * Encode unstructured text (Subject, custom headers) as RFC 2047 B-encoded
 * words when it contains non-ASCII; each word stays ≤ 75 chars and never
 * splits a UTF-8 sequence.
 */
export function encodeUnstructured(value: string): string {
  const v = sanitizeHeaderValue(value);
  if (!NON_ASCII.test(v)) return v;
  return encodeWords(v).join(' ');
}

/** Split text into RFC 2047 `=?UTF-8?B?…?=` words. */
export function encodeWords(text: string): string[] {
  const words: string[] = [];
  const maxBytes = 45; // 45 bytes → 60 base64 chars + 12 overhead = 72 ≤ 75
  let chunk: Buffer[] = [];
  let size = 0;
  const flush = () => {
    if (!size) return;
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`);
    chunk = [];
    size = 0;
  };
  for (const ch of text) {
    const b = Buffer.from(ch, 'utf8');
    if (size + b.length > maxBytes) flush();
    chunk.push(b);
    size += b.length;
  }
  flush();
  return words;
}

/** Display-name encoding for addresses: quoted when needed, RFC 2047 when non-ASCII. */
export function encodeDisplayName(name: string): string {
  const n = sanitizeHeaderValue(name);
  if (NON_ASCII.test(n)) return encodeWords(n).join(' ');
  if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(n)) return n;
  return `"${n.replace(/[\\"]/g, m => `\\${m}`)}"`;
}

/**
 * Format a MIME parameter. ASCII tokens stay bare, other ASCII values are
 * quoted, and non-ASCII values use RFC 2231 (`name*=UTF-8''…`, split into
 * `name*0*`, `name*1*` … continuations) with an ASCII `name=` fallback for
 * old clients.
 */
export function formatParam(name: string, value: string): string {
  const v = sanitizeHeaderValue(value);
  if (!NON_ASCII.test(v)) {
    return TOKEN.test(v) && v.length <= 60 ? `${name}=${v}` : `${name}="${v.replace(/[\\"]/g, m => `\\${m}`)}"`;
  }
  const fallback = v.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  const encoded = pctEncode(v);
  const parts: string[] = [`${name}="${fallback}"`];
  if (encoded.length <= 60) {
    parts.push(`${name}*=UTF-8''${encoded}`);
  } else {
    const segs = splitPct(encoded, 60);
    segs.forEach((seg, i) => parts.push(`${name}*${i}*=${i === 0 ? "UTF-8''" : ''}${seg}`));
  }
  return parts.join('; ');
}

function pctEncode(s: string): string {
  return [...Buffer.from(s, 'utf8')]
    .map(b => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

/** Split a percent-encoded string without breaking `%XX` triplets. */
function splitPct(s: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + max, s.length);
    if (s[end - 1] === '%') end -= 1;
    else if (s[end - 2] === '%') end -= 2;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** `value; p1=…; p2=…` */
export function withParams(value: string, params: Record<string, string | undefined>): string {
  const segs = [value];
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') segs.push(formatParam(k, v));
  return segs.join('; ');
}

/**
 * Fold a header line at whitespace so lines stay ≤ 78 chars where possible
 * (RFC 5322 §2.1.1). Words are never split, so encoded words stay intact.
 */
export function foldHeader(name: string, value: string): string {
  const first = `${name}: `;
  if (first.length + value.length <= 78) return first + value;
  const tokens = value.split(/(?<=[;,]) +| +/);
  let out = first;
  let col = first.length;
  tokens.forEach((tok, i) => {
    if (i > 0) {
      if (col + 1 + tok.length > 78) {
        out += '\r\n ';
        col = 1;
      } else {
        out += ' ';
        col++;
      }
    }
    out += tok;
    col += tok.length;
  });
  return out;
}

/** Normalise a Message-ID reference to `<id>` form; rejects junk. */
export function normalizeMsgId(id: string): string {
  const v = sanitizeHeaderValue(id).replace(/^<|>$/g, '');
  if (!v || /[<>\s]/.test(v)) throw new MimeError(`Invalid Message-ID: ${JSON.stringify(id)}`);
  return `<${v}>`;
}

/** RFC 5322 date: `Wed, 30 Sep 2026 10:00:00 +0000`. */
export function formatRfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}
