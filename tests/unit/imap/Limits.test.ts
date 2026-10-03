import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { ImapParser } from '../../../src/imap/ImapParser.js';
import { ImapClient } from '../../../src/imap/ImapClient.js';
import { SmtpClient } from '../../../src/smtp/SmtpClient.js';
import { parseMessage } from '../../../src/core/MimeParser.js';
import { LimitError } from '../../../src/errors.js';
import { tlsDefaults } from '../../../src/core/net.js';
import { imapServer } from '../../helpers/mockServers.js';

describe('IMAP parser limits', () => {
  it('rejects an oversized literal as soon as {N} arrives, before buffering it', () => {
    const p = new ImapParser({ maxLiteralBytes: 1024 });
    expect(() => p.feed('* 1 FETCH (BODY[] {4000000000}\r\n')).toThrow(LimitError);
  });

  it('rejects an endless line without CRLF and an oversized line', () => {
    expect(() => new ImapParser({ maxLineBytes: 100 }).feed('* OK ' + 'x'.repeat(200))).toThrow(/without CRLF/);
    expect(() => new ImapParser({ maxLineBytes: 100 }).feed('* OK ' + 'x'.repeat(200) + '\r\n')).toThrow(/exceeds 100/);
  });

  it('rejects a response whose literals add up beyond maxResponseBytes', () => {
    const p = new ImapParser({ maxResponseBytes: 50, maxLiteralBytes: 40 });
    expect(() => p.feed('* 1 FETCH (BODY[1] {30}\r\n' + 'a'.repeat(30) + ' BODY[2] {30}\r\n')).toThrow(/maxResponseBytes/);
  });

  it('accepts normal traffic under default limits and resets per response', () => {
    const p = new ImapParser({ maxResponseBytes: 100 });
    for (let i = 0; i < 50; i++) expect(p.feed(`* ${i} EXISTS\r\n`)).toHaveLength(1);
  });

  it('fails the command with LimitError and closes the connection', async () => {
    const srv = await imapServer({
      handler: (line, tag, socket) => {
        if (/ NOOP$/.test(line)) { socket.write(`* 1 FETCH (BODY[] {999999999}\r\n`); return true; }
        return false;
      },
    });
    try {
      const c = new ImapClient({ host: '127.0.0.1', port: srv.port, secure: false, auth: { type: 'plain', user: 'u', pass: 'p' }, limits: { maxLiteralBytes: 1_000 } });
      await c.connect();
      const err = await c.noop().catch(e => e);
      expect(err).toBeInstanceOf(LimitError);
      expect(err.code).toBe('ELIMIT');
      expect(err.retryable).toBe(false);
      expect(c.isConnected).toBe(false);
    } finally {
      await srv.close();
    }
  });
});

describe('MIME parse limits', () => {
  const many = (n: number) => [
    'Content-Type: multipart/mixed; boundary=B', '',
    ...Array.from({ length: n }, (_, i) => `--B\r\nContent-Type: text/plain\r\n\r\npart ${i}`),
    '--B--',
  ].join('\r\n');

  it('truncates instead of throwing when a message has too many parts', () => {
    const m = parseMessage(many(5_000), { maxParts: 100 });
    expect(m.truncated).toBe(true);
    expect(m.text).toBe('part 0');
    expect(m.attachments.length).toBeLessThan(100);
  });

  it('caps header bytes and nesting depth', () => {
    const big = parseMessage(`Subject: s\r\nX-Junk: ${'a'.repeat(10_000)}\r\n\r\nbody`, { maxHeaderBytes: 1_000 });
    expect(big.truncated).toBe(true);
    expect(big.envelope.subject).toBe('s');
    let nested = 'Content-Type: text/plain\r\n\r\nleaf';
    for (let i = 0; i < 10; i++) nested = `Content-Type: message/rfc822\r\n\r\n${nested}`;
    expect(parseMessage(nested, { maxDepth: 3 }).truncated).toBe(true);
  });

  it('normal messages are not marked truncated', () => {
    expect(parseMessage(many(20)).truncated).toBe(false);
  });
});

describe('SMTP reply limits', () => {
  it('a server flooding a multi-line reply fails the command instead of crashing', async () => {
    const server = net.createServer((s) => {
      s.on('error', () => {});
      s.write('220 hi\r\n');
      s.once('data', () => {
        for (let i = 0; i < 1_200; i++) s.write(`250-line ${i}\r\n`);
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    try {
      const c = new SmtpClient({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, secure: false, socketTimeout: 2_000 });
      await expect(c.connect()).rejects.toMatchObject({ code: 'ELIMIT' });
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe('TLS defaults', () => {
  it('defaults to TLS 1.2+ but lets callers override', () => {
    expect(tlsDefaults(undefined).minVersion).toBe('TLSv1.2');
    expect(tlsDefaults({ minVersion: 'TLSv1.3', rejectUnauthorized: false })).toEqual({ minVersion: 'TLSv1.3', rejectUnauthorized: false });
  });
});
