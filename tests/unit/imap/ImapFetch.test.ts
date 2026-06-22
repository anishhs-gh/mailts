import { describe, it, expect } from 'vitest';
import { parseFetchResponse, parseSectionResponse } from '../../../src/imap/ImapFetch.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function fetchLine(items: string): string {
  return `1 FETCH (${items})`;
}

// Build a minimal RFC822 literal block the way a real IMAP server sends it
function rfc822Literal(raw: string): string {
  return `RFC822 {${raw.length}}\r\n${raw}`;
}

// ── Basic field parsing ────────────────────────────────────────────────────────

describe('parseFetchResponse — metadata fields', () => {
  it('extracts UID', () => {
    const msg = parseFetchResponse(1, fetchLine('UID 42 FLAGS () RFC822.SIZE 100 INTERNALDATE "01-Jan-2025 10:00:00 +0000"'));
    expect(msg.uid).toBe(42);
  });

  it('extracts FLAGS', () => {
    const msg = parseFetchResponse(1, fetchLine('UID 1 FLAGS (\\Seen \\Answered) RFC822.SIZE 100 INTERNALDATE "01-Jan-2025 10:00:00 +0000"'));
    expect(msg.flags).toEqual(['\\Seen', '\\Answered']);
  });

  it('extracts RFC822.SIZE', () => {
    const msg = parseFetchResponse(1, fetchLine('UID 1 FLAGS () RFC822.SIZE 8192 INTERNALDATE "01-Jan-2025 10:00:00 +0000"'));
    expect(msg.size).toBe(8192);
  });
});

// ── text/plain body ────────────────────────────────────────────────────────────

