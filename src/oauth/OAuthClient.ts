import { createHash, randomBytes } from 'crypto';
import { httpRequest } from '../transports/HttpClient.js';
import { OAuthError } from '../errors.js';
import type { TokenProvider } from '../types/auth.js';
import { google, microsoft, type OAuthProvider } from './providers.js';

/** Result of a code exchange or refresh. */
export interface TokenSet {
  accessToken: string;
  /** Present after authorization; after a refresh only when the provider rotated it. */
  refreshToken?: string;
  /** Absolute expiry of `accessToken`. */
  expiresAt: Date;
  scope?: string;
  idToken?: string;
  /**
   * Mailbox address from the ID token (`email` / `preferred_username` claim).
   * Decoded **without signature verification** — use it to pre-fill the login,
   * never for authorization decisions.
   */
  email?: string;
}

export interface ClientCredentials {
  provider: OAuthProvider;
  clientId: string;
  /** Required by Google for all clients; omit for Microsoft public (desktop) clients. */
  clientSecret?: string;
  /** Token request timeout in ms. @default 15_000 */
  timeoutMs?: number;
}

// ── PKCE ────────────────────────────────────────────────────────────────────

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 PKCE pair (S256). */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/** Unguessable `state` value for CSRF protection. */
export function createState(): string {
  return randomBytes(16).toString('base64url');
}

// ── Authorization URL ───────────────────────────────────────────────────────

export interface AuthorizationUrlOptions {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  /** From `createPkce().challenge`. */
  codeChallenge: string;
  /** From `createState()`; verify it on the callback. */
  state: string;
  /** @default provider.scopes */
  scopes?: readonly string[];
  /** Pre-fill the account picker. */
  loginHint?: string;
  extraParams?: Record<string, string>;
}

/** Build the URL to send the user to for consent (authorization code + PKCE). */
export function buildAuthorizationUrl(o: AuthorizationUrlOptions): string {
  const url = new URL(o.provider.authorizationUrl);
  const params: Record<string, string> = {
    ...o.provider.authParams,
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: (o.scopes ?? o.provider.scopes).join(' '),
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: 'S256',
    ...(o.loginHint ? { login_hint: o.loginHint } : {}),
    ...o.extraParams,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ── Token endpoint ──────────────────────────────────────────────────────────

export interface ExchangeCodeOptions extends ClientCredentials {
  code: string;
  redirectUri: string;
  /** From `createPkce().verifier`. */
  codeVerifier: string;
}

/** Exchange an authorization code for tokens. */
export function exchangeCode(o: ExchangeCodeOptions): Promise<TokenSet> {
  return tokenRequest(o, {
    grant_type: 'authorization_code',
    code: o.code,
    redirect_uri: o.redirectUri,
    code_verifier: o.codeVerifier,
  });
}

export interface RefreshOptions extends ClientCredentials {
  refreshToken: string;
  /** Microsoft requires the scopes on refresh; defaults to `provider.scopes`. */
  scopes?: readonly string[];
}

/**
 * Get a fresh access token. Microsoft may return a new (rotated) refresh
 * token — persist `refreshToken` whenever it is present.
 * Throws `OAuthError` with `oauthCode: 'invalid_grant'` when the user must
 * sign in again (revoked, expired or password changed).
 */
export function refreshAccessToken(o: RefreshOptions): Promise<TokenSet> {
  return tokenRequest(o, {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    ...(o.provider.id === 'microsoft' ? { scope: (o.scopes ?? o.provider.scopes).join(' ') } : {}),
  });
}

async function tokenRequest(c: ClientCredentials, form: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({
    ...form,
    client_id: c.clientId,
    ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
  }).toString();

  let res;
  try {
    res = await httpRequest({
      method: 'POST',
      url: c.provider.tokenUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(c.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new OAuthError(`OAuth token request failed: ${(err as Error).message}`, undefined, true);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new OAuthError(`OAuth token endpoint returned HTTP ${res.status} (not JSON)`, undefined, res.status >= 500);
  }

  if (res.status >= 400 || typeof json['access_token'] !== 'string') {
    const code = typeof json['error'] === 'string' ? json['error'] : undefined;
    const desc = typeof json['error_description'] === 'string' ? `: ${json['error_description']}` : '';
    throw new OAuthError(`OAuth error ${code ?? `HTTP ${res.status}`}${desc}`, code, res.status >= 500 || code === 'temporarily_unavailable');
  }

  const expiresIn = Number(json['expires_in'] ?? 3600);
  const idToken = typeof json['id_token'] === 'string' ? json['id_token'] : undefined;
  return {
    accessToken: json['access_token'] as string,
    refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
    expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000),
    scope: typeof json['scope'] === 'string' ? json['scope'] : undefined,
    idToken,
    email: idToken ? emailFromIdToken(idToken) : undefined,
  };
}

/** Read the email claim from a JWT without verifying it (display / pre-fill only). */
export function emailFromIdToken(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const v = payload['email'] ?? payload['preferred_username'] ?? payload['upn'];
    return typeof v === 'string' && v.includes('@') ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── Token provider ──────────────────────────────────────────────────────────

export interface TokenProviderOptions extends ClientCredentials {
  refreshToken: string;
  scopes?: readonly string[];
  /** Seed with a known access token to skip the first refresh. */
  accessToken?: string;
  expiresAt?: Date;
  /**
   * Called when the provider issues a new refresh token (Microsoft rotates
   * them). Persist it — the old one may stop working.
   */
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  /** Called after every successful refresh. */
  onTokens?: (tokens: TokenSet) => void | Promise<void>;
  /** Refresh this many ms before expiry. @default 60_000 */
  skewMs?: number;
}

/**
 * Create a `getToken` function for `auth: { type: 'xoauth2', user, getToken }`.
 * Caches the access token until shortly before expiry, refreshes once per
 * burst (concurrent callers share one request), and forces a refresh when the
 * mail server rejects a token.
 */
export function createTokenProvider(o: TokenProviderOptions): TokenProvider {
  let refreshToken = o.refreshToken;
  let accessToken = o.accessToken;
  let expiresAt = o.expiresAt?.getTime() ?? 0;
  let inflight: Promise<string> | null = null;
  const skew = o.skewMs ?? 60_000;

  const refresh = async (): Promise<string> => {
    const tokens = await refreshAccessToken({ ...o, refreshToken });
    accessToken = tokens.accessToken;
    expiresAt = tokens.expiresAt.getTime();
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      refreshToken = tokens.refreshToken;
      await o.onRefreshToken?.(refreshToken);
    }
    await o.onTokens?.(tokens);
    return accessToken;
  };

  return ({ invalid }) => {
    if (!invalid && accessToken && Date.now() < expiresAt - skew) return accessToken;
    if (invalid) accessToken = undefined;
    inflight ??= refresh().finally(() => { inflight = null; });
    return inflight;
  };
}

/** `createTokenProvider` for Google. */
export function googleTokenProvider(o: Omit<TokenProviderOptions, 'provider'> & { provider?: OAuthProvider }): TokenProvider {
  return createTokenProvider({ ...o, provider: o.provider ?? google });
}

/** `createTokenProvider` for Microsoft (`tenant` defaults to `common`). */
export function microsoftTokenProvider(
  o: Omit<TokenProviderOptions, 'provider'> & { provider?: OAuthProvider; tenant?: string },
): TokenProvider {
  return createTokenProvider({ ...o, provider: o.provider ?? microsoft({ tenant: o.tenant }) });
}
