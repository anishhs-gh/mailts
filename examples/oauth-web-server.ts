/**
 * OAuth for a web app / hosted service — "Connect your mailbox" with Google or Microsoft.
 *
 * Flow: /connect/google → provider consent → /callback → tokens → /send uses the
 * mailbox. Uses only node:http so it runs anywhere; the same calls drop into
 * Express, Fastify, Next.js route handlers, Cloud Run, etc.
 *
 * Run:
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… MS_CLIENT_ID=… MS_CLIENT_SECRET=… \
 *     npx tsx examples/oauth-web-server.ts
 *   open http://localhost:3000
 *
 * Register http://localhost:3000/callback as the redirect URI ("Web application"
 * client for Google, "Web" platform for Microsoft).
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

const BASE = 'http://localhost:3000';
const REDIRECT = `${BASE}/callback`;

const clients: Record<string, { provider: OAuthProvider; clientId: string; clientSecret?: string }> = {
  google: { provider: google, clientId: process.env['GOOGLE_CLIENT_ID'] ?? '', clientSecret: process.env['GOOGLE_CLIENT_SECRET'] },
  microsoft: { provider: microsoft(), clientId: process.env['MS_CLIENT_ID'] ?? '', clientSecret: process.env['MS_CLIENT_SECRET'] },
};

/** state → PKCE verifier + provider, valid for 10 minutes. */
const pending = new Map<string, { verifier: string; client: string; expires: number }>();
/** Connected mailboxes (demo: memory only). */
const accounts = new Map<string, { client: string; refreshToken: string }>();

const html = (body: string) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">${body}</body>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  try {
    if (url.pathname === '/') {
      const list = [...accounts.keys()].map(a => `<li>${a} — <a href="/send?user=${encodeURIComponent(a)}">send test</a></li>`).join('');
      res.end(html(`<h1>Mailboxes</h1><ul>${list || '<li>none</li>'}</ul>
        <p><a href="/connect/google">Connect Google</a> · <a href="/connect/microsoft">Connect Microsoft</a></p>`));
      return;
    }

    const connect = /^\/connect\/(google|microsoft)$/.exec(url.pathname);
    if (connect) {
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
      const mail = new MailTs({ smtp: { ...cfg.smtp, pool: false }, attachmentPolicy: 'deny' });
      const r = await mail.send({ from: user, to: user, subject: 'Connected via mailts', text: 'OAuth works.' });
      res.end(html(r.ok ? `<p>Sent ${r.messageId}</p><a href="/">back</a>` : `<p>Failed: ${r.error.message}</p>`));
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    // Never echo provider error bodies to users in production; log them server-side.
    res.writeHead(500).end('Something went wrong');
    process.stderr.write(`${(err as Error).message}\n`);
  }
}).listen(3000, () => process.stderr.write(`Open ${BASE}\n`));
