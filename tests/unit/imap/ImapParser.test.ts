import { describe, it, expect } from 'vitest';
import { ImapParser, parseList, decodeRfc2047, decodeBytes, parseEnvelopeAddresses } from '../../../src/imap/ImapParser.js';

describe('ImapParser.feed', () => {
  it('parses a simple tagged OK response', () => {
    const parser = new ImapParser();
    const results = parser.feed('M0001 OK LOGIN completed\r\n');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'tagged', tag: 'M0001', status: 'OK', data: 'LOGIN completed' });
  });

  it('parses a tagged NO response', () => {
    const parser = new ImapParser();
    const [r] = parser.feed('A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
    expect(r).toMatchObject({ type: 'tagged', status: 'NO' });
  });

  it('parses a tagged BAD response', () => {
    const parser = new ImapParser();
    const [r] = parser.feed('T1 BAD Unknown command\r\n');
    expect(r).toMatchObject({ type: 'tagged', status: 'BAD' });
  });

  it('parses untagged OK response', () => {
    const parser = new ImapParser();
    const [r] = parser.feed('* OK [CAPABILITY IMAP4rev1] ready\r\n');
    expect(r).toMatchObject({ type: 'untagged', status: 'OK' });
  });

  it('parses untagged BYE', () => {
    const parser = new ImapParser();
    const [r] = parser.feed('* BYE Logging out\r\n');
    expect(r).toMatchObject({ type: 'untagged', status: 'BYE' });
  });

  it('parses continuation response', () => {
    const parser = new ImapParser();
    const [r] = parser.feed('+ go ahead\r\n');
    expect(r).toMatchObject({ type: 'continuation', data: 'go ahead' });
  });

  it('handles multiple responses in one chunk', () => {
    const parser = new ImapParser();
    const input = '* 3 EXISTS\r\n* 1 RECENT\r\nM0001 OK SELECT done\r\n';
    const results = parser.feed(input);
    expect(results).toHaveLength(3);
    expect(results[2]).toMatchObject({ type: 'tagged', status: 'OK' });
  });

  it('handles responses split across chunks', () => {
    const parser = new ImapParser();
    const r1 = parser.feed('M0001 OK LO');
    expect(r1).toHaveLength(0);
    const r2 = parser.feed('GIN ok\r\n');
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ type: 'tagged', status: 'OK' });
  });

  it('handles literal string {N}', () => {
    const parser = new ImapParser();
    const chunk = '* 1 FETCH (BODY[TEXT] {11}\r\nHello World)\r\n';
    const results = parser.feed(chunk);
    expect(results).toHaveLength(1);
    expect(results[0]!.data).toContain('Hello World');
  });

  it('handles PREAUTH greeting', () => {
    const parser = new ImapParser();
    const [r] = parser.feed('* PREAUTH [CAPABILITY IMAP4rev1] logged in\r\n');
    expect(r).toMatchObject({ type: 'untagged', status: 'PREAUTH' });
  });

  it('ignores blank lines', () => {
    const parser = new ImapParser();
    const results = parser.feed('\r\n');
    expect(results).toHaveLength(0);
  });
});

