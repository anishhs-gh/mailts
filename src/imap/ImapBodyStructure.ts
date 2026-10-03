import { tokenize, tokStr, tokNum, tokList, isNil, type ImapToken } from './ImapTokenizer.js';
import { parseHeaderValue } from '../core/MimeParser.js';

// ── Public types ───────────────────────────────────────────────────────────────

/** A single non-multipart MIME part with its section number and metadata. */
export interface BodyLeaf {
  /** Discriminator. */
  type: 'leaf';
  /** IMAP section number: "1", "2", "3.1", "3.2.1", … */
  section: string;
  /** Full content-type: "text/plain", "application/pdf", … */
  contentType: string;
  /** Charset parameter of text parts, e.g. `utf-8`. */
  charset?: string;
  /** Transfer encoding: "base64" | "quoted-printable" | "7bit" | "8bit" | "binary" */
  encoding: string;
  /** Size in octets on the wire (after transfer encoding). */
  size: number;
  /** Number of lines — present only for text/* parts. */
  lines?: number;
  /** Content-ID without angle brackets (inline images referenced as `cid:`). */
  contentId?: string;
  /** Decoded filename from Content-Disposition or Content-Type `name`. */
  filename?: string;
  /** "attachment" | "inline" | undefined */
  disposition?: string;
  /** For `message/rfc822` parts: the structure of the enclosed message. */
  body?: BodyNode;
}

/** A multipart container — holds an ordered list of child BodyNodes. */
export interface BodyMultipart {
  /** Discriminator. */
  type: 'multipart';
  /** IMAP section number prefix: "" for top-level, "3" for a nested multipart. */
  section: string;
  /** Full content-type: "multipart/mixed", "multipart/alternative", … */
  contentType: string;
  /** MIME boundary string. */
  boundary: string;
  /** Child parts in order. */
  parts: BodyNode[];
}

/** A node of a message's MIME structure (`fetchStructure()`, `fetch({ structure: true })`). */
export type BodyNode = BodyLeaf | BodyMultipart;

// ── Entry points ───────────────────────────────────────────────────────────────

/**
 * Parse a raw BODYSTRUCTURE into a typed BodyNode tree.
 *
 * Accepts the parenthesised structure itself, or a whole FETCH response line —
 * the `BODYSTRUCTURE` item is located automatically.
 */
export function parseBodyStructure(raw: string): BodyNode {
  const tokens = tokenize(raw);
  const list = findBodyStructure(tokens) ?? tokens.find(t => t.type === 'list');
  if (!list) throw new Error('No BODYSTRUCTURE found');
  return bodyStructureFromToken(list, '');
}

function findBodyStructure(tokens: ImapToken[]): ImapToken | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const s = tokStr(t)?.toUpperCase();
    if ((s === 'BODYSTRUCTURE' || s === 'BODY') && tokens[i + 1]?.type === 'list') return tokens[i + 1];
    if (t.type === 'list') {
      const inner = findBodyStructure(t.items);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** Build a BodyNode from a tokenized `body` production (RFC 3501 §9). */
export function bodyStructureFromToken(tok: ImapToken, sectionPrefix: string): BodyNode {
  const items = tokList(tok) ?? [];
  if (items[0]?.type === 'list') return parseMultipart(items, sectionPrefix);
  return parseLeaf(items, sectionPrefix || '1');
}

function parseMultipart(items: ImapToken[], prefix: string): BodyMultipart {
  const parts: BodyNode[] = [];
  let i = 0;
  while (i < items.length && items[i]!.type === 'list') {
    const section = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    parts.push(bodyStructureFromToken(items[i]!, section));
    i++;
  }
  const subtype = (tokStr(items[i]) ?? 'mixed').toLowerCase();
  const params = paramsFromList(items[i + 1]);
  return {
    type: 'multipart',
    section: prefix,
    contentType: `multipart/${subtype}`,
    boundary: params['boundary'] ?? '',
    parts,
  };
}

function parseLeaf(f: ImapToken[], section: string): BodyLeaf {
  // body-type-1part (RFC 3501 §9):
  //  0 type 1 subtype 2 params 3 id 4 description 5 encoding 6 size
  //  text:    7 lines,                      then ext: md5 dsp lang loc
  //  message: 7 envelope 8 body 9 lines,    then ext
  //  basic:                                  then ext at 7
  const type = (tokStr(f[0]) ?? 'application').toLowerCase();
  const subtype = (tokStr(f[1]) ?? 'octet-stream').toLowerCase();
  const params = paramsFromList(f[2]);
  const contentId = tokStr(f[3])?.replace(/^<|>$/g, '');
  const encoding = (tokStr(f[5]) ?? '7bit').toLowerCase();
  const size = tokNum(f[6]) ?? 0;

  const isMessage = type === 'message' && (subtype === 'rfc822' || subtype === 'global');
  let extStart = 7;
  let lines: number | undefined;
  let body: BodyNode | undefined;
  if (type === 'text') {
    lines = tokNum(f[7]);
    extStart = 8;
  } else if (isMessage && f[8]?.type === 'list') {
    body = bodyStructureFromToken(f[8], section);
    lines = tokNum(f[9]);
    extStart = 10;
  }

  const dsp = findDisposition(f, extStart);
  const filename = dsp?.params['filename'] ?? params['name'];

  const leaf: BodyLeaf = {
    type: 'leaf',
    section,
    contentType: `${type}/${subtype}`,
    encoding,
    size,
    contentId: contentId || undefined,
    disposition: dsp?.type,
  };
  if (params['charset']) leaf.charset = params['charset'];
  if (filename) leaf.filename = filename;
  if (type === 'text' && lines !== undefined) leaf.lines = lines;
  if (body) leaf.body = body;
  return leaf;
}

/**
 * Locate body-fld-dsp: `(type (params))` or NIL. The RFC position is tried
 * first; some servers insert extra NILs, so later list tokens are scanned too.
 */
function findDisposition(
  f: ImapToken[],
  start: number,
): { type: string; params: Record<string, string> } | undefined {
  for (let i = start; i < f.length; i++) {
    const l = tokList(f[i]);
    if (!l || l.length < 1) continue;
    const t = tokStr(l[0]);
    if (t && (isNil(l[1]) || l[1]?.type === 'list')) {
      return { type: t.toLowerCase(), params: paramsFromList(l[1]) };
    }
  }
  return undefined;
}

/** `("name" "value" …)` → lower-cased key map, RFC 2231/2047 decoded. */
function paramsFromList(tok: ImapToken | undefined): Record<string, string> {
  const l = tokList(tok);
  if (!l) return {};
  // Re-serialise as a header parameter string so RFC 2231 continuations
  // (name*0*, name*1*) are merged by the shared MIME parameter parser.
  const segs: string[] = [];
  for (let i = 0; i + 1 < l.length; i += 2) {
    const k = tokStr(l[i]);
    const v = tokStr(l[i + 1]);
    if (!k || v === undefined) continue;
    segs.push(`${k}="${v.replace(/[\\"]/g, m => `\\${m}`)}"`);
  }
  return parseHeaderValue(`x; ${segs.join('; ')}`).params;
}
