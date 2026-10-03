/**
 * OAuth2 / XOAUTH2 — Gmail (or Microsoft 365) SMTP + IMAP with automatic token refresh.
 *
 * Access tokens expire after ~1 hour. Give mailts a `getToken` provider instead of a
 * static token: it is called on every (re)connect and again with `invalid: true` if the
 * server rejects a token, so long-running apps keep working.
 *
 * Get a refresh token once with `examples/oauth-cli.ts signin`, then:
 *
 * Run:
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=… MAIL_USER=you@gmail.com \
 *     npx tsx examples/xoauth2.ts
 */
import { MailTs } from '../src/index.js';
import { google, googleTokenProvider, mailConfigFor } from '../src/oauth/index.js';

const user = process.env['MAIL_USER'];
const clientId = process.env['GOOGLE_CLIENT_ID'];
const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
const refreshToken = process.env['GOOGLE_REFRESH_TOKEN'];
if (!user || !clientId || !clientSecret || !refreshToken) {
  console.error('Set MAIL_USER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN');
  process.exit(1);
}

// Caches the access token, refreshes ~60 s before expiry, one request per burst.
const getToken = googleTokenProvider({
  clientId,
  clientSecret,
  refreshToken,
  onRefreshToken: () => { /* Google keeps refresh tokens stable; Microsoft rotates — persist it there */ },
});

// imap.gmail.com:993 + smtp.gmail.com:465 with auth: { type: 'xoauth2', user, getToken }
const config = mailConfigFor(google, { user, getToken });
const mail = new MailTs({ ...config, smtp: { ...config.smtp, pool: false } });

// ── SMTP ──────────────────────────────────────────────────────────────────
const result = await mail.send({
  from: { email: user, name: 'My App' },
  to: user,
  subject: 'Sent via OAuth2',
  text: 'No app password — a refreshed OAuth2 access token.',
});
console.log('SMTP:', result.ok ? result.messageId : result.error.message);

// ── IMAP ──────────────────────────────────────────────────────────────────
const session = mail.imap;
const status = await session.open('INBOX');
console.log(`INBOX: ${status.exists} messages, ${status.unseen} unseen`);

const unread = await session.fetch({ seen: false, limit: 5 });
console.log('Unread:', unread.map(m => m.envelope.subject).join(' | ') || '(none)');
await session.close();

// A static token still works when you manage refresh yourself:
//   auth: { type: 'xoauth2', user, token: accessToken }
