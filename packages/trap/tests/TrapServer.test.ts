import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import { TrapServer } from '../src/CatchServer.js';

function sendSmtp(port: number, rawMessage: string, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let buf = '';
    let step = 0;

    sock.on('data', (d: Buffer) => {
      buf += d.toString();
      if (!buf.endsWith('\r\n')) return;
      const line = buf.trim();
      buf = '';

      if (step === 0 && line.startsWith('220')) {
        sock.write('EHLO test\r\n'); step++;
      } else if (step === 1 && line.includes('250')) {
        sock.write(`MAIL FROM:<${from}>\r\n`); step++;
      } else if (step === 2 && line.startsWith('250')) {
        sock.write(`RCPT TO:<${to}>\r\n`); step++;
      } else if (step === 3 && line.startsWith('250')) {
        sock.write('DATA\r\n'); step++;
      } else if (step === 4 && line.startsWith('354')) {
        sock.write(rawMessage + '\r\n.\r\n'); step++;
      } else if (step === 5 && line.startsWith('250')) {
        sock.write('QUIT\r\n'); step++;
      } else if (step === 6 && line.startsWith('221')) {
        sock.end(); resolve();
      }
    });

    sock.on('error', reject);
  });
}

describe('TrapServer', () => {
  let server: TrapServer;
  const smtpPort = 19250;
  const httpPort = 19800;

  beforeAll(async () => {
    server = new TrapServer({ smtpPort, httpPort });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('starts and exposes url', () => {
    expect(server.url).toBe(`http://127.0.0.1:${httpPort}`);
  });

  it('captures a plain text email via SMTP', async () => {
    const raw = [
      'From: alice@example.com',
      'To: bob@example.com',
      'Subject: Hello from test',
      'Content-Type: text/plain',
      '',
      'Test body',
    ].join('\r\n');

    await sendSmtp(smtpPort, raw, 'alice@example.com', 'bob@example.com');

    await new Promise(r => setTimeout(r, 50));
    const msgs = server.store.getAll();
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const msg = msgs[0]!;
    expect(msg.subject).toBe('Hello from test');
    expect(msg.smtpEnvelope.from).toBe('alice@example.com');
    expect(msg.smtpEnvelope.to).toContain('bob@example.com');
  });

  it('parses from/to from headers', async () => {
    server.store.clear();
    const raw = [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Parsed headers',
      '',
      'Body',
    ].join('\r\n');

    await sendSmtp(smtpPort, raw, 'alice@example.com', 'bob@example.com');
    await new Promise(r => setTimeout(r, 50));

    const msg = server.store.getAll()[0]!;
    expect(msg.from[0]?.email).toBe('alice@example.com');
    expect(msg.from[0]?.name).toBe('Alice');
    expect(msg.to[0]?.email).toBe('bob@example.com');
  });

  it('captures html email', async () => {
    server.store.clear();
    const raw = [
      'From: a@b.com',
      'To: c@d.com',
      'Subject: HTML',
      'Content-Type: text/html',
      '',
      '<h1>Hello</h1>',
    ].join('\r\n');

    await sendSmtp(smtpPort, raw, 'a@b.com', 'c@d.com');
    await new Promise(r => setTimeout(r, 50));

    const msg = server.store.getAll()[0]!;
    expect(msg.html).toContain('<h1>Hello</h1>');
    expect(msg.text).toBeNull();
  });
});

describe('TrapServer HTTP API', () => {
  let server: TrapServer;
  const smtpPort = 19251;
  const httpPort = 19801;

  beforeAll(async () => {
    server = new TrapServer({ smtpPort, httpPort });
    await server.start();
  });

  afterAll(async () => { await server.stop(); });

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const { httpRequest } = await import('../../trap/src/server/HttpServer.js').catch(() => ({ httpRequest: null }));
    return new Promise((resolve, reject) => {
      const http = require('http') as typeof import('http');
      http.get(`http://127.0.0.1:${httpPort}${path}`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  it('GET /api/stats returns counts', async () => {
    const { status, body } = await get('/api/stats') as { status: number; body: { total: number; unread: number } };
    expect(status).toBe(200);
    expect(typeof body.total).toBe('number');
    expect(typeof body.unread).toBe('number');
  });

  it('GET /api/messages returns array', async () => {
    const { status, body } = await get('/api/messages') as { status: number; body: unknown[] };
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/messages/:bad-id returns 404', async () => {
    const { status } = await get('/api/messages/nonexistent-id');
    expect(status).toBe(404);
  });
});
