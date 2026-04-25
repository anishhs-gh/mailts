/**
 * Alternative transports — Resend, SendGrid, Postmark, Mailgun, AWS SES.
 *
 * Each transport implements the same `Transport` interface, so you can swap
 * without changing any send() call.  Set the relevant env var and uncomment
 * the block you want to try.
 *
 * Run:  RESEND_API_KEY=re_... npx tsx examples/transports.ts
 */
import { MailTs } from '../src/index.js';
import {
  ResendTransport,
  PostmarkTransport,
  SendGridTransport,
  MailgunTransport,
  SesTransport,
} from '../src/transports/index.js';

const EMAIL_FROM = 'noreply@example.com';
const EMAIL_TO   = 'recipient@example.com';

const message = {
  from: { email: EMAIL_FROM, name: 'Example App' },
  to: EMAIL_TO,
  subject: 'Transport demo',
  text: 'Sent via a pluggable transport.',
  html: '<p>Sent via a <strong>pluggable transport</strong>.</p>',
};

// ── Resend ────────────────────────────────────────────────────────────────────
if (process.env['RESEND_API_KEY']) {
  const mail = new MailTs({
    transport: new ResendTransport({ apiKey: process.env['RESEND_API_KEY']! }),
    logger: { level: 'info', format: 'pretty' },
  });
  const r = await mail.send(message);
  console.log('Resend:', r.ok ? r.messageId : r.error.message);
  await mail.shutdown();
}

// ── SendGrid ──────────────────────────────────────────────────────────────────
if (process.env['SENDGRID_API_KEY']) {
  const mail = new MailTs({
    transport: new SendGridTransport({ apiKey: process.env['SENDGRID_API_KEY']! }),
  });
  const r = await mail.send(message);
  console.log('SendGrid:', r.ok ? r.messageId : r.error.message);
  await mail.shutdown();
}

// ── Postmark ──────────────────────────────────────────────────────────────────
if (process.env['POSTMARK_TOKEN']) {
  const mail = new MailTs({
    transport: new PostmarkTransport({ serverToken: process.env['POSTMARK_TOKEN']! }),
  });
  const r = await mail.send(message);
  console.log('Postmark:', r.ok ? r.messageId : r.error.message);
  await mail.shutdown();
}

// ── Mailgun ───────────────────────────────────────────────────────────────────
if (process.env['MAILGUN_API_KEY']) {
  const mail = new MailTs({
    transport: new MailgunTransport({
      apiKey: process.env['MAILGUN_API_KEY']!,
      domain: process.env['MAILGUN_DOMAIN'] ?? 'mg.example.com',
      // region: 'eu',  // uncomment for EU Mailgun endpoint
    }),
  });
  const r = await mail.send(message);
  console.log('Mailgun:', r.ok ? r.messageId : r.error.message);
  await mail.shutdown();
}

// ── AWS SES ───────────────────────────────────────────────────────────────────
// SesTransport uses SigV4 — supply credentials explicitly via env vars.
// For EC2/ECS/Lambda, fetch a short-lived token from the instance metadata
// service and pass it as sessionToken.
if (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']) {
  const mail = new MailTs({
    transport: new SesTransport({
      region:          process.env['AWS_REGION'] ?? 'us-east-1',
      accessKeyId:     process.env['AWS_ACCESS_KEY_ID']!,
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY']!,
      sessionToken:    process.env['AWS_SESSION_TOKEN'], // optional — STS / instance profile
    }),
  });
  const r = await mail.send(message);
  console.log('SES:', r.ok ? r.messageId : r.error.message);
  await mail.shutdown();
}

// ── Custom transport ──────────────────────────────────────────────────────────
// Implement the Transport interface to plug in any HTTP-based email service.
import type { Transport, TransportResult } from '../src/transports/Transport.js';
import type { EmailOptions } from '../src/types/index.js';

class MyCustomTransport implements Transport {
  readonly name = 'my-custom';

  async send(
    _message: { raw: Buffer; from: string; to: string[]; messageId: string },
    options: EmailOptions,
  ): Promise<TransportResult> {
    const to = Array.isArray(options.to) ? options.to : [options.to];
    const recipients = to.map(a => typeof a === 'string' ? a : a.email);
    // Call your API here...
    console.log(`[custom] Would send to ${recipients.join(', ')}`);
    return {
      messageId: `custom-${Date.now()}@example.com`,
      accepted: recipients,
      rejected: [],
    };
  }
}

const customMail = new MailTs({ transport: new MyCustomTransport() });
const r = await customMail.send(message);
console.log('Custom:', r.ok ? r.messageId : r.error.message);
await customMail.shutdown();
