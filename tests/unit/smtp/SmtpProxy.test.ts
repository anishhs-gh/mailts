import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { connectThroughProxy } from '../../../src/smtp/SmtpProxy.js';
import { SmtpClient } from '../../../src/smtp/SmtpClient.js';
import { smtpServer } from '../../helpers/mockServers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(f => f())); });

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const sockets = new Set<net.Socket>();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  closers.push(() => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return (server.address() as AddressInfo).port;
}

/**
 * HTTP CONNECT proxy. With `coalesce`, it waits for the target's first bytes
 * (the SMTP greeting) and sends them in the same write as the 200 header.
 */
async function httpProxy(opts: { auth?: string; status?: number; coalesce?: boolean } = {}) {
  const seen: string[] = [];
  const port = await listen(net.createServer((client) => {
    client.on('error', () => {});
    client.once('data', (d) => {
      const head = d.toString();
      seen.push(head);
      if (opts.auth && !head.includes(`Proxy-Authorization: Basic ${Buffer.from(opts.auth).toString('base64')}`)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      if (opts.status && opts.status !== 200) { client.end(`HTTP/1.1 ${opts.status} Nope\r\n\r\n`); return; }
      const [host, p] = head.split(' ')[1]!.split(':');
      const upstream = net.createConnection(Number(p), host!);
      upstream.on('error', () => client.destroy());
      if (opts.coalesce) {
        upstream.once('data', (first) => {
          client.write(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'), first]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
      } else {
        upstream.once('connect', () => {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          upstream.pipe(client);
          client.pipe(upstream);
        });
      }
    });
  }));
  return { port, seen };
}

/** Minimal SOCKS5 server (no auth or user/pass) that coalesces the reply with the target's greeting. */
async function socks5Proxy(creds?: { user: string; pass: string }) {
  const port = await listen(net.createServer((c) => {
    c.on('error', () => {});
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 + buf[1]!) {
        const methods = [...buf.subarray(2, 2 + buf[1]!)];
        buf = buf.subarray(2 + buf[1]!);
        if (creds && methods.includes(2)) { c.write(Buffer.from([5, 2])); stage = 1; }
        else if (!creds && methods.includes(0)) { c.write(Buffer.from([5, 0])); stage = 2; }
        else { c.end(Buffer.from([5, 0xff])); return; }
      }
      if (stage === 1 && buf.length >= 2) {
        const ulen = buf[1]!; const user = buf.subarray(2, 2 + ulen).toString();
        const plen = buf[2 + ulen]!; const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const ok = user === creds!.user && pass === creds!.pass;
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) { c.end(); return; }
        stage = 2;
      }
      if (stage === 2 && buf.length >= 5 && buf.length >= 5 + buf[4]! + 2) {
        const host = buf.subarray(5, 5 + buf[4]!).toString();
        const tport = buf.readUInt16BE(5 + buf[4]!);
        c.removeListener('data', onData);
        const up = net.createConnection(tport, host);
        up.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        up.once('data', (first) => {
          c.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), first]));
          up.pipe(c); c.pipe(up);
        });
      }
    };
    c.on('data', onData);
  }));
  return { port };
}

/** SOCKS4a server that coalesces its 8-byte reply with the greeting. */
async function socks4Proxy() {
  const port = await listen(net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (d) => {
      const tport = d.readUInt16BE(2);
      const end = d.indexOf(0, 9);
      const host = d.subarray(9, end).toString();
      const up = net.createConnection(tport, host);
      up.on('error', () => c.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0])));
      up.once('data', (first) => {
        c.write(Buffer.concat([Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]), first]));
        up.pipe(c); c.pipe(up);
      });
    });
  }));
  return { port };
}

async function target() {
  const smtp = await smtpServer();
  closers.push(smtp.close);
  return smtp;
}

