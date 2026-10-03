import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  google,
  microsoft,
  mailConfigFor,
  createPkce,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  createTokenProvider,
  authorizeWithLoopback,
  emailFromIdToken,
  OAuthError,
  type OAuthProvider,
} from '../../../src/oauth/index.js';
import { createHash } from 'crypto';

type Handler = (form: URLSearchParams) => { status?: number; body: Record<string, unknown> };

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
});

async function tokenServer(handler: Handler): Promise<{ provider: OAuthProvider; requests: URLSearchParams[] }> {
  const requests: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      requests.push(form);
      const out = handler(form);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { provider: { ...google, tokenUrl: `http://127.0.0.1:${port}/token` }, requests };
}

const jwt = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('providers', () => {
  it('has correct Google and Microsoft endpoints, scopes and servers', () => {
    expect(google.scopes).toContain('https://mail.google.com/');
    expect(google.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    const ms = microsoft({ tenant: 'contoso.com' });
    expect(ms.tokenUrl).toBe('https://login.microsoftonline.com/contoso.com/oauth2/v2.0/token');
    expect(ms.scopes).toEqual(expect.arrayContaining([
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ]));
    expect(ms.smtp).toEqual({ host: 'smtp.office365.com', port: 587, secure: false });
  });

  it('mailConfigFor builds xoauth2 IMAP + SMTP configs', () => {
    const getToken = () => 't';
    const cfg = mailConfigFor(microsoft(), { user: 'a@contoso.com', getToken });
    expect(cfg.imap).toMatchObject({ host: 'outlook.office365.com', auth: { type: 'xoauth2', user: 'a@contoso.com', getToken } });
    expect(cfg.smtp.auth!.getToken).toBe(getToken);
  });
});

describe('authorization URL + PKCE', () => {
  it('builds an S256 PKCE request with offline access for Google', () => {
    const pkce = createPkce();
    expect(createHash('sha256').update(pkce.verifier).digest('base64url')).toBe(pkce.challenge);
    const url = new URL(buildAuthorizationUrl({
      provider: google, clientId: 'cid', redirectUri: 'http://127.0.0.1:1/cb',
      codeChallenge: pkce.challenge, state: 'st', loginHint: 'me@gmail.com',
    }));
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('scope')).toContain('https://mail.google.com/');
    expect(p.get('login_hint')).toBe('me@gmail.com');
  });
});

describe('token endpoint', () => {
  it('exchanges a code and reads the email claim', async () => {
    const { provider, requests } = await tokenServer(() => ({
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: jwt({ email: 'me@gmail.com' }) },
    }));
    const t = await exchangeCode({ provider, clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'r', codeVerifier: 'v' });
    expect(t).toMatchObject({ accessToken: 'at', refreshToken: 'rt', email: 'me@gmail.com' });
    expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(requests[0]!.get('grant_type')).toBe('authorization_code');
    expect(requests[0]!.get('code_verifier')).toBe('v');
    expect(requests[0]!.get('client_secret')).toBe('sec');
  });

  it('sends scopes on Microsoft refresh and surfaces invalid_grant', async () => {
    const { provider, requests } = await tokenServer(() => ({
      status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70008: expired' },
    }));
    const ms = { ...microsoft(), tokenUrl: provider.tokenUrl };
    const err = await refreshAccessToken({ provider: ms, clientId: 'cid', refreshToken: 'old' }).catch(e => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.oauthCode).toBe('invalid_grant');
    expect(err.retryable).toBe(false);
    expect(requests[0]!.get('scope')).toContain('SMTP.Send');
    expect(requests[0]!.get('client_secret')).toBeNull();
  });
});

describe('createTokenProvider', () => {
  it('caches, refreshes once for concurrent callers, rotates refresh tokens and forces refresh when invalid', async () => {
    let n = 0;
    const { provider, requests } = await tokenServer(() => {
      n++;
      return { body: { access_token: `at${n}`, expires_in: 3600, ...(n === 2 ? { refresh_token: 'rt2' } : {}) } };
    });
    const rotated: string[] = [];
    const getToken = createTokenProvider({
      provider, clientId: 'cid', refreshToken: 'rt1', onRefreshToken: t => { rotated.push(t); },
    });
    const ctx = { protocol: 'imap' as const, user: 'u', invalid: false };

    const [a, b] = await Promise.all([getToken(ctx), getToken(ctx)]);
    expect([a, b]).toEqual(['at1', 'at1']);
    expect(requests).toHaveLength(1);
    expect(await getToken(ctx)).toBe('at1'); // cached

    expect(await getToken({ ...ctx, invalid: true })).toBe('at2');
    expect(rotated).toEqual(['rt2']);
    await getToken({ ...ctx, invalid: true });
    expect(requests[2]!.get('refresh_token')).toBe('rt2'); // uses the rotated token
  });
});

describe('authorizeWithLoopback', () => {
  it('completes the browser flow and rejects forged state', async () => {
    const { provider, requests } = await tokenServer(() => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 60 } }));
    const tokens = await authorizeWithLoopback({
      provider, clientId: 'cid', clientSecret: 's',
      onAuthUrl: async (url) => {
        const p = new URL(url).searchParams;
        const redirect = p.get('redirect_uri')!.replace(provider.loopbackHost, '127.0.0.1');
        const forged = await fetch(`${redirect}?code=evil&state=wrong`);
        expect(forged.status).toBe(400);
        const ok = await fetch(`${redirect}?code=good&state=${p.get('state')}`);
        expect(ok.status).toBe(200);
      },
    });
    expect(tokens.refreshToken).toBe('rt');
    expect(requests[0]!.get('code')).toBe('good');
    expect(requests[0]!.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('rejects when the user denies consent', async () => {
    const { provider } = await tokenServer(() => ({ body: {} }));
    await expect(authorizeWithLoopback({
      provider, clientId: 'cid',
      onAuthUrl: async (url) => {
        const p = new URL(url).searchParams;
        await fetch(`${p.get('redirect_uri')}?error=access_denied&state=${p.get('state')}`);
      },
    })).rejects.toMatchObject({ oauthCode: 'access_denied' });
  });
});

describe('emailFromIdToken', () => {
  it('reads email or preferred_username', () => {
    expect(emailFromIdToken(jwt({ preferred_username: 'a@contoso.com' }))).toBe('a@contoso.com');
    expect(emailFromIdToken('garbage')).toBeUndefined();
  });
});