describe('parseFetchResponse — text/plain RFC822', () => {
  it('populates body.text for a plain message', () => {
    const raw = [
      'From: sender@example.com\r\n',
      'To: recipient@example.com\r\n',
      'Subject: Test\r\n',
      'Content-Type: text/plain; charset=utf-8\r\n',
      '\r\n',
      'Hello, world!',
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    expect(msg.body?.text).toBe('Hello, world!');
    expect(msg.body?.html).toBeUndefined();
    expect(msg.body?.attachments).toHaveLength(0);
  });

  it('decodes quoted-printable text body', () => {
    const raw = [
      'Content-Type: text/plain; charset=utf-8\r\n',
      'Content-Transfer-Encoding: quoted-printable\r\n',
      '\r\n',
      'caf=C3=A9',
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    expect(msg.body?.text).toBe('café');
  });
});

// ── text/html body ────────────────────────────────────────────────────────────

describe('parseFetchResponse — text/html RFC822', () => {
  it('populates body.html for an HTML-only message', () => {
    const html = '<p>Hello <b>World</b></p>';
    const raw = [
      'Content-Type: text/html; charset=utf-8\r\n',
      'Content-Transfer-Encoding: base64\r\n',
      '\r\n',
      Buffer.from(html).toString('base64'),
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    expect(msg.body?.html).toBe(html);
    expect(msg.body?.text).toBeUndefined();
  });
});

// ── multipart/alternative ─────────────────────────────────────────────────────

describe('parseFetchResponse — multipart/alternative', () => {
  it('extracts text and html from a multipart/alternative message', () => {
    const boundary = 'TEST_BOUNDARY_001';
    const textPart = 'Hello in plain text';
    const htmlPart = '<p>Hello in HTML</p>';

    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: text/plain; charset=utf-8\r\n',
      '\r\n',
      textPart,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: text/html; charset=utf-8\r\n',
      '\r\n',
      htmlPart,
      '\r\n',
      `--${boundary}--\r\n`,
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    expect(msg.body?.text?.trim()).toBe(textPart);
    expect(msg.body?.html?.trim()).toBe(htmlPart);
    expect(msg.body?.attachments).toHaveLength(0);
  });
});

// ── Attachments ───────────────────────────────────────────────────────────────

describe('parseFetchResponse — attachments', () => {
  it('extracts an explicit attachment from multipart/mixed', () => {
    const boundary = 'MIX_BOUNDARY';
    const textPart = 'See attached.';
    const pdfContent = Buffer.from('%PDF-mock').toString('base64');

    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: text/plain; charset=utf-8\r\n',
      '\r\n',
      textPart,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: application/pdf\r\n',
      'Content-Transfer-Encoding: base64\r\n',
      'Content-Disposition: attachment; filename="report.pdf"\r\n',
      '\r\n',
      pdfContent,
      '\r\n',
      `--${boundary}--\r\n`,
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    expect(msg.body?.text?.trim()).toBe(textPart);
    expect(msg.body?.attachments).toHaveLength(1);
    expect(msg.body?.attachments[0]!.filename).toBe('report.pdf');
    expect(msg.body?.attachments[0]!.contentType).toBe('application/pdf');
    expect(msg.body?.attachments[0]!.inline).toBe(false);
  });

  it('treats named inline part as attachment with inline=true and contentId', () => {
    const boundary = 'INLINE_BOUNDARY';
    const cid = 'logo@example.com';
    const imgB64 = Buffer.from('fake-png').toString('base64');

    const raw = [
      `Content-Type: multipart/related; boundary="${boundary}"\r\n`,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: text/html; charset=utf-8\r\n',
      '\r\n',
      `<img src="cid:${cid}">`,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: image/png\r\n',
      'Content-Transfer-Encoding: base64\r\n',
      `Content-Disposition: inline; filename="logo.png"\r\n`,
      `Content-ID: <${cid}>\r\n`,
      '\r\n',
      imgB64,
      '\r\n',
      `--${boundary}--\r\n`,
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    const att = msg.body?.attachments[0];
    expect(att).toBeDefined();
    expect(att!.inline).toBe(true);
    expect(att!.contentId).toBe(cid);
    expect(att!.filename).toBe('logo.png');
  });
});

// ── message/rfc822 (forwarded email) ──────────────────────────────────────────

describe('parseFetchResponse — message/rfc822', () => {
  it('parses a nested forwarded message', () => {
    const boundary = 'FWD_BOUNDARY';
    const nestedRaw = [
      'From: original@example.com\r\n',
      'Subject: Original message\r\n',
      'Content-Type: text/plain; charset=utf-8\r\n',
      '\r\n',
      'This is the original email.',
    ].join('');

    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: text/plain; charset=utf-8\r\n',
      '\r\n',
      'Please see the forwarded message below.',
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Type: message/rfc822\r\n',
      'Content-Disposition: attachment; filename="forwarded.eml"\r\n',
      '\r\n',
      nestedRaw,
      '\r\n',
      `--${boundary}--\r\n`,
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);

    const att = msg.body?.attachments[0];
    expect(att).toBeDefined();
    expect(att!.contentType).toBe('message/rfc822');
    expect(att!.nestedMessage).toBeDefined();
    expect(att!.nestedMessage!.envelope.subject).toBe('Original message');
    expect(att!.nestedMessage!.body?.text?.trim()).toBe('This is the original email.');
  });
});

// ── Charset decoding ──────────────────────────────────────────────────────────

describe('parseFetchResponse — charset decoding', () => {
  it('decodes ISO-8859-1 base64 encoded text body', () => {
    // "café" in ISO-8859-1 is bytes [63, 61, 66, e9] — not valid UTF-8
    const cafeLatin1 = Buffer.from('café', 'latin1').toString('base64');
    const raw = [
      'Content-Type: text/plain; charset=iso-8859-1\r\n',
      'Content-Transfer-Encoding: base64\r\n',
      '\r\n',
      cafeLatin1,
    ].join('');

    const data = fetchLine(`UID 1 FLAGS () RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2025 10:00:00 +0000" ${rfc822Literal(raw)}`);
    const msg = parseFetchResponse(1, data);
    expect(msg.body?.text).toBe('café');
  });
});

// ── parseSectionResponse ──────────────────────────────────────────────────────

describe('parseSectionResponse', () => {
  it('extracts raw bytes for a known section', () => {
    const content = 'Hello from section 1';
    const data = `1 FETCH (UID 5 BODY[1] {${content.length}}\r\n${content})`;
    const buf = parseSectionResponse(data, '1');
    expect(buf).not.toBeNull();
    expect(buf!.toString('utf8')).toBe(content);
  });

  it('extracts BODY.PEEK response for a subsection', () => {
    const content = '<p>HTML content</p>';
    const data = `1 FETCH (UID 7 BODY[1.2] {${content.length}}\r\n${content})`;
    const buf = parseSectionResponse(data, '1.2');
    expect(buf).not.toBeNull();
    expect(buf!.toString('utf8')).toBe(content);
  });

  it('returns null when section is not in the response', () => {
    const data = '1 FETCH (UID 5 FLAGS (\\Seen))';
    expect(parseSectionResponse(data, '1')).toBeNull();
  });
});
