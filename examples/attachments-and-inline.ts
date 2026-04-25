/**
 * Attachments, inline images, and embedded RFC 822 messages.
 *
 * Run:  SMTP_PASS=<pass> npx tsx examples/attachments-and-inline.ts
 */
import { readFileSync } from 'fs';
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env['SMTP_PASS']! },
  },
});

// ── 1. File attachments ───────────────────────────────────────────────────────
const result1 = await mail.send({
  from: { email: 'billing@example.com', name: 'Billing' },
  to: 'customer@example.com',
  subject: 'Your monthly invoice',
  text: 'Please find your invoice and report attached.',
  attachments: [
    {
      // Inline Buffer content
      filename: 'invoice.txt',
      content: Buffer.from('Invoice #1042\nAmount: $49.00\nDue: 2026-05-01'),
      contentType: 'text/plain',
    },
    {
      // File read from disk
      filename: 'report.csv',
      content: 'date,amount\n2026-04-01,$49.00',
      contentType: 'text/csv',
    },
    {
      // Path — read and base64-encoded at send time
      filename: 'logo.png',
      path: './assets/logo.png',
      contentType: 'image/png',
    },
  ],
});
console.log('Invoice email:', result1.ok ? result1.messageId : result1.error.message);

// ── 2. Inline images (CID embedding) ─────────────────────────────────────────
//    The image is referenced as `cid:banner` in the HTML body.
//    The attachment with the matching `cid` is embedded inline by the client.
const result2 = await mail.send({
  from: { email: 'noreply@example.com', name: 'Example' },
  to: 'user@example.com',
  subject: 'Newsletter with inline banner',
  html: `
    <html>
      <body>
        <img src="cid:banner" alt="Banner" width="600" />
        <h1>This month's updates</h1>
        <p>Check out what's new in April 2026.</p>
      </body>
    </html>
  `,
  attachments: [
    {
      filename: 'banner.png',
      content: readFileSync('./assets/banner.png'),
      contentType: 'image/png',
      cid: 'banner',          // matches `cid:banner` in the HTML above
      disposition: 'inline',
    },
  ],
});
console.log('Newsletter email:', result2.ok ? result2.messageId : result2.error.message);

// ── 3. Forwarded message as RFC 822 attachment ────────────────────────────────
//    Embed a raw email as a message/rfc822 part — used when forwarding
//    a message while preserving its original headers.
const originalRaw = [
  'From: original@example.com',
  'To: you@example.com',
  'Subject: Original message',
  'Date: Tue, 22 Apr 2026 12:00:00 +0000',
  '',
  'This is the body of the original message.',
].join('\r\n');

const result3 = await mail.send({
  from: 'you@example.com',
  to: 'colleague@example.com',
  subject: 'Fwd: Original message',
  text: 'See the forwarded message below.',
  attachments: [
    {
      filename: 'forwarded.eml',
      rfc822: originalRaw,    // content/path/contentType/encoding are ignored when rfc822 is set
    },
  ],
});
console.log('Forward email:', result3.ok ? result3.messageId : result3.error.message);

await mail.shutdown();
