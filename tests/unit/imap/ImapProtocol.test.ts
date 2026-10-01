import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { ImapParser } from '../../../src/imap/ImapParser.js';
import { parseFetchAttributes, parseSectionResponse, parseFetchResponse } from '../../../src/imap/ImapFetch.js';
import { encodeMailboxName, decodeMailboxName, uidSets, tokenize } from '../../../src/imap/ImapTokenizer.js';
import { ImapParts, checkFlags, formatDateTime } from '../../../src/imap/ImapCommands.js';
import { parseListResponse, ImapClient } from '../../../src/imap/ImapClient.js';
import { ImapSession } from '../../../src/imap/ImapSession.js';
import { parseBodyStructure } from '../../../src/imap/ImapBodyStructure.js';
import type { ImapConfig } from '../../../src/types/imap.js';

// ── Framing ──────────────────────────────────────────────────────────────────

describe('ImapParser literal framing (regression: bodies truncated)', () => {
  const body = 'My answer\r\n\r\nOn Tue, x wrote:\r\n> Original question\r\n> line2';
  const wire = `* 5 FETCH (UID 5 BODY[1] {${body.length}}\r\n${body})\r\nM1 OK FETCH completed\r\n`;

  it('reads the literal in full regardless of prefix length', () => {
    const res = new ImapParser().feed(wire);
    expect(res).toHaveLength(2);
    expect(parseSectionResponse(res[0]!.data, '1')!.toString()).toBe(body);
  });

  it('frames identically for every chunk size 1..40', () => {
    for (let size = 1; size <= 40; size++) {
      const p = new ImapParser();
      const out = [];
      for (let i = 0; i < wire.length; i += size) out.push(...p.feed(wire.slice(i, i + size)));
      expect(out.map(r => r.type)).toEqual(['untagged', 'tagged']);
      expect(parseSectionResponse(out[0]!.data, '1')!.toString()).toBe(body);
    }
  });

  it('handles several literals in one response and literal content that looks like syntax', () => {
    const a = 'x) {5}\r\n';
    const b = 'FLAGS (\\Deleted) UID 999';
    const res = new ImapParser().feed(`* 1 FETCH (UID 7 BODY[1] {${a.length}}\r\n${a} BODY[2] {${b.length}}\r\n${b} FLAGS (\\Seen))\r\n`);
    expect(res).toHaveLength(1);
    const attrs = parseFetchAttributes(res[0]!.data)!;
    expect(attrs.uid).toBe(7);
    expect(attrs.flags).toEqual(['\\Seen']);
    expect(attrs.sections.get('1')!.toString()).toBe(a);
    expect(attrs.sections.get('2')!.toString()).toBe(b);
  });

  it('preserves 8-bit bytes exactly', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0xc3, 0xa9, 0x29]);
    const head = Buffer.from(`* 1 FETCH (UID 1 BODY[] {${bytes.length}}\r\n`, 'latin1');
    const res = new ImapParser().feed(Buffer.concat([head, bytes, Buffer.from(')\r\n')]));
    expect(parseSectionResponse(res[0]!.data, '')!.equals(bytes)).toBe(true);
  });

  it('classifies untagged status only on whole words', () => {
    const [r] = new ImapParser().feed('* NOTIFY something\r\n');
    expect(r!.status).toBeUndefined();
  });
});

// ── FETCH decoding ───────────────────────────────────────────────────────────

