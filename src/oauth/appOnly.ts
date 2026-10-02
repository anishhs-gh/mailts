/**
 * App-only ("organisation-wide") access tokens — no per-user sign-in.
 *
 * - Google Workspace: service account with domain-wide delegation (JWT bearer grant)
 * - Microsoft 365: client credentials (secret or certificate assertion)
 *
 * Both return a `TokenProvider` for `auth: { type: 'xoauth2', user, getToken }`,
 * `GraphTransport`, `GmailTransport`, `GraphMailbox` and `GmailMailbox`.
 */
import { createSign, randomUUID, X509Certificate } from 'crypto';
import { httpRequest } from '../transports/HttpClient.js';
import { OAuthError } from '../errors.js';
import type { TokenProvider } from '../types/auth.js';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Sign a compact JWT with RS256. */
function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKeyPem);
  return `${input}.${b64url(signature)}`;
}

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }

async function postToken(url: string, form: Record<string, string>, timeoutMs: number): Promise<TokenResponse & { status: number }> {
  let res;
  try {
    res = await httpRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new OAuthError(`Token request failed: ${(err as Error).message}`, undefined, true);
  }
  let json: TokenResponse;
  try {
    json = JSON.parse(res.body) as TokenResponse;
  } catch {
    throw new OAuthError(`Token endpoint returned HTTP ${res.status} (not JSON)`, undefined, res.status >= 500);
  }
  return { ...json, status: res.status };
}

/** Cache an access token until shortly before expiry; one refresh per burst. */
function cached(fetchToken: () => Promise<{ token: string; expiresIn: number }>, skewMs = 60_000): TokenProvider {
  let token: string | undefined;
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;
  return ({ invalid }) => {
    if (!invalid && token && Date.now() < expiresAt - skewMs) return token;
    inflight ??= fetchToken()
      .then(r => { token = r.token; expiresAt = Date.now() + r.expiresIn * 1000; return r.token; })
      .finally(() => { inflight = null; });
    return inflight;
  };
}

// ── Google: service account + domain-wide delegation ────────────────────────

export interface GoogleServiceAccountOptions {
  /** The service-account JSON key (or its `client_email` / `private_key` fields). */
  credentials: { client_email: string; private_key: string; private_key_id?: string; token_uri?: string };
  /** Mailbox to act as (Workspace user). Domain-wide delegation must allow the scopes for this client. */
  subject: string;
  /** @default ['https://mail.google.com/'] (IMAP/SMTP + Gmail API) */
  scopes?: readonly string[];
  timeoutMs?: number;
}

/**
 * Token provider for a Google Workspace mailbox using a service account with
 * domain-wide delegation. Works for Workspace domains only (not @gmail.com).
 *
 * Admin setup: create a service account and JSON key, then in the Workspace
 * Admin console → Security → API controls → Domain-wide delegation, authorise
 * the service account's client ID for the scopes.
 */
export function googleServiceAccountProvider(o: GoogleServiceAccountOptions): TokenProvider {
  const tokenUrl = o.credentials.token_uri ?? 'https://oauth2.googleapis.com/token';
  const scopes = o.scopes ?? ['https://mail.google.com/'];
  return cached(async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      { alg: 'RS256', typ: 'JWT', ...(o.credentials.private_key_id ? { kid: o.credentials.private_key_id } : {}) },
      { iss: o.credentials.client_email, sub: o.subject, scope: scopes.join(' '), aud: tokenUrl, iat: now, exp: now + 3600 },
      o.credentials.private_key,
    );
    const res = await postToken(tokenUrl, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }, o.timeoutMs ?? 15_000);
    if (res.access_token) return { token: res.access_token, expiresIn: res.expires_in ?? 3600 };
    const hint = res.error === 'unauthorized_client'
      ? ' — domain-wide delegation is not configured for this service account client ID and these scopes'
      : res.error === 'invalid_grant' ? ' — check the subject exists in the Workspace domain and the key is valid' : '';
    throw new OAuthError(`Google service account token failed: ${res.error ?? `HTTP ${res.status}`}${res.error_description ? ` (${res.error_description})` : ''}${hint}`,
      res.error, res.status >= 500);
  });
}

