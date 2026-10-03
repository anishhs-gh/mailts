import { describe, it, expect } from 'vitest';
import {
  parseMessage, parseMime, parseHeaderValue, parseAddressHeader, parseMessageIds,
  splitMultipart, decodeQuotedPrintable, decodeText,
} from '../../../src/core/MimeParser.js';

const crlf = (lines: string[]) => lines.join('\r\n');

describe('parseHeaderValue', () => {
  it('parses quoted, token and RFC 2231 continuation parameters', () => {
    const v = parseHeaderValue(`attachment; filename*0*=UTF-8''%C3%9Cber; filename*1*=sicht.pdf; size=12; name="a \\"b\\""`);
    expect(v.value).toBe('attachment');
    expect(v.params).toEqual({ filename: 'Übersicht.pdf', size: '12', name: 'a "b"' });
  });

  it('decodes RFC 2047 inside quoted parameters and ignores junk', () => {
    const v = parseHeaderValue('text/plain; name="=?UTF-8?B?w7w=?=.txt"; ; novalue; charset=ISO-8859-1');
    expect(v.params).toEqual({ name: 'ü.txt', charset: 'ISO-8859-1' });
  });

  it('handles semicolons inside quotes', () => {
    expect(parseHeaderValue('inline; filename="a;b.txt"').params['filename']).toBe('a;b.txt');
  });
});

describe('parseAddressHeader', () => {
  it('handles groups, quoted commas, comments and encoded names', () => {
    const list = parseAddressHeader('"Doe, John" <j@x.com>, Team: a@x.com, b@x.com (Bee);, =?UTF-8?Q?Zo=C3=AB?= <z@x.com>, undisclosed-recipients:;');
    expect(list).toEqual([
      { email: 'j@x.com', name: 'Doe, John' },
      { email: 'a@x.com' },
      { email: 'b@x.com', name: 'Bee' },
      { email: 'z@x.com', name: 'Zoë' },
    ]);
  });

  it('returns [] for empty input and extracts message ids', () => {
    expect(parseAddressHeader(undefined)).toEqual([]);
    expect(parseMessageIds('<a@x> junk <b@y>')).toEqual(['<a@x>', '<b@y>']);
  });
});

describe('splitMultipart', () => {
  it('ignores preamble/epilogue and boundary look-alikes, tolerates missing close', () => {
    const body = crlf(['preamble', '--B', 'part1', '--Bnot-a-boundary', '--B', 'part2', '--B--', 'epilogue']);
    expect(splitMultipart(body, 'B')).toEqual(['part1\r\n--Bnot-a-boundary', 'part2']);
    expect(splitMultipart(crlf(['--B', 'only']), 'B')).toEqual(['only']);
  });
});

describe('decoding', () => {
  it('quoted-printable: soft breaks, trailing whitespace, invalid escapes', () => {
    expect(decodeQuotedPrintable('caf=C3=A9 =\r\nau lait  \r\n=ZZ').toString()).toBe('café au lait\r\n=ZZ');
  });

  it('charset fallbacks: us-ascii with 8-bit bytes, unknown labels', () => {
    expect(decodeText(Buffer.from('café'), 'us-ascii')).toBe('café');
    expect(decodeText(Buffer.from([0xe9]), 'us-ascii')).toBe('é'); // windows-1252 fallback
    expect(decodeText(Buffer.from('x'), 'x-unknown')).toBe('x');
    expect(decodeText(Buffer.from([0xe9]), 'iso-8859-1')).toBe('é');
  });
});

describe('parseMessage', () => {
  it('parses a multipart/digest with implicit message/rfc822 parts', () => {
    const raw = crlf([
      'Subject: digest', 'Content-Type: multipart/digest; boundary=D', '',
      '--D', '', 'Subject: inner one', '', 'body one',
      '--D', '', 'Subject: inner two', '', 'body two',
      '--D--',
    ]);
    const m = parseMessage(raw);
    expect(m.attachments.map(a => a.nestedMessage?.envelope.subject)).toEqual(['inner one', 'inner two']);
  });

  it('decodes a base64-encoded forwarded message', () => {
    const inner = Buffer.from('Subject: fwd\r\n\r\nhello').toString('base64');
    const raw = crlf([
      'Content-Type: multipart/mixed; boundary=M', '',
      '--M', 'Content-Type: text/plain', '', 'see below',
      '--M', 'Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64', '', inner,
      '--M--',
    ]);
    const m = parseMessage(raw);
    expect(m.text).toBe('see below');
    expect(m.attachments[0]!.nestedMessage!.body!.text).toBe('hello');
  });

  it('keeps a second text body as an attachment and handles LF-only input', () => {
    const raw = 'Content-Type: multipart/mixed; boundary=X\n\n--X\nContent-Type: text/plain\n\nmain\n--X\nContent-Type: text/plain\n\nfooter\n--X--\n';
    const m = parseMessage(raw);
    expect(m.text).toBe('main');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.content!.toString()).toBe('footer');
  });

  it('survives pathological nesting depth', () => {
    let raw = 'Subject: deep\r\nContent-Type: text/plain\r\n\r\nleaf';
    for (let i = 0; i < 100; i++) raw = `Content-Type: message/rfc822\r\n\r\n${raw}`;
    expect(() => parseMime(raw)).not.toThrow();
  });

  it('parses messages with no body and headers-only input', () => {
    expect(parseMessage('Subject: only headers').envelope.subject).toBe('only headers');
    expect(parseMessage('\r\nbody without headers').text).toBe('body without headers');
  });
});
