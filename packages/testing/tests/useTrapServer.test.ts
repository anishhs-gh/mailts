import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as net from 'net';
import { TrapServer } from '@mailts/trap';
import { useTrapServer } from '../src/index.js';

function sendSmtp(port: number, raw: string, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let buf = '';
    let step = 0;
    sock.on('data', (d: Buffer) => {
      buf += d.toString();
      if (!buf.endsWith('\r\n')) return;
      const line = buf.trim(); buf = '';
      if (step === 0 && line.startsWith('220')) { sock.write('EHLO test\r\n'); step++; }
      else if (step === 1 && line.includes('250')) { sock.write(`MAIL FROM:<${from}>\r\n`); step++; }
      else if (step === 2 && line.startsWith('250')) { sock.write(`RCPT TO:<${to}>\r\n`); step++; }
      else if (step === 3 && line.startsWith('250')) { sock.write('DATA\r\n'); step++; }
      else if (step === 4 && line.startsWith('354')) { sock.write(raw + '\r\n.\r\n'); step++; }
      else if (step === 5 && line.startsWith('250')) { sock.write('QUIT\r\n'); step++; }
      else if (step === 6 && line.startsWith('221')) { sock.end(); resolve(); }
    });
    sock.on('error', reject);
  });
}

describe('useTrapServer', () => {
  const trap = useTrapServer({ smtpPort: 19252, httpPort: 19802 });

  it('starts the server (url is accessible)', () => {
    expect(trap.server.url).toBe('http://127.0.0.1:19802');
  });

  it('messages() returns empty initially', () => {
    expect(trap.messages()).toHaveLength(0);
  });

  it('waitForMessage resolves when message arrives', async () => {
    const raw = 'From: a@b.com\r\nTo: c@d.com\r\nSubject: Test waitForMessage\r\n\r\nBody';
    const waitPromise = trap.waitForMessage({ subject: 'Test waitForMessage' });
    await sendSmtp(19252, raw, 'a@b.com', 'c@d.com');
    const msg = await waitPromise;
    expect(msg.subject).toBe('Test waitForMessage');
  });

  it('waitForMessage matches by to address', async () => {
    const raw = 'From: a@b.com\r\nTo: specific@example.com\r\nSubject: To filter\r\n\r\nBody';
    const waitPromise = trap.waitForMessage({ to: 'specific@example.com' });
    await sendSmtp(19252, raw, 'a@b.com', 'specific@example.com');
    const msg = await waitPromise;
    expect(msg.to[0]?.email).toBe('specific@example.com');
  });

  it('waitForMessage matches by regex subject', async () => {
    const raw = 'From: a@b.com\r\nTo: c@d.com\r\nSubject: Order #12345 confirmed\r\n\r\nBody';
    const waitPromise = trap.waitForMessage({ subject: /Order #\d+ confirmed/ });
    await sendSmtp(19252, raw, 'a@b.com', 'c@d.com');
    const msg = await waitPromise;
    expect(msg.subject).toMatch(/Order #\d+ confirmed/);
  });

  it('waitForMessage rejects on timeout when no matching message', async () => {
    await expect(
      trap.waitForMessage({ subject: 'This will never arrive', timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });

  it('clear() empties the store', async () => {
    const raw = 'From: a@b.com\r\nTo: c@d.com\r\nSubject: Before clear\r\n\r\nBody';
    await sendSmtp(19252, raw, 'a@b.com', 'c@d.com');
    await new Promise(r => setTimeout(r, 50));
    trap.clear();
    expect(trap.messages()).toHaveLength(0);
  });
});
