/**
 * Failure-mode tests from the 1.0 trust audit: hangs, dead peers, TLS upgrades, leaks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import * as tls from 'tls';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImapClient } from '../../../src/imap/ImapClient.js';
import { MailboxWatcher } from '../../../src/imap/MailboxWatcher.js';
import { SmtpClient } from '../../../src/smtp/SmtpClient.js';
import { microsoft, authorizeWithLoopback } from '../../../src/oauth/index.js';
import { imapServer } from '../../helpers/mockServers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); });

const HAS_OPENSSL = (() => { try { execFileSync('openssl', ['version']); return true; } catch { return false; } })();
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'mailts-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
}

const imapCfg = (port: number, extra: Record<string, unknown> = {}) => ({
  host: '127.0.0.1', port, secure: false, auth: { type: 'plain' as const, user: 'u', pass: 'p' }, socketTimeout: 500, ...extra,
});

describe('IMAP command execution', () => {
  it('fails fast when the server rejects a command carrying several literals', async () => {
    const srv = await imapServer({
      caps: 'IMAP4rev1',
      handler: (line, tag, socket) => {
        if (/ LOGIN \{\d+\}$/.test(line)) { socket.write(`${tag} BAD literal not allowed here\r\n`); return true; }
        return false;
      },
    });
    cleanups.push(srv.close);
    // Both user and password contain non-ASCII → two literals
    const c = new ImapClient({ ...imapCfg(srv.port, { socketTimeout: 60_000 }), auth: { type: 'plain', user: 'üser', pass: 'pässword' } });
    const t0 = Date.now();
    await expect(c.connect()).rejects.toThrow(/BAD: literal not allowed/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('IDLE failure modes', () => {
  it('detects a silent dead peer after IDLE renewal instead of stalling (regression)', async () => {
    const srv = await imapServer({
      handler: (line, _tag, socket) => {
        if (/ IDLE$/.test(line)) { socket.write('+ idling\r\n'); return true; }
        if (line === 'DONE') return true; // peer silently gone: never answers
        return false;
      },
    });
    cleanups.push(srv.close);
    const c = new ImapClient(imapCfg(srv.port, { idleRenewalMs: 50, socketTimeout: 200 }));
    await c.connect();
    await c.select('INBOX');
    const closed = new Promise<void>(r => c.once('close', () => r()));
    await c.idle();
    const t0 = Date.now();
    await closed;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(c.isConnected).toBe(false);
  });

  it('a watcher recovers when IDLE fails mid-session (loop error → reconnect)', async () => {
    let idles = 0;
    const srv = await imapServer({
      handler: (line, tag, socket) => {
        if (/ IDLE$/.test(line)) {
          idles++;
          (socket as net.Socket & { t?: string }).t = tag;
          if (idles === 2) { socket.write(`${tag} BAD IDLE unavailable\r\n`); return true; }
          socket.write('+ idling\r\n');
          return true;
        }
        if (line === 'DONE') { socket.write(`${(socket as net.Socket & { t?: string }).t} OK\r\n`); return true; }
        return false;
      },
    });
    cleanups.push(srv.close);
    const w = new MailboxWatcher(imapCfg(srv.port, { idleRenewalMs: 30 }), 'INBOX', { reconnectDelayMs: 20 });
    await w.start();
    cleanups.push(() => w.stop());
    await new Promise<void>(r => { const t = setInterval(() => { if (srv.state.connections >= 2) { clearInterval(t); r(); } }, 10); });
    expect(srv.state.connections).toBeGreaterThanOrEqual(2);
  });

  it('does not leak listeners across many commands and IDLE cycles', async () => {
    const srv = await imapServer({
      handler: (line, tag, socket) => {
        if (/ IDLE$/.test(line)) { (socket as net.Socket & { t?: string }).t = tag; socket.write('+ idling\r\n'); return true; }
        if (line === 'DONE') { socket.write(`${(socket as net.Socket & { t?: string }).t} OK\r\n`); return true; }
        return false;
      },
    });
    cleanups.push(srv.close);
    const c = new ImapClient(imapCfg(srv.port));
    await c.connect();
    await c.select('INBOX');
    const stop = await c.idle();
    for (let i = 0; i < 100; i++) await c.noop();       // each one interrupts and resumes IDLE
    const counts = ['exists', 'close', 'error', 'untagged'].map(e => c.listenerCount(e));
    for (let i = 0; i < 100; i++) await c.noop();
    expect(['exists', 'close', 'error', 'untagged'].map(e => c.listenerCount(e))).toEqual(counts);
    await stop();
    await c.close();
  });
});

describe.skipIf(!HAS_OPENSSL)('STARTTLS over real TLS', () => {
  it('SMTP upgrades, re-reads EHLO, and authenticates only inside TLS', async () => {
    const { key, cert } = selfSigned();
    const log: Array<{ tls: boolean; line: string }> = [];
    const server = net.createServer((raw) => {
      raw.on('error', () => {});
      raw.write('220 mock ESMTP\r\n');
      const serve = (sock: net.Socket, secure: boolean) => {
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf('\r\n')) !== -1) {
            const line = buf.slice(0, i); buf = buf.slice(i + 2);
            log.push({ tls: secure, line });
            if (/^EHLO/.test(line)) sock.write(secure ? '250-mock\r\n250 AUTH PLAIN\r\n' : '250-mock\r\n250 STARTTLS\r\n');
            else if (line === 'STARTTLS') {
              sock.write('220 go ahead\r\n');
              sock.removeListener('data', onData);
              const secured = new tls.TLSSocket(sock, { isServer: true, key, cert });
              secured.on('error', () => {});
              serve(secured, true);
              return;
            } else if (/^AUTH PLAIN/.test(line)) sock.write('235 ok\r\n');
            else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
            else sock.write('250 ok\r\n');
          }
        };
        sock.on('data', onData);
      };
      serve(raw, false);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>(r => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;

    const c = new SmtpClient({
      host: '127.0.0.1', port, secure: false, requireTLS: true, tls: { rejectUnauthorized: false },
      auth: { type: 'plain', user: 'u', pass: 'p' }, socketTimeout: 2_000,
    });
    await c.connect();
    expect(c.isReady).toBe(true);
    expect(log.filter(l => /^EHLO/.test(l.line)).map(l => l.tls)).toEqual([false, true]);
    expect(log.find(l => /^AUTH/.test(l.line))!.tls).toBe(true);
    await c.quit();

    // Without opting out, a self-signed certificate is rejected
    const strict = new SmtpClient({ host: '127.0.0.1', port, secure: false, auth: { type: 'plain', user: 'u', pass: 'p' }, socketTimeout: 2_000 });
    await expect(strict.connect()).rejects.toThrow(/TLS upgrade failed/);
  });

  it('IMAP upgrades with STARTTLS, discards pre-TLS capabilities, and logs in inside TLS', async () => {
    const { key, cert } = selfSigned();
    const events: string[] = [];
    const server = net.createServer((raw) => {
      raw.on('error', () => {});
      raw.write('* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready\r\n');
      const serve = (sock: net.Socket, secure: boolean) => {
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf('\r\n')) !== -1) {
            const line = buf.slice(0, i); buf = buf.slice(i + 2);
            const tag = line.split(' ')[0];
            events.push(`${secure ? 'tls' : 'plain'}:${line.split(' ').slice(1, 2).join('')}`);
            if (/ STARTTLS$/.test(line)) {
              sock.write(`${tag} OK begin TLS\r\n`);
              sock.removeListener('data', onData);
              const secured = new tls.TLSSocket(sock, { isServer: true, key, cert });
              secured.on('error', () => {});
              serve(secured, true);
              return;
            }
            if (/ CAPABILITY$/.test(line)) sock.write(`* CAPABILITY IMAP4rev1 ${secure ? 'AUTH=PLAIN' : 'STARTTLS LOGINDISABLED'}\r\n${tag} OK\r\n`);
            else if (/ LOGIN /.test(line)) sock.write(`${tag} OK [CAPABILITY IMAP4rev1] ok\r\n`);
            else if (/ LOGOUT$/.test(line)) { sock.write(`* BYE\r\n${tag} OK\r\n`); sock.end(); }
            else sock.write(`${tag} OK\r\n`);
          }
        };
        sock.on('data', onData);
      };
      serve(raw, false);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>(r => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;

    const c = new ImapClient({ ...imapCfg(port, { socketTimeout: 2_000 }), requireTLS: true, tls: { rejectUnauthorized: false } });
    await c.connect();
    expect(c.isConnected).toBe(true);
    // LOGINDISABLED applied only before TLS: after the upgrade LOGIN is used inside TLS
    expect(events).toEqual(['plain:STARTTLS', 'tls:CAPABILITY', 'tls:LOGIN']);
    await c.close();
  });
});

describe('Microsoft loopback redirect', () => {
  it('uses http://localhost:<port> (path /) to match a registered http://localhost', async () => {
    let redirect = '';
    await authorizeWithLoopback({
      provider: microsoft(), clientId: 'c', timeoutMs: 2_000,
      onAuthUrl: async (url) => {
        redirect = new URL(url).searchParams.get('redirect_uri')!;
        const p = new URL(url).searchParams;
        await fetch(`${redirect.replace('localhost', '127.0.0.1')}/?error=access_denied&state=${p.get('state')}`);
      },
    }).catch(() => {});
    expect(redirect).toMatch(/^http:\/\/localhost:\d+$/);
  });
});
