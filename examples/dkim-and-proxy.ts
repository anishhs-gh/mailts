/**
 * DKIM signing + SOCKS5 proxy example.
 *
 * DKIM adds a cryptographic signature that receiving servers use to verify
 * the email genuinely came from your domain, improving deliverability.
 *
 * Prerequisites:
 *   1. Generate a 2048-bit RSA key pair for your domain:
 *        openssl genrsa -out dkim-private.pem 2048
 *        openssl rsa -in dkim-private.pem -pubout -out dkim-public.pem
 *   2. Publish the public key as a DNS TXT record:
 *        selector._domainkey.example.com  TXT  "v=DKIM1; k=rsa; p=<base64-public-key>"
 *   3. Set SMTP_PASS env var.
 *
 * Run:  SMTP_PASS=<pass> npx tsx examples/dkim-and-proxy.ts
 */
import { readFileSync } from 'fs';
import { MailTs } from '../src/index.js';

// ── DKIM only ─────────────────────────────────────────────────────────────────
const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: {
      type: 'plain',
      user: 'noreply@example.com',
      pass: process.env['SMTP_PASS']!,
    },
    dkim: {
      domainName: 'example.com',
      keySelector: 'mail',             // matches DNS record: mail._domainkey.example.com
      privateKey: readFileSync('./dkim-private.pem', 'utf8'),
      // headerFieldNames defaults to ['from','to','subject','date','message-id']
      // Add more to extend signing coverage:
      headerFieldNames: ['from', 'to', 'subject', 'date', 'message-id', 'reply-to'],
    },
  },
  logger: { level: 'debug', format: 'pretty', protocol: true },
});

const result = await mail.send({
  from: { email: 'noreply@example.com', name: 'Example' },
  to: 'user@example.com',
  subject: 'DKIM-signed email',
  text: 'This message is cryptographically signed with DKIM.',
  html: '<p>This message is cryptographically signed with <strong>DKIM</strong>.</p>',
});
console.log('DKIM send:', result.ok ? result.messageId : result.error.message);

// ── DKIM + SOCKS5 proxy ───────────────────────────────────────────────────────
// Useful when your server's outbound IP is not on the SPF record, or when
// routing via a dedicated sending IP through a proxy service.
const mailViaProxy = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: {
      type: 'plain',
      user: 'noreply@example.com',
      pass: process.env['SMTP_PASS']!,
    },
    dkim: {
      domainName: 'example.com',
      keySelector: 'mail',
      privateKey: readFileSync('./dkim-private.pem', 'utf8'),
    },
    proxy: {
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      // auth: { user: 'proxy-user', pass: 'proxy-pass' },  // if the proxy requires auth
    },
  },
});

const proxyResult = await mailViaProxy.send({
  from: 'noreply@example.com',
  to: 'user@example.com',
  subject: 'Via proxy + DKIM',
  text: 'Routed through SOCKS5 proxy and DKIM-signed.',
});
console.log('Proxy + DKIM:', proxyResult.ok ? proxyResult.messageId : proxyResult.error.message);

// ── HTTP CONNECT proxy ────────────────────────────────────────────────────────
const mailViaHttp = new MailTs({
  smtp: {
    host: 'smtp.sendgrid.net',
    port: 587,
    auth: {
      type: 'plain',
      user: 'apikey',
      pass: process.env['SENDGRID_API_KEY']!,
    },
    proxy: {
      type: 'http',           // HTTP CONNECT tunnel
      host: 'proxy.corp.internal',
      port: 3128,
    },
  },
});

console.log('HTTP proxy instance created (send omitted — no key set)');

await mail.shutdown();
await mailViaProxy.shutdown();
await mailViaHttp.shutdown();