describe('parseList', () => {
  it('parses space-separated atoms', () => {
    expect(parseList('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('parses quoted strings', () => {
    expect(parseList('"hello world" NIL')).toEqual(['hello world', 'NIL']);
  });

  it('parses nested parenthesized groups', () => {
    const result = parseList('(\\Noselect \\HasChildren) "/" INBOX');
    expect(result[0]).toBe('(\\Noselect \\HasChildren)');
    expect(result[1]).toBe('/');
    expect(result[2]).toBe('INBOX');
  });

  it('handles NIL atoms', () => {
    expect(parseList('NIL NIL a@b.com')).toContain('NIL');
  });

  it('handles escaped quotes in strings', () => {
    const result = parseList('"say \\"hello\\""');
    expect(result[0]).toBe('say "hello"');
  });
});

describe('decodeRfc2047', () => {
  it('decodes base64-encoded word', () => {
    const encoded = '=?UTF-8?B?SGVsbG8gV29ybGQ=?=';
    expect(decodeRfc2047(encoded)).toBe('Hello World');
  });

  it('decodes Q-encoded word', () => {
    const encoded = '=?UTF-8?Q?Hello=20World?=';
    expect(decodeRfc2047(encoded)).toBe('Hello World');
  });

  it('decodes underscore as space in Q-encoding', () => {
    const encoded = '=?UTF-8?Q?Hello_World?=';
    expect(decodeRfc2047(encoded)).toBe('Hello World');
  });

  it('passes through plain ASCII unchanged', () => {
    expect(decodeRfc2047('plain text')).toBe('plain text');
  });

  it('decodes multiple encoded words', () => {
    const input = '=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?IFdvcmxk?=';
    const result = decodeRfc2047(input);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('decodes Q-encoded multi-byte UTF-8 sequences correctly', () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK → UTF-8: E2 80 99
    const encoded = "=?UTF-8?Q?month=E2=80=99s?=";
    expect(decodeRfc2047(encoded)).toBe("month’s");
  });

  it('discards whitespace between adjacent encoded words (RFC 2047)', () => {
    // Space between two encoded words must be dropped, not preserved
    const input = '=?UTF-8?Q?off_o?= =?UTF-8?Q?n_your?=';
    expect(decodeRfc2047(input)).toBe('off on your');
  });

  it('preserves whitespace that is part of literal text', () => {
    const input = 'Hello =?UTF-8?B?V29ybGQ=?=';
    expect(decodeRfc2047(input)).toBe('Hello World');
  });

  it('decodes emoji via Q-encoding multi-byte', () => {
    // ✈ U+2708 → UTF-8: E2 9C 88
    const encoded = '=?UTF-8?Q?flight_=E2=9C=88?=';
    expect(decodeRfc2047(encoded)).toBe('flight ✈');
  });
});

describe('decodeRfc2047 — charset-aware decoding', () => {
  it('decodes ISO-8859-1 base64 encoded word correctly', () => {
    // "café" in ISO-8859-1 — byte 0xe9 is é in Latin-1, not valid UTF-8
    const bytes = Buffer.from('café', 'latin1').toString('base64');
    const encoded = `=?ISO-8859-1?B?${bytes}?=`;
    expect(decodeRfc2047(encoded)).toBe('café');
  });

  it('decodes ISO-8859-1 Q-encoded word', () => {
    // é = 0xe9 in ISO-8859-1
    const encoded = '=?ISO-8859-1?Q?caf=E9?=';
    expect(decodeRfc2047(encoded)).toBe('café');
  });

  it('decodes UTF-8 encoded word (regression: should be unchanged)', () => {
    const bytes = Buffer.from('héllo', 'utf8').toString('base64');
    const encoded = `=?UTF-8?B?${bytes}?=`;
    expect(decodeRfc2047(encoded)).toBe('héllo');
  });

  it('falls back to UTF-8 for unknown charset without throwing', () => {
    const bytes = Buffer.from('test', 'utf8').toString('base64');
    const encoded = '=?x-unknown-charset?B?dGVzdA==?=';
    expect(() => decodeRfc2047(encoded)).not.toThrow();
  });
});

describe('decodeBytes', () => {
  it('decodes UTF-8 bytes', () => {
    const buf = Buffer.from('héllo', 'utf8');
    expect(decodeBytes(buf, 'utf-8')).toBe('héllo');
  });

  it('decodes ISO-8859-1 bytes', () => {
    const buf = Buffer.from('café', 'latin1');
    expect(decodeBytes(buf, 'iso-8859-1')).toBe('café');
  });

  it('falls back to UTF-8 for an unknown charset', () => {
    const buf = Buffer.from('hello', 'utf8');
    expect(decodeBytes(buf, 'x-not-a-real-charset')).toBe('hello');
  });
});

describe('parseEnvelopeAddresses', () => {
  it('returns empty array for NIL', () => {
    expect(parseEnvelopeAddresses('NIL')).toEqual([]);
  });

  it('parses a single address', () => {
    const raw = '(("John Doe" NIL "john" "example.com"))';
    const result = parseEnvelopeAddresses(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ email: 'john@example.com', name: 'John Doe' });
  });

  it('parses multiple addresses', () => {
    const raw = '(("Alice" NIL "alice" "a.com")("Bob" NIL "bob" "b.com"))';
    const result = parseEnvelopeAddresses(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.email).toBe('alice@a.com');
    expect(result[1]!.email).toBe('bob@b.com');
  });

  it('handles address with NIL name', () => {
    const raw = '((NIL NIL "user" "host.com"))';
    const result = parseEnvelopeAddresses(raw);
    expect(result[0]!.email).toBe('user@host.com');
    expect(result[0]!.name).toBeUndefined();
  });

  it('returns empty for empty string', () => {
    expect(parseEnvelopeAddresses('')).toEqual([]);
  });
});
