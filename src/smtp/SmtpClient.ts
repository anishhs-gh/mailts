import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { SmtpStream } from './SmtpStream.js';
import { SmtpReply } from './SmtpReply.js';
import { Cmd, parseCapabilities, dotStuff } from './SmtpCommand.js';
import { Credential } from '../core/Credential.js';
import { Redactor } from '../logger/Redactor.js';
import { connectThroughProxy } from './SmtpProxy.js';
import type { Logger } from '../logger/Logger.js';
import type { SmtpConfig, SmtpCapabilities } from '../types/smtp.js';
import {
  SmtpConnError,
  SmtpAuthError,
  SmtpError,
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
  private replyLines: string[] = [];
  private replyCode: number | null = null;
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
      const payload = cred.buildXOAuth2Payload();
      const reply = await this.command(Cmd.authXOAuth2(payload), 'auth');
      if (reply.code !== 235) throw SmtpError.fromReply(reply.code, [...reply.lines]);
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

    throw new SmtpAuthError(`No supported auth method available. Server offers: ${caps.auth.join(', ')}`, 535, []);
  }

  /** Send a single message — returns message-ID from 250 reply. */
  async sendMessage(from: string, to: string[], raw: Buffer): Promise<string> {
    if (this.state !== 'ready') throw new SmtpConnError('Client not in READY state');
    this.state = 'sending';

    try {
      const sizeParam = this.capabilities?.size ? raw.length : undefined;
      await this.command(Cmd.mailFrom(from, sizeParam), 'mail_from');

      if (this.capabilities?.pipelining) {
        // Pipeline RCPT TO commands — write all without waiting for individual replies
        await this.pipelineRcpts(to);
      } else {
        for (const rcpt of to) {
          await this.command(Cmd.rcptTo(rcpt), 'rcpt_to');
        }
      }

      await this.command(Cmd.data(), 'data');

      // Write dot-stuffed body followed by terminating dot
      const stuffed = dotStuff(raw);
      this.logger?.proto('C', 'smtp', `[DATA] ${stuffed.length} bytes`);
      const dataReply = await new Promise<SmtpReply>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new SmtpTimeoutError('data_body')),
          this.config.socketTimeout ?? 30_000,
        );
        this.replyQueue.push({ resolve, reject, timer });
        this.socket!.write(stuffed);
        this.socket!.write('\r\n');
      });

      if (dataReply.code !== 250) {
        throw SmtpError.fromReply(dataReply.code, [...dataReply.lines]);
      }

      this.messagesSent++;
      this.state = 'ready';

      // Extract queued message ID from reply if present
      const idMatch = dataReply.text.match(/<([^>]+)>/);
      return idMatch?.[1] ?? `mailts-${Date.now()}@local`;
    } catch (err) {
      this.state = 'error';
      // Attempt RSET to recover
      try {
        await this.command(Cmd.rset(), 'rset');
        this.state = 'ready';
      } catch {
        // Connection is dead
      }
      throw err;
    }
  }

  private async pipelineRcpts(to: string[]): Promise<void> {
    const replyPromises = to.map(rcpt => {
      const p = this.readReply('rcpt_to');
      this.socket!.write(Cmd.rcptTo(rcpt) + '\r\n');
      return p;
    });
    for (let i = 0; i < replyPromises.length; i++) {
      const reply = await replyPromises[i]!;
      if (reply.code !== 250 && reply.code !== 251) {
        throw SmtpError.fromReply(reply.code, [...reply.lines]);
      }
    }
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
}
