/**
 * OAuth2 / XOAUTH2 authentication — Gmail SMTP and IMAP.
 *
 * Unlike app passwords, OAuth2 tokens are short-lived (1 hour) and scoped.
 * Pass the access_token you get from Google's token endpoint as `token`.
 *
 * Prerequisites:
 *   1. Create OAuth2 credentials at console.cloud.google.com
 *   2. Grant scope: https://mail.google.com/
 *   3. Exchange your auth code for tokens (access_token + refresh_token)
 *   4. Refresh when expired: POST https://oauth2.googleapis.com/token
 *
 * Run:  GMAIL_USER=you@gmail.com GMAIL_TOKEN=<access_token> npx tsx examples/xoauth2.ts
 */
import { MailTs } from '../src/index.js';

const user  = process.env['GMAIL_USER']!;
const token = process.env['GMAIL_TOKEN']!;

if (!user || !token) {
  console.error('Set GMAIL_USER and GMAIL_TOKEN env vars');
  process.exit(1);
}

// ── SMTP with XOAUTH2 ─────────────────────────────────────────────────────
const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: {
      type: 'xoauth2',
      user,
      token,   // `pass` is ignored for xoauth2
    },
    pool: false,   // one-shot send, no shutdown() needed
  },
  logger: { level: 'info', format: 'pretty' },
});

const result = await mail.send({
  from: { email: user, name: 'My App' },
  to: 'recipient@example.com',
  subject: 'Sent via OAuth2',
  text: 'No app password — just a short-lived OAuth2 access token.',
  html: '<p>No app password — just a short-lived OAuth2 access token.</p>',
});
console.log('SMTP XOAUTH2:', result.ok ? result.messageId : result.error.message);

// ── IMAP with XOAUTH2 ─────────────────────────────────────────────────────
const reader = new MailTs({
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'xoauth2', user, token },
  },
});

const session = reader.imap;
await session.connect();

const mailboxes = await session.listMailboxes();
console.log('Mailboxes:', mailboxes.map(b => b.name).join(', '));

const status = await session.open('INBOX');
console.log(`INBOX: ${status.exists} messages, ${status.unseen} unseen`);

const messages = await session.fetch({ seen: false, limit: 5 });
console.log(`Unread: ${messages.map(m => m.envelope.subject).join(', ')}`);
await session.close();

console.log('IMAP XOAUTH2: connected and listed inbox successfully');