describe('FETCH attribute decoding', () => {
  it('returns an empty section for NIL instead of the next section (regression)', () => {
    const data = '1 FETCH (UID 1 BODY[1] NIL BODY[2] {4}\r\nabcd)';
    expect(parseSectionResponse(data, '1')!.length).toBe(0);
    expect(parseSectionResponse(data, '2')!.toString()).toBe('abcd');
  });

  it('parses ENVELOPE with literal subject and parenthesis in names', () => {
    const subj = 'Re: "quoted" (x)';
    const data = `1 FETCH (UID 3 ENVELOPE ("Mon, 1 Jan 2024 10:00:00 +0000" {${subj.length}}\r\n${subj} (("A (B)" NIL "a" "x.com")) NIL NIL ((NIL NIL "b" "y.com")("Grp" NIL "g" NIL)(NIL NIL "c" "z.com")(NIL NIL NIL NIL)) NIL NIL "<p@x>" "<m@x>"))`;
    const msg = parseFetchResponse(1, data);
    expect(msg.envelope!.subject).toBe(subj);
    expect(msg.envelope!.from[0]).toMatchObject({ email: 'a@x.com', name: 'A (B)' });
    expect(msg.envelope!.to.map(a => (a as { email: string }).email)).toEqual(['b@y.com', 'c@z.com']);
    expect(msg.envelope!.inReplyTo).toBe('<p@x>');
  });

  it('decodes BODY[] into bodies and references', () => {
    const raw = 'Subject: hi\r\nReferences: <a@x> <b@x>\r\nContent-Type: text/plain\r\n\r\nline1\r\n> quoted\r\n';
    const msg = parseFetchResponse(1, `1 FETCH (UID 2 BODY[] {${raw.length}}\r\n${raw})`);
    expect(msg.body!.text).toBe('line1\r\n> quoted');
    expect(msg.envelope!.references).toEqual(['<a@x>', '<b@x>']);
  });

  it('reads references from a HEADER.FIELDS fetch', () => {
    const h = 'References: <r1@x>\r\n\r\n';
    const msg = parseFetchResponse(1, `1 FETCH (UID 2 BODY[HEADER.FIELDS (REFERENCES)] {${h.length}}\r\n${h})`);
    expect(msg.envelope!.references).toEqual(['<r1@x>']);
  });
});

// ── BODYSTRUCTURE ────────────────────────────────────────────────────────────

describe('BODYSTRUCTURE extension fields', () => {
  it('reads disposition at the RFC position for non-text parts', () => {
    const node = parseBodyStructure('("application" "pdf" NIL NIL NIL "base64" 10 NIL ("attachment" ("filename" "a.pdf")) NIL NIL)');
    expect(node).toMatchObject({ disposition: 'attachment', filename: 'a.pdf' });
  });

  it('decodes RFC 2231 continuation filenames', () => {
    const node = parseBodyStructure(`("application" "pdf" NIL NIL NIL "base64" 10 NIL ("attachment" ("filename*0*" "utf-8''caf%C3%A9" "filename*1*" "%20menu.pdf")) NIL NIL)`);
    expect(node).toMatchObject({ filename: 'café menu.pdf' });
  });

  it('nests message/rfc822 structure', () => {
    const node = parseBodyStructure('(("text" "plain" NIL NIL NIL "7bit" 5 1 NIL NIL NIL)("message" "rfc822" NIL NIL NIL "7bit" 50 (NIL "s" NIL NIL NIL NIL NIL NIL NIL NIL) ("text" "plain" NIL NIL NIL "7bit" 5 1 NIL NIL NIL) 3 NIL ("attachment" NIL) NIL) "mixed")');
    expect(node.type).toBe('multipart');
    const fwd = (node as { parts: Array<{ body?: unknown; disposition?: string }> }).parts[1]!;
    expect(fwd.disposition).toBe('attachment');
    expect(fwd.body).toMatchObject({ section: '2', contentType: 'text/plain' });
  });
});

// ── Encoding helpers ─────────────────────────────────────────────────────────

