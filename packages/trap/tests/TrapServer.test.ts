import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { TrapServer } from '../src/CatchServer.js';
import { PersistStore } from '../src/store/PersistStore.js';
import type { CapturedMessage } from '../src/store/MemoryStore.js';

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

function httpGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpDelete(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── SMTP capture ───────────────────────────────────────────────────────────────

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

// ── HTTP API ───────────────────────────────────────────────────────────────────

describe('TrapServer HTTP API', () => {
  let server: TrapServer;
  const smtpPort = 19251;
  const httpPort = 19801;

  beforeAll(async () => {
    server = new TrapServer({ smtpPort, httpPort });
    await server.start();
  });

  afterAll(async () => { await server.stop(); });

  it('GET /api/stats returns counts', async () => {
    const { status, body } = await httpGet(httpPort, '/api/stats') as { status: number; body: { total: number; unread: number } };
    expect(status).toBe(200);
    expect(typeof body.total).toBe('number');
    expect(typeof body.unread).toBe('number');
  });

  it('GET /api/messages returns array', async () => {
    const { status, body } = await httpGet(httpPort, '/api/messages') as { status: number; body: unknown[] };
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/messages/:bad-id returns 404', async () => {
    const { status } = await httpGet(httpPort, '/api/messages/nonexistent-id');
    expect(status).toBe(404);
  });

  it('GET /api/messages/:id strips raw and attachment content fields', async () => {
    // Capture a message first
    server.store.clear();
    const raw = [
      'From: sender@example.com',
      'To: recipient@example.com',
      'Subject: Strip test',
      '',
      'Body text',
    ].join('\r\n');
    await sendSmtp(smtpPort, raw, 'sender@example.com', 'recipient@example.com');
    await new Promise(r => setTimeout(r, 50));

    const msg = server.store.getAll()[0]!;
    const { status, body } = await httpGet(httpPort, `/api/messages/${msg.id}`) as { status: number; body: Record<string, unknown> };
    expect(status).toBe(200);
    expect(body['raw']).toBeUndefined();
    expect(body['id']).toBe(msg.id);
    expect(body['subject']).toBe('Strip test');
  });

  it('DELETE /api/messages/:id removes the message', async () => {
    server.store.clear();
    const raw = ['From: a@b.com', 'To: c@d.com', 'Subject: Del', '', 'x'].join('\r\n');
    await sendSmtp(smtpPort, raw, 'a@b.com', 'c@d.com');
    await new Promise(r => setTimeout(r, 50));

    const msg = server.store.getAll()[0]!;
    const { status } = await httpDelete(httpPort, `/api/messages/${msg.id}`);
    expect(status).toBe(200);
    expect(server.store.getAll()).toHaveLength(0);
  });

  it('GET /api/events sends shutdown event on server stop', async () => {
    const subServer = new TrapServer({ smtpPort: 19252, httpPort: 19802 });
    await subServer.start();

    const received: string[] = [];
    await new Promise<void>((resolve) => {
      const req = http.request('http://127.0.0.1:19802/api/events', (res) => {
        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          received.push(text);
          if (text.includes('shutdown')) resolve();
        });
      });
      req.end();
      // Trigger shutdown after a short delay
      setTimeout(() => subServer.stop(), 50);
    });

    expect(received.some(r => r.includes('shutdown'))).toBe(true);
  });
});

// ── PersistStore ───────────────────────────────────────────────────────────────

describe('PersistStore', () => {
  const tmpFile = join(tmpdir(), `mailts-test-${Date.now()}.ndjson`);

  afterAll(() => {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  function makeMsg(id: string): CapturedMessage {
    return {
      id,
      receivedAt: new Date(),
      smtpEnvelope: { from: 'a@b.com', to: ['c@d.com'], remoteAddress: '127.0.0.1' },
      headers: {},
      subject: `Subject ${id}`,
      from: [{ name: null, email: 'a@b.com' }],
      to: [{ name: null, email: 'c@d.com' }],
      cc: [],
      text: 'Body',
      html: null,
      attachments: [],
      raw: Buffer.from('raw'),
      size: 3,
      read: false,
    };
  }

  it('persists messages to disk on add', () => {
    const store = new PersistStore(tmpFile);
    store.add(makeMsg('msg-1'));
    const lines = readFileSync(tmpFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe('msg-1');
  });

  it('loads messages from disk on construction', () => {
    const store2 = new PersistStore(tmpFile);
    expect(store2.getAll()).toHaveLength(1);
    expect(store2.getAll()[0]!.id).toBe('msg-1');
  });

  it('delete removes message from disk', () => {
    const store = new PersistStore(tmpFile);
    store.add(makeMsg('msg-2'));
    expect(store.getAll()).toHaveLength(2);

    store.delete('msg-1');
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0]!.id).toBe('msg-2');

    // Reload from disk — deleted message must not reappear
    const store2 = new PersistStore(tmpFile);
    expect(store2.getAll()).toHaveLength(1);
    expect(store2.getAll()[0]!.id).toBe('msg-2');
  });

  it('clear empties the file', () => {
    const store = new PersistStore(tmpFile);
    store.clear();
    expect(store.getAll()).toHaveLength(0);
    expect(readFileSync(tmpFile, 'utf8')).toBe('');
  });
});
