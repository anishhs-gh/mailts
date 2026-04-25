import type { TLSSocketOptions } from 'tls';
import type { DkimConfig } from '../core/Dkim.js';
import type { ProxyConfig } from '../smtp/SmtpProxy.js';

export type { DkimConfig, ProxyConfig };

export type SmtpAuthType = 'plain' | 'login' | 'xoauth2';

export interface SmtpAuth {
  readonly type: SmtpAuthType;
  readonly user: string;
  readonly pass?: string;
  readonly token?: string;
}

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
