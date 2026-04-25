import { MemoryStore } from './store/MemoryStore.js';
import { PersistStore, resolvePersistPath } from './store/PersistStore.js';
import { SmtpServer } from './server/SmtpServer.js';
import { HttpServer } from './server/HttpServer.js';
import type { CapturedMessage } from './store/MemoryStore.js';

export interface TrapServerOptions {
  smtpPort?: number;
  httpPort?: number;
  host?: string;
  maxMessages?: number;
  maxSize?: number;
  /** Enable persistence. Pass true for default path, or a string path. */
  persist?: boolean | string;
}

const DEFAULTS = {
  smtpPort: 1025,
  httpPort: 1080,
  host: '127.0.0.1',
  maxMessages: 100,
  maxSize: 25 * 1024 * 1024,
  persist: false as boolean | string,
};

/**
 * In-process SMTP trap and web UI server.
 *
 * Captures all inbound SMTP messages without forwarding them.
 * Exposes a REST/SSE API at `httpPort` and an optional web UI.
 *
 * @example
 * ```ts
 * const trap = new TrapServer({ smtpPort: 1025, httpPort: 1080 });
 * await trap.start();
 * // Open http://localhost:1080 to inspect messages
 * await trap.stop();
 * ```
 */
export class TrapServer {
  readonly store: MemoryStore;
  private smtp: SmtpServer;
  private http: HttpServer;
  private opts: Required<TrapServerOptions>;

  constructor(opts: TrapServerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.store = this.opts.persist
      ? new PersistStore(
          typeof this.opts.persist === 'string' ? this.opts.persist : resolvePersistPath(),
          this.opts.maxMessages,
        )
      : new MemoryStore(this.opts.maxMessages);

    this.smtp = new SmtpServer({
      port: this.opts.smtpPort,
      host: this.opts.host,
      maxSize: this.opts.maxSize,
      store: this.store,
      onMessage: (msg) => this.onMessage(msg),
    });

    this.http = new HttpServer({
      port: this.opts.httpPort,
      host: this.opts.host,
      store: this.store,
    });
  }

  /** Start the SMTP and HTTP servers. Resolves when both are listening. */
  async start(): Promise<void> {
    await Promise.all([this.smtp.listen(), this.http.listen()]);
  }

  /** Stop both servers and release their ports. */
  async stop(): Promise<void> {
    await Promise.all([this.smtp.close(), this.http.close()]);
  }

  /** URL of the web UI. */
  get url(): string {
    return `http://${this.opts.host}:${this.opts.httpPort}`;
  }

  /** Direct link to a specific captured message in the web UI. */
  messageUrl(id: string): string {
    return `${this.url}/message/${id}`;
  }

  private onMessage(msg: CapturedMessage): void {
    this.http.broadcast('message', {
      id: msg.id,
      subject: msg.subject,
      from: msg.from,
      receivedAt: msg.receivedAt,
      size: msg.size,
    });
  }
}
