import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, createVerify, X509Certificate, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { googleServiceAccountProvider, microsoftAppOnlyProvider, OAuthError } from '../../../src/oauth/index.js';
import { MailTs } from '../../../src/core/MailTs.js';
import { tokenServer, smtpServer } from '../../helpers/mockServers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decodeJwt(jwt: string) {
  const [h, c, sig] = jwt.split('.');
  const verified = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>,
    verified,
  };
}
const ctx = { protocol: 'imap' as const, user: 'u', invalid: false };

describe('googleServiceAccountProvider', () => {
  it('exchanges a signed JWT (domain-wide delegation) and caches the token', async () => {
    const ts = await tokenServer(() => ({ body: { access_token: 'sa-token', expires_in: 3600 } }));
    cleanups.push(ts.close);
    const getToken = googleServiceAccountProvider({
      credentials: { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privatePem, private_key_id: 'k1', token_uri: ts.url },
      subject: 'support@company.com',
    });
    expect(await getToken(ctx)).toBe('sa-token');
    expect(await getToken(ctx)).toBe('sa-token');
    expect(ts.requests).toHaveLength(1);

    const form = ts.requests[0]!;
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = decodeJwt(form.get('assertion')!);
    expect(jwt.verified).toBe(true);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    expect(jwt.claims).toMatchObject({
      iss: 'svc@proj.iam.gserviceaccount.com', sub: 'support@company.com', scope: 'https://mail.google.com/', aud: ts.url,
    });
    expect((jwt.claims['exp'] as number) - (jwt.claims['iat'] as number)).toBe(3600);

    await getToken({ ...ctx, invalid: true });
    expect(ts.requests).toHaveLength(2); // forced refresh
  });

  it('explains a missing domain-wide delegation', async () => {
    const ts = await tokenServer(() => ({ status: 401, body: { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' } }));
    cleanups.push(ts.close);
    const getToken = googleServiceAccountProvider({
      credentials: { client_email: 'svc@x', private_key: privatePem, token_uri: ts.url }, subject: 'a@company.com',
    });
    const err = await Promise.resolve(getToken(ctx)).catch(e => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.oauthCode).toBe('unauthorized_client');
    expect(err.message).toMatch(/domain-wide delegation is not configured/);
  });
});

describe('microsoftAppOnlyProvider', () => {
  it('client secret: requests the Exchange .default scope', async () => {
    const ts = await tokenServer(() => ({ body: { access_token: 'app-token', expires_in: 3599 } }));
    cleanups.push(ts.close);
    const getToken = microsoftAppOnlyProvider({ tenant: 'contoso.com', clientId: 'cid', clientSecret: 'sec', tokenUrl: ts.url });
    expect(await getToken(ctx)).toBe('app-token');
    expect(Object.fromEntries(ts.requests[0]!)).toEqual({
      grant_type: 'client_credentials', client_id: 'cid', scope: 'https://outlook.office365.com/.default', client_secret: 'sec',
    });
  });

  it('certificate: signs a client assertion with the x5t thumbprint; Graph scope', async () => {
    const ts = await tokenServer(() => ({ body: { access_token: 'cert-token', expires_in: 3600 } }));
    cleanups.push(ts.close);
    const getToken = microsoftAppOnlyProvider({
      tenant: 'contoso.com', clientId: 'cid', api: 'graph', tokenUrl: ts.url,
      certificate: { privateKey: privatePem, thumbprint: 'AB:CD:EF:01' },
    });
    await getToken(ctx);
    const form = ts.requests[0]!;
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(form.get('client_secret')).toBeNull();
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const jwt = decodeJwt(form.get('client_assertion')!);
    expect(jwt.verified).toBe(true);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT', x5t: Buffer.from('abcdef01', 'hex').toString('base64url') });
    expect(jwt.claims).toMatchObject({ aud: ts.url, iss: 'cid', sub: 'cid' });
    expect(typeof jwt.claims['jti']).toBe('string');
  });

  it.skipIf(!(() => { try { execFileSync('openssl', ['version']); return true; } catch { return false; } })())(
    'computes x5t from a certificate PEM', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mailts-cert-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mailts-test',
        '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
      const certPem = readFileSync(join(dir, 'c.pem'), 'utf8');
      const ts = await tokenServer(() => ({ body: { access_token: 't', expires_in: 3600 } }));
      cleanups.push(ts.close);
      await microsoftAppOnlyProvider({
        tenant: 't.com', clientId: 'cid', tokenUrl: ts.url,
        certificate: { privateKey: readFileSync(join(dir, 'k.pem'), 'utf8'), certificatePem: certPem },
      })(ctx);
      const header = JSON.parse(Buffer.from(ts.requests[0]!.get('client_assertion')!.split('.')[0]!, 'base64url').toString());
      const der = new X509Certificate(certPem).raw;
      expect(header.x5t).toBe(createHash('sha1').update(der).digest('base64url'));
    });

  it('rejects multi-tenant aliases and missing credentials, surfaces AADSTS errors', async () => {
    expect(() => microsoftAppOnlyProvider({ tenant: 'common', clientId: 'c', clientSecret: 's' })).toThrow(/specific tenant/);
    expect(() => microsoftAppOnlyProvider({ tenant: 't.com', clientId: 'c' })).toThrow(/clientSecret or certificate/);
    const ts = await tokenServer(() => ({ status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' } }));
    cleanups.push(ts.close);
    const err = await Promise.resolve(microsoftAppOnlyProvider({ tenant: 't.com', clientId: 'c', clientSecret: 'bad', tokenUrl: ts.url })(ctx)).catch(e => e);
    expect(err).toMatchObject({ oauthCode: 'invalid_client', retryable: false });
    expect(err.message).toContain('AADSTS7000215: Invalid client secret provided.');
    expect(err.message).not.toContain('Trace ID');
  });

  it('plugs into SMTP XOAUTH2 to send as a shared mailbox', async () => {
    const ts = await tokenServer(() => ({ body: { access_token: 'app-token', expires_in: 3600 } }));
    const smtp = await smtpServer({ acceptToken: t => t === 'app-token' });
    cleanups.push(ts.close, smtp.close);
    const getToken = microsoftAppOnlyProvider({ tenant: 'contoso.com', clientId: 'cid', clientSecret: 's', tokenUrl: ts.url });
    const mail = new MailTs({ smtp: { host: '127.0.0.1', port: smtp.port, secure: false, pool: false, auth: { type: 'xoauth2', user: 'support@contoso.com', getToken } } });
    const r = await mail.send({ from: 'support@contoso.com', to: 'a@x.com', text: 'hi' });
    expect(r.ok).toBe(true);
  });
});
