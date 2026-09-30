/**
 * FETCH response decoding — walks the tokenized attribute list by key.
 * Literal content is consumed by length in the tokenizer, so message bodies
 * can never be mistaken for FETCH attributes.
 */
import { decodeRfc2047, decodeLatin1Utf8, envelopeAddressesFromTokens } from './ImapParser.js';
import { tokenize, tokStr, tokNum, tokList, isNil, type ImapToken } from './ImapTokenizer.js';
import { bodyStructureFromToken, type BodyNode } from './ImapBodyStructure.js';
import { parseMessage, MimeHeaders, parseMessageIds, envelopeFromHeaders } from '../core/MimeParser.js';
import type { ImapEnvelope, ImapMessage } from '../types/imap.js';

/** Decoded FETCH attributes for one message. */
export interface FetchAttributes {
  seq: number;
  uid?: number;
  flags?: string[];
  size?: number;
  internalDate?: Date | null;
  modSeq?: number;
  envelope?: ImapEnvelope;
  bodyStructure?: BodyNode;
  /**
   * Body sections keyed by normalised section spec (`''` = whole message,
   * `'1.2'`, `'HEADER'`, `'HEADER.FIELDS (REFERENCES)'`). NIL → empty buffer.
   */
  sections: Map<string, Buffer>;
}

/** Normalise a section spec for lookup: upper-case keywords, single spaces, no `<origin>`. */
export function normalizeSection(section: string): string {
  return section.trim().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').toUpperCase();
}

/**
 * Decode an untagged FETCH response (`"<seq> FETCH (…)"`).
 * Returns `null` when `data` is not a FETCH response.
 */
export function parseFetchAttributes(data: string): FetchAttributes | null {
  const m = /^(\d+)\s+FETCH\s+/i.exec(data);
  if (!m) return null;
  const tokens = tokenize(data, m[0].length);
  const attrs = tokList(tokens[0]) ?? [];
  const out: FetchAttributes = { seq: Number(m[1]), sections: new Map() };

  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const key = tokStr(attrs[i]);
    const val = attrs[i + 1];
    if (!key) continue;
    const K = key.toUpperCase();

    if (K === 'UID') out.uid = tokNum(val);
    else if (K === 'FLAGS') out.flags = (tokList(val) ?? []).map(t => tokStr(t) ?? '').filter(Boolean);
    else if (K === 'RFC822.SIZE') out.size = tokNum(val);
    else if (K === 'INTERNALDATE') {
      const d = tokStr(val);
      const date = d ? new Date(d) : null;
      out.internalDate = date && !isNaN(date.getTime()) ? date : null;
    } else if (K === 'MODSEQ') out.modSeq = tokNum(tokList(val)?.[0]);
    else if (K === 'ENVELOPE') out.envelope = envelopeFromToken(val);
    else if (K === 'BODYSTRUCTURE' || (K === 'BODY' && val?.type === 'list')) {
      try { out.bodyStructure = bodyStructureFromToken(val!, ''); } catch { /* malformed */ }
    } else if (K === 'RFC822') out.sections.set('', sectionBytes(val));
    else if (K === 'RFC822.HEADER') out.sections.set('HEADER', sectionBytes(val));
    else if (K === 'RFC822.TEXT') out.sections.set('TEXT', sectionBytes(val));
    else {
      const sec = /^(?:BODY|BINARY)(?:\.PEEK)?\[(.*)\](?:<\d+>)?$/is.exec(key);
      if (sec) out.sections.set(normalizeSection(sec[1]!), sectionBytes(val));
    }
  }
  return out;
}

function sectionBytes(t: ImapToken | undefined): Buffer {
  if (isNil(t)) return Buffer.alloc(0);
  return Buffer.from(tokStr(t) ?? '', 'latin1');
}

/** Build an `ImapEnvelope` from a tokenized ENVELOPE list. */
export function envelopeFromToken(tok: ImapToken | undefined): ImapEnvelope {
  const f = tokList(tok) ?? [];
  const str = (t: ImapToken | undefined) => (isNil(t) ? null : tokStr(t) ?? null);
  const dateStr = str(f[0]);
  const date = dateStr ? new Date(dateStr) : null;
  const subject = str(f[1]);
  return {
    date: date && !isNaN(date.getTime()) ? date : null,
    subject: subject ? decodeRfc2047(subject) : '',
    from: envelopeAddressesFromTokens(f[2]),
    sender: envelopeAddressesFromTokens(f[3]),
    replyTo: envelopeAddressesFromTokens(f[4]),
    to: envelopeAddressesFromTokens(f[5]),
    cc: envelopeAddressesFromTokens(f[6]),
    bcc: envelopeAddressesFromTokens(f[7]),
    inReplyTo: str(f[8]) ? decodeLatin1Utf8(str(f[8])!) : null,
    messageId: str(f[9]) ? decodeLatin1Utf8(str(f[9])!) : null,
  };
}

/** Parse a FETCH response data string into an ImapMessage. */
export function parseFetchResponse(seq: number, data: string): Partial<ImapMessage> {
  const attrs = parseFetchAttributes(/^\d+\s+FETCH\s/i.test(data) ? data : `${seq} FETCH ${data}`);
  if (!attrs) return { seq };
  return messageFromAttributes(attrs);
}

/** Convert decoded attributes into the public `ImapMessage` shape. */
export function messageFromAttributes(a: FetchAttributes): Partial<ImapMessage> {
  const msg: Partial<ImapMessage> = { seq: a.seq };
  if (a.uid !== undefined) msg.uid = a.uid;
  if (a.flags) msg.flags = a.flags;
  if (a.size !== undefined) msg.size = a.size;
  if (a.internalDate !== undefined) msg.internalDate = a.internalDate;
  if (a.modSeq !== undefined) msg.modSeq = a.modSeq;
  if (a.envelope) msg.envelope = a.envelope;
  if (a.bodyStructure) msg.structure = a.bodyStructure;

  const full = a.sections.get('');
  if (full !== undefined) {
    const parsed = parseMessage(full);
    msg.body = { text: parsed.text, html: parsed.html, attachments: parsed.attachments };
    if (parsed.text === undefined) delete msg.body.text;
    if (parsed.html === undefined) delete msg.body.html;
    if (!msg.envelope) msg.envelope = parsed.envelope;
    else msg.envelope.references = parsed.references;
  }

  // Header-only fetches: HEADER or HEADER.FIELDS (…)
  for (const [key, buf] of a.sections) {
    if (!key.startsWith('HEADER')) continue;
    const headers = new MimeHeaders(buf.toString('latin1'));
    if (!msg.envelope) msg.envelope = envelopeFromHeaders(headers);
    if (headers.has('references')) msg.envelope.references = parseMessageIds(headers.raw('references'));
  }
  return msg;
}

/**
 * Extract raw bytes for a specific BODY[section] from a FETCH response data string.
 * Returns null if the section is not present; an empty buffer when the server sent NIL.
 */
export function parseSectionResponse(data: string, section: string): Buffer | null {
  const attrs = parseFetchAttributes(/^\d+\s+FETCH\s/i.test(data) ? data : `0 FETCH ${data}`);
  if (!attrs) return null;
  return attrs.sections.get(normalizeSection(section)) ?? null;
}
