import type { ImapConfig } from '../types/imap.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { TokenProvider } from '../types/auth.js';

/** Endpoints, scopes and mail servers for an OAuth mail provider. */
export interface OAuthProvider {
  readonly id: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /** Scopes that grant IMAP + SMTP access (and a refresh token). */
  readonly scopes: readonly string[];
  /** Extra authorization parameters (e.g. Google's `access_type=offline`). */
  readonly authParams: Readonly<Record<string, string>>;
  /** Host used in loopback redirect URIs (`127.0.0.1` or `localhost`). */
  readonly loopbackHost: string;
  readonly imap: Pick<ImapConfig, 'host' | 'port' | 'secure'>;
  readonly smtp: Pick<SmtpConfig, 'host' | 'port' | 'secure'>;
}

/**
 * Google (Gmail and Google Workspace).
 *
 * Create an OAuth client at https://console.cloud.google.com/apis/credentials —
 * "Desktop app" for CLIs (loopback redirect), "Web application" for servers.
 * The `https://mail.google.com/` scope is *restricted*: public apps need Google
 * verification (and an annual security assessment); testing-mode clients work
 * for up to 100 listed test users.
 */
export const google: OAuthProvider = {
  id: 'google',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://mail.google.com/', 'openid', 'email'],
  // offline + consent guarantees a refresh token on every authorization
  authParams: { access_type: 'offline', prompt: 'consent' },
  loopbackHost: '127.0.0.1',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
};

export interface MicrosoftOptions {
  /**
   * `common` (work + personal accounts, default), `organizations`,
   * `consumers` (Outlook.com / Hotmail only), or a tenant id / domain.
   */
  tenant?: string;
  /** Sovereign-cloud login host. @default 'login.microsoftonline.com' */
  authority?: string;
}

/**
 * Microsoft 365 / Exchange Online and Outlook.com.
 *
 * Register an app at https://entra.microsoft.com → App registrations. Add the
 * delegated permissions `IMAP.AccessAsUser.All` and `SMTP.Send` (Office 365
 * Exchange Online), `offline_access`, and a redirect URI: "Mobile and desktop"
 * `http://localhost` for CLIs (any port is accepted), or your web callback.
 * Tenants must allow SMTP AUTH for the mailbox for sending.
 */
export function microsoft(opts: MicrosoftOptions = {}): OAuthProvider {
  const tenant = encodeURIComponent(opts.tenant ?? 'common');
  const authority = opts.authority ?? 'login.microsoftonline.com';
  return {
    id: 'microsoft',
    authorizationUrl: `https://${authority}/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://${authority}/${tenant}/oauth2/v2.0/token`,
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
      'openid',
      'email',
    ],
    authParams: { prompt: 'select_account' },
    loopbackHost: 'localhost',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  };
}

/**
 * Build ready-to-use IMAP and SMTP configs for an OAuth provider.
 *
 * @example
 * ```ts
 * const getToken = googleTokenProvider({ clientId, clientSecret, refreshToken });
 * const mail = new MailTs(mailConfigFor(google, { user: 'me@gmail.com', getToken }));
 * ```
 */
export function mailConfigFor(
  provider: OAuthProvider,
  auth: { user: string; getToken: TokenProvider },
): { imap: ImapConfig; smtp: SmtpConfig } {
  const a = { type: 'xoauth2' as const, user: auth.user, getToken: auth.getToken };
  return {
    imap: { ...provider.imap, auth: a },
    smtp: { ...provider.smtp, auth: a },
  };
}