describe('command encoding', () => {
  it('round-trips modified UTF-7 mailbox names', () => {
    for (const n of ['INBOX', 'Entwürfe', '日本語', 'A&B', 'Sent Items', '~peter/mail/台北/日本語']) {
      expect(decodeMailboxName(encodeMailboxName(n))).toBe(n);
    }
    expect(encodeMailboxName('A&B')).toBe('A&-B');
    expect(encodeMailboxName('Entwürfe')).toBe('Entw&APw-rfe');
  });

  it('parses LIST names with spaces, NIL delimiter, literals and special-use', () => {
    expect(parseListResponse('LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"')).toEqual({
      name: '[Gmail]/Sent Mail', delimiter: '/', flags: ['\\HasNoChildren', '\\Sent'], specialUse: '\\Sent',
    });
    expect(parseListResponse('LIST () NIL {5}\r\nA "B"').name).toBe('A "B"');
    expect(parseListResponse('LIST () NIL Flat').delimiter).toBe('');
    expect(parseListResponse('LIST () "." INBOX.Entw&APw-rfe').name).toBe('INBOX.Entwürfe');
  });

  it('compresses and chunks UID sets', () => {
    expect(uidSets([5, 1, 2, 3, 9, 3])).toEqual(['1:3,5,9']);
    const many = Array.from({ length: 5_000 }, (_, i) => i * 2 + 1);
    const sets = uidSets(many, 1_000);
    expect(sets.length).toBeGreaterThan(1);
    expect(sets.every(s => s.length <= 1_000)).toBe(true);
  });

  it('rejects flags and sets that would inject protocol syntax', () => {
    expect(() => checkFlags(['\\Seen) UID EXPUNGE 1:*\r\nA1 LOGOUT'])).toThrow(/Invalid IMAP flag/);
    expect(() => ImapParts.uidFetch('1:*\r\nX', 'UID')).toThrow(/sequence set/);
    expect(checkFlags(['\\Seen', '$Label1'])).toBe('\\Seen $Label1');
  });

  it('sends non-ASCII search text as a literal with CHARSET', () => {
    const parts = ImapParts.uidSearch({ from: 'José' });
    expect(parts).toContain('CHARSET UTF-8');
    expect(parts.some(p => typeof p !== 'string')).toBe(true);
  });

  it('formats APPEND date-time per RFC 3501', () => {
    expect(formatDateTime(new Date(Date.UTC(2024, 0, 5, 7, 8, 9)))).toBe('"05-Jan-2024 07:08:09 +0000"');
  });

  it('tokenizes section atoms containing spaces', () => {
    const [t] = tokenize('BODY[HEADER.FIELDS (A B)]<0>');
    expect(t).toEqual({ type: 'atom', value: 'BODY[HEADER.FIELDS (A B)]<0>' });
  });
});

// ── Live mock server tests ───────────────────────────────────────────────────

type Handler = (line: string, tag: string, socket: net.Socket) => boolean | void;

