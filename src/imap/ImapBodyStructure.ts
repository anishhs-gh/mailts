import { decodeRfc2047 } from './ImapParser.js';

// ── Public types ───────────────────────────────────────────────────────────────

/** A single non-multipart MIME part with its section number and metadata. */
export interface BodyLeaf {
  type: 'leaf';
  /** IMAP section number: "1", "2", "3.1", "3.2.1", … */
  section: string;
  /** Full content-type: "text/plain", "application/pdf", … */
  contentType: string;
  charset?: string;
  /** Transfer encoding: "base64" | "quoted-printable" | "7bit" | "8bit" | "binary" */
  encoding: string;
  /** Size in octets on the wire (after transfer encoding). */
  size: number;
  /** Number of lines — present only for text/* parts. */
  lines?: number;
  contentId?: string;
  filename?: string;
  /** "attachment" | "inline" | undefined */
  disposition?: string;
}

/** A multipart container — holds an ordered list of child BodyNodes. */
export interface BodyMultipart {
  type: 'multipart';
  /** IMAP section number prefix: "" for top-level, "3" for a nested multipart. */
  section: string;
  /** Full content-type: "multipart/mixed", "multipart/alternative", … */
  contentType: string;
  boundary: string;
  parts: BodyNode[];
}

export type BodyNode = BodyLeaf | BodyMultipart;

// ── Parser entry point ─────────────────────────────────────────────────────────

/**
 * Parse a raw BODYSTRUCTURE response string into a typed BodyNode tree.
 *
 * The input should be the parenthesised content after the `BODYSTRUCTURE`
 * keyword, e.g. the full untagged FETCH data line works too — the parser
 * locates the BODYSTRUCTURE token automatically.
 */
export function parseBodyStructure(raw: string): BodyNode {
  const str = extractBodyStructureToken(raw);
  const tokens = tokenise(str);
  const [node] = parseNode(tokens, 0, '');
  return node;
}

// ── Tokeniser ──────────────────────────────────────────────────────────────────

type Token = string | Token[];

function tokenise(str: string): Token[] {
  const result: Token[] = [];
  let i = skipWS(str, 0);

  while (i < str.length) {
    if (str[i] === '(') {
      const [inner, next] = readList(str, i);
      result.push(inner);
      i = next;
    } else if (str[i] === '"') {
      const [val, next] = readQuoted(str, i);
      result.push(val);
      i = next;
    } else {
      const [val, next] = readAtom(str, i);
      result.push(val);
      i = next;
    }
    i = skipWS(str, i);
  }

  return result;
}

function readList(str: string, start: number): [Token[], number] {
  const items: Token[] = [];
  let i = skipWS(str, start + 1); // skip opening '('

  while (i < str.length && str[i] !== ')') {
    if (str[i] === '(') {
      const [inner, next] = readList(str, i);
      items.push(inner);
      i = next;
    } else if (str[i] === '"') {
      const [val, next] = readQuoted(str, i);
      items.push(val);
      i = next;
    } else {
      const [val, next] = readAtom(str, i);
      items.push(val);
      i = next;
    }
    i = skipWS(str, i);
  }

  return [items, i + 1]; // skip closing ')'
}

function readQuoted(str: string, start: number): [string, number] {
  let val = '';
  let i = start + 1; // skip opening '"'
  while (i < str.length && str[i] !== '"') {
    if (str[i] === '\\') { i++; }
    val += str[i++];
  }
  return [val, i + 1]; // skip closing '"'
}

function readAtom(str: string, start: number): [string, number] {
  let i = start;
  while (i < str.length && str[i] !== ' ' && str[i] !== ')' && str[i] !== '(') i++;
  return [str.slice(start, i), i];
}

function skipWS(str: string, i: number): number {
  while (i < str.length && str[i] === ' ') i++;
  return i;
}

// ── Node parser ────────────────────────────────────────────────────────────────

function parseNode(tokens: Token[], index: number, sectionPrefix: string): [BodyNode, number] {
  const token = tokens[index];

  // Multipart: first token is itself a list (nested part)
  if (Array.isArray(token)) {
    return parseMultipart(tokens, index, sectionPrefix);
  }

  // Leaf
  return [parseLeaf(tokens as string[], index, sectionPrefix || '1'), tokens.length];
}

