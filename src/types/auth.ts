/** Context passed to a token provider on every (re)authentication. */
export interface TokenContext {
  /** Which protocol is authenticating. */
  protocol: 'smtp' | 'imap';
  /** The login (mailbox address). */
  user: string;
  /**
   * `true` when the previously returned token was rejected by the server —
   * the provider must refresh instead of returning a cached token.
   */
  invalid: boolean;
}

/**
 * Supplies an OAuth 2.0 access token. Called on every connect and once more
 * (with `invalid: true`) after the server rejects a token.
 * See `@mailts/core/oauth` for ready-made Google and Microsoft providers.
 */
export type TokenProvider = (ctx: TokenContext) => Promise<string> | string;

export type MailAuthType = 'plain' | 'login' | 'xoauth2';

/**
 * Credentials for SMTP or IMAP.
 * - `plain` / `login`: `user` + `pass`
 * - `xoauth2`: `user` + either a static `token` or a `getToken` provider (preferred —
 *   access tokens expire after ~1h and are refreshed transparently).
 */
export interface MailAuth {
  readonly type: MailAuthType;
  readonly user: string;
  readonly pass?: string;
  /** Static OAuth access token (no refresh). */
  readonly token?: string;
  /** OAuth access-token provider — called on each (re)connect. */
  readonly getToken?: TokenProvider;
}
