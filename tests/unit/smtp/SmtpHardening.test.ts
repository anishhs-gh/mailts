import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { SmtpClient } from '../../../src/smtp/SmtpClient.js';
import { SmtpPool } from '../../../src/smtp/SmtpPool.js';
import { MailTs } from '../../../src/core/MailTs.js';
import { MailWorker } from '../../../src/queue/MailWorker.js';
import { dotStuff } from '../../../src/smtp/SmtpCommand.js';
import type { SmtpConfig } from '../../../src/types/smtp.js';
import type { QueueDriver, DriverMessage } from '../../../src/queue/QueueDriver.js';
import type { Transport } from '../../../src/transports/Transport.js';

interface ServerOpts {
  ehlo?: string[];
  onLine?: (line: string, socket: net.Socket, state: { data: boolean }) => boolean | void;
}

async function smtpServer(opts: ServerOpts, test: (cfg: SmtpConfig, log: string[], messages: string[]) => Promise<void>) {
  const log: string[] = [];
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('220 test ESMTP\r\n');
    const state = { data: false };
    let buf = '';
    let body = '';
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (state.data) {
          if (line === '.') { state.data = false; messages.push(body); body = ''; socket.write('250 2.0.0 Ok: queued as ABC123\r\n'); }
          else body += line + '\r\n';
          continue;
        }
        log.push(line);
        if (opts.onLine?.(line, socket, state)) continue;
        if (/^EHLO/i.test(line)) socket.write(['250-test', ...(opts.ehlo ?? ['PIPELINING', 'AUTH PLAIN LOGIN XOAUTH2'])].map((l, idx, a) => `250${idx === a.length - 1 ? ' ' : '-'}${idx === 0 ? 'test' : l}`).join('\r\n') + '\r\n');
        else if (/^AUTH PLAIN/i.test(line)) socket.write('235 ok\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 ok\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write(/nobody@/.test(line) ? '550 5.1.1 No such user\r\n' : '250 ok\r\n');
        else if (/^DATA/i.test(line)) { state.data = true; socket.write('354 go\r\n'); }
        else if (/^RSET/i.test(line)) socket.write('250 ok\r\n');
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await test({ host: '127.0.0.1', port, secure: false, socketTimeout: 2_000, connectionTimeout: 2_000 }, log, messages);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

describe('SMTP hardening', () => {
  it('refuses to authenticate without STARTTLS when requireTLS is on (regression)', async () => {
    await smtpServer({}, async (cfg, log) => {
      const c = new SmtpClient({ ...cfg, requireTLS: true, auth: { type: 'plain', user: 'u', pass: 'p' } });
      await expect(c.connect()).rejects.toThrow(/STARTTLS/);
      expect(log.some(l => /^AUTH/.test(l))).toBe(false);
    });
  });

  it('answers the XOAUTH2 334 challenge and retries once with a refreshed token', async () => {
    const tokens: string[] = [];
    await smtpServer({
      onLine: (line, socket) => {
        if (/^AUTH XOAUTH2 /.test(line)) {
          const tok = Buffer.from(line.slice(13), 'base64').toString();
          socket.write(tok.includes('Bearer stale') ? `334 ${Buffer.from('{"status":"401"}').toString('base64')}\r\n` : '235 ok\r\n');
          return true;
        }
        if (line === '') { socket.write('535 5.7.8 invalid token\r\n'); return true; }
        return false;
      },
    }, async (cfg, log) => {
      const c = new SmtpClient({
        ...cfg, requireTLS: false,
        auth: { type: 'xoauth2', user: 'u@x.com', getToken: ({ invalid }) => { const t = invalid ? 'fresh' : 'stale'; tokens.push(t); return t; } },
      });
      await c.connect();
      expect(tokens).toEqual(['stale', 'fresh']);
      expect(log).toContain('');
      expect(c.isReady).toBe(true);
      await c.quit();
    });
  });

  it('delivers to accepted recipients and reports rejected ones', async () => {
    await smtpServer({}, async (cfg, _log, messages) => {
      const c = new SmtpClient(cfg);
      await c.connect();
      const r = await c.send('a@x.com', ['ok@x.com', 'nobody@x.com'], Buffer.from('Subject: s\r\n\r\nhi\r\n'));
      expect(r.accepted).toEqual(['ok@x.com']);
      expect(r.rejected).toEqual(['nobody@x.com']);
      expect(r.rejectedErrors[0]!.replyCode).toBe(550);
      expect(r.serverId).toBe('ABC123');
      expect(messages).toHaveLength(1);
      await expect(c.send('a@x.com', ['ok@x.com', 'nobody@x.com'], Buffer.from('x\r\n'), { allRecipientsRequired: true }))
        .rejects.toMatchObject({ replyCode: 550 });
      expect(c.isReady).toBe(true); // RSET recovered the connection
      await c.quit();
    });
  });

  it('adds SMTPUTF8 when required and fails clearly when unsupported', async () => {
    await smtpServer({ ehlo: ['SMTPUTF8', '8BITMIME'] }, async (cfg, log) => {
      const c = new SmtpClient(cfg);
      await c.connect();
      await c.send('a@x.com', ['用户@例子.广告'], Buffer.from('x\r\n'), { smtpUtf8: true, eightBit: true });
      expect(log.find(l => l.startsWith('MAIL FROM'))).toMatch(/BODY=8BITMIME SMTPUTF8/);
      await c.quit();
    });
    await smtpServer({}, async (cfg) => {
      const c = new SmtpClient(cfg);
      await c.connect();
      await expect(c.send('a@x.com', ['用户@例子.广告'], Buffer.from('x\r\n'), { smtpUtf8: true })).rejects.toThrow(/SMTPUTF8/);
      await c.quit();
    });
  });

  it('rejects envelope addresses that would inject commands', async () => {
    await smtpServer({}, async (cfg) => {
      const c = new SmtpClient(cfg);
      await c.connect();
      await expect(c.send('a@x.com', ['b@x.com>\r\nRCPT TO:<c@x.com'], Buffer.from('x'))).rejects.toThrow(/envelope address/);
      await c.quit();
    });
  });

  it('pool discards a broken client instead of handing it to the next waiter (regression)', async () => {
    await smtpServer({}, async (cfg) => {
      const pool = new SmtpPool({ ...cfg, pool: { maxConnections: 1 } });
      const first = await pool.acquire();
      const waiting = pool.acquire();
      first.destroy();
      pool.release(first);
      const second = await waiting;
      expect(second).not.toBe(first);
      expect(second.isReady).toBe(true);
      pool.release(second);
      await pool.drain();
    });
  });
});

describe('dotStuff', () => {
  it('stuffs leading dots on every line and terminates once', () => {
    expect(dotStuff(Buffer.from('.a\r\nb\r\n..c\r\n')).toString()).toBe('..a\r\nb\r\n...c\r\n.\r\n');
    expect(dotStuff(Buffer.from('x')).toString()).toBe('x\r\n.\r\n');
  });
});

describe('MailTs send pipeline', () => {
  it('queued sends honour devMode (regression: devMode sent real mail)', async () => {
    let transported = 0;
    const transport: Transport = { name: 't', async send(m) { transported++; return { messageId: m.messageId, accepted: m.to, rejected: [] }; } };
    const mail = new MailTs({ transport, devMode: true });
    mail.queue.enqueue({ to: 'a@x.com', subject: 's', text: 't' });
    await mail.queue.drain();
    expect(transported).toBe(0);
  });

  it('middleware runs on a fresh copy per queued attempt (no accumulation across retries)', async () => {
    const subjects: string[] = [];
    let calls = 0;
    const transport: Transport = {
      name: 't',
      async send(m, o) {
        subjects.push(o.subject!);
        if (++calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return { messageId: m.messageId, accepted: m.to, rejected: [] };
      },
    };
    const mail = new MailTs({ transport, queue: { retryDelay: 1, jitter: false } });
    mail.use((o, next) => { o.subject = `[x] ${o.subject}`; return next(); });
    mail.queue.enqueue({ to: 'a@x.com', subject: 's', text: 't' });
    await mail.queue.drain();
    expect(subjects).toEqual(['[x] s', '[x] s']);
  });

  it('validation errors are not retried; network errors are', async () => {
    const mail = new MailTs({ transport: { name: 't', async send() { throw new TypeError('bad input'); } }, queue: { retryDelay: 1 } });
    mail.queue.on('dead', () => {});
    const job = mail.queue.enqueue({ to: 'a@x.com', subject: 's', text: 't' });
    await mail.queue.drain();
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(1);
  });

  it('build() returns the exact bytes and applies attachmentPolicy', async () => {
    const mail = new MailTs({ attachmentPolicy: 'deny' });
    const built = await mail.build({ from: 'a@x.com', to: 'b@x.com', subject: 's', text: 't' });
    expect(built.raw.toString()).toContain('Subject: s');
    const res = await mail.send({ from: 'a@x.com', to: 'b@x.com', text: 't', attachments: [{ filename: 'p', path: '/etc/hosts' }] });
    expect(res.ok).toBe(false);
  });

  it('reports partial recipient acceptance end-to-end', async () => {
    await smtpServer({}, async (cfg) => {
      const mail = new MailTs({ smtp: { ...cfg, pool: false } });
      const r = await mail.send({ from: 'a@x.com', to: ['ok@x.com', 'nobody@x.com'], subject: 's', text: 't' });
      expect(r).toMatchObject({ ok: true, accepted: ['ok@x.com'], rejected: ['nobody@x.com'] });
    });
  });

  it('shutdown() delivers pending in-memory mail instead of cancelling it (regression)', async () => {
    let sent = 0;
    const mail = new MailTs({ transport: { name: 't', async send(m) { sent++; return { messageId: m.messageId, accepted: m.to, rejected: [] }; } } });
    mail.queue.pause();
    mail.queue.enqueue({ to: 'a@x.com', subject: 's', text: 't' });
    mail.queue.enqueue({ to: 'a@x.com', subject: 's', text: 't' });
    const res = await mail.shutdown();
    expect(sent).toBe(2);
    expect(res).toEqual({ cancelled: 0, remaining: 0 });
  });
});

describe('MailWorker', () => {
  function driver(total: number) {
    let next = 0;
    const d: QueueDriver & { acks: string[]; released: string[]; held: number; maxHeld: number } = {
      acks: [], released: [], held: 0, maxHeld: 0,
      async dequeue(): Promise<DriverMessage | null> {
        if (next >= total) return null;
        d.held++; d.maxHeld = Math.max(d.maxHeld, d.held);
        const id = `m${next++}`;
        return { id, data: { to: 'a@x.com', subject: id, text: 't' } };
      },
      async ack(id) { d.held--; d.acks.push(id); if (id === 'm0') throw new Error('ack failed'); },
      async nack() { d.held--; },
      async release(id) { d.held--; d.released.push(id); },
    };
    return d;
  }

  it('bounds messages held to concurrency + prefetch and survives ack failures', async () => {
    const d = driver(20);
    const errors: Error[] = [];
    const w = new MailWorker(d, {
      transport: { name: 't', async send(m) { await new Promise(r => setTimeout(r, 2)); return { messageId: m.messageId, accepted: m.to, rejected: [] }; } },
      queue: { concurrency: 2 }, prefetch: 1, idleDelayMs: 5,
    });
    w.on('error', e => errors.push(e));
    await w.start();
    while (d.acks.length < 20) await new Promise(r => setTimeout(r, 5));
    await w.shutdown();
    expect(d.maxHeld).toBeLessThanOrEqual(3);
    expect(errors.map(e => e.message)).toEqual(['ack failed']);
  });

  it('releases unstarted messages back to the driver on shutdown', async () => {
    const d = driver(5);
    const w = new MailWorker(d, {
      transport: { name: 't', async send(m) { await new Promise(r => setTimeout(r, 50)); return { messageId: m.messageId, accepted: m.to, rejected: [] }; } },
      queue: { concurrency: 1 }, prefetch: 2, idleDelayMs: 5,
    });
    await w.start();
    await new Promise(r => setTimeout(r, 20));
    await w.shutdown(500);
    expect(d.acks).toEqual(['m0']);
    expect(d.released).toEqual(['m1', 'm2']);
  });
});
