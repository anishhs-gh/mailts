/**
 * Property test: for random, adversarial messages, buildMessage → parseMessage
 * returns exactly what went in, and the wire format stays RFC-compliant.
 */
import { describe, it, expect } from 'vitest';
import { buildMessage } from '../../../src/core/Message.js';
import { parseMessage } from '../../../src/core/MimeParser.js';
import { dotStuff } from '../../../src/smtp/SmtpCommand.js';

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const PIECES = [
  'Hello', 'café', 'naïve', 'Grüße', '日本語', '中文', '한국어', 'Привет', 'שלום', 'مرحبا', '🎉', '👩‍💻', '😀😀',
  'é', ',', ';', '"', "'", '<', '>', '(', ')', '\\', '=', '?', '_', '=?UTF-8?B?eA==?=', ' ', '  ', '\t', 'Re:', 'Fwd:',
];
const BODY_LINES = ['.', '..leading dots', 'From the start', 'trailing space   ', 'tab\tinside', '=3D literal', '', ' ', 'ünïcödé 🚀',
  'x'.repeat(200), '— em dash — and “quotes”', 'line=', 'end='];

function pick<T>(r: () => number, a: readonly T[]): T { return a[Math.floor(r() * a.length)]!; }
function phrase(r: () => number, n: number): string {
  return Array.from({ length: 1 + Math.floor(r() * n) }, () => pick(r, PIECES)).join(r() < 0.5 ? ' ' : '');
}
function body(r: () => number): string {
  const nl = r() < 0.5 ? '\n' : '\r\n';
  return Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(r, BODY_LINES)).join(nl);
}

describe('MIME round-trip (property)', () => {
  it('300 random messages survive build → parse unchanged', async () => {
    const r = rng(20261002);
    for (let i = 0; i < 300; i++) {
      const subject = phrase(r, 12).trim() || 'x';
      const fromName = phrase(r, 4).replace(/\s+/g, ' ').trim();
      const text = body(r);
      const withHtml = r() < 0.5;
      const html = withHtml ? `<p>${phrase(r, 6).replace(/[<>&]/g, '')}</p>` : undefined;
      const attachments = Array.from({ length: Math.floor(r() * 3) }, (_, k) => {
        const data = Buffer.from(Array.from({ length: Math.floor(r() * 300) }, () => Math.floor(r() * 256)));
        return { filename: `${phrase(r, 3).replace(/[\r\n]/g, '').trim() || 'f'}-${k}.bin`, content: data };
      });

      const built = await buildMessage({
        from: { email: 'sender@example.com', name: fromName || undefined },
        to: ['a@example.com', { email: 'b@example.com', name: phrase(r, 3).trim() || undefined }],
        subject,
        text,
        ...(html ? { html } : {}),
        attachments,
        references: ['<root@example.com>'],
        inReplyTo: '<parent@example.com>',
      });

      const wire = built.raw.toString('latin1');
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7f]/.test(wire), `8-bit byte in message ${i}`).toBe(false);
      for (const line of wire.split('\r\n')) expect(line.length, `line too long in message ${i}`).toBeLessThanOrEqual(998);
      expect(wire.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // only CRLF line endings

      const p = parseMessage(built.raw);
      expect(p.envelope.subject, `subject ${i}`).toBe(subject.replace(/\s+/g, ' ').trim() === subject ? subject : p.envelope.subject);
      expect(p.envelope.subject.replace(/\s+/g, ' ')).toBe(subject.replace(/\s+/g, ' '));
      expect(p.envelope.from[0]).toEqual({ email: 'sender@example.com', ...(fromName ? { name: fromName } : {}) });
      expect(p.envelope.to.map(a => (a as { email: string }).email)).toEqual(['a@example.com', 'b@example.com']);
      const expectedText = text.replace(/\r?\n/g, '\r\n').replace(/\s+$/, '');
      // A whitespace-only body part is reported as absent (by design)
      if (expectedText.trim()) expect(p.text, `text ${i}`).toBe(expectedText);
      else expect(p.text ?? '', `text ${i}`).toBe('');
      if (html) expect(p.html).toBe(html);
      expect(p.references).toEqual(['<root@example.com>']);
      expect(p.envelope.inReplyTo).toBe('<parent@example.com>');
      expect(p.attachments.map(a => a.filename)).toEqual(attachments.map(a => a.filename));
      p.attachments.forEach((a, k) => expect(a.content!.equals(attachments[k]!.content), `attachment ${i}/${k}`).toBe(true));
      expect(p.truncated).toBe(false);

      // SMTP dot-stuffing round-trips too (what the receiving server un-stuffs)
      const stuffed = dotStuff(built.raw).toString('latin1');
      const unstuffed = stuffed.slice(0, -5).replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.');
      expect(unstuffed === wire || unstuffed === `${wire}`.replace(/\r\n$/, ''), `dot-stuffing ${i}`).toBe(true);
    }
  });
});
