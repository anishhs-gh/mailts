import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { SmtpStream } from './SmtpStream.js';
import { SmtpReply } from './SmtpReply.js';
import { Cmd, parseCapabilities, dotStuff } from './SmtpCommand.js';
import { Credential, parseXOAuth2Error } from '../core/Credential.js';
import { resolveRequireTLS } from '../core/net.js';
import { Redactor } from '../logger/Redactor.js';
import { connectThroughProxy } from './SmtpProxy.js';
import type { Logger } from '../logger/Logger.js';
import type { SmtpConfig, SmtpCapabilities } from '../types/smtp.js';
import {
  SmtpConnError,
  SmtpAuthError,
  SmtpError,
  SmtpRejectError,
  SmtpTimeoutError,
  SmtpTlsError,
} from '../errors.js';

type SmtpState =
  | 'idle'
  | 'connecting'
  | 'greeting'
  | 'ehlo'
  | 'starttls'
  | 'ehlo_tls'
  | 'auth'
  | 'ready'
  | 'sending'
  | 'quit'
  | 'closed'
  | 'error';

interface PendingReply {
  resolve: (r: SmtpReply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Result of a single SMTP transaction. */
export interface SmtpSendResult {
  /** Queue id from the final 250 reply, when the server reports one. */
  serverId: string;
  accepted: string[];
  rejected: string[];
  /** Per-recipient rejection replies, e.g. `550 5.1.1 No such user`. */
  rejectedErrors: SmtpError[];
}

export interface SmtpSendOptions {
  /** Declare 8BITMIME body (`BODY=8BITMIME`). */
  eightBit?: boolean;
  /** Request SMTPUTF8 (internationalised addresses). */
  smtpUtf8?: boolean;
  /** Fail when any recipient is rejected (default: deliver to the accepted ones). */
  allRecipientsRequired?: boolean;
}

export interface SmtpClientEvents {
  ready: () => void;
  close: () => void;
  error: (err: Error) => void;
}

/**
 * Low-level SMTP client with TLS, STARTTLS, AUTH (PLAIN/LOGIN/XOAUTH2),
 * PIPELINING, and SIZE extension support.
 *
 * Lifecycle: `new SmtpClient(config)` → `connect()` → `sendMessage()` (N×) → `quit()`.
 * For pooled usage prefer `SmtpPool`.
 */
export class SmtpClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private stream: SmtpStream | null = null;
  private state: SmtpState = 'idle';
  private capabilities: SmtpCapabilities | null = null;
  private replyQueue: PendingReply[] = [];
  private redactor: Redactor;
  private messagesSent = 0;

  readonly config: SmtpConfig;
  private readonly logger: Logger | null;

  constructor(config: SmtpConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger ?? null;
    this.redactor = new Redactor();
  }

  /** `true` when the client has completed the handshake and is ready to send. */
  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** Number of messages successfully transmitted on this connection. */
  get messageCount(): number {
    return this.messagesSent;
  }

  /**
   * Open the TCP/TLS connection, complete the SMTP greeting + EHLO,
   * upgrade to TLS via STARTTLS if available, and authenticate.
   * @throws {SmtpConnError} on connection failure
   * @throws {SmtpAuthError} on authentication failure
   * @throws {SmtpTlsError} on TLS handshake failure
   */
  async connect(): Promise<void> {
    if (this.state !== 'idle') throw new SmtpConnError('Client already connected');
    this.state = 'connecting';
    this.redactor.reset();

    const { host, port, secure, tls: tlsOpts, connectionTimeout = 10_000 } = this.config;
    const resolvedPort = port ?? (secure ? 465 : 587);

    let socket: net.Socket | tls.TLSSocket;

    if (this.config.proxy) {
      // Connect through proxy first, then optionally upgrade to TLS
      const tunneled = await connectThroughProxy(
        this.config.proxy, host, resolvedPort, connectionTimeout,
      ).catch(e => { throw new SmtpConnError(`Proxy error: ${(e as Error).message}`); });

      if (secure) {
        const tlsSocket = tls.connect({ socket: tunneled, servername: host, ...tlsOpts });
        await new Promise<void>((resolve, reject) => {
          tlsSocket.once('secureConnect', resolve);
          tlsSocket.once('error', (e) => reject(new SmtpTlsError(`TLS over proxy failed: ${e.message}`)));
        });
        socket = tlsSocket;
      } else {
        socket = tunneled;
      }
    } else if (secure) {
      const tlsSocket = tls.connect(resolvedPort, host, { ...tlsOpts, servername: host });
      await new Promise<void>((resolve, reject) => {
        const connTimer = setTimeout(() => { tlsSocket.destroy(); reject(new SmtpTimeoutError('connecting')); }, connectionTimeout);
        tlsSocket.once('secureConnect', () => { clearTimeout(connTimer); resolve(); });
        tlsSocket.once('error', (e) => { clearTimeout(connTimer); reject(new SmtpConnError(`Connection failed: ${e.message}`)); });
      });
      socket = tlsSocket;
    } else {
      const tcpSocket = net.createConnection(resolvedPort, host);
      await new Promise<void>((resolve, reject) => {
        const connTimer = setTimeout(() => { tcpSocket.destroy(); reject(new SmtpTimeoutError('connecting')); }, connectionTimeout);
        tcpSocket.once('connect', () => { clearTimeout(connTimer); resolve(); });
        tcpSocket.once('error', (e) => { clearTimeout(connTimer); reject(new SmtpConnError(`Connection failed: ${e.message}`)); });
      });
      socket = tcpSocket;
    }

    socket.setTimeout(this.config.socketTimeout ?? 30_000);
    this.attachSocket(socket);

    // Read greeting
    this.state = 'greeting';
    const greeting = await this.readReply('greeting');
    if (greeting.code !== 220) {
      throw SmtpError.fromReply(greeting.code, [...greeting.lines]);
    }
    this.logger?.proto('S', 'smtp', greeting.firstLine);

    // EHLO
    await this.doEhlo();

    // STARTTLS if not already TLS and server supports it
    if (!secure && this.capabilities?.starttls) {
      await this.doStartTls();
    } else if (!secure && this.config.auth && resolveRequireTLS(this.config.requireTLS, host)) {
      this.socket?.destroy();
      throw new SmtpTlsError(
        'SMTP server does not offer STARTTLS; refusing to authenticate over an unencrypted connection ' +
        '(set requireTLS: false to allow)',
      );
    } else if (!secure && this.config.requireTLS === true) {
      this.socket?.destroy();
      throw new SmtpTlsError('SMTP server does not offer STARTTLS and requireTLS is set');
    }

    // AUTH
    if (this.config.auth) {
      await this.doAuth(Credential.from(this.config.auth));
    }

    this.state = 'ready';
    this.emit('ready');
  }

  private attachSocket(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    this.stream = new SmtpStream();
    socket.pipe(this.stream);

    this.stream.on('data', (reply: SmtpReply) => this.onReply(reply));

    socket.on('timeout', () => {
      this.failPending(new SmtpTimeoutError(this.state));
      socket.destroy();
    });

    socket.on('error', (err) => {
      const wrapped = new SmtpConnError(`Socket error: ${err.message}`);
      this.failPending(wrapped);
      this.state = 'error';
      this.emit('error', wrapped);
    });

    socket.on('close', () => {
      this.state = 'closed';
      this.failPending(new SmtpConnError('Connection closed unexpectedly'));
      this.emit('close');
    });
  }

  private onReply(reply: SmtpReply): void {
    for (const line of reply.lines) {
      const safe = this.redactor.redact(line, 'S');
      this.logger?.proto('S', 'smtp', safe);
    }

    const pending = this.replyQueue.shift();
    if (!pending) return;

    clearTimeout(pending.timer);

    if (reply.code >= 400) {
      pending.reject(SmtpError.fromReply(reply.code, [...reply.lines]));
    } else {
      pending.resolve(reply);
    }
  }

  private readReply(phase: string): Promise<SmtpReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.replyQueue.findIndex(p => p.resolve === resolve);
        if (idx !== -1) this.replyQueue.splice(idx, 1);
        reject(new SmtpTimeoutError(phase));
      }, this.config.socketTimeout ?? 30_000);

      this.replyQueue.push({ resolve, reject, timer });
    });
  }

  private async command(cmd: string, phase = 'command'): Promise<SmtpReply> {
    if (!this.socket) throw new SmtpConnError('Not connected');
    const logLine = this.redactor.redact(cmd, 'C');
    this.logger?.proto('C', 'smtp', logLine);
    const replyPromise = this.readReply(phase);
    this.socket.write(cmd + '\r\n');
    return replyPromise;
  }

  private failPending(err: Error): void {
    const queue = this.replyQueue.splice(0);
    for (const pending of queue) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private async doEhlo(): Promise<void> {
    this.state = 'ehlo';
    const clientName = this.config.clientName ?? 'mailts.local';
    const reply = await this.command(Cmd.ehlo(clientName), 'ehlo');
    this.capabilities = parseCapabilities(reply.lines);
    this.logger?.debug('smtp', `Capabilities: ${JSON.stringify(this.capabilities)}`);
  }

  private async doStartTls(): Promise<void> {
    this.state = 'starttls';
    const reply = await this.command(Cmd.starttls(), 'starttls');
    if (reply.code !== 220) {
      throw new SmtpTlsError(`STARTTLS rejected: ${reply.text}`);
    }

    const rawSocket = this.socket as net.Socket;
    // Unpipe stream from old socket
    rawSocket.unpipe(this.stream!);

    const tlsSocket = tls.connect({
      socket: rawSocket,
      servername: this.config.host,
      ...this.config.tls,
    });

    await new Promise<void>((resolve, reject) => {
      tlsSocket.once('secureConnect', resolve);
      tlsSocket.once('error', (e) => reject(new SmtpTlsError(`TLS upgrade failed: ${e.message}`)));
    });

    const protocol = (tlsSocket as unknown as { getProtocol?: () => string }).getProtocol?.() ?? 'unknown';
    const cipher = tlsSocket.getCipher();
    this.logger?.proto('C', 'smtp', `[TLS] upgraded (${protocol}, ${cipher?.name ?? 'unknown'})`);

    this.attachSocket(tlsSocket);

    // Re-EHLO after TLS
    this.state = 'ehlo_tls';
    await this.doEhlo();
  }

  private async doAuth(cred: Credential): Promise<void> {
    this.state = 'auth';
    const caps = this.capabilities;
    if (!caps) throw new SmtpConnError('No capabilities — EHLO not done');

    if (cred.type === 'xoauth2') {
      if (!caps.auth.includes('XOAUTH2')) {
        throw new SmtpAuthError('Server does not support XOAUTH2', 535, []);
      }
      await this.authXOAuth2(cred, false);
      return;
    }

    if (cred.type === 'plain' && caps.auth.includes('PLAIN')) {
      const payload = cred.buildPlainPayload();
      const reply = await this.command(Cmd.authPlain(payload), 'auth');
      if (reply.code !== 235) throw SmtpError.fromReply(reply.code, [...reply.lines]);
      return;
    }

    if (caps.auth.includes('LOGIN')) {
      await this.command(Cmd.authLogin(), 'auth');
      await this.command(cred.buildLoginUser(), 'auth_user');
      const reply = await this.command(cred.buildLoginPass(), 'auth_pass');
      if (reply.code !== 235) throw SmtpError.fromReply(reply.code, [...reply.lines]);
      return;
    }

    if (caps.auth.includes('PLAIN')) {
      const reply = await this.command(Cmd.authPlain(cred.buildPlainPayload()), 'auth');
      if (reply.code !== 235) throw SmtpError.fromReply(reply.code, [...reply.lines]);
      return;
    }

    throw new SmtpAuthError(`No supported auth method available. Server offers: ${caps.auth.join(', ') || 'none'}`, 535, []);
  }

  /**
   * AUTH XOAUTH2. On failure the server sends a `334 <base64 JSON>` challenge
   * and waits for an empty line before the final 5xx — answering it keeps the
   * connection usable. A rejected token is refreshed once via `getToken`.
   */
  private async authXOAuth2(cred: Credential, invalid: boolean): Promise<void> {
    const token = await cred.resolveToken({ protocol: 'smtp', invalid });
    let reply: SmtpReply;
    try {
      reply = await this.command(Cmd.authXOAuth2(cred.buildXOAuth2Payload(token)), 'auth');
    } catch (e) {
      // Some servers (e.g. Microsoft 365) reject with 535 directly, without a challenge
      if (e instanceof SmtpAuthError && !invalid && cred.canRefresh) return this.authXOAuth2(cred, true);
      throw e;
    }
    if (reply.code === 235) return;

    let detail = '';
    if (reply.code === 334) {
      const err = parseXOAuth2Error(reply.text);
      detail = err.status ? ` (status ${err.status})` : '';
      try {
        reply = await this.command('', 'auth');
      } catch (e) {
        if (!(e instanceof SmtpError)) throw e;
        if (!invalid && cred.canRefresh) {
          this.logger?.debug('smtp', 'XOAUTH2 token rejected — refreshing and retrying once');
          return this.authXOAuth2(cred, true);
        }
        throw new SmtpAuthError(`SMTP XOAUTH2 authentication failed${detail}: ${e.message}`, e.replyCode || 535, [...e.replyLines]);
      }
    }
    throw SmtpError.fromReply(reply.code, [...reply.lines]);
  }

  /**
   * Send a single message. Returns the server queue id from the 250 reply.
   * @deprecated Prefer `send()` which also reports accepted/rejected recipients.
   */
  async sendMessage(from: string, to: string[], raw: Buffer, opts: SmtpSendOptions = {}): Promise<string> {
    return (await this.send(from, to, raw, opts)).serverId;
  }

  /**
   * Run one SMTP transaction (MAIL FROM / RCPT TO / DATA).
   * Recipients rejected with 5xx/4xx are reported in `rejected`; the message is
   * still delivered to the accepted ones unless `allRecipientsRequired`.
   * Throws when no recipient is accepted or the message itself is refused.
   */
  async send(from: string, to: string[], raw: Buffer, opts: SmtpSendOptions = {}): Promise<SmtpSendResult> {
    if (this.state !== 'ready') throw new SmtpConnError('Client not in READY state');
    if (to.length === 0) throw new SmtpRejectError('No recipients', 554, []);
    // Validate the whole envelope before writing anything to the socket
    const rcptLines = to.map(Cmd.rcptTo);
    Cmd.mailFrom(from);
    this.state = 'sending';

    const caps = this.capabilities;
    if (caps?.size && raw.length > caps.size) {
      this.state = 'ready';
      throw new SmtpRejectError(`Message size ${raw.length} exceeds server limit ${caps.size}`, 552, []);
    }
    if (opts.smtpUtf8 && !caps?.smtpUtf8) {
      this.state = 'ready';
      throw new SmtpRejectError('Server does not support SMTPUTF8 (required for internationalised addresses)', 553, []);
    }

    const params: string[] = [];
    if (caps?.size) params.push(`SIZE=${raw.length}`);
    if (opts.eightBit && caps?.eightBitMime) params.push('BODY=8BITMIME');
    if (opts.smtpUtf8) params.push('SMTPUTF8');

    try {
      await this.command(Cmd.mailFrom(from, params), 'mail_from');

      const accepted: string[] = [];
      const rejected: string[] = [];
      const rejectedErrors: SmtpError[] = [];
      const results = caps?.pipelining
        ? await this.pipelineRcpts(rcptLines)
        : await this.serialRcpts(rcptLines);
      results.forEach((r, i) => {
        if (r instanceof Error) { rejected.push(to[i]!); rejectedErrors.push(r); }
        else accepted.push(to[i]!);
      });

      if (accepted.length === 0 || (opts.allRecipientsRequired && rejected.length)) {
        throw rejectedErrors[0] ?? new SmtpRejectError('All recipients rejected', 554, []);
      }

      await this.command(Cmd.data(), 'data');

      const stuffed = dotStuff(raw);
      this.logger?.proto('C', 'smtp', `[DATA] ${stuffed.length} bytes`);
      const dataReply = await new Promise<SmtpReply>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new SmtpTimeoutError('data_body')),
          Math.max(this.config.socketTimeout ?? 30_000, 60_000),
        );
        this.replyQueue.push({ resolve, reject, timer });
        this.socket!.write(stuffed);
      });

      if (dataReply.code !== 250) {
        throw SmtpError.fromReply(dataReply.code, [...dataReply.lines]);
      }

      this.messagesSent++;
      this.state = 'ready';
      const idMatch = dataReply.text.match(/<([^>]+)>/) ?? dataReply.text.match(/(?:queued as|id=)\s*(\S+)/i);
      return { serverId: idMatch?.[1] ?? '', accepted, rejected, rejectedErrors };
    } catch (err) {
      this.state = 'error';
      // Attempt RSET to recover the connection for the next message
      if (this.socket && !this.socket.destroyed) {
        try {
          await this.command(Cmd.rset(), 'rset');
          this.state = 'ready';
        } catch {
          this.socket?.destroy();
        }
      }
      throw err;
    }
  }

  private async serialRcpts(lines: string[]): Promise<Array<SmtpReply | SmtpError>> {
    const out: Array<SmtpReply | SmtpError> = [];
    for (const line of lines) {
      try {
        out.push(await this.command(line, 'rcpt_to'));
      } catch (e) {
        if (!(e instanceof SmtpError) || e instanceof SmtpConnError) throw e;
        out.push(e);
      }
    }
    return out;
  }

  private async pipelineRcpts(lines: string[]): Promise<Array<SmtpReply | SmtpError>> {
    const promises = lines.map(line => {
      const p = this.readReply('rcpt_to');
      this.logger?.proto('C', 'smtp', this.redactor.redact(line, 'C'));
      this.socket!.write(line + '\r\n');
      return p;
    });
    const settled = await Promise.allSettled(promises);
    return settled.map(r => {
      if (r.status === 'fulfilled') return r.value;
      if (r.reason instanceof SmtpError && !(r.reason instanceof SmtpConnError)) return r.reason;
      throw r.reason;
    });
  }

  /** Send QUIT and close the socket. Safe to call even if already closed. */
  async quit(): Promise<void> {
    if (this.state === 'closed' || this.state === 'idle') return;
    this.state = 'quit';
    try {
      await this.command(Cmd.quit(), 'quit');
    } catch {
      // Ignore errors during quit
    } finally {
      this.socket?.destroy();
      this.state = 'closed';
    }
  }

  /** Send NOOP and return `true` if the server responds 250. */
  async verify(): Promise<boolean> {
    if (this.state !== 'ready') return false;
    try {
      const reply = await this.command(Cmd.noop(), 'noop');
      return reply.code === 250;
    } catch {
      return false;
    }
  }

  /** Immediately destroy the socket without sending QUIT. */
  destroy(): void {
    this.socket?.destroy();
    this.state = 'closed';
  }

  /** Server capabilities from the last EHLO (null before connect). */
  get serverCapabilities(): SmtpCapabilities | null {
    return this.capabilities;
  }
}
