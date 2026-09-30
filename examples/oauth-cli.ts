/**
 * OAuth for a CLI / desktop app — sign in once, send later, sign out.
 * Works with Gmail / Google Workspace and Microsoft 365 / Outlook.com.
 *
 *   npx tsx examples/oauth-cli.ts signin   # browser sign-in, stores the refresh token
 *   npx tsx examples/oauth-cli.ts send     # uses the stored token (refreshed automatically)
 *   npx tsx examples/oauth-cli.ts signout  # revokes (Google) and deletes the stored token
 *
 * Env:
 *   PROVIDER=google|microsoft   MAIL_USER=you@example.com   MAIL_TO=someone@example.com
 *   Google:    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (OAuth client type "Desktop app")
 *   Microsoft: MS_CLIENT_ID [MS_TENANT]                 (public client, redirect http://localhost)
 *
 * The refresh token is kept in a 0600 file for the demo. In a real CLI use the OS
 * keychain (e.g. @napi-rs/keyring). Everything is logged to stderr, so this also
 * works inside stdio MCP servers.
 */
import { readFile, writeFile, rm } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { MailTs } from '../src/index.js';
import {
  authorizeWithLoopback,
  createTokenProvider,
  google,
  microsoft,
  mailConfigFor,
  OAuthError,
  type OAuthProvider,
} from '../src/oauth/index.js';

const log = (m: string) => process.stderr.write(`${m}\n`);
const isGoogle = (process.env['PROVIDER'] ?? 'google') === 'google';
const user = process.env['MAIL_USER'] ?? '';
const clientId = (isGoogle ? process.env['GOOGLE_CLIENT_ID'] : process.env['MS_CLIENT_ID']) ?? '';
const clientSecret = isGoogle ? process.env['GOOGLE_CLIENT_SECRET'] : undefined;
const provider: OAuthProvider = isGoogle ? google : microsoft({ tenant: process.env['MS_TENANT'] ?? 'common' });
const store = join(homedir(), `.mailts-oauth-${provider.id}.json`);

if (!user || !clientId || (isGoogle && !clientSecret)) {
  log('Set MAIL_USER and the client id (and GOOGLE_CLIENT_SECRET for Google). See the header of this file.');
  process.exit(1);
}

async function saveRefreshToken(refreshToken: string): Promise<void> {
  await writeFile(store, JSON.stringify({ user, refreshToken }), { mode: 0o600 });
}

async function loadRefreshToken(): Promise<string> {
  try {
    return (JSON.parse(await readFile(store, 'utf8')) as { refreshToken: string }).refreshToken;
  } catch {
    throw new Error(`Not signed in — run: npx tsx examples/oauth-cli.ts signin`);
  }
}

async function signin(): Promise<void> {
  const tokens = await authorizeWithLoopback({
    provider,
    clientId,
    clientSecret,
    loginHint: user,
    onAuthUrl: async (url) => {
      log('Opening your browser to sign in…');
      const { openBrowser } = await import('../src/oauth/index.js');
      await openBrowser(url).catch(() => log(`Open this URL:\n${url}`));
    },
  });
  if (!tokens.refreshToken) throw new Error('No refresh token returned — check offline access / consent settings');
  await saveRefreshToken(tokens.refreshToken);
  log(`Signed in${tokens.email ? ` as ${tokens.email}` : ''}. Refresh token saved to ${store}`);
}

async function send(): Promise<void> {
  const getToken = createTokenProvider({
    provider,
    clientId,
    clientSecret,
    refreshToken: await loadRefreshToken(),
    onRefreshToken: saveRefreshToken, // Microsoft rotates refresh tokens — keep the newest
  });
  const cfg = mailConfigFor(provider, { user, getToken });
  const mail = new MailTs({ ...cfg, smtp: { ...cfg.smtp, pool: false } });

  const result = await mail.send({
    from: user,
    to: process.env['MAIL_TO'] ?? user,
    subject: 'Hello from mailts + OAuth',
    text: 'Sent with a refreshed OAuth access token.',
  });
  if (result.ok) log(`Sent ${result.messageId}`);
  else if (result.error instanceof OAuthError && result.error.oauthCode === 'invalid_grant') {
    log('Your sign-in expired or was revoked — run signin again.');
  } else log(`Send failed: ${result.error.message}`);
}

async function signout(): Promise<void> {
  const refreshToken = await loadRefreshToken().catch(() => undefined);
  if (refreshToken && isGoogle) {
    const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
    log(res.ok ? 'Google access revoked.' : `Revoke returned HTTP ${res.status}`);
  } else if (refreshToken) {
    log('Microsoft: remove the app at https://myapps.microsoft.com to revoke access.');
  }
  await rm(store, { force: true });
  log('Local token deleted.');
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { signin, send, signout };
const run = command ? commands[command] : undefined;
if (!run) {
  log('Usage: oauth-cli.ts signin | send | signout');
  process.exit(1);
}
await run().catch((err: Error) => { log(err.message); process.exit(1); });
