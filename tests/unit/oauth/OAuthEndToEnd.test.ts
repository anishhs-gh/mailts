/**
 * OAuth wired through the whole SDK: token endpoint → token provider →
 * SMTP / IMAP XOAUTH2 → refresh on rejection → error propagation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MailTs } from '../../../src/core/MailTs.js';
import { ImapSession } from '../../../src/imap/ImapSession.js';
import {
  google,
  microsoft,
  createTokenProvider,
  microsoftTokenProvider,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  authorizeWithLoopback,
  mailConfigFor,
  OAuthError,
  type OAuthProvider,
} from '../../../src/oauth/index.js';
import { imapServer, smtpServer, tokenServer } from '../../helpers/mockServers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });

/** Token server that issues at1, at2, … on every refresh. */
async function issuingTokens(extra: (n: number) => Record<string, unknown> = () => ({})) {
  const ts = await tokenServer((_f, n) => ({ body: { access_token: `at${n}`, expires_in: 3600, ...extra(n) } }));
  cleanups.push(ts.close);
  return ts;
}

const withTokenUrl = (p: OAuthProvider, url: string): OAuthProvider => ({ ...p, tokenUrl: url });

describe('OAuth → SMTP', () => {
  it('sends with a provider token, and refreshes once when the server rejects it', async () => {
    const ts = await issuingTokens();
    const smtp = await smtpServer({ acceptToken: t => t === 'at2' }); // at1 is "expired"
    cleanups.push(smtp.close);

    const getToken = createTokenProvider({
      provider: withTokenUrl(google, ts.url), clientId: 'cid', clientSecret: 's', refreshToken: 'rt',
    });
    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: smtp.port, secure: false, pool: false, auth: { type: 'xoauth2', user: 'me@x.com', getToken } },
    });
    const r = await mail.send({ from: 'me@x.com', to: 'you@x.com', subject: 's', text: 't' });

    expect(r.ok).toBe(true);
    expect(ts.requests).toHaveLength(2);           // initial + forced refresh
    expect(smtp.log.filter(l => l.startsWith('AUTH XOAUTH2'))).toHaveLength(2);
    expect(smtp.log).toContain('');                // the 334 challenge was answered
    expect(smtp.state.messages).toHaveLength(1);
  });

  it('reuses the cached token across sends (no refresh per message)', async () => {
    const ts = await issuingTokens();
    const smtp = await smtpServer();
    cleanups.push(smtp.close);
    const getToken = createTokenProvider({ provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 's', refreshToken: 'rt' });
    const mail = new MailTs({ smtp: { host: '127.0.0.1', port: smtp.port, secure: false, pool: false, auth: { type: 'xoauth2', user: 'me@x.com', getToken } } });
    for (let i = 0; i < 3; i++) expect((await mail.send({ from: 'me@x.com', to: 'you@x.com', text: `m${i}` })).ok).toBe(true);
    expect(ts.requests).toHaveLength(1);
  });

  it('reports invalid_grant as a non-retryable OAuthError; the queue does not retry it', async () => {
    const ts = await tokenServer(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    cleanups.push(ts.close);
    const smtp = await smtpServer();
    cleanups.push(smtp.close);
    const getToken = createTokenProvider({ provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 's', refreshToken: 'revoked' });
    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: smtp.port, secure: false, pool: false, auth: { type: 'xoauth2', user: 'me@x.com', getToken } },
      queue: { maxRetries: 5, retryDelay: 1 },
    });

    const direct = await mail.send({ from: 'me@x.com', to: 'you@x.com', text: 't' });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error).toBeInstanceOf(OAuthError);
      expect((direct.error as OAuthError).oauthCode).toBe('invalid_grant');
      expect(direct.error.retryable).toBe(false);
    }

    mail.queue.on('dead', () => {});
    const job = mail.queue.enqueue({ from: 'me@x.com', to: 'you@x.com', text: 't' });
    await mail.queue.drain();
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(1);
    expect(smtp.state.messages).toHaveLength(0);
  });

  it('treats a token-endpoint outage as retryable and recovers on the next attempt', async () => {
    const ts = await tokenServer((_f, n) => (n === 1
      ? { status: 503, body: { error: 'temporarily_unavailable' } }
      : { body: { access_token: 'ok', expires_in: 3600 } }));
    cleanups.push(ts.close);
    const smtp = await smtpServer();
    cleanups.push(smtp.close);
    const getToken = createTokenProvider({ provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 's', refreshToken: 'rt' });
    const mail = new MailTs({
      smtp: { host: '127.0.0.1', port: smtp.port, secure: false, pool: false, auth: { type: 'xoauth2', user: 'me@x.com', getToken } },
      queue: { retryDelay: 1, jitter: false },
    });
    const job = mail.queue.enqueue({ from: 'me@x.com', to: 'you@x.com', text: 't' });
    await mail.queue.drain();
    expect(job.status).toBe('success');
    expect(job.attempts).toBe(2);
  });
});

