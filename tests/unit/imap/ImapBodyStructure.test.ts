import { describe, it, expect } from 'vitest';
import { parseBodyStructure } from '../../../src/imap/ImapBodyStructure.js';
import type { BodyLeaf, BodyMultipart } from '../../../src/imap/ImapBodyStructure.js';

// ── Leaf bodies ────────────────────────────────────────────────────────────────

describe('parseBodyStructure — single-part leaf', () => {
  it('parses a plain text body', () => {
    const raw = '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 512 18 NIL NIL NIL)';
    const node = parseBodyStructure(raw) as BodyLeaf;
    expect(node.type).toBe('leaf');
    expect(node.contentType).toBe('text/plain');
    expect(node.charset).toBe('utf-8');
    expect(node.encoding).toBe('7bit');
    expect(node.size).toBe(512);
    expect(node.lines).toBe(18);
    expect(node.section).toBe('1');
  });

  it('parses a base64 HTML body', () => {
    const raw = '("text" "html" ("charset" "utf-8") NIL NIL "base64" 3120 47 NIL NIL NIL)';
    const node = parseBodyStructure(raw) as BodyLeaf;
    expect(node.contentType).toBe('text/html');
    expect(node.encoding).toBe('base64');
    expect(node.size).toBe(3120);
  });

  it('parses a PDF attachment with filename and disposition', () => {
    const raw = '("application" "pdf" ("name" "report.pdf") NIL NIL "base64" 204800 NIL NIL ("attachment" ("filename" "report.pdf")) NIL)';
    const node = parseBodyStructure(raw) as BodyLeaf;
    expect(node.contentType).toBe('application/pdf');
    expect(node.filename).toBe('report.pdf');
    expect(node.disposition).toBe('attachment');
    expect(node.size).toBe(204800);
    expect(node.lines).toBeUndefined();
  });

  it('parses a content-id for inline image', () => {
    const raw = '("image" "jpeg" ("name" "photo.jpg") "<img001@example.com>" NIL "base64" 8192 NIL NIL ("inline" ("filename" "photo.jpg")) NIL)';
    const node = parseBodyStructure(raw) as BodyLeaf;
    expect(node.contentType).toBe('image/jpeg');
    expect(node.contentId).toBe('img001@example.com');
    expect(node.disposition).toBe('inline');
    expect(node.filename).toBe('photo.jpg');
  });

  it('handles NIL content-id and charset gracefully', () => {
    const raw = '("application" "octet-stream" NIL NIL NIL "base64" 1024 NIL NIL NIL NIL)';
    const node = parseBodyStructure(raw) as BodyLeaf;
    expect(node.charset).toBeUndefined();
    expect(node.contentId).toBeUndefined();
    expect(node.disposition).toBeUndefined();
  });

  it('extracts section from full FETCH response line', () => {
    const line = '1 FETCH (UID 42 BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 100 4 NIL NIL NIL))';
    const node = parseBodyStructure(line) as BodyLeaf;
    expect(node.type).toBe('leaf');
    expect(node.contentType).toBe('text/plain');
  });
});

// ── Multipart bodies ───────────────────────────────────────────────────────────

describe('parseBodyStructure — multipart/alternative', () => {
  it('parses two-part alternative (plain + html)', () => {
    const raw = [
      '(',
      '  ("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 420 18 NIL NIL NIL)',
      '  ("text" "html"  ("charset" "utf-8") NIL NIL "base64" 3120 47 NIL NIL NIL)',
      '  "alternative"',
      ')',
    ].join('');

    const node = parseBodyStructure(raw) as BodyMultipart;
    expect(node.type).toBe('multipart');
    expect(node.contentType).toBe('multipart/alternative');
    expect(node.parts).toHaveLength(2);

    const plain = node.parts[0] as BodyLeaf;
    expect(plain.type).toBe('leaf');
    expect(plain.contentType).toBe('text/plain');
    expect(plain.section).toBe('1');
    expect(plain.encoding).toBe('quoted-printable');

    const html = node.parts[1] as BodyLeaf;
    expect(html.type).toBe('leaf');
    expect(html.contentType).toBe('text/html');
    expect(html.section).toBe('2');
    expect(html.encoding).toBe('base64');
  });
});