async function withServer(
  opts: { greeting?: string; caps?: string; handler?: Handler },
  test: (cfg: ImapConfig, log: string[]) => Promise<void>,
): Promise<void> {
  const log: string[] = [];
  const caps = opts.caps ?? 'IMAP4rev1 IDLE UIDPLUS MOVE';
  const server = net.createServer((socket) => {
    socket.write(opts.greeting ?? `* OK [CAPABILITY ${caps}] ready\r\n`);
    let buf = '';
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line);
        const tag = line.split(' ')[0]!;
        if (opts.handler?.(line, tag, socket)) continue;
        if (/ LOGIN /i.test(line)) socket.write(`${tag} OK [CAPABILITY ${caps}] LOGIN done\r\n`);
        else if (/ CAPABILITY$/i.test(line)) socket.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
        else if (/ (SELECT|EXAMINE) /i.test(line)) socket.write(`* 3 EXISTS\r\n* OK [UIDVALIDITY 9] v\r\n* OK [UIDNEXT 4] n\r\n${tag} OK [READ-WRITE] done\r\n`);
        else if (/ LOGOUT$/i.test(line)) { socket.write(`* BYE\r\n${tag} OK bye\r\n`); socket.end(); }
        else if (/^M\d+ /.test(line)) socket.write(`${tag} OK done\r\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await test({
      host: '127.0.0.1', port, secure: false,
      auth: { type: 'plain', user: 'u', pass: 'p' },
      connectionTimeout: 2_000, socketTimeout: 2_000,
    }, log);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

describe('ImapClient against a mock server', () => {
  it('refuses plaintext login to a non-loopback host without STARTTLS', async () => {
    await withServer({}, async (cfg) => {
      // localhost is exempt by default; force the check
      const client = new ImapClient({ ...cfg, requireTLS: true });
      await expect(client.connect()).rejects.toThrow(/STARTTLS/);
    });
  });

  it('answers an XOAUTH2 error challenge, refreshes the token once and succeeds', async () => {
    const tokens: string[] = [];
    let attempts = 0;
    let authTag = '';
    await withServer({
      caps: 'IMAP4rev1 SASL-IR AUTH=XOAUTH2',
      handler: (line, tag, socket) => {
        if (/AUTHENTICATE XOAUTH2 /.test(line)) {
          attempts++;
          authTag = tag;
          const decoded = Buffer.from(line.split(' ').pop()!, 'base64').toString();
          if (decoded.includes('Bearer stale')) {
            socket.write(`+ ${Buffer.from('{"status":"401","schemes":"bearer"}').toString('base64')}\r\n`);
          } else {
            socket.write(`${tag} OK [CAPABILITY IMAP4rev1] authenticated\r\n`);
          }
          return true;
        }
        if (line === '') { socket.write(`${authTag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); return true; }
        return false;
      },
    }, async (cfg) => {
      const client = new ImapClient({
        ...cfg,
        auth: {
          type: 'xoauth2', user: 'u@x.com',
          getToken: ({ invalid }) => { const t = invalid ? 'fresh' : 'stale'; tokens.push(t); return t; },
        },
      });
      await client.connect();
      expect(tokens).toEqual(['stale', 'fresh']);
      expect(attempts).toBe(2);
      await client.close();
    });
  });

  it('rejects pending commands immediately when the connection drops', async () => {
    await withServer({
      handler: (line, _tag, socket) => { if (/ NOOP$/.test(line)) { socket.destroy(); return true; } return false; },
    }, async (cfg) => {
      const client = new ImapClient({ ...cfg, socketTimeout: 60_000 });
      await client.connect();
      const t0 = Date.now();
      await expect(client.noop()).rejects.toMatchObject({ retryable: true });
      expect(Date.now() - t0).toBeLessThan(1_000);
    });
  });

  it('IDLE yields to queued commands and resumes', async () => {
    let idles = 0;
    await withServer({
      handler: (line, tag, socket) => {
        if (/ IDLE$/.test(line)) { idles++; (socket as net.Socket & { idleTag?: string }).idleTag = tag; socket.write('+ idling\r\n'); return true; }
        if (line === 'DONE') { socket.write(`${(socket as net.Socket & { idleTag?: string }).idleTag} OK IDLE done\r\n`); return true; }
        return false;
      },
    }, async (cfg, log) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.select('INBOX');
      const stop = await client.idle();
      await client.noop();
      await new Promise(r => setTimeout(r, 50));
      expect(idles).toBe(2);
      await stop();
      const i = log.findIndex(l => / NOOP$/.test(l));
      expect(log[i - 1]).toBe('DONE');
      await client.close();
    });
  });
});