// ── Microsoft: client credentials ──────────────────────────────────────────

export interface MicrosoftAppOnlyOptions {
  /** Tenant id or domain (not `common`). */
  tenant: string;
  clientId: string;
  /** Client secret — or use `certificate`. */
  clientSecret?: string;
  /** Certificate credential (recommended over secrets). */
  certificate?: {
    /** PEM private key matching the uploaded certificate. */
    privateKey: string;
    /** The certificate PEM (its SHA-1 thumbprint is computed) … */
    certificatePem?: string;
    /** … or the SHA-1 thumbprint as hex (as shown in the Entra portal). */
    thumbprint?: string;
  };
  /**
   * API the token is for: `'imap-smtp'` → `https://outlook.office365.com/.default`,
   * `'graph'` → `https://graph.microsoft.com/.default`. @default 'imap-smtp'
   */
  api?: 'imap-smtp' | 'graph';
  /** Sovereign-cloud login host. @default 'login.microsoftonline.com' */
  authority?: string;
  /** Full token endpoint override (tests, proxies). */
  tokenUrl?: string;
  timeoutMs?: number;
}

/**
 * Token provider for Microsoft 365 app-only access (client credentials).
 *
 * Admin setup:
 * - IMAP/SMTP: grant the application permissions `IMAP.AccessAsApp` / `SMTP.SendAsApp`
 *   (Office 365 Exchange Online) + admin consent, then in Exchange Online PowerShell
 *   register the service principal (`New-ServicePrincipal`) and grant it access to each
 *   mailbox (`Add-MailboxPermission`). Use the mailbox address as `user`.
 * - Graph: grant `Mail.ReadWrite` / `Mail.Send` application permissions + admin consent
 *   (optionally scoped with an application access policy).
 *
 * @experimental Not yet verified against a live tenant.
 */
export function microsoftAppOnlyProvider(o: MicrosoftAppOnlyOptions): TokenProvider {
  if (!o.clientSecret && !o.certificate) throw new OAuthError('microsoftAppOnlyProvider needs clientSecret or certificate');
  if (o.tenant === 'common' || o.tenant === 'organizations' || o.tenant === 'consumers') {
    throw new OAuthError('App-only tokens need a specific tenant id or domain, not common/organizations/consumers');
  }
  const authority = o.authority ?? 'login.microsoftonline.com';
  const tokenUrl = o.tokenUrl ?? `https://${authority}/${encodeURIComponent(o.tenant)}/oauth2/v2.0/token`;
  const scope = o.api === 'graph' ? 'https://graph.microsoft.com/.default' : 'https://outlook.office365.com/.default';

  let x5t: string | undefined;
  if (o.certificate) {
    const hex = o.certificate.thumbprint
      ?? (o.certificate.certificatePem ? new X509Certificate(o.certificate.certificatePem).fingerprint : undefined);
    if (!hex) throw new OAuthError('certificate needs certificatePem or thumbprint');
    x5t = Buffer.from(hex.replace(/[^0-9a-f]/gi, ''), 'hex').toString('base64url');
  }

  return cached(async () => {
    const form: Record<string, string> = { grant_type: 'client_credentials', client_id: o.clientId, scope };
    if (o.certificate) {
      const now = Math.floor(Date.now() / 1000);
      form['client_assertion_type'] = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
      form['client_assertion'] = signJwt(
        { alg: 'RS256', typ: 'JWT', x5t },
        { aud: tokenUrl, iss: o.clientId, sub: o.clientId, jti: randomUUID(), nbf: now, iat: now, exp: now + 600 },
        o.certificate.privateKey,
      );
    } else {
      form['client_secret'] = o.clientSecret!;
    }
    const res = await postToken(tokenUrl, form, o.timeoutMs ?? 15_000);
    if (res.access_token) return { token: res.access_token, expiresIn: res.expires_in ?? 3600 };
    throw new OAuthError(
      `Microsoft app-only token failed: ${res.error ?? `HTTP ${res.status}`}${res.error_description ? ` (${res.error_description.split('\r\n')[0]})` : ''}`,
      res.error, res.status >= 500);
  });
}
