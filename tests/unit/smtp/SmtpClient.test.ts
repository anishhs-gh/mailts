import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { SmtpClient } from '../../../src/smtp/SmtpClient.js';
import { SmtpAuthError, SmtpConnError } from '../../../src/errors.js';

function createMockSmtpServer(handler: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getPort(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No address');
  return addr.port;
}

async function withServer(
  handler: (socket: net.Socket) => void,
  test: (port: number) => Promise<void>,
): Promise<void> {
  const server = await createMockSmtpServer(handler);
  try {
    await test(getPort(server));
  } finally {
    server.close();
  }
}

describe('SmtpClient', () => {
  it('connects and completes EHLO', async () => {
    await withServer((s) => {
      s.write('220 test.smtp ESMTP\r\n');
      s.on('data', (d: Buffer) => {
        const cmd = d.toString();
        if (cmd.startsWith('EHLO')) {
          s.write('250-test.smtp\r\n250 OK\r\n');
        } else if (cmd.startsWith('QUIT')) {
          s.write('221 Bye\r\n');
          s.end();
        }
      });
    }, async (port) => {
      const client = new SmtpClient({ host: '127.0.0.1', port, secure: false });
      await client.connect();
      expect(client.isReady).toBe(true);
      await client.quit();
    });
  });

  it('authenticates with AUTH PLAIN', async () => {
    let authenticated = false;
    await withServer((s) => {
      s.write('220 test.smtp ESMTP\r\n');
      s.on('data', (d: Buffer) => {
        const cmd = d.toString();
        if (cmd.startsWith('EHLO')) {
          s.write('250-test.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (cmd.startsWith('AUTH PLAIN')) {
          authenticated = true;
          s.write('235 Authentication successful\r\n');
        } else if (cmd.startsWith('QUIT')) {
          s.write('221 Bye\r\n');
          s.end();
        }
      });
    }, async (port) => {
      const client = new SmtpClient({
        host: '127.0.0.1',
        port,
        secure: false,
        auth: { type: 'plain', user: 'user@example.com', pass: 'secret' },
      });
      await client.connect();
      expect(authenticated).toBe(true);
      await client.quit();
    });
  });

  it('throws SmtpAuthError on bad credentials', async () => {
    await withServer((s) => {
      s.write('220 test.smtp ESMTP\r\n');
      s.on('data', (d: Buffer) => {
        const cmd = d.toString();
        if (cmd.startsWith('EHLO')) {
          s.write('250-test.smtp\r\n250 AUTH PLAIN\r\n');
        } else if (cmd.startsWith('AUTH')) {
          s.write('535 5.7.8 Authentication credentials invalid\r\n');
        }
      });
    }, async (port) => {
      const client = new SmtpClient({
        host: '127.0.0.1',
        port,
        secure: false,
        auth: { type: 'plain', user: 'user@example.com', pass: 'wrong' },
      });
      await expect(client.connect()).rejects.toThrow(SmtpAuthError);
    });
  });

  it('sends a message successfully', async () => {
    let receivedData = '';
    await withServer((s) => {
      s.write('220 test.smtp ESMTP\r\n');
      let collectingData = false;
      s.on('data', (d: Buffer) => {
        const cmd = d.toString();
        if (collectingData) {
          receivedData += cmd;
          if (cmd.includes('\r\n.\r\n') || cmd.includes('\r\n.')) {
            collectingData = false;
            s.write('250 OK: queued\r\n');
          }
          return;
        }
        if (cmd.startsWith('EHLO')) {
          s.write('250-test.smtp\r\n250 OK\r\n');
        } else if (cmd.startsWith('MAIL FROM')) {
          s.write('250 OK\r\n');
        } else if (cmd.startsWith('RCPT TO')) {
          s.write('250 OK\r\n');
        } else if (cmd.startsWith('DATA')) {
          s.write('354 Start input\r\n');
          collectingData = true;
        } else if (cmd.startsWith('QUIT')) {
          s.write('221 Bye\r\n');
          s.end();
        }
      });
    }, async (port) => {
      const client = new SmtpClient({ host: '127.0.0.1', port, secure: false });
      await client.connect();
      const msgId = await client.sendMessage(
        'from@example.com',
        ['to@example.com'],
        Buffer.from('Subject: Test\r\n\r\nHello world\r\n'),
      );
      expect(typeof msgId).toBe('string');
      expect(client.messageCount).toBe(1);
      await client.quit();
    });
  });

  it('throws on connection refused', async () => {
    const client = new SmtpClient({ host: '127.0.0.1', port: 19876, secure: false });
    await expect(client.connect()).rejects.toThrow();
  });
});
