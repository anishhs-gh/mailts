import type { ImapConfig } from '../types/imap.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { TokenProvider } from '../types/auth.js';

/** Endpoints, scopes and mail servers for an OAuth mail provider. */
export interface OAuthProvider {
  /** Provider id: `'google'` or `'microsoft'`. */
  readonly id: string;
  /** Authorization (consent) endpoint. */
  readonly authorizationUrl: string;
  /** Token endpoint. */
  readonly tokenUrl: string;
  /** Scopes that grant IMAP + SMTP access (and a refresh token). */
  readonly scopes: readonly string[];
  /** Extra authorization parameters (e.g. Google's `access_type=offline`). */
  readonly authParams: Readonly<Record<string, string>>;
  /** Host used in loopback redirect URIs (`127.0.0.1` or `localhost`). */
  readonly loopbackHost: string;
  /**
   * Path of the loopback redirect URI. Microsoft matches the registered path
   * (only the port may vary), so it uses `/` to match `http://localhost`.
   */
  readonly loopbackPath: string;
  /** IMAP server for this provider (used by `mailConfigFor()`). */
  readonly imap: Pick<ImapConfig, 'host' | 'port' | 'secure'>;
  /** SMTP server for this provider (used by `mailConfigFor()`). */
  readonly smtp: Pick<SmtpConfig, 'host' | 'port' | 'secure'>;
}

/**
 * Scope sets per API. A Microsoft token is issued for one resource, so IMAP/SMTP
 * (outlook.office.com) and Graph (graph.microsoft.com) need separate tokens.
 */
export const SCOPES = {
  google: {
    /** IMAP + SMTP + Gmail API (restricted scope — verification + annual assessment for public apps). */
    full: ['https://mail.google.com/'],
    /** Gmail API send only (sensitive, not restricted). */
    send: ['https://www.googleapis.com/auth/gmail.send'],
    /** Gmail API read/modify/send without permanent delete (restricted). */
    modify: ['https://www.googleapis.com/auth/gmail.modify'],
  },
  microsoft: {
    /** IMAP + SMTP AUTH (XOAUTH2). */
    imapSmtp: ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'],
    /** Microsoft Graph mail. */
    graph: ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'],
    /** Microsoft Graph send only. */
    graphSend: ['https://graph.microsoft.com/Mail.Send'],
  },
} as const;

const OIDC = ['openid', 'email'];

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
  scopes: [...SCOPES.google.full, ...OIDC],
  // offline + consent guarantees a refresh token on every authorization
  authParams: { access_type: 'offline', prompt: 'consent' },
  loopbackHost: '127.0.0.1',
  loopbackPath: '/callback',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
};

/**
 * Google with a custom scope set, e.g. `googleWith(SCOPES.google.send)` for a
 * Gmail-API-only sender (no IMAP/SMTP access requested).
 */
export function googleWith(scopes: readonly string[]): OAuthProvider {
  return { ...google, id: 'google', scopes: [...scopes, ...OIDC] };
}

/** Options for `microsoft()`. */
export interface MicrosoftOptions {
  /**
   * `common` (work + personal accounts, default), `organizations`,
   * `consumers` (Outlook.com / Hotmail only), or a tenant id / domain.
   */
  tenant?: string;
  /** Sovereign-cloud login host. @default 'login.microsoftonline.com' */
  authority?: string;
  /**
   * API to request access for. `'imap-smtp'` (default) for XOAUTH2;
   * `'graph'` for `GraphTransport` / Graph mailboxes. One token serves one API.
   */
  api?: 'imap-smtp' | 'graph' | 'graph-send';
}

/**
 * Microsoft 365 / Exchange Online and Outlook.com.
 *
 * Register an app at https://entra.microsoft.com → App registrations. Add the
 * delegated permissions `IMAP.AccessAsUser.All` and `SMTP.Send` (Office 365
 * Exchange Online), `offline_access`, and a redirect URI: "Mobile and desktop"
 * `http://localhost` for CLIs (any port is accepted; the loopback flow uses path `/`),
 * or your web callback.
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
      ...(opts.api === 'graph' ? SCOPES.microsoft.graph : opts.api === 'graph-send' ? SCOPES.microsoft.graphSend : SCOPES.microsoft.imapSmtp),
      'offline_access',
      ...OIDC,
    ],
    authParams: { prompt: 'select_account' },
    loopbackHost: 'localhost',
    loopbackPath: '/',
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