const client = (proxy: { type: 'http' | 'socks5' | 'socks4'; port: number; auth?: { user: string; pass: string } }, smtpPort: number) =>
  new SmtpClient({ host: '127.0.0.1', port: smtpPort, secure: false, connectionTimeout: 2_000, socketTimeout: 2_000,
    proxy: { type: proxy.type, host: '127.0.0.1', port: proxy.port, auth: proxy.auth } });

describe('SMTP through proxies', () => {
  for (const coalesce of [false, true]) {
    it(`HTTP CONNECT${coalesce ? ' with the greeting in the same packet (regression)' : ''}`, async () => {
      const smtp = await target();
      const proxy = await httpProxy({ coalesce, auth: 'u:p' });
      const c = client({ type: 'http', port: proxy.port, auth: { user: 'u', pass: 'p' } }, smtp.port);
      await c.connect();
      const r = await c.send('a@x.com', ['b@x.com'], Buffer.from('Subject: s\r\n\r\nhi\r\n'));
      expect(r.accepted).toEqual(['b@x.com']);
      expect(proxy.seen[0]).toMatch(/^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1/);
      await c.quit();
    });
  }

  it('HTTP CONNECT: 407 and other refusals fail cleanly', async () => {
    const smtp = await target();
    const needsAuth = await httpProxy({ auth: 'u:p' });
    await expect(client({ type: 'http', port: needsAuth.port }, smtp.port).connect()).rejects.toThrow(/407/);
    const refusing = await httpProxy({ status: 403 });
    await expect(client({ type: 'http', port: refusing.port }, smtp.port).connect()).rejects.toThrow(/403/);
  });

  it('SOCKS5 without and with username/password (greeting coalesced)', async () => {
    const smtp = await target();
    const open = await socks5Proxy();
    const c1 = client({ type: 'socks5', port: open.port }, smtp.port);
    await c1.connect();
    expect(c1.isReady).toBe(true);
    await c1.quit();

    const authed = await socks5Proxy({ user: 'u', pass: 'p' });
    const c2 = client({ type: 'socks5', port: authed.port, auth: { user: 'u', pass: 'p' } }, smtp.port);
    await c2.connect();
    await c2.quit();
    await expect(client({ type: 'socks5', port: authed.port, auth: { user: 'u', pass: 'bad' } }, smtp.port).connect())
      .rejects.toThrow(/auth failed/);
  });

  it('SOCKS5 reports an unreachable target', async () => {
    const proxy = await socks5Proxy();
    await expect(client({ type: 'socks5', port: proxy.port }, 1).connect()).rejects.toThrow(/connection failed \(5\)/);
  });

  it('SOCKS4a (greeting coalesced) and refusal', async () => {
    const smtp = await target();
    const proxy = await socks4Proxy();
    const c = client({ type: 'socks4', port: proxy.port }, smtp.port);
    await c.connect();
    expect(c.isReady).toBe(true);
    await c.quit();
    await expect(client({ type: 'socks4', port: proxy.port }, 1).connect()).rejects.toThrow(/status 91/);
  });

  it('times out on a silent proxy and rejects unsafe targets', async () => {
    const silent = await listen(net.createServer((s) => { s.on('error', () => {}); }));
    await expect(connectThroughProxy({ type: 'http', host: '127.0.0.1', port: silent }, 'mail.x.com', 25, 100)).rejects.toThrow(/timeout/);
    await expect(connectThroughProxy({ type: 'socks5', host: '127.0.0.1', port: silent }, 'mail.x.com', 25, 100)).rejects.toThrow(/timeout/);
    await expect(connectThroughProxy({ type: 'http', host: '127.0.0.1', port: silent }, 'evil\r\nX: y', 25, 100)).rejects.toThrow(/Invalid proxy target host/);
    await expect(connectThroughProxy({ type: 'http', host: '127.0.0.1', port: silent }, 'mail.x.com', 70000, 100)).rejects.toThrow(/port/);
  });
});