function parseMultipart(tokens: Token[], startIndex: number, sectionPrefix: string): [BodyMultipart, number] {
  const parts: BodyNode[] = [];
  let i = startIndex;
  let partNum = 1;

  // Collect all leading list-tokens — each is a child part
  while (i < tokens.length && Array.isArray(tokens[i])) {
    const childSection = sectionPrefix ? `${sectionPrefix}.${partNum}` : String(partNum);
    const childTokens = tokens[i] as Token[];
    const [child] = parseNode(childTokens, 0, childSection);
    parts.push(child);
    i++;
    partNum++;
  }

  // Next atom after the parts is the multipart subtype ("mixed", "alternative", …)
  const subtype = isNil(tokens[i]) ? 'mixed' : String(tokens[i] ?? 'mixed').toLowerCase();
  i++;

  // Extension data: params list may follow — extract boundary from it
  let boundary = '';
  if (i < tokens.length && Array.isArray(tokens[i])) {
    boundary = extractParam(tokens[i] as Token[], 'boundary') ?? '';
    i++;
  }

  return [
    {
      type: 'multipart',
      section: sectionPrefix,
      contentType: `multipart/${subtype}`,
      boundary,
      parts,
    },
    i,
  ];
}

function parseLeaf(tokens: string[], _startIndex: number, section: string): BodyLeaf {
  // Positional fields per RFC 3501 §7.4.2:
  // 0: type  1: subtype  2: params  3: content-id  4: description
  // 5: encoding  6: size  7: lines (text/* only)  8: md5
  // 9: disposition  10: language
  const type    = isNil(tokens[0]) ? 'application' : tokens[0]!.toLowerCase();
  const subtype = isNil(tokens[1]) ? 'octet-stream' : tokens[1]!.toLowerCase();
  const params  = tokens[2] ?? '';
  const contentId   = isNil(tokens[3]) ? undefined : tokens[3]!.replace(/^<|>$/g, '');
  const encoding    = isNil(tokens[5]) ? '7bit' : tokens[5]!.toLowerCase();
  const size        = isNil(tokens[6]) ? 0 : parseInt(tokens[6]!, 10);
  const linesRaw    = tokens[7];
  const dispRaw     = tokens[9];

  const charset  = extractParamFromString(params, 'charset');
  const filename = extractParamFromString(params, 'name') ??
                   extractDispositionParam(dispRaw, 'filename');
  const disposition = extractDispositionType(dispRaw);

  const leaf: BodyLeaf = {
    type: 'leaf',
    section,
    contentType: `${type}/${subtype}`,
    encoding,
    size,
    contentId,
    disposition,
  };

  if (charset) leaf.charset = charset;
  if (filename) leaf.filename = decodeRfc2047(filename);
  if (type === 'text' && !isNil(linesRaw)) leaf.lines = parseInt(linesRaw!, 10);

  return leaf;
}

// ── Param helpers ──────────────────────────────────────────────────────────────

function extractParam(tokens: Token[], name: string): string | undefined {
  const flat = tokens.map(t => (Array.isArray(t) ? '' : t));
  for (let i = 0; i < flat.length - 1; i++) {
    if (flat[i]!.toLowerCase() === name.toLowerCase()) return flat[i + 1] ?? undefined;
  }
  return undefined;
}

function extractParamFromString(raw: string | string[] | Token, name: string): string | undefined {
  if (Array.isArray(raw)) return extractParam(raw as Token[], name);
  if (typeof raw !== 'string' || isNil(raw)) return undefined;
  const re = new RegExp(`${name}\\s*=\\s*"?([^"\\s;]+)"?`, 'i');
  const m = raw.match(re);
  return m ? m[1] : undefined;
}

function extractDispositionType(raw: string | string[] | Token | undefined): string | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const first = (raw as Token[])[0];
    if (typeof first === 'string' && !isNil(first)) return first.toLowerCase();
    return undefined;
  }
  if (typeof raw === 'string' && !isNil(raw)) return raw.toLowerCase();
  return undefined;
}

function extractDispositionParam(
  raw: string | string[] | Token | undefined,
  name: string,
): string | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return extractParam(raw as Token[], name);
}

// ── BODYSTRUCTURE token extractor ──────────────────────────────────────────────

function extractBodyStructureToken(raw: string): string {
  const upper = raw.toUpperCase();
  const idx = upper.indexOf('BODYSTRUCTURE');
  if (idx !== -1) {
    const after = raw.slice(idx + 'BODYSTRUCTURE'.length).trimStart();
    if (after.startsWith('(')) return after.slice(1, findMatchingParen(after, 0));
  }
  // Assume raw is already the bare parenthesised content
  if (raw.trimStart().startsWith('(')) {
    const s = raw.trimStart();
    return s.slice(1, findMatchingParen(s, 0));
  }
  return raw;
}

function findMatchingParen(str: string, start: number): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return str.length;
}

function isNil(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.toUpperCase() === 'NIL');
}
