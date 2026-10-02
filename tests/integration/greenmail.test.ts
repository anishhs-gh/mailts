/**
 * End-to-end tests against GreenMail (a real IMAP/SMTP server).
 * Run with: npm run test:integration   (needs Java 11+; downloads a pinned jar once)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { MailTs } from '../../src/core/MailTs.js';
import { ImapSession } from '../../src/imap/ImapSession.js';
import { parseMessage } from '../../src/core/MimeParser.js';
import type { ImapConfig } from '../../src/types/imap.js';
import type { SmtpConfig } from '../../src/types/smtp.js';

const RUN = process.env['MAILTS_IT'] === '1';

describe.skipIf(!RUN)('GreenMail integration', () => {
  let stop: (() => Promise<void>) | undefined;
  let n = 0;

  /** A fresh mailbox per test — GreenMail creates users on first login. */
  function account() {
    const user = `u${Date.now()}${n++}${randomBytes(2).toString('hex')}@example.test`;
    const auth = { type: 'plain' as const, user, pass: 'pw' };
    const imap: ImapConfig = { host: '127.0.0.1', port: 3993, secure: true, tls: { rejectUnauthorized: false }, auth };
    const smtp: SmtpConfig = { host: '127.0.0.1', port: 3025, secure: false, auth, pool: false };
    return { user, imap, smtp, mail: new MailTs({ smtp, imap }) };
  }

  async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise(r => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    // @ts-expect-error — plain ESM script without types
    const { startGreenMail } = await import('../../scripts/greenmail.mjs');
    const gm = await startGreenMail();
    stop = () => gm.stop();
  }, 120_000);

  afterAll(async () => { await stop?.(); });

  it('reads multi-line and quoted bodies in full (regression: literal truncation)', async () => {
    const { user, mail, imap } = account();
    const text = 'My answer\n\nOn Tue, x wrote:\n> Original question\n> line2\n' + 'filler line\n'.repeat(500);
    const sent = await mail.send({ from: user, to: user, subject: 'Grüße ☕ quoted', text });
    expect(sent.ok).toBe(true);

    const s = new ImapSession(imap);
    const [msg] = await waitFor(async () => { const m = await s.fetch({ bodies: true }); return m.length ? m : undefined; });
    expect(msg!.envelope.subject).toBe('Grüße ☕ quoted');
    expect(msg!.body!.text).toBe(text.replace(/\n/g, '\r\n').trimEnd());
    expect(msg!.flags).not.toContain('\\Seen');

    // BODY.PEEK never sets \Seen
    const [again] = await s.fetch({ uids: [msg!.uid] });
    expect(again!.flags).not.toContain('\\Seen');

    const section = await s.fetchSection(msg!.uid, '1');
    expect(section.length).toBeGreaterThan(5_000);

    const [t] = await s.fetchText([msg!.uid]);
    expect(t!.body!.text).toBe(msg!.body!.text);
    await s.close();
  });

  it('round-trips attachments, inline images and binary content', async () => {
    const { user, mail, imap } = account();
    const binary = randomBytes(2 * 1024 * 1024);
    await mail.send({
      from: user, to: user, subject: 'attachments',
      text: 'see attached', html: '<p>logo <img src="cid:logo"></p>',
      attachments: [
        { filename: 'Übersicht März.bin', content: binary },
        { filename: 'logo.png', content: Buffer.from([137, 80, 78, 71]), cid: 'logo' },
      ],
    });
    const s = new ImapSession(imap);
    const [msg] = await waitFor(async () => { const m = await s.fetch({ bodies: true }); return m.length ? m : undefined; });
    const big = msg!.body!.attachments.find(a => a.filename === 'Übersicht März.bin')!;
    expect(big.content!.equals(binary)).toBe(true);
    expect(msg!.body!.attachments.find(a => a.contentId === 'logo')!.inline).toBe(true);

    const raw = await s.fetchRaw(msg!.uid);
    expect(parseMessage(raw).attachments).toHaveLength(2);
    await s.close();
  });

  it('handles mailbox names with spaces and non-ASCII, append, move and delete', async () => {
    const { user, imap, mail } = account();
    const s = new ImapSession(imap);
    await s.createMailbox('Sent Items');
    await s.createMailbox('Entwürfe');
    const names = (await s.listMailboxes()).map(b => b.name);
    expect(names).toEqual(expect.arrayContaining(['INBOX', 'Sent Items', 'Entwürfe']));

    const res = await s.appendMessage('Entwürfe', { from: user, to: user, subject: 'draft', text: 'd' }, ['\\Draft']);
    expect(res.messageId).toMatch(/^<.+>$/);
    const drafts = await s.fetch({ mailbox: 'Entwürfe' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.flags).toContain('\\Draft');

    await s.move([drafts[0]!.uid], 'Sent Items', 'Entwürfe');
    expect(await s.fetch({ mailbox: 'Entwürfe' })).toHaveLength(0);
    const moved = await s.fetch({ mailbox: 'Sent Items' });
    expect(moved).toHaveLength(1);
    await s.delete([moved[0]!.uid], 'Sent Items');
    expect(await s.fetch({ mailbox: 'Sent Items' })).toHaveLength(0);

    const saved = await mail.saveToSent({ from: user, to: user, subject: 'copy', text: 'x' }, { mailbox: 'Sent Items' });
    expect(saved.mailbox).toBe('Sent Items');
    await mail.shutdown();
    await s.close();
  });

  it('threads replies with In-Reply-To / References and reads them back', async () => {
    const { user, mail, imap } = account();
    await mail.send({ from: user, to: user, subject: 'Re: plan', text: 'ok', inReplyTo: '<a@x>', references: ['<root@x>', '<a@x>'] });
    const s = new ImapSession(imap);
    const [msg] = await waitFor(async () => { const m = await s.fetch({ headers: ['References'] }); return m.length ? m : undefined; });
    expect(msg!.envelope.inReplyTo).toBe('<a@x>');
    expect(msg!.envelope.references).toEqual(['<root@x>', '<a@x>']);
    await s.close();
  });

  it('searches, including non-ASCII text', async () => {
    const { user, mail, imap } = account();
    await mail.send({ from: user, to: user, subject: 'Invoice José', text: 'x' });
    await mail.send({ from: user, to: user, subject: 'Other', text: 'y' });
    const s = new ImapSession(imap);
    await waitFor(async () => ((await s.search({})).length === 2 ? true : undefined));
    expect(await s.search({ subject: 'Invoice' })).toHaveLength(1);
    expect(await s.search({ subject: 'José' })).toHaveLength(1);
    await s.close();
  });

  it('watch() reports new messages by UID', async () => {
    const { user, mail, imap } = account();
    const s = new ImapSession(imap);
    const w = await s.watch('INBOX');
    const got = new Promise<number[]>(r => w.once('new', r));
    await mail.send({ from: user, to: user, subject: 'ping', text: 'x' });
    const uids = await got;
    expect(uids).toHaveLength(1);
    const [msg] = await s.fetch({ uids });
    expect(msg!.envelope.subject).toBe('ping');
    await w.stop();
    await s.close();
  });

  it('queued mail is delivered on shutdown, not cancelled (regression)', async () => {
    const { user, imap, smtp } = account();
    const mail = new MailTs({ smtp, imap });
    mail.queue.pause();
    for (let i = 0; i < 3; i++) mail.queue.enqueue({ from: user, to: user, subject: `q${i}`, text: 'x' });
    await mail.shutdown();
    const s = new ImapSession(imap);
    const msgs = await waitFor(async () => { const m = await s.fetch({}); return m.length === 3 ? m : undefined; });
    expect(msgs.map(m => m.envelope.subject).sort()).toEqual(['q0', 'q1', 'q2']);
    await s.close();
  });

  it('imapMailbox() implements the provider-neutral Mailbox API', async () => {
    const { imapMailbox } = await import('../../src/mailbox/index.js');
    const { user, mail, imap } = account();
    await mail.send({ from: user, to: user, subject: 'neutral one', text: 'alpha' });
    await mail.send({ from: user, to: user, subject: 'neutral two', text: 'beta' });
    const box = imapMailbox(new ImapSession(imap));
    await waitFor(async () => ((await box.search({})).length === 2 ? true : undefined));

    const list = await box.fetch({ limit: 10 });
    expect(list.map(m => m.envelope.subject)).toEqual(['neutral two', 'neutral one']); // newest first
    expect(list[0]!.flags).not.toContain('\\Seen');
    expect(await box.search({ subject: 'two' })).toEqual([list[0]!.id]);

    const [full] = await box.fetch({ ids: [list[1]!.id], bodies: true });
    expect(full!.body!.text).toBe('alpha');

    await box.setSeen([list[0]!.id], true);
    expect(await box.status()).toEqual({ total: 2, unread: 1 });

    const archived = (await box.listMailboxes()).length;
    expect(archived).toBeGreaterThan(0);
    const { id } = await box.append('INBOX', (await mail.build({ from: user, to: user, subject: 'appended', text: 'x' })).raw, { seen: false });
    expect(id).toBeTruthy();
    await box.delete([list[1]!.id]);
    expect((await box.fetch({})).map(m => m.envelope.subject).sort()).toEqual(['appended', 'neutral two']);
    await box.close();
  });
});
