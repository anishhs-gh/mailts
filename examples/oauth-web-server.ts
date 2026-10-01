/**
 * OAuth for a web app / hosted service — "Connect your mailbox" with Google or Microsoft.
 *
 * Flow: /connect/google → provider consent → /callback → tokens → /send uses the
 * mailbox. Uses only node:http so it runs anywhere; the same calls drop into
 * Express, Fastify, Next.js route handlers, Cloud Run, etc.
 *
 * Run:
 *   cp examples/.env.example examples/.env   # fill in the client id/secret you have
 *   npm run example:oauth-web
 *   open http://127.0.0.1:3000
 *
 * Only providers with a client id configured are offered.
 *
 * Redirect URI = BASE_URL + /callback (default http://127.0.0.1:3000/callback).
 * - Google "Web application" client (what a backend uses): add the redirect URI under
 *   "Authorized redirect URIs" exactly — scheme, host, port and path must match, and
 *   127.0.0.1 ≠ localhost. Otherwise Google answers `Error 400: redirect_uri_mismatch`.
 * - Google "Desktop app" client: loopback redirects are accepted without registering (local only).
 * - Microsoft: "Web" platform redirect URI in the app registration, same exact-match rule.
 * - Deployed: register https://your.domain/callback and set BASE_URL=https://your.domain.
 *
 * Production notes: keep `pending` and `accounts` in a database, encrypt refresh
 * tokens at rest (KMS), bind the session cookie to `state`, and use HTTPS.
 */
import { createServer } from 'http';
import { MailTs } from '../src/index.js';
import {
  buildAuthorizationUrl,
  createPkce,
  createState,
  createTokenProvider,
  exchangeCode,
  google,
  microsoft,
  mailConfigFor,
  type OAuthProvider,
} from '../src/oauth/index.js';

