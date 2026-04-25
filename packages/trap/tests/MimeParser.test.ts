import { describe, it, expect } from 'vitest';
import { parseMime } from '../src/server/MimeParser.js';

const partial = {
  id: 'test-id',
  receivedAt: new Date(),
  smtpEnvelope: { from: 'a@b.com', to: ['c@d.com'], remoteAddress: '127.0.0.1' },
  raw: Buffer.alloc(0),
  size: 0,
  read: false,
};

function make(headers: string, body: string): Buffer {
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8');
}

describe('MimeParser - plain text', () => {
  it('parses subject', () => {
    const raw = make('Subject: Hello world\r\nFrom: Alice <alice@example.com>', 'Body');
    const msg = parseMime(raw, partial);
    expect(msg.subject).toBe('Hello world');
  });

  it('parses From address', () => {
    const raw = make('From: Alice <alice@example.com>\r\nSubject: Hi', 'Body');
    const msg = parseMime(raw, partial);
    expect(msg.from[0]?.email).toBe('alice@example.com');
    expect(msg.from[0]?.name).toBe('Alice');
  });

  it('parses To addresses', () => {
    const raw = make('To: bob@example.com, Carol <carol@example.com>\r\nSubject: Hi', 'Body');
    const msg = parseMime(raw, partial);
    expect(msg.to).toHaveLength(2);
    expect(msg.to[0]?.email).toBe('bob@example.com');
    expect(msg.to[1]?.email).toBe('carol@example.com');
  });

  it('parses Cc', () => {
    const raw = make('To: a@b.com\r\nCc: cc@example.com\r\nSubject: Hi', 'Body');
    const msg = parseMime(raw, partial);
    expect(msg.cc[0]?.email).toBe('cc@example.com');
  });

  it('decodes plain text body', () => {
    const raw = make('Content-Type: text/plain; charset=UTF-8', 'Hello plain text');
    const msg = parseMime(raw, partial);
    expect(msg.text).toBe('Hello plain text');
    expect(msg.html).toBeNull();
  });

  it('decodes quoted-printable body', () => {
    const raw = make(
      'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable',
      'Hello=20World',
    );
    const msg = parseMime(raw, partial);
    expect(msg.text).toContain('Hello World');
  });

  it('decodes base64 body', () => {
    const raw = make(
      'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64',
      Buffer.from('Hello base64').toString('base64'),
    );
    const msg = parseMime(raw, partial);
    expect(msg.text).toContain('Hello base64');
  });

  it('decodes RFC 2047 encoded subject', () => {
    const raw = make('Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=', 'Body');
    const msg = parseMime(raw, partial);
    expect(msg.subject).toBe('Hello World');
  });

  it('populates headers record', () => {
    const raw = make('Subject: Test\r\nX-Custom: value', 'Body');
    const msg = parseMime(raw, partial);
    expect(msg.headers['x-custom']).toContain('value');
  });
});

describe('MimeParser - HTML', () => {
  it('parses text/html body', () => {
    const raw = make('Content-Type: text/html; charset=UTF-8', '<h1>Hello</h1>');
    const msg = parseMime(raw, partial);
    expect(msg.html).toContain('<h1>Hello</h1>');
    expect(msg.text).toBeNull();
  });
});

describe('MimeParser - multipart/alternative', () => {
  it('extracts both text and html parts', () => {
    const boundary = 'boundary123';
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Plain text version',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>HTML version</p>',
      `--${boundary}--`,
    ].join('\r\n');

    const raw = make(
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\nSubject: Test`,
      body,
    );
    const msg = parseMime(raw, partial);
    expect(msg.text).toContain('Plain text version');
    expect(msg.html).toContain('<p>HTML version</p>');
  });
});

describe('MimeParser - multipart/mixed with attachment', () => {
  it('extracts attachment', () => {
    const boundary = 'mixedbound';
    const fileContent = 'file data here';
    const b64 = Buffer.from(fileContent).toString('base64');

    const body = [
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'See attached',
      `--${boundary}`,
      'Content-Type: text/plain; name="test.txt"',
      'Content-Disposition: attachment; filename="test.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      `--${boundary}--`,
    ].join('\r\n');

    const raw = make(
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\nSubject: With attachment`,
      body,
    );
    const msg = parseMime(raw, partial);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe('test.txt');
    expect(msg.attachments[0]?.content.toString()).toBe(fileContent);
  });
});

describe('MimeParser - edge cases', () => {
  it('handles missing headers gracefully', () => {
    const raw = Buffer.from('\r\n\r\nJust a body', 'utf8');
    const msg = parseMime(raw, partial);
    expect(msg.subject).toBe('');
    expect(msg.from).toHaveLength(0);
  });

  it('handles folded headers', () => {
    const raw = make(
      'Subject: Long subject\r\n that is folded\r\n across lines',
      'Body',
    );
    const msg = parseMime(raw, partial);
    expect(msg.subject).toContain('Long subject');
    expect(msg.subject).toContain('folded');
  });
});
