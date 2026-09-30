/**
 * Minimal scripted IMAP / SMTP / OAuth token servers for tests.
 * Each handler sees one protocol line at a time and may answer itself
 * (return true) or fall through to sensible defaults.
 */
import * as net from 'net';
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface Running<T> {
  port: number;
  log: string[];
  close(): Promise<void>;
  state: T;
}

type LineHandler = (line: string, tag: string, socket: net.Socket) => boolean | void;

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

function closer(server: net.Server, sockets: Set<net.Socket>) {
  return () => new Promise<void>(r => {
    for (const s of sockets) s.destroy();
    server.close(() => r());
  });
}

/** IMAP server: greeting with `caps`, answers LOGIN/AUTHENTICATE/SELECT/LOGOUT by default. */
export async function imapServer(opts: {
  caps?: string;
  handler?: LineHandler;
  /** Called when an AUTHENTICATE XOAUTH2 arrives; return true to accept the bearer token. */
  acceptToken?: (token: string) => boolean;
  uidNext?: () => number;
} = {}): Promise<Running<{ connections: number }>> {
  const log: string[] = [];
  const state = { connections: 0 };
  const sockets = new Set<net.Socket>();
  const caps = opts.caps ?? 'IMAP4rev1 IDLE UIDPLUS SASL-IR AUTH=XOAUTH2';
  const server = net.createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write(`* OK [CAPABILITY ${caps}] ready\r\n`);
    let buf = '';
    let authTag = '';
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line);
        const tag = line.split(' ')[0]!;
        if (opts.handler?.(line, tag, socket)) continue;
        if (line === '' && authTag) {
          socket.write(`${authTag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          authTag = '';
        } else if (/ AUTHENTICATE XOAUTH2 /.test(line)) {
          const decoded = Buffer.from(line.split(' ').pop()!, 'base64').toString();
          const token = /auth=Bearer ([^\x01]*)/.exec(decoded)?.[1] ?? '';
          if (!opts.acceptToken || opts.acceptToken(token)) socket.write(`${tag} OK [CAPABILITY ${caps}] ok\r\n`);
          else { authTag = tag; socket.write(`+ ${Buffer.from('{"status":"401"}').toString('base64')}\r\n`); }
        } else if (/ LOGIN /.test(line)) socket.write(`${tag} OK [CAPABILITY ${caps}] ok\r\n`);
        else if (/ CAPABILITY$/.test(line)) socket.write(`* CAPABILITY ${caps}\r\n${tag} OK\r\n`);
        else if (/ (SELECT|EXAMINE) /.test(line)) {
          socket.write(`* 3 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT ${opts.uidNext?.() ?? 4}] n\r\n${tag} OK [READ-WRITE] done\r\n`);
        } else if (/ LOGOUT$/.test(line)) { socket.write(`* BYE\r\n${tag} OK\r\n`); socket.end(); }
        else if (/^\S+ \S/.test(line)) socket.write(`${tag} OK\r\n`);
      }
    });
  });
  const port = await listen(server);
  return { port, log, state, close: closer(server, sockets) };
}

/** SMTP server with XOAUTH2 support; records DATA payloads in `state.messages`. */
export async function smtpServer(opts: {
  ehlo?: string[];
  acceptToken?: (token: string) => boolean;
  handler?: (line: string, socket: net.Socket) => boolean | void;
} = {}): Promise<Running<{ messages: string[] }>> {
  const log: string[] = [];
  const state = { messages: [] as string[] };
  const sockets = new Set<net.Socket>();
  const ehlo = opts.ehlo ?? ['PIPELINING', 'AUTH PLAIN LOGIN XOAUTH2', '8BITMIME'];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 mock ESMTP\r\n');
    let buf = '';
    let data = false;
    let body = '';
    let challenged = false;
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; state.messages.push(body); body = ''; socket.write('250 2.0.0 queued as Q1\r\n'); }
          else body += `${line}\r\n`;
          continue;
        }
        log.push(line);
        if (opts.handler?.(line, socket)) continue;
        if (challenged) { challenged = false; socket.write('535 5.7.8 Authentication failed\r\n'); continue; }
        if (/^EHLO/i.test(line)) {
          const lines = ['mock', ...ehlo];
          socket.write(lines.map((l, idx) => `250${idx === lines.length - 1 ? ' ' : '-'}${l}`).join('\r\n') + '\r\n');
        } else if (/^AUTH XOAUTH2 /.test(line)) {
          const token = /auth=Bearer ([^\x01]*)/.exec(Buffer.from(line.slice(13), 'base64').toString())?.[1] ?? '';
          if (!opts.acceptToken || opts.acceptToken(token)) socket.write('235 2.7.0 ok\r\n');
          else { challenged = true; socket.write(`334 ${Buffer.from('{"status":"401"}').toString('base64')}\r\n`); }
        } else if (/^AUTH/i.test(line)) socket.write('235 ok\r\n');
        else if (/^DATA/i.test(line)) { data = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  const port = await listen(server);
  return { port, log, state, close: closer(server, sockets) };
}

/** OAuth token endpoint: `respond` gets the form, returns status + JSON body. */
export async function tokenServer(
  respond: (form: URLSearchParams, n: number) => { status?: number; body: unknown; raw?: string },
): Promise<{ url: string; requests: URLSearchParams[]; close(): Promise<void> }> {
  const requests: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      requests.push(form);
      const out = respond(form, requests.length);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }).end(out.raw ?? JSON.stringify(out.body));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/token`,
    requests,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