const BASE = (process.env['BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const REDIRECT = `${BASE}/callback`;
const PORT = Number(process.env['PORT'] ?? new URL(BASE).port ?? 3000) || 3000;

const all: Record<string, { provider: OAuthProvider; clientId: string; clientSecret?: string }> = {
  google: { provider: google, clientId: process.env['GOOGLE_CLIENT_ID'] ?? '', clientSecret: process.env['GOOGLE_CLIENT_SECRET'] || undefined },
  microsoft: {
    provider: microsoft({ tenant: process.env['MS_TENANT'] || 'common' }),
    clientId: process.env['MS_CLIENT_ID'] ?? '',
    clientSecret: process.env['MS_CLIENT_SECRET'] || undefined,
  },
};
const clients = Object.fromEntries(Object.entries(all).filter(([, c]) => c.clientId));
if (Object.keys(clients).length === 0) {
  process.stderr.write('No OAuth client configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET and/or MS_CLIENT_ID (see examples/.env.example)\n');
  process.exit(1);
}

/** state → PKCE verifier + provider, valid for 10 minutes. */
const pending = new Map<string, { verifier: string; client: string; expires: number }>();
/** Connected mailboxes (demo: memory only). */
const accounts = new Map<string, { client: string; refreshToken: string }>();

const html = (body: string) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">${body}</body>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  try {
    if (url.pathname === '/') {
      const list = [...accounts.keys()].map(a => `<li>${escapeHtml(a)} — <a href="/send?user=${encodeURIComponent(a)}">read inbox + send test</a></li>`).join('');
      const links = Object.keys(clients).map(n => `<a href="/connect/${n}">Connect ${n[0]!.toUpperCase()}${n.slice(1)}</a>`).join(' · ');
      res.end(html(`<h1>Mailboxes</h1><ul>${list || '<li>none connected yet</li>'}</ul><p>${links}</p>`));
      return;
    }

    const connect = /^\/connect\/(google|microsoft)$/.exec(url.pathname);
    if (connect && clients[connect[1]!]) {
      const name = connect[1]!;
      const c = clients[name]!;
      const pkce = createPkce();
      const state = createState();
      pending.set(state, { verifier: pkce.verifier, client: name, expires: Date.now() + 600_000 });
      const location = buildAuthorizationUrl({
        provider: c.provider, clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: pkce.challenge, state,
      });
      res.writeHead(302, { Location: location }).end();
      return;
    }

    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state') ?? '';
      const p = pending.get(state);
      pending.delete(state);
      if (!p || p.expires < Date.now()) { res.writeHead(400).end('Invalid or expired state'); return; }
      const error = url.searchParams.get('error');
      if (error) { res.writeHead(400).end(`Sign-in failed: ${error}`); return; }

      const c = clients[p.client]!;
      const tokens = await exchangeCode({
        provider: c.provider, clientId: c.clientId, clientSecret: c.clientSecret,
        code: url.searchParams.get('code') ?? '', redirectUri: REDIRECT, codeVerifier: p.verifier,
      });
      // The id_token email is unverified — use it to label the account, and confirm by logging in.
      const user = tokens.email ?? 'unknown';
      if (!tokens.refreshToken) { res.writeHead(400).end('No refresh token (offline access not granted)'); return; }
      accounts.set(user, { client: p.client, refreshToken: tokens.refreshToken });
      res.writeHead(302, { Location: '/' }).end();
      return;
    }

    if (url.pathname === '/send') {
      const user = url.searchParams.get('user') ?? '';
      const acct = accounts.get(user);
      if (!acct) { res.writeHead(404).end('Unknown mailbox'); return; }
      const c = clients[acct.client]!;
      const getToken = createTokenProvider({
        provider: c.provider, clientId: c.clientId, clientSecret: c.clientSecret,
        refreshToken: acct.refreshToken,
        onRefreshToken: (rt) => { acct.refreshToken = rt; }, // Microsoft rotation — persist in your DB
      });
      const cfg = mailConfigFor(c.provider, { user, getToken });
      const mail = new MailTs({ ...cfg, smtp: { ...cfg.smtp, pool: false }, attachmentPolicy: 'deny' });

      // Read (IMAP) and send (SMTP) as the connected user
      const session = mail.imap;
      const status = await session.open('INBOX');
      const latest = await session.fetch({ limit: 3 });
      await session.close();
      const r = await mail.send({ from: user, to: user, subject: 'Connected via mailts (web flow)', text: 'OAuth web flow works.' });

      const subjects = latest.reverse().map(m => `<li>${escapeHtml(m.envelope.subject || '(no subject)')}</li>`).join('');
      res.end(html(`<h1>${escapeHtml(user)}</h1>
        <p>INBOX: ${status.exists} messages, ${status.unseen ?? '?'} unseen. Newest:</p><ul>${subjects}</ul>
        <p>${r.ok ? `Test email sent to yourself: ${escapeHtml(r.messageId)}` : `Send failed: ${escapeHtml(r.error.message)}`}</p>
        <p><a href="/disconnect?user=${encodeURIComponent(user)}">Disconnect</a> · <a href="/">back</a></p>`));
      return;
    }

    if (url.pathname === '/disconnect') {
      const user = url.searchParams.get('user') ?? '';
      const acct = accounts.get(user);
      accounts.delete(user);
      // Google lets you revoke the grant; for Microsoft the user removes the app at myapps.microsoft.com
      if (acct?.client === 'google') {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acct.refreshToken)}`, { method: 'POST' }).catch(() => {});
      }
      res.writeHead(302, { Location: '/' }).end();
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    // Never echo provider error bodies to users in production; log them server-side.
    res.writeHead(500).end('Something went wrong');
    process.stderr.write(`${(err as Error).message}\n`);
  }
}).listen(PORT, '127.0.0.1', () => process.stderr.write(`Open ${BASE}  (providers: ${Object.keys(clients).join(', ')})\n`));

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
