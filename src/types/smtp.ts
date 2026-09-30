import type { TLSSocketOptions } from 'tls';
import type { DkimConfig } from '../core/Dkim.js';
import type { ProxyConfig } from '../smtp/SmtpProxy.js';
import type { MailAuth, MailAuthType } from './auth.js';

export type { DkimConfig, ProxyConfig };

export type SmtpAuthType = MailAuthType;

/** SMTP credentials — see `MailAuth`. */
export type SmtpAuth = MailAuth;

export interface SmtpPoolConfig {
  maxConnections?: number;
  maxMessages?: number;
  idleTimeout?: number;
}

export interface SmtpConfig {
  host: string;
  port?: number;
  secure?: boolean;
  auth?: SmtpAuth;
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

export interface SmtpCapabilities {
  starttls: boolean;
  pipelining: boolean;
  size: number | null;
  auth: string[];
  eightBitMime: boolean;
  smtpUtf8: boolean;
  chunking: boolean;
}

export interface SmtpSendEnvelope {
  from: string;
  to: string[];
}