describe('OAuth → IMAP', () => {
  it('authenticates, refreshes after rejection, and re-authenticates on reconnect with the cached token', async () => {
    const ts = await issuingTokens();
    const imap = await imapServer({ acceptToken: t => t !== 'at1' });
    cleanups.push(imap.close);
    const getToken = createTokenProvider({ provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 's', refreshToken: 'rt' });
    const session = new ImapSession({
      host: '127.0.0.1', port: imap.port, secure: false,
      auth: { type: 'xoauth2', user: 'me@x.com', getToken },
      reconnect: { retries: 1, delayMs: 10 },
    });

    await session.open('INBOX');
    expect(ts.requests).toHaveLength(2); // at1 rejected → at2

    // Drop the connection; the next call reconnects using the cached at2
    (session as unknown as { client: { destroy(): void } }).client.destroy();
    await new Promise(r => setTimeout(r, 20));
    await session.open('INBOX');
    expect(imap.state.connections).toBe(2);
    expect(ts.requests).toHaveLength(2);
    await session.close();
  });

  it('works with mailConfigFor() presets pointed at local servers', async () => {
    const ts = await issuingTokens();
    const imap = await imapServer();
    const smtp = await smtpServer();
    cleanups.push(imap.close, smtp.close);
    const provider = withTokenUrl(microsoft(), ts.url);
    const getToken = createTokenProvider({ provider, clientId: 'c', refreshToken: 'rt' });
    const cfg = mailConfigFor(provider, { user: 'me@contoso.com', getToken });
    const mail = new MailTs({
      imap: { ...cfg.imap, host: '127.0.0.1', port: imap.port, secure: false },
      smtp: { ...cfg.smtp, host: '127.0.0.1', port: smtp.port, secure: false, pool: false },
    });
    expect((await mail.send({ from: 'me@contoso.com', to: 'a@x.com', text: 't' })).ok).toBe(true);
    const saved = await mail.saveToSent({ from: 'me@contoso.com', to: 'a@x.com', text: 't' }, { mailbox: 'Sent Items' });
    expect(saved.mailbox).toBe('Sent Items');
    expect(ts.requests).toHaveLength(1); // one token shared by SMTP and IMAP
    await mail.shutdown();
  });
});

