import * as http from 'http';
import { spawn } from 'child_process';
import type { AddressInfo } from 'net';
import { OAuthError } from '../errors.js';
import { buildAuthorizationUrl, createPkce, createState, exchangeCode, type TokenSet } from './OAuthClient.js';
import type { OAuthProvider } from './providers.js';

/** Options for `authorizeWithLoopback()` (browser sign-in for CLIs and desktop apps). */
export interface LoopbackOptions {
  /** `google()` or `microsoft()`. */
  provider: OAuthProvider;
  /** OAuth client id (Google: "Desktop app" client; Microsoft: public client with `http://localhost` redirect). */
  clientId: string;
  /** Required by Google even for desktop clients; omit for Microsoft public clients. */
  clientSecret?: string;
  /** @default provider.scopes */
  scopes?: readonly string[];
  /** Pre-fill the account picker with this address. */
  loginHint?: string;
  /** Fixed port (0 = random, the default). */
  port?: number;
  /** Give up after this long. @default 300_000 (5 min) */
  timeoutMs?: number;
  /**
   * Receives the authorization URL. Default: open the system browser.
   * Show the URL to the user as a fallback (on stderr — never stdout in stdio MCP servers).
   */
  onAuthUrl?: (url: string) => void | Promise<void>;
  /** Page shown in the browser after success. */
  successHtml?: string;
  /** Abort the flow. */
  signal?: AbortSignal;
}

const DEFAULT_SUCCESS = '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center">' +
  '<h1>Signed in</h1><p>You can close this window and return to the terminal.</p></body>';

/**
 * Run the OAuth authorization-code + PKCE flow for a CLI: start a one-shot
 * server on `127.0.0.1`, open the browser, wait for the redirect, exchange
 * the code. Returns the tokens — store `refreshToken` securely (OS keychain).
 *
 * @example
 * ```ts
 * const tokens = await authorizeWithLoopback({
 *   provider: google, clientId, clientSecret,
 *   onAuthUrl: (url) => console.error(`Open: ${url}`),
 * });
 * ```
 */
export async function authorizeWithLoopback(o: LoopbackOptions): Promise<TokenSet> {
  const pkce = createPkce();
  const state = createState();
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const callbackPath = o.provider.loopbackPath ?? '/callback';
  const redirectUri = `http://${o.provider.loopbackHost}:${port}${callbackPath === '/' ? '' : callbackPath}`;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new OAuthError('Timed out waiting for the browser sign-in', 'timeout')),
        o.timeoutMs ?? 300_000,
      );
      const onAbort = () => reject(new OAuthError('Sign-in aborted', 'aborted'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== callbackPath || (!url.searchParams.has('code') && !url.searchParams.has('error'))) {
          res.writeHead(404).end();
          return;
        }
        const p = url.searchParams;
        if (p.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid state');
          return; // ignore forged/stale callbacks; keep waiting
        }
        const err = p.get('error');
        const c = p.get('code');
        if (err || !c) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Sign-in failed: ${err ?? 'no code'}`);
          done();
          reject(new OAuthError(`Authorization failed: ${err ?? 'no code'}${p.get('error_description') ? ` — ${p.get('error_description')}` : ''}`, err ?? undefined));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(o.successHtml ?? DEFAULT_SUCCESS);
        done();
        resolve(c);
      });

      const authUrl = buildAuthorizationUrl({
        provider: o.provider,
        clientId: o.clientId,
        redirectUri,
        codeChallenge: pkce.challenge,
        state,
        scopes: o.scopes,
        loginHint: o.loginHint,
      });
      Promise.resolve((o.onAuthUrl ?? openBrowser)(authUrl)).catch(() => { /* user can open it manually */ });
    });

    return await exchangeCode({
      provider: o.provider,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      code,
      redirectUri,
      codeVerifier: pkce.verifier,
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** Open `url` in the default browser (macOS, Windows, Linux). Never writes to stdout. */
export function openBrowser(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
