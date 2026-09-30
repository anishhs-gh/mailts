import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMessage } from '../../../src/core/Message.js';
import { parseMessage } from '../../../src/core/MimeParser.js';

const base = { from: 'Zoë Ünal <zoe@example.com>', to: 'bob@example.com' };

function headerBlock(raw: Buffer): string {
  const s = raw.toString('latin1');
  return s.slice(0, s.indexOf('\r\n\r\n'));
}

describe('buildMessage — encoding round-trip', () => {
  it('RFC 2047-encodes non-ASCII subject and names, and output is 7-bit clean', async () => {
    const subject = 'Café ☕ — résumé attached '.repeat(4);
    const built = await buildMessage({ ...base, subject, text: 'Grüße\nzweite Zeile  \n.dot line' });
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(built.raw.toString('latin1'))).toBe(false);
    for (const line of built.raw.toString('latin1').split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);

    const parsed = parseMessage(built.raw);
    expect(parsed.envelope.subject).toBe(subject.trim());
    expect(parsed.envelope.from[0]).toMatchObject({ email: 'zoe@example.com', name: 'Zoë Ünal' });
    expect(parsed.text).toBe('Grüße\r\nzweite Zeile  \r\n.dot line');
  });

  it('encodes non-ASCII attachment filenames with RFC 2231 and an ASCII fallback', async () => {
    const built = await buildMessage({
      ...base, text: 'x',
      attachments: [{ filename: 'Übersicht März 2026 — final version with a long name.pdf', content: Buffer.from('%PDF') }],
    });
    const parsed = parseMessage(built.raw);
    expect(parsed.attachments[0]!.filename).toBe('Übersicht März 2026 — final version with a long name.pdf');
    expect(built.raw.toString('latin1')).toMatch(/filename\*0\*=UTF-8''/);
  });

  it('cannot inject headers through attachment filename or content type (regression)', async () => {
    const built = await buildMessage({
      ...base, text: 'x',
      attachments: [{ filename: 'a.txt"\r\nBcc: victim@evil.com\r\nX: "', content: 'hi' }],
    });
    expect(built.raw.toString()).not.toMatch(/^Bcc:/m);
    await expect(buildMessage({
      ...base, text: 'x',
      attachments: [{ filename: 'a', content: 'hi', contentType: 'text/plain\r\nBcc: x@y.com' }],
    })).rejects.toThrow(/Invalid content type/);
    await expect(buildMessage({ ...base, text: 'x', headers: { 'X-A\r\nBcc': 'v' } })).rejects.toThrow(/header name/);
  });

  it('sets In-Reply-To and References', async () => {
    const built = await buildMessage({ ...base, text: 'x', inReplyTo: 'p@x', references: ['<a@x>', 'p@x'] });
    const parsed = parseMessage(built.raw);
    expect(parsed.envelope.inReplyTo).toBe('<p@x>');
    expect(parsed.references).toEqual(['<a@x>', '<p@x>']);
  });

  it('allows a calendar-only invite (regression)', async () => {
    const built = await buildMessage({
      ...base, subject: 'Invite',
      ical: { summary: 'Sync', start: new Date('2026-10-01T10:00:00Z'), end: new Date('2026-10-01T11:00:00Z'), organizer: { email: 'zoe@example.com' } },
    });
    const head = headerBlock(built.raw);
    expect(head).toMatch(/Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/);
    expect(parseMessage(built.raw).root.contentType).toBe('text/calendar');
  });

  it('honours attachment encodings and rejects binary as 7bit', async () => {
    const qp = await buildMessage({ ...base, text: 'x', attachments: [{ filename: 'n.txt', content: 'naïve', encoding: 'quoted-printable' }] });
    expect(parseMessage(qp.raw).attachments[0]!.content!.toString('utf8')).toBe('naïve');
    await expect(buildMessage({ ...base, text: 'x', attachments: [{ filename: 'b', content: Buffer.from([0, 1]), encoding: '7bit' }] }))
      .rejects.toThrow(/cannot be sent as 7bit/);
    const eight = await buildMessage({ ...base, text: 'x', attachments: [{ filename: 'e.txt', content: 'naïve', encoding: '8bit' }] });
    expect(eight.requires8BitMime).toBe(true);
  });

  it('flags SMTPUTF8 for internationalised addresses and dedupes envelope recipients', async () => {
    const built = await buildMessage({ from: 'a@example.com', to: ['用户@例子.广告', 'B@x.com'], bcc: 'b@x.com', text: 'x' });
    expect(built.requiresSmtpUtf8).toBe(true);
    expect(built.to).toEqual(['用户@例子.广告', 'B@x.com']);
  });

  it('round-trips a full mixed/related/alternative message', async () => {
    const built = await buildMessage({
      ...base, subject: 's', text: 'plain', html: '<p>html <img src="cid:logo"></p>',
      attachments: [
        { filename: 'logo.png', content: Buffer.from([137, 80, 78, 71]), cid: 'logo' },
        { filename: 'data.bin', content: Buffer.from([0, 255, 13, 10]) },
      ],
    });
    const p = parseMessage(built.raw);
    expect(p.text).toBe('plain');
    expect(p.html).toContain('cid:logo');
    const logo = p.attachments.find(a => a.contentId === 'logo')!;
    expect([...logo.content!]).toEqual([137, 80, 78, 71]);
    expect([...p.attachments.find(a => a.filename === 'data.bin')!.content!]).toEqual([0, 255, 13, 10]);
  });
});

describe('attachmentPolicy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailts-att-'));
  const inside = join(dir, 'ok.txt');
  writeFileSync(inside, 'inside');
  const outsideDir = mkdtempSync(join(tmpdir(), 'mailts-out-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
  symlinkSync(join(outsideDir, 'secret.txt'), join(dir, 'link.txt'));

  it("'deny' rejects path attachments", async () => {
    await expect(buildMessage({ ...base, text: 'x', attachments: [{ filename: 'a', path: inside }] }, { attachmentPolicy: 'deny' }))
      .rejects.toThrow(/disabled/);
  });

  it('{ root } allows files inside and rejects traversal and symlink escapes', async () => {
    const policy = { root: dir };
    const ok = await buildMessage({ ...base, text: 'x', attachments: [{ filename: 'a', path: 'ok.txt' }] }, { attachmentPolicy: policy });
    expect(parseMessage(ok.raw).attachments[0]!.content!.toString()).toBe('inside');
    for (const path of ['../' + join(outsideDir, 'secret.txt').split('/').slice(-2).join('/'), join(outsideDir, 'secret.txt'), 'link.txt']) {
      await expect(buildMessage({ ...base, text: 'x', attachments: [{ filename: 'a', path }] }, { attachmentPolicy: policy }))
        .rejects.toThrow(/escapes|not found/);
    }
  });
});