describe('secret hygiene', () => {
  it('never writes access tokens, refresh tokens or passwords to protocol logs', async () => {
    const ts = await tokenServer(() => ({ body: { access_token: 'SECRET-ACCESS-TOKEN', expires_in: 3600 } }));
    cleanups.push(ts.close);
    const imap = await imapServer();
    const smtp = await smtpServer();
    cleanups.push(imap.close, smtp.close);
    const getToken = createTokenProvider({ provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 'CLIENT-SECRET', refreshToken: 'SECRET-REFRESH' });
    const auth = { type: 'xoauth2' as const, user: 'me@x.com', getToken };
    const mail = new MailTs({
      logger: { level: 'debug', protocol: true },
      imap: { host: '127.0.0.1', port: imap.port, secure: false, auth },
      smtp: { host: '127.0.0.1', port: smtp.port, secure: false, pool: false, auth },
    });
    const lines: string[] = [];
    mail.logger.onEvent(e => { lines.push(`${e.message} ${JSON.stringify(e.meta ?? {})}`); });

    await mail.send({ from: 'me@x.com', to: 'a@x.com', text: 't' });
    const session = mail.imap;
    await session.open('INBOX');
    await session.close();

    const plainPw = new MailTs({
      logger: { level: 'debug', protocol: true },
      imap: { host: '127.0.0.1', port: imap.port, secure: false, auth: { type: 'plain', user: 'u', pass: 'HUNTER2-PASSWORD' } },
    });
    plainPw.logger.onEvent(e => { lines.push(e.message); });
    const s2 = plainPw.imap;
    await s2.open('INBOX');
    await s2.close();

    const all = lines.join('\n');
    expect(all).toContain('AUTHENTICATE');          // protocol logging was really on
    const xoauthPayload = Buffer.from('user=me@x.com\x01auth=Bearer SECRET-ACCESS-TOKEN\x01\x01').toString('base64');
    for (const secret of ['SECRET-ACCESS-TOKEN', 'SECRET-REFRESH', 'CLIENT-SECRET', 'HUNTER2-PASSWORD', xoauthPayload]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('OAuth client details', () => {
  it('builds Microsoft authorization URLs with tenant, scopes and account picker', () => {
    const url = new URL(buildAuthorizationUrl({
      provider: microsoft({ tenant: 'rezolve.com' }), clientId: 'cid', redirectUri: 'http://localhost:5000/callback',
      codeChallenge: 'ch', state: 'st', extraParams: { domain_hint: 'rezolve.com' },
    }));
    expect(url.pathname).toBe('/rezolve.com/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('domain_hint')).toBe('rezolve.com');
    expect(url.searchParams.get('access_type')).toBeNull();
  });

  it('does not send scope on Google refresh, but does on Microsoft', async () => {
    const ts = await issuingTokens();
    await refreshAccessToken({ provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 's', refreshToken: 'r' });
    await refreshAccessToken({ provider: withTokenUrl(microsoft(), ts.url), clientId: 'c', refreshToken: 'r' });
    expect(ts.requests[0]!.get('scope')).toBeNull();
    expect(ts.requests[1]!.get('scope')).toContain('IMAP.AccessAsUser.All');
  });

  it('maps non-JSON and network failures to retryable OAuthErrors', async () => {
    const ts = await tokenServer(() => ({ status: 502, body: null, raw: '<html>Bad gateway</html>' }));
    cleanups.push(ts.close);
    const e1 = await exchangeCode({ provider: withTokenUrl(google, ts.url), clientId: 'c', code: 'x', redirectUri: 'r', codeVerifier: 'v' }).catch(e => e);
    expect(e1).toBeInstanceOf(OAuthError);
    expect(e1.retryable).toBe(true);

    const e2 = await refreshAccessToken({ provider: withTokenUrl(google, 'http://127.0.0.1:1/token'), clientId: 'c', refreshToken: 'r', timeoutMs: 2_000 }).catch(e => e);
    expect(e2).toBeInstanceOf(OAuthError);
    expect(e2.retryable).toBe(true);
  });

  it('token provider refreshes before expiry, reports tokens, and recovers after a failed refresh', async () => {
    let fail = true;
    const ts = await tokenServer((_f, n) => {
      if (n === 2 && fail) { fail = false; return { status: 500, body: { error: 'server_error' } }; }
      return { body: { access_token: `at${n}`, expires_in: 30 } }; // < 60 s skew → always stale
    });
    cleanups.push(ts.close);
    const seen: string[] = [];
    const getToken = createTokenProvider({
      provider: withTokenUrl(google, ts.url), clientId: 'c', clientSecret: 's', refreshToken: 'rt',
      onTokens: t => { seen.push(t.accessToken); },
    });
    const ctx = { protocol: 'smtp' as const, user: 'u', invalid: false };
    expect(await getToken(ctx)).toBe('at1');
    await expect(getToken(ctx)).rejects.toBeInstanceOf(OAuthError); // refresh #2 fails
    expect(await getToken(ctx)).toBe('at3');                          // not stuck on the failed promise
    expect(seen).toEqual(['at1', 'at3']);
  });

  it('microsoftTokenProvider persists rotated refresh tokens', async () => {
    const ts = await issuingTokens(n => ({ refresh_token: `rt${n + 1}` }));
    const saved: string[] = [];
    const getToken = microsoftTokenProvider({
      provider: withTokenUrl(microsoft(), ts.url), clientId: 'c', refreshToken: 'rt1',
      onRefreshToken: rt => { saved.push(rt); },
    });
    await getToken({ protocol: 'imap', user: 'u', invalid: false });
    await getToken({ protocol: 'imap', user: 'u', invalid: true });
    expect(saved).toEqual(['rt2', 'rt3']);
    expect(ts.requests.map(r => r.get('refresh_token'))).toEqual(['rt1', 'rt2']);
  });

  it('loopback flow times out, honours abort, and ignores unrelated requests', async () => {
    await expect(authorizeWithLoopback({ provider: google, clientId: 'c', timeoutMs: 50, onAuthUrl: () => {} }))
      .rejects.toMatchObject({ oauthCode: 'timeout' });

    const ac = new AbortController();
    const flow = authorizeWithLoopback({
      provider: google, clientId: 'c', signal: ac.signal,
      onAuthUrl: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
        const other = await fetch(`http://127.0.0.1:${redirect.port}/favicon.ico`);
        expect(other.status).toBe(404);
        ac.abort();
      },
    });
    await expect(flow).rejects.toMatchObject({ oauthCode: 'aborted' });
  });
});
