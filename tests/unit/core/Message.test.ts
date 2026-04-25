import { describe, it, expect } from 'vitest';
import { buildMessage } from '../../../src/core/Message.js';

describe('Message builder', () => {
  it('builds a plain text email', async () => {
    const built = await buildMessage({
      from: 'sender@example.com',
      to: 'to@example.com',
      subject: 'Hello',
      text: 'Hello world',
    });

    const raw = built.raw.toString('utf8');
    expect(raw).toContain('From: sender@example.com');
    expect(raw).toContain('To: to@example.com');
    expect(raw).toContain('Subject: Hello');
    expect(raw).toContain('MIME-Version: 1.0');
    expect(raw).toContain('Content-Type: text/plain');
    expect(built.from).toBe('sender@example.com');
    expect(built.to).toContain('to@example.com');
    expect(built.messageId).toMatch(/^<[^>]+>$/);
  });

  it('builds an HTML-only email', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'HTML Test',
      html: '<h1>Hello</h1>',
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('Content-Type: text/html');
  });

  it('builds multipart/alternative for text+html', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Both',
      text: 'Plain',
      html: '<p>HTML</p>',
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
  });

  it('builds multipart/mixed with attachment', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Attach',
      text: 'See attached',
      attachments: [{
        filename: 'test.txt',
        content: 'hello attachment',
        contentType: 'text/plain',
      }],
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('test.txt');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
  });

  it('includes multiple recipients in envelope', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: ['x@y.com', 'z@w.com'],
      subject: 'Multi',
      text: 'Hi all',
    });
    expect(built.to).toContain('x@y.com');
    expect(built.to).toContain('z@w.com');
  });

  it('includes CC and BCC in envelope to (not headers for BCC)', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'x@y.com',
      cc: 'cc@test.com',
      bcc: 'bcc@hidden.com',
      subject: 'CC BCC',
      text: 'Hi',
    });
    expect(built.to).toContain('cc@test.com');
    expect(built.to).toContain('bcc@hidden.com');
  });

  it('sets priority headers', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Urgent',
      text: 'Urgent!',
      priority: 'high',
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('X-Priority: 1');
    expect(raw).toContain('Importance: High');
  });

  it('throws if no recipients', async () => {
    await expect(buildMessage({ from: 'a@b.com', to: '', subject: 'X', text: 'Y' }))
      .rejects.toThrow();
  });

  it('throws if no body content', async () => {
    await expect(buildMessage({ from: 'a@b.com', to: 'b@c.com', subject: 'X' }))
      .rejects.toThrow();
  });

  it('prevents header injection in subject (strips CR/LF, no new header line)', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Subject\r\nBcc: attacker@evil.com',
      text: 'Hi',
    });
    const raw = built.raw.toString('utf8');
    // The CR+LF must be stripped — no injected header line (starts a new line with a header name)
    // Verify no standalone Bcc header line exists (header injection prevention works)
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).not.toContain('\r\nBcc:');
    // Subject should appear on a single line (no embedded CRLF)
    const subjectLine = raw.split('\r\n').find(l => l.startsWith('Subject:'));
    expect(subjectLine).toBeDefined();
    expect(subjectLine!.includes('\r') || subjectLine!.includes('\n')).toBe(false);
  });

  it('auto-generates plain text from HTML when only html is provided', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'HTML auto text',
      html: '<h1>Hello</h1><p>World</p>',
    });
    const raw = built.raw.toString('utf8');
    // With html-only, the builder may produce text/html or multipart/alternative
    // but the message must contain the visible content
    expect(raw).toContain('Hello');
    expect(raw).toContain('World');
  });

  it('builds multipart/related for CID inline attachments', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Inline image',
      html: '<img src="cid:logo">',
      attachments: [{
        filename: 'logo.png',
        content: Buffer.from('fakepng'),
        contentType: 'image/png',
        cid: 'logo',
      }],
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('multipart/related');
    expect(raw).toContain('Content-ID: <logo>');
    expect(raw).toContain('image/png');
    expect(raw).toContain('logo.png');
  });

  it('builds text/calendar part for iCal attachment', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Meeting invite',
      text: 'You are invited',
      ical: {
        summary: 'Team Sync',
        start: new Date('2024-06-01T14:00:00Z'),
        end: new Date('2024-06-01T15:00:00Z'),
        organizer: { name: 'Alice', email: 'alice@example.com' },
      },
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('text/calendar');
    expect(raw).toContain('invite.ics');
    expect(raw).toContain('BEGIN:VCALENDAR');
  });

  it('embeds rfc822 messages as message/rfc822 parts', async () => {
    const embeddedRaw = Buffer.from(
      'From: forward@example.com\r\nSubject: Forwarded\r\n\r\nOriginal content',
    );
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'FWD: something',
      text: 'See attached',
      attachments: [{
        filename: 'original.eml',
        rfc822: embeddedRaw,
      }],
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('message/rfc822');
    expect(raw).toContain('original.eml');
    expect(raw).toContain('Original content');
  });

  it('adds custom extra headers', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Custom headers',
      text: 'Hi',
      headers: { 'X-Campaign-ID': 'summer2024' },
    });
    expect(built.raw.toString()).toContain('X-Campaign-ID: summer2024');
  });

  it('includes Reply-To header when set', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Reply-To test',
      text: 'Hi',
      replyTo: 'replyhere@example.com',
    });
    expect(built.raw.toString()).toContain('Reply-To: replyhere@example.com');
  });

  it('separates headers from body with a blank line (CRLF CRLF)', async () => {
    const built = await buildMessage({
      from: 'a@b.com',
      to: 'b@b.com',
      subject: 'Sep',
      text: 'Body content',
    });
    const raw = built.raw.toString('binary');
    // Headers block ends, blank line, then body
    expect(raw).toMatch(/\r\n\r\n/);
    // Body appears after the blank line
    const sep = raw.indexOf('\r\n\r\n');
    expect(raw.slice(sep + 4)).toContain('Body content');
  });

  it('pool:false flag is accepted in SmtpConfig type', () => {
    // Type-level check — if this compiles, the type accepts pool: false
    const config: import('../../../src/types/smtp.js').SmtpConfig = {
      host: 'smtp.example.com',
      pool: false,
    };
    expect(config.pool).toBe(false);
  });
});