describe('parseBodyStructure — multipart/mixed with attachment', () => {
  it('assigns section numbers correctly', () => {
    const raw = [
      '(',
      '  ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 210 6 NIL NIL NIL)',
      '  ("application" "pdf" ("name" "r.pdf") NIL NIL "base64" 20480 NIL NIL ("attachment" ("filename" "r.pdf")) NIL)',
      '  "mixed"',
      ')',
    ].join('');

    const node = parseBodyStructure(raw) as BodyMultipart;
    expect(node.contentType).toBe('multipart/mixed');
    expect(node.parts).toHaveLength(2);
    expect((node.parts[0] as BodyLeaf).section).toBe('1');
    expect((node.parts[1] as BodyLeaf).section).toBe('2');
  });
});

describe('parseBodyStructure — nested multipart', () => {
  it('parses mixed > alternative nesting', () => {
    // multipart/mixed containing a multipart/alternative and a PDF
    const raw = [
      '(',
      '  (', // alternative block
      '    ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 100 3 NIL NIL NIL)',
      '    ("text" "html"  ("charset" "utf-8") NIL NIL "base64" 500 10 NIL NIL NIL)',
      '    "alternative"',
      '  )',
      '  ("application" "pdf" ("name" "x.pdf") NIL NIL "base64" 1024 NIL NIL NIL NIL)',
      '  "mixed"',
      ')',
    ].join('');

    const root = parseBodyStructure(raw) as BodyMultipart;
    expect(root.type).toBe('multipart');
    expect(root.contentType).toBe('multipart/mixed');
    expect(root.parts).toHaveLength(2);

    const alt = root.parts[0] as BodyMultipart;
    expect(alt.type).toBe('multipart');
    expect(alt.contentType).toBe('multipart/alternative');
    expect(alt.section).toBe('1');
    expect(alt.parts).toHaveLength(2);

    const plain = alt.parts[0] as BodyLeaf;
    expect(plain.section).toBe('1.1');
    expect(plain.contentType).toBe('text/plain');

    const html = alt.parts[1] as BodyLeaf;
    expect(html.section).toBe('1.2');
    expect(html.contentType).toBe('text/html');

    const pdf = root.parts[1] as BodyLeaf;
    expect(pdf.section).toBe('2');
    expect(pdf.contentType).toBe('application/pdf');
  });

  it('handles three-level nesting with correct section numbers', () => {
    const raw = [
      '(',
      '  (',
      '    (',
      '      ("text" "plain" NIL NIL NIL "7bit" 10 1 NIL NIL NIL)',
      '      ("text" "html"  NIL NIL NIL "7bit" 20 1 NIL NIL NIL)',
      '      "alternative"',
      '    )',
      '    ("image" "png" NIL NIL NIL "base64" 512 NIL NIL NIL NIL)',
      '    "related"',
      '  )',
      '  ("application" "zip" ("name" "a.zip") NIL NIL "base64" 2048 NIL NIL NIL NIL)',
      '  "mixed"',
      ')',
    ].join('');

    const root = parseBodyStructure(raw) as BodyMultipart;
    const related = root.parts[0] as BodyMultipart;
    expect(related.section).toBe('1');
    expect(related.contentType).toBe('multipart/related');

    const alt = related.parts[0] as BodyMultipart;
    expect(alt.section).toBe('1.1');

    expect((alt.parts[0] as BodyLeaf).section).toBe('1.1.1');
    expect((alt.parts[1] as BodyLeaf).section).toBe('1.1.2');
    expect((related.parts[1] as BodyLeaf).section).toBe('1.2');
    expect((root.parts[1] as BodyLeaf).section).toBe('2');
  });
});

// ── RFC 2047 filename decoding ─────────────────────────────────────────────────

describe('parseBodyStructure — RFC 2047 filename decoding', () => {
  it('decodes base64-encoded filename in attachment', () => {
    // "report.pdf" base64 encoded: cmVwb3J0LnBkZg==
    const encoded = '=?UTF-8?B?cmVwb3J0LnBkZg==?=';
    const raw = `("application" "pdf" ("name" "${encoded}") NIL NIL "base64" 1024 NIL NIL NIL NIL)`;
    const node = parseBodyStructure(raw) as BodyLeaf;
    expect(node.filename).toBe('report.pdf');
  });
});
