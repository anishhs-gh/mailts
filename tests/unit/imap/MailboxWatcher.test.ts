import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { MailboxWatcher } from '../../../src/imap/MailboxWatcher.js';
import { imapServer } from '../../helpers/mockServers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });

type S = net.Socket & { idleTag?: string };
const idleHandler = (onIdle?: (s: S) => void) => (line: string, tag: string, socket: net.Socket) => {
  const s = socket as S;
  if (/ IDLE$/.test(line)) { s.idleTag = tag; socket.write('+ idling\r\n'); onIdle?.(s); return true; }
  if (line === 'DONE') { socket.write(`${s.idleTag} OK\r\n`); return true; }
  return false;
};

const cfg = (port: number) => ({ host: '127.0.0.1', port, secure: false, auth: { type: 'plain' as const, user: 'u', pass: 'p' }, socketTimeout: 2_000 });

describe('MailboxWatcher', () => {
  it('catches up on mail that arrived while disconnected', async () => {
    let uidNext = 4;
    const searches: string[] = [];
    const srv = await imapServer({
      caps: 'IMAP4rev1 IDLE',
      uidNext: () => uidNext,
      handler: (line, tag, socket) => {
        const m = /UID SEARCH UID (\d+):\*/.exec(line);
        if (m) { searches.push(m[1]!); socket.write(`* SEARCH ${uidNext > 4 ? '4 5' : '3'}\r\n${tag} OK\r\n`); return true; }
        return idleHandler()(line, tag, socket);
      },
    });
    cleanups.push(srv.close);
    const w = new MailboxWatcher(cfg(srv.port), 'INBOX', { reconnectDelayMs: 20 });
    await w.start();
    const got = new Promise<number[]>(r => w.once('new', r));

    uidNext = 6; // two messages arrive while we are offline
    (w as unknown as { client: { destroy(): void } }).client.destroy();

    expect(await got).toEqual([4, 5]);
    expect(srv.state.connections).toBe(2);
    await w.stop();
  });

  it('emits reset when UIDVALIDITY changes across a reconnect', async () => {
    let validity = 7;
    const srv = await imapServer({
      caps: 'IMAP4rev1 IDLE',
      handler: (line, tag, socket) => {
        if (/ EXAMINE /.test(line)) {
          socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY ${validity}] v\r\n* OK [UIDNEXT 2] n\r\n${tag} OK [READ-ONLY] done\r\n`);
          return true;
        }
        return idleHandler()(line, tag, socket);
      },
    });
    cleanups.push(srv.close);
    const w = new MailboxWatcher(cfg(srv.port), 'INBOX', { reconnectDelayMs: 20 });
    await w.start();
    const reset = new Promise<number>(r => w.once('reset', r));
    validity = 8;
    (w as unknown as { client: { destroy(): void } }).client.destroy();
    expect(await reset).toBe(8);
    await w.stop();
  });

  it('polls with NOOP when the server has no IDLE', async () => {
    let noops = 0;
    const srv = await imapServer({
      caps: 'IMAP4rev1',
      handler: (line, tag, socket) => {
        if (/ NOOP$/.test(line)) { noops++; socket.write(`${noops === 1 ? '* 4 EXISTS\r\n' : ''}${tag} OK\r\n`); return true; }
        if (/UID SEARCH UID 4:\*/.test(line)) { socket.write(`* SEARCH 4\r\n${tag} OK\r\n`); return true; }
        return false;
      },
    });
    cleanups.push(srv.close);
    const w = new MailboxWatcher(cfg(srv.port), 'INBOX', { pollMs: 30 });
    await w.start();
    expect(await new Promise<number[]>(r => w.once('new', r))).toEqual([4]);
    expect(srv.log.some(l => / IDLE$/.test(l))).toBe(false);
    await w.stop();
  });

  it('reports flag changes and expunges pushed during IDLE', async () => {
    const srv = await imapServer({
      caps: 'IMAP4rev1 IDLE',
      handler: idleHandler((s) => setTimeout(() => s.write('* 2 FETCH (UID 9 FLAGS (\\Seen))\r\n* 1 EXPUNGE\r\n'), 10)),
    });
    cleanups.push(srv.close);
    const w = new MailboxWatcher(cfg(srv.port), 'INBOX');
    const flags = new Promise(r => w.once('flags', r));
    const expunge = new Promise(r => w.once('expunge', r));
    await w.start();
    expect(await flags).toEqual({ uid: 9, flags: ['\\Seen'] });
    expect(await expunge).toBe(1);
    await w.stop();
  });

  it('stops reconnecting after an authentication failure', async () => {
    let logins = 0;
    const srv = await imapServer({
      caps: 'IMAP4rev1 IDLE',
      handler: (line, tag, socket) => {
        if (/ LOGIN /.test(line) && ++logins > 1) { socket.write(`${tag} NO [AUTHENTICATIONFAILED] revoked\r\n`); return true; }
        return idleHandler()(line, tag, socket);
      },
    });
    cleanups.push(srv.close);
    const w = new MailboxWatcher(cfg(srv.port), 'INBOX', { reconnectDelayMs: 10 });
    await w.start();
    const err = new Promise<Error>(r => w.on('error', r));
    (w as unknown as { client: { destroy(): void } }).client.destroy();
    expect((await err).name).toBe('ImapAuthError');
    await new Promise(r => setTimeout(r, 100));
    expect(logins).toBe(2);
    await w.stop();
  });
});
