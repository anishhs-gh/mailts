import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImapSession } from '../../../src/imap/ImapSession.js';
import { MailTs } from '../../../src/core/MailTs.js';
import type { ImapConfig } from '../../../src/types/imap.js';

type Handler = (line: string, tag: string, socket: net.Socket) => boolean | void;

async function withImap(handler: Handler, test: (cfg: ImapConfig, log: string[]) => Promise<void>): Promise<void> {
  const log: string[] = [];
  const caps = 'IMAP4rev1 IDLE UIDPLUS SPECIAL-USE';
  const server = net.createServer((socket) => {
    socket.write(`* OK [CAPABILITY ${caps}] ready\r\n`);
    let buf = '';
    let pendingLiteral = 0;
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      for (;;) {
        if (pendingLiteral) {
          if (buf.length < pendingLiteral) return;
          buf = buf.slice(pendingLiteral);
          pendingLiteral = 0;
        }
        const i = buf.indexOf('\r\n');
        if (i === -1) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line);
        const lit = /\{(\d+)\}$/.exec(line);
        const tag = line.split(' ')[0]!;
        if (lit) { pendingLiteral = Number(lit[1]); socket.write('+ go\r\n'); (socket as net.Socket & { litTag?: string }).litTag = tag; continue; }
        if (line === '' && (socket as net.Socket & { litTag?: string }).litTag) {
          const t = (socket as net.Socket & { litTag?: string }).litTag!;
          delete (socket as net.Socket & { litTag?: string }).litTag;
          socket.write(`${t} OK [APPENDUID 7 42] appended\r\n`);
          continue;
        }
        if (handler(line, tag, socket)) continue;
        if (/ LOGIN /i.test(line)) socket.write(`${tag} OK [CAPABILITY ${caps}] ok\r\n`);
        else if (/ (SELECT|EXAMINE) /i.test(line)) socket.write(`* 5 EXISTS\r\n* OK [UNSEEN 2] u\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT 9] n\r\n${tag} OK [${/EXAMINE/.test(line) ? 'READ-ONLY' : 'READ-WRITE'}] done\r\n`);
        else if (/ STATUS /i.test(line)) socket.write(`* STATUS "INBOX" (UNSEEN 3)\r\n${tag} OK\r\n`);
        else if (/ LIST /i.test(line)) socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n* LIST () "/" Trash\r\n${tag} OK\r\n`);
        else if (/ LOGOUT$/i.test(line)) { socket.write(`* BYE\r\n${tag} OK\r\n`); socket.end(); }
        else if (/^\S+ /.test(line)) socket.write(`${tag} OK\r\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await test({ host: '127.0.0.1', port, secure: false, auth: { type: 'plain', user: 'u@x.com', pass: 'p' }, socketTimeout: 2_000 }, log);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

describe('ImapSession features', () => {
  it('open() counts unseen and reports firstUnseen; openReadOnly then write re-selects', async () => {
    await withImap(() => false, async (cfg, log) => {
      const s = new ImapSession(cfg);
      const st = await s.open('INBOX');
      expect(st).toMatchObject({ unseen: 3, firstUnseen: 2, uidNext: 9, exists: 5 });
      await s.openReadOnly('INBOX');
      await s.markSeen([1]);
      const selects = log.filter(l => / (SELECT|EXAMINE) /.test(l));
      expect(selects.map(l => l.split(' ')[1])).toEqual(['SELECT', 'EXAMINE', 'SELECT']);
      await s.close();
    });
  });

  it('findMailbox uses SPECIAL-USE and falls back to common names', async () => {
    await withImap(() => false, async (cfg) => {
      const s = new ImapSession(cfg);
      expect(await s.findMailbox('\\Sent')).toBe('Sent Messages');
      expect(await s.findMailbox('\\Trash')).toBe('Trash');
      expect(await s.findMailbox('\\Junk')).toBeUndefined();
      await s.close();
    });
  });

  it('appendMessage builds and uploads EmailOptions', async () => {
    await withImap(() => false, async (cfg, log) => {
      const s = new ImapSession(cfg);
      const res = await s.appendMessage('Drafts', { from: 'u@x.com', to: 'b@x.com', subject: 'd', text: 'x' }, ['\\Draft']);
      expect(res).toMatchObject({ uid: 42, uidValidity: 7 });
      expect(res.messageId).toMatch(/^<.+@x\.com>$/);
      expect(log.some(l => /APPEND "Drafts" \(\\Draft\) \{\d+\}/.test(l))).toBe(true);
      await s.close();
    });
  });

  it('appendMessage applies attachmentPolicy: rejected by default, allowed via MailTs { root }', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailts-append-'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const msg = { from: 'u@x.com', to: 'b@x.com', text: 'x', attachments: [{ filename: 'a.txt', path: 'a.txt' }] };
    await withImap(() => false, async (cfg, log) => {
      const plain = new ImapSession(cfg);
      await expect(plain.appendMessage('Drafts', msg)).rejects.toThrow(/attachmentPolicy/);
      expect(log.some(l => / APPEND /.test(l))).toBe(false);
      await plain.close();

      const session = new MailTs({ imap: cfg, attachmentPolicy: { root: dir } }).imap;
      await expect(session.appendMessage('Drafts', msg)).resolves.toMatchObject({ uid: 42 });
      await session.close();
    });
  });

  it('mail.saveToSent() finds the Sent mailbox and appends the built message', async () => {
    await withImap(() => false, async (cfg, log) => {
      const mail = new MailTs({ imap: cfg });
      const r = await mail.saveToSent({ from: 'u@x.com', to: 'b@x.com', subject: 's', text: 'x' });
      expect(r).toEqual({ mailbox: 'Sent Messages', uid: 42 });
      expect(log.some(l => /APPEND "Sent Messages" \(\\Seen\)/.test(l))).toBe(true);
      await mail.shutdown();
    });
  });

  it('legacy idle() reports new messages by UID on a dedicated connection', async () => {
    await withImap((line, tag, socket) => {
      if (/ IDLE$/.test(line)) {
        socket.write('+ idling\r\n');
        (socket as net.Socket & { idleTag?: string }).idleTag = tag;
        setTimeout(() => socket.write('* 6 EXISTS\r\n'), 10);
        return true;
      }
      if (line === 'DONE') { socket.write(`${(socket as net.Socket & { idleTag?: string }).idleTag} OK\r\n`); return true; }
      if (/UID SEARCH UID 9:\*/.test(line)) { socket.write(`* SEARCH 9\r\n${tag} OK\r\n`); return true; }
      return false;
    }, async (cfg) => {
      const s = new ImapSession(cfg);
      const got = new Promise<unknown>(r => { void s.idle(msg => r(msg)); });
      expect(await got).toEqual({ uid: 9 });
      await s.stopIdle();
      await s.close();
    });
  });

  it('keepAliveMs sends NOOP on an idle connection', async () => {
    await withImap(() => false, async (cfg, log) => {
      const s = new ImapSession({ ...cfg, keepAliveMs: 1_000 });
      await s.connect();
      await new Promise(r => setTimeout(r, 1_700));
      expect(log.some(l => / NOOP$/.test(l))).toBe(true);
      await s.close();
    });
  });

  it('a closed session refuses further use', async () => {
    await withImap(() => false, async (cfg) => {
      const s = new ImapSession(cfg);
      await s.connect();
      await s.close();
      await expect(s.listMailboxes()).rejects.toThrow(/closed/);
    });
  });
});

describe('MailTs.configure', () => {
  it('refuses to replace a queue that still has unsent in-memory jobs', () => {
    const mail = new MailTs({ transport: { name: 't', async send(m) { return { messageId: m.messageId, accepted: m.to, rejected: [] }; } } });
    mail.queue.pause();
    mail.queue.enqueue({ to: 'a@x.com', text: 'x' });
    expect(() => mail.configure({ queue: { concurrency: 2 } })).toThrow(/unsent jobs/);
    mail.queue.cancelAll();
    expect(() => mail.configure({ queue: { concurrency: 2 } })).not.toThrow();
  });
});
