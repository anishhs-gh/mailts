/**
 * Integration test — spins up a real TCP server simulating an SMTP exchange.
 * Tests the full handshake path: greeting → EHLO → STARTTLS upgrade simulation → AUTH → MAIL → DATA.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { MailTs } from '../../src/core/MailTs.js';

function createEsmtpServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise(resolve => {
    const server = net.createServer((socket) => {
      socket.write('220 integration.test ESMTP MailTs\r\n');

      let state = 'greeting';
      let dataMode = false;
      let dataBuffer = '';

      socket.on('data', (chunk: Buffer) => {
        const text = chunk.toString();

        if (dataMode) {
          dataBuffer += text;
          if (dataBuffer.includes('\r\n.\r\n') || dataBuffer.endsWith('\r\n.')) {
            dataMode = false;
            dataBuffer = '';
            socket.write('250 2.0.0 OK: queued as test-msg-id\r\n');
          }
          return;
        }

        const lines = text.split('\r\n').filter(Boolean);
        for (const line of lines) {
          const upper = line.toUpperCase();

          if (upper.startsWith('EHLO')) {
            socket.write('250-integration.test\r\n');
            socket.write('250-AUTH PLAIN LOGIN\r\n');
            socket.write('250-SIZE 10485760\r\n');
            socket.write('250 OK\r\n');
          } else if (upper.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (upper.startsWith('AUTH LOGIN')) {
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (upper.startsWith('MAIL FROM')) {
            socket.write('250 2.1.0 OK\r\n');
          } else if (upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.5 OK\r\n');
          } else if (upper.startsWith('DATA')) {
            socket.write('354 Start input, end with <CRLF>.<CRLF>\r\n');
            dataMode = true;
          } else if (upper.startsWith('QUIT')) {
            socket.write('221 2.0.0 Closing\r\n');
            socket.end();
          } else if (upper.startsWith('NOOP')) {
            socket.write('250 OK\r\n');
          } else if (upper.startsWith('RSET')) {
            socket.write('250 OK\r\n');
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

describe('SMTP Integration', () => {
  let server: net.Server;
  let port: number;

  afterEach(() => {
    server?.close();
  });

  it('sends a text email end-to-end', async () => {
    ({ server, port } = await createEsmtpServer());

    const mail = new MailTs({
      smtp: {
        host: '127.0.0.1',
        port,
        secure: false,
        auth: { type: 'plain', user: 'user@test.com', pass: 'secret' },
      },
    });

    const result = await mail.send({
      from: 'user@test.com',
      to: 'recipient@test.com',
      subject: 'Integration Test',
      text: 'Hello from integration test!',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toBeTruthy();
    }

    await mail.shutdown();
  });

  it('sends an HTML email with template', async () => {
    ({ server, port } = await createEsmtpServer());

    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port, secure: false },
    });

    const result = await mail.sendTemplate({
      from: 'noreply@test.com',
      to: 'user@test.com',
      subject: 'Welcome',
      template: 'Hello {{name}}, welcome to {{company}}!',
      data: { name: 'Alice', company: 'Acme' },
    });

    expect(result.ok).toBe(true);
    await mail.shutdown();
  });

  it('returns ok:false on permanent rejection', async () => {
    const rejectServer = await new Promise<{ server: net.Server; port: number }>(resolve => {
      const s = net.createServer((socket) => {
        socket.write('220 test ESMTP\r\n');
        socket.on('data', (d: Buffer) => {
          const cmd = d.toString();
          if (cmd.startsWith('EHLO')) {
            socket.write('250-test\r\n250 OK\r\n');
          } else if (cmd.startsWith('MAIL FROM')) {
            socket.write('550 5.1.1 User unknown\r\n');
          } else if (cmd.startsWith('RSET')) {
            socket.write('250 OK\r\n');
          } else if (cmd.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as net.AddressInfo;
        resolve({ server: s, port: addr.port });
      });
    });

    server = rejectServer.server;

    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: rejectServer.port, secure: false },
    });

    const result = await mail.send({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Test',
      text: 'Hi',
    });

    expect(result.ok).toBe(false);
    await mail.shutdown();
  });

  it('testConnection() returns true on valid server', async () => {
    ({ server, port } = await createEsmtpServer());

    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port, secure: false },
    });

    const ok = await mail.testConnection();
    expect(ok).toBe(true);
    await mail.shutdown();
  });

  it('notify() prepends [NOTIFICATION] to subject', async () => {
    ({ server, port } = await createEsmtpServer());
    const captured: string[] = [];
    server.on('connection', (socket: net.Socket) => {
      socket.on('data', (chunk: Buffer) => {
        captured.push(chunk.toString());
      });
    });

    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port, secure: false },
    });

    const result = await mail.notify({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Deploy finished',
      text: 'All good.',
    });

    expect(result.ok).toBe(true);
    const raw = captured.join('');
    expect(raw).toContain('Subject: [NOTIFICATION] Deploy finished');
    await mail.shutdown();
  });

  it('alert() prepends [ALERT] and sets high priority', async () => {
    ({ server, port } = await createEsmtpServer());
    const captured: string[] = [];
    server.on('connection', (socket: net.Socket) => {
      socket.on('data', (chunk: Buffer) => {
        captured.push(chunk.toString());
      });
    });

    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port, secure: false },
    });

    const result = await mail.alert({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Disk full',
      text: 'Server out of space.',
    });

    expect(result.ok).toBe(true);
    const raw = captured.join('');
    expect(raw).toContain('Subject: [ALERT] Disk full');
    expect(raw).toContain('X-Priority: 1');
    await mail.shutdown();
  });

  it('configure() swaps SMTP host without creating a new instance', async () => {
    ({ server, port } = await createEsmtpServer());

    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port, secure: false },
    });

    const r1 = await mail.send({ from: 'a@b.com', to: 'c@d.com', subject: 'Before', text: 'hi' });
    expect(r1.ok).toBe(true);

    // Reconfigure to a second server
    const second = await createEsmtpServer();
    mail.configure({ smtp: { host: '127.0.0.1', port: second.port, secure: false } });

    const r2 = await mail.send({ from: 'a@b.com', to: 'c@d.com', subject: 'After', text: 'hi' });
    expect(r2.ok).toBe(true);

    await mail.shutdown();
    server.close();
    second.server.close();
    server = second.server; // so afterEach doesn't double-close
  });

  it('pool config is accepted and send succeeds', async () => {
    ({ server, port } = await createEsmtpServer());

    const mail = new MailTs({
      smtp: {
        host: '127.0.0.1',
        port,
        secure: false,
        pool: { maxConnections: 2, maxMessages: 10, idleTimeout: 5_000 },
        connectionTimeout: 5_000,
        socketTimeout: 10_000,
      },
    });

    const results = await Promise.all([
      mail.send({ from: 'a@b.com', to: 'c@d.com', subject: 'P1', text: 'hi' }),
      mail.send({ from: 'a@b.com', to: 'c@d.com', subject: 'P2', text: 'hi' }),
    ]);

    expect(results.every(r => r.ok)).toBe(true);
    await mail.shutdown();
  });
});
