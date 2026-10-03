import type { TLSSocketOptions } from 'tls';
import type { DkimConfig } from '../core/Dkim.js';
import type { ProxyConfig } from '../smtp/SmtpProxy.js';
import type { MailAuth, MailAuthType } from './auth.js';

export type { DkimConfig, ProxyConfig };

/** SMTP auth mechanism — alias of `MailAuthType`. */
export type SmtpAuthType = MailAuthType;

/** SMTP credentials — see `MailAuth`. */
export type SmtpAuth = MailAuth;

/** Connection pool settings for `SmtpConfig.pool`. */
export interface SmtpPoolConfig {
  /** Open connections at most. @default 5 */
  maxConnections?: number;
  /** Messages per connection before it is replaced. @default 100 */
  maxMessages?: number;
  /** Close a connection after this many ms unused. @default 60_000 */
  idleTimeout?: number;
}

/** SMTP server settings for `MailTs`, `SmtpClient` and `SmtpPool`. */
export interface SmtpConfig {
  /** Server hostname, e.g. `smtp.gmail.com`. */
  host: string;
  /** Server port. @default 465 when `secure`, otherwise 587 */
  port?: number;
  /** Implicit TLS (port 465). `false`/unset uses plain TCP + STARTTLS (see `requireTLS`). @default false */
  secure?: boolean;
  /** Credentials. Omit for unauthenticated relays (e.g. a local trap). */
  auth?: SmtpAuth;
  /** Name sent in `EHLO`. @default 'mailts.local' */
  clientName?: string;
  /**
   * Milliseconds to wait for the TCP/TLS handshake to complete.
   * @default 10_000
   */
  connectionTimeout?: number;
  /**
   * Milliseconds to wait for a server reply after sending a command.
   * Also used as the socket idle timeout — if the server sends nothing for
   * this long, the connection is considered dead.
   * @default 30_000
   */
  socketTimeout?: number;
  /** TLS options (CA, client certificate, `servername`…). `minVersion` defaults to `'TLSv1.2'`. */
  tls?: TLSSocketOptions;
  /**
   * Refuse to authenticate or send over an unencrypted connection. When the
   * server does not offer STARTTLS on a plain connection, `connect()` fails
   * with `SmtpTlsError` instead of sending credentials in clear text.
   * Defaults to `true` when `auth` is set, except for loopback hosts
   * (`localhost`, `127.0.0.1`, `::1`) such as local test servers and bridges.
   */
  requireTLS?: boolean;
  /**
   * When `true` (default `false`), a send fails if the server rejects any
   * recipient. Otherwise the message is delivered to the accepted recipients
   * and the rejected ones are reported in `SendResult.rejected`.
   */
  allRecipientsRequired?: boolean;
  /**
   * Set to `false` to disable connection pooling — a fresh connection is
   * opened and closed for every send.  The process exits naturally after the
   * last send without needing `shutdown()`.  Useful for scripts and CLIs.
   * @default SmtpPoolConfig (pooling enabled)
   */
  pool?: SmtpPoolConfig | false;
  /**
   * DKIM signing configuration.  When set, every outgoing message is signed with
   * a `DKIM-Signature` header using rsa-sha256 with relaxed/relaxed canonicalization.
   */
  dkim?: DkimConfig;
  /**
   * Route the SMTP connection through an HTTP CONNECT, SOCKS5, or SOCKS4 proxy.
   */
  proxy?: ProxyConfig;
}

/** Extensions the server advertised in its EHLO reply. */
export interface SmtpCapabilities {
  /** STARTTLS (RFC 3207) offered. */
  starttls: boolean;
  /** PIPELINING (RFC 2920) — commands batched. */
  pipelining: boolean;
  /** Maximum message size in bytes (SIZE), or `null` when not announced. */
  size: number | null;
  /** Offered AUTH mechanisms, e.g. `['PLAIN', 'LOGIN', 'XOAUTH2']`. */
  auth: string[];
  /** 8BITMIME (RFC 6152). */
  eightBitMime: boolean;
  /** SMTPUTF8 (RFC 6531) — internationalised addresses. */
  smtpUtf8: boolean;
  /** CHUNKING / BDAT (RFC 3030). */
  chunking: boolean;
}

export interface SmtpSendEnvelope {
  from: string;
  to: string[];
}