describe('ImapSession against a mock server', () => {
  it('fetch({ bodies }) uses BODY.PEEK[] and never sets \\Seen', async () => {
    const raw = 'Subject: s\r\n\r\nhello\r\nworld';
    await withServer({
      handler: (line, tag, socket) => {
        if (/UID SEARCH/.test(line)) { socket.write(`* SEARCH 1\r\n${tag} OK\r\n`); return true; }
        if (/UID FETCH/.test(line)) {
          socket.write(`* 1 FETCH (UID 1 FLAGS () BODY[] {${raw.length}}\r\n${raw})\r\n${tag} OK\r\n`);
          return true;
        }
        return false;
      },
    }, async (cfg, log) => {
      const s = new ImapSession(cfg);
      const [m] = await s.fetch({ bodies: true });
      expect(m!.body!.text).toBe('hello\r\nworld');
      const fetchLine = log.find(l => /UID FETCH/.test(l))!;
      expect(fetchLine).toContain('BODY.PEEK[]');
      expect(fetchLine).not.toMatch(/\bRFC822\b(?!\.SIZE)/);
      expect(log.some(l => /STORE/.test(l))).toBe(false);
      await s.close();
    });
  });

  it('fetchText transfer-decodes quoted-printable parts (regression)', async () => {
    await withServer({
      handler: (line, tag, socket) => {
        if (/BODYSTRUCTURE/.test(line)) {
          socket.write(`* 1 FETCH (UID 1 BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 9 1 NIL NIL NIL))\r\n${tag} OK\r\n`);
          return true;
        }
        if (/BODY\.PEEK\[1\]/.test(line)) {
          socket.write(`* 1 FETCH (UID 1 BODY[1] {9}\r\ncaf=C3=A9)\r\n${tag} OK\r\n`);
          return true;
        }
        return false;
      },
    }, async (cfg) => {
      const s = new ImapSession(cfg);
      const [m] = await s.fetchText([1]);
      expect(m!.body!.text).toBe('café');
      await s.close();
    });
  });

  it('reconnects on the next call after the connection drops', async () => {
    let connections = 0;
    await withServer({
      handler: (line, _tag, socket) => {
        if (/ LOGIN /.test(line)) connections++;
        if (/ NOOP$/.test(line) && connections === 1) { socket.destroy(); return true; }
        return false;
      },
    }, async (cfg) => {
      const s = new ImapSession({ ...cfg, reconnect: { retries: 2, delayMs: 10 } });
      await s.open('INBOX');
      await expect(s.getCapabilities().then(() => (s as unknown as { client: ImapClient }).client.noop())).rejects.toBeTruthy();
      const status = await s.open('INBOX');
      expect(status.exists).toBe(3);
      expect(connections).toBe(2);
      await s.close();
    });
  });

  it('watch() reports new messages by UID', async () => {
    await withServer({
      handler: (line, tag, socket) => {
        if (/ IDLE$/.test(line)) {
          socket.write('+ idling\r\n');
          setTimeout(() => socket.write('* 4 EXISTS\r\n'), 20);
          (socket as net.Socket & { idleTag?: string }).idleTag = tag;
          return true;
        }
        if (line === 'DONE') { socket.write(`${(socket as net.Socket & { idleTag?: string }).idleTag} OK\r\n`); return true; }
        if (/UID SEARCH UID 4:\*/.test(line)) { socket.write(`* SEARCH 4\r\n${tag} OK\r\n`); return true; }
        return false;
      },
    }, async (cfg) => {
      const s = new ImapSession(cfg);
      const w = await s.watch('INBOX');
      const uids = await new Promise<number[]>(r => w.once('new', r));
      expect(uids).toEqual([4]);
      await w.stop();
      await s.close();
    });
  });
});

describe('IMAP plan gaps', () => {
  it('INBOX is case-insensitive, other mailbox names are not (I12)', async () => {
    const selects: string[] = [];
    await withServer({
      handler: (line, tag, socket) => {
        if (/ SELECT /.test(line)) { selects.push(line.split(' ').slice(2).join(' ')); socket.write(`* 1 EXISTS\r\n${tag} OK [READ-WRITE] done\r\n`); return true; }
        if (/UID SEARCH/.test(line)) { socket.write(`* SEARCH\r\n${tag} OK\r\n`); return true; }
        return false;
      },
    }, async (cfg) => {
      const s = new ImapSession(cfg);
      await s.search({}, 'INBOX');
      await s.search({}, 'inbox');   // same mailbox — no reselect
      await s.search({}, 'Work');
      await s.search({}, 'work');    // different mailbox — reselect
      expect(selects).toEqual(['"INBOX"', '"Work"', '"work"']);
      await s.close();
    });
  });

  it('frames a 8 MB literal in 16 KB chunks quickly (I13: no O(n²) buffering)', () => {
    const body = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const wire = Buffer.concat([Buffer.from(`* 1 FETCH (UID 1 BODY[] {${body.length}}\r\n`), body, Buffer.from(')\r\n')]);
    const p = new ImapParser();
    const t0 = performance.now();
    const out = [];
    for (let i = 0; i < wire.length; i += 16 * 1024) out.push(...p.feed(wire.subarray(i, i + 16 * 1024)));
    const ms = performance.now() - t0;
    expect(out).toHaveLength(1);
    expect(parseSectionResponse(out[0]!.data, '')!.length).toBe(body.length);
    expect(ms).toBeLessThan(2_000); // quadratic re-concatenation took tens of seconds at this size
  });

  it('a command with no server activity times out and closes the connection (I7)', async () => {
    await withServer({
      handler: (line) => / NOOP$/.test(line), // swallow NOOP: never answer
    }, async (cfg) => {
      const c = new ImapClient({ ...cfg, socketTimeout: 100 });
      await c.connect();
      const t0 = Date.now();
      await expect(c.noop()).rejects.toThrow(/timeout: NOOP/);
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(c.isConnected).toBe(false);
    });
  });
});
