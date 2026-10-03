import { SmtpPool } from '../smtp/SmtpPool.js';
import { SmtpClient, type SmtpSendResult } from '../smtp/SmtpClient.js';
import { buildMessage, type BuiltMessage } from './Message.js';
import { resolveAttachment, type AttachmentPathPolicy } from './Attachment.js';
import { signDkim } from './Dkim.js';
import { TemplateRenderer } from './Template.js';
import { MailQueue } from '../queue/MailQueue.js';
import { SqliteQueue, resolveQueueDbPath } from '../queue/SqliteQueue.js';
import { Logger } from '../logger/Logger.js';
import { ImapSession } from '../imap/ImapSession.js';
import { loadConfig } from './Config.js';
import { HealthChecker } from '../health/HealthChecker.js';
import type { HealthResult } from '../health/HealthChecker.js';
import type { TelemetryHooks } from '../telemetry/index.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { ImapConfig } from '../types/imap.js';
import type { QueueOptions, ShutdownOptions, ShutdownResult } from '../types/queue.js';
import type { LoggerOptions } from '../types/logger.js';
import type {
  EmailOptions,
  TemplateEmailOptions,
  SendResult,
  AliasConfig,
  TemplateEngine,
  Middleware,
} from '../types/core.js';
import type { Transport } from '../transports/Transport.js';
import { ConfigError, MailTsError, ImapError } from '../errors.js';

/** Top-level configuration passed to `new MailTs()` or `.configure()`. */
export interface MailTsConfig {
  /** SMTP transport settings. */
  smtp?: SmtpConfig;
  /** IMAP settings for reading mail. */
  imap?: ImapConfig;
  /** Queue behaviour — concurrency, retries, dead-letter. */
  queue?: QueueOptions;
  /** Logger options — level, format, protocol tracing. */
  logger?: LoggerOptions;
  /**
   * When `true`, `send()` / `sendTemplate()` / helpers log but do not transmit.
   * Useful for development and testing pipelines.
   */
  devMode?: boolean;
  /**
   * Pluggable send transport.  When set, takes precedence over `smtp` for all
   * outbound mail.  Use the built-in transports from `@mailts/core/transports` or
   * implement the `Transport` interface yourself.
   *
   * @example
   * ```ts
   * import { ResendTransport } from '@mailts/core/transports';
   * new MailTs({ transport: new ResendTransport({ apiKey: '...' }) });
   * ```
   */
  transport?: Transport;
  /** Telemetry hooks for observability — wired to send and queue events. */
  telemetry?: TelemetryHooks;
  /**
   * Policy for attachments given by filesystem `path`. Unset rejects them (same as
   * `'deny'`). Use `{ root }` to allow one directory, or `'allow'` only when every
   * message comes from trusted code — never for untrusted input such as AI agents.
   */
  attachmentPolicy?: AttachmentPathPolicy;
}

/** Per-call options for `send()`. */
export interface SendCallOptions {
  /**
   * After a successful send, APPEND the exact sent bytes to the Sent mailbox
   * via IMAP (`true` = auto-detect with SPECIAL-USE, or a mailbox name).
   * Gmail stores sent mail itself — leave this off there.
   */
  saveToSent?: boolean | string;
  /** Abort the send. */
  signal?: AbortSignal;
}

/**
 * Main developer entry point for `mailts`.
 *
 * @example
 * ```ts
 * const mail = new MailTs({
 *   smtp: { host: 'smtp.gmail.com', port: 587,
 *           auth: { type: 'plain', user: 'me@gmail.com', pass: process.env.SMTP_PASS! } },
 *   logger: { level: 'info', format: 'pretty' },
 * });
 *
 * const result = await mail.send({
 *   from: 'me@gmail.com',
 *   to: 'you@example.com',
 *   subject: 'Hello',
 *   text: 'Hi!',
 * });
 * ```
 */
export class MailTs {
  private smtpConfig: SmtpConfig | null = null;
  private imapConfig: ImapConfig | null = null;
  private pool: SmtpPool | null = null;
  private poolingDisabled = false;
  private transportOverride: Transport | null = null;
  private _queue: MailQueue | null = null;
  private templateRenderer = new TemplateRenderer();
  private middlewares: Middleware[] = [];
  private aliases: Map<string, AliasConfig> = new Map();
  private devMode = false;
  private queueOpts: QueueOptions = {};
  private hooks: TelemetryHooks = {};
  private attachmentPolicy: AttachmentPathPolicy | undefined;
  private sentSession: ImapSession | null = null;
  private sentMailbox: string | null = null;

  /**
   * Structured logger — subscribe via `logger.onEvent(fn)` or stream via
   * `logger.stream()`.
   */
  readonly logger: Logger;

  /**
   * Create a new MailTs instance.
   *
   * If no `config` is provided the constructor attempts to load one from
   * `.mailtsrc` / `.mailtsrc.json` in the current directory, then falls back to
   * `~/.mailts/config.json`.  Environment variable placeholders (`${VAR}`) in
   * any string value are expanded at load time.
   */
  constructor(config?: MailTsConfig) {
    const resolved = config ?? loadConfig() ?? {};
    this.logger = new Logger(resolved.logger);
    this.applyConfig(resolved);
  }

  /**
   * Update configuration without creating a new instance.
   * Can be called multiple times — each call merges into the running state.
   * Chainable.
   */
  configure(config: MailTsConfig): this {
    this.applyConfig(config);
    return this;
  }

  private applyConfig(config: MailTsConfig): void {
    if (config.logger) this.logger.configure(config.logger);
    if (config.devMode !== undefined) this.devMode = config.devMode;

    if (config.transport) {
      this.transportOverride = config.transport;
    }

    if (config.attachmentPolicy) this.attachmentPolicy = config.attachmentPolicy;

    if (config.smtp) {
      const oldPool = this.pool;
      this.smtpConfig = config.smtp;
      this.poolingDisabled = config.smtp.pool === false;
      this.pool = this.poolingDisabled ? null : new SmtpPool(config.smtp, this.logger);
      if (oldPool) void oldPool.drain().catch(() => {});
    }

    if (config.imap) {
      this.imapConfig = config.imap;
      const old = this.sentSession;
      this.sentSession = null;
      this.sentMailbox = null;
      if (old) void old.close().catch(() => {});
    }

    if (config.telemetry) this.hooks = config.telemetry;

    if (config.queue !== undefined) {
      const old = this._queue;
      if (old) {
        const st = old.stats();
        if (st.pending + st.running + st.scheduled > 0 && !old.persistent) {
          throw new ConfigError('Cannot replace the queue while it has unsent jobs — drain or shut it down first');
        }
        if (old instanceof SqliteQueue) old.close();
      }
      this.queueOpts = config.queue;
      this.rebuildQueue();
    }
  }

  private rebuildQueue(): void {
    const sendFn = (opts: EmailOptions, signal?: AbortSignal) => this.sendQueued(opts, signal);
    let q: MailQueue;
    if (this.queueOpts.persist) {
      try {
        q = new SqliteQueue(resolveQueueDbPath(this.queueOpts.persist), this.queueOpts, this.logger, sendFn);
      } catch (err) {
        this.logger.warn('queue', `SqliteQueue failed, falling back to MailQueue: ${err instanceof Error ? err.message : String(err)}`);
        q = new MailQueue(this.queueOpts, this.logger);
      }
    } else {
      q = new MailQueue(this.queueOpts, this.logger);
    }
    q.setSendFn(sendFn);

    // Hooks are looked up at event time so later `configure({ telemetry })` calls apply
    q.on('enqueued',    job => this.hooks.onQueueEnqueue?.(job));
    q.on('success',     job => this.hooks.onQueueSuccess?.(job));
    q.on('dead',        job => this.hooks.onQueueDead?.(job));
    q.on('retry',       (job, attempt, delay) => this.hooks.onQueueRetry?.(job, attempt, delay));
    q.on('cancelled',   job => this.hooks.onQueueCancelled?.(job));
    q.on('interrupted', job => this.hooks.onQueueInterrupted?.(job));

    this._queue = q;
  }

  private requireSmtpConfig(): SmtpConfig {
    if (!this.smtpConfig) {
      throw new ConfigError('SMTP not configured. Pass smtp config to configure() or constructor.');
    }
    return this.smtpConfig;
  }

  private requireSmtp(): SmtpPool {
    if (!this.pool || !this.smtpConfig) {
      throw new ConfigError('SMTP not configured. Pass smtp config to configure() or constructor.');
    }
    return this.pool;
  }

  // ─── Middleware ───────────────────────────────────────────────────────────

  /**
   * Register a middleware function that runs before every `send()` call.
   * Middlewares execute in registration order and may mutate the `EmailOptions`
   * object before it reaches the transport.
   *
   * @example
   * ```ts
   * mail.use(async (msg, next) => {
   *   msg.headers = { ...msg.headers, 'X-Sent-By': 'my-app' };
   *   await next();
   * });
   * ```
   */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  // ─── Template engine ─────────────────────────────────────────────────────

  /**
   * Replace the built-in `{{variable}}` template engine.
   * `engine.render(compiled, data)` must return the rendered string.
   * `engine.compile(template)` is optional — used for pre-compilation
   * (e.g. Handlebars).
   *
   * @example
   * ```ts
   * import Handlebars from 'handlebars';
   * mail.setTemplateEngine({
   *   compile: Handlebars.compile,
   *   render: (compiled, data) => compiled(data),
   * });
   * ```
   */
  setTemplateEngine(engine: TemplateEngine): this {
    this.templateRenderer.setEngine(engine);
    return this;
  }

  // ─── Aliases ──────────────────────────────────────────────────────────────

  /**
   * Register a reusable email configuration under `name`.
   * Trigger it later via `mail.trigger(name, overrides)`.
   *
   * @example
   * ```ts
   * mail.define('welcome', {
   *   from: 'noreply@company.com',
   *   subject: 'Welcome!',
   *   template: './templates/welcome.html',
   * });
   * await mail.trigger('welcome', { to: 'newuser@example.com', data: { name: 'Alice' } });
   * ```
   */
  define(name: string, config: AliasConfig): this {
    if (typeof name !== 'string' || !name.trim()) {
      throw new ConfigError('Alias name must be a non-empty string');
    }
    this.aliases.set(name, config);
    return this;
  }

  /**
   * Trigger a previously defined alias, optionally overriding any field.
   * Routing (`send` / `notify` / `alert` / `ping` / `sendTemplate`) is
   * determined by the alias `type` and presence of `template`.
   */
  async trigger(name: string, overrides: Partial<AliasConfig> = {}): Promise<SendResult> {
    const alias = this.aliases.get(name);
    if (!alias) throw new ConfigError(`Alias "${name}" is not defined`);

    const merged: AliasConfig = { ...alias, ...overrides };
    const data = merged.data ?? {};

    // Render template variables in all string fields when data is provided
    if (Object.keys(data).length > 0) {
      if (merged.subject) merged.subject = this.templateRenderer.render(merged.subject, data);
      if (merged.text)    merged.text    = this.templateRenderer.render(merged.text, data);
      if (merged.html)    merged.html    = this.templateRenderer.render(merged.html, data);
    }

    if (merged.template) {
      return this.sendTemplate({ ...(merged as TemplateEmailOptions), to: merged.to! });
    }

    switch (merged.type) {
      case 'notify': return this.notify(merged as EmailOptions);
      case 'alert':  return this.alert(merged as EmailOptions);
      case 'ping':   return this.ping(merged as EmailOptions);
      default:       return this.send(merged as EmailOptions);
    }
  }

  // ─── Core send ───────────────────────────────────────────────────────────

  /**
   * Send an email immediately through the SMTP transport.
   *
   * Runs all registered middlewares in order before building and transmitting
   * the message.  In `devMode` the message is logged but never sent.
   *
   * Returns a discriminated-union `SendResult` — check `result.ok` before
   * accessing `result.messageId`.
   */
  async send(options: EmailOptions, callOpts: SendCallOptions = {}): Promise<SendResult> {
    if (this.devMode) return this.devResult(options);
    const prepared = await this.runMiddleware(options);
    const result = await this.sendDirect(prepared, callOpts.signal, callOpts.saveToSent);
    return result;
  }

  /**
   * The queue's send path: honours `devMode` and runs middleware on a fresh copy
   * of the job's options for every attempt (so mutations never accumulate
   * across retries). Used by `mail.queue` and `MailWorker`.
   */
  async sendQueued(options: EmailOptions, signal?: AbortSignal): Promise<SendResult> {
    if (this.devMode) return this.devResult(options);
    try {
      const prepared = await this.runMiddleware(copyOptions(options));
      return await this.sendDirect(prepared, signal);
    } catch (err) {
      return { ok: false, error: toMailError(err), attempts: 1 };
    }
  }

  /**
   * Send immediately — bypasses middleware and `devMode`, threads `signal` to
   * the transport. For advanced callers that manage their own pipeline.
   */
  dispatch(options: EmailOptions, signal?: AbortSignal): Promise<SendResult> {
    return this.sendDirect(options, signal);
  }

  /**
   * Build the exact RFC 5322 bytes `send()` would transmit (DKIM-signed when
   * configured) without sending. Use it for IMAP APPEND (drafts), previews or tests.
   */
  async build(options: EmailOptions): Promise<BuiltMessage> {
    const built = await buildMessage(options, { attachmentPolicy: this.attachmentPolicy });
    const raw = this.smtpConfig?.dkim ? signDkim(built.raw, this.smtpConfig.dkim) : built.raw;
    return { ...built, raw };
  }

  /**
   * APPEND a message to the Sent mailbox over IMAP (`\\Seen`). Many providers
   * (unlike Gmail) do not store SMTP-sent mail. `mailbox` defaults to the
   * SPECIAL-USE `\\Sent` mailbox (falling back to common names).
   */
  async saveToSent(
    message: EmailOptions | BuiltMessage | Buffer,
    opts: { mailbox?: string } = {},
  ): Promise<{ mailbox: string; uid?: number }> {
    const raw = Buffer.isBuffer(message) ? message : 'raw' in message ? message.raw : (await this.build(message)).raw;
    const session = this.sentImap();
    const mailbox = opts.mailbox ?? (this.sentMailbox ??= await session.findMailbox('\\Sent') ?? null);
    if (!mailbox) throw new ImapError('No Sent mailbox found — pass { mailbox } explicitly');
    const res = await session.append(mailbox, raw, ['\\Seen']);
    return { mailbox, uid: res.uid };
  }

  /**
   * HTTP transports read attachments from `options`; resolve `path` entries here,
   * under the attachment policy, so transports never touch the filesystem.
   */
  private async materializePaths(options: EmailOptions): Promise<EmailOptions> {
    if (!options.attachments?.some(a => a.path !== undefined && a.content === undefined)) return options;
    const attachments = await Promise.all(options.attachments.map(async (a) => {
      if (a.path === undefined || a.content !== undefined || a.rfc822 !== undefined) return a;
      const r = await resolveAttachment(a, this.attachmentPolicy);
      const { path: _path, ...rest } = a;
      return { ...rest, filename: r.filename, contentType: r.contentType, content: await r.getContent() };
    }));
    return { ...options, attachments };
  }

  private sentImap(): ImapSession {
    if (!this.imapConfig) throw new ConfigError('IMAP not configured — saveToSent needs imap config');
    return (this.sentSession ??= new ImapSession(this.imapConfig, this.logger, { attachmentPolicy: this.attachmentPolicy }));
  }

  private devResult(options: EmailOptions): SendResult {
    this.logger.info('core', `[devMode] Would send email to ${JSON.stringify(options.to)}`);
    return { ok: true, messageId: `<dev-${Date.now()}@local>`, accepted: [], rejected: [] };
  }

  private async runMiddleware(options: EmailOptions): Promise<EmailOptions> {
    let index = 0;
    const next = async (): Promise<void> => {
      if (index < this.middlewares.length) {
        const fn = this.middlewares[index++]!;
        await fn(options, next);
      }
    };
    await next();
    return options;
  }

  private async sendDirect(
    options: EmailOptions,
    signal?: AbortSignal,
    saveToSent?: boolean | string,
  ): Promise<SendResult> {
    const t0 = Date.now();
    try {
      const message = await this.build(options);
      let result: SendResult & { ok: true };

      if (this.transportOverride) {
        const transport = this.transportOverride;
        this.logger.debug('core', `Sending via ${transport.name} (${message.raw.length} bytes)`);
        const r = await transport.send(message, await this.materializePaths(options), signal);
        this.logger.info('core', `Message sent (${r.messageId})`);
        result = { ok: true, messageId: r.messageId, accepted: r.accepted, rejected: r.rejected };
      } else {
        const r = await this.sendSmtp(message, signal);
        if (r.rejected.length) {
          this.logger.warn('smtp', `Recipients rejected: ${r.rejected.join(', ')}`);
        }
        this.logger.info('smtp', `Message sent (${message.messageId})${r.serverId ? ` — server id: ${r.serverId}` : ''}`);
        result = { ok: true, messageId: message.messageId, accepted: r.accepted, rejected: r.rejected };
      }

      if (saveToSent) {
        try {
          await this.saveToSent(message, typeof saveToSent === 'string' ? { mailbox: saveToSent } : {});
        } catch (err) {
          // The mail was delivered — report, don't fail the send
          this.logger.warn('imap', `saveToSent failed: ${err instanceof Error ? err.message : String(err)}`);
          this.hooks.onError?.(err instanceof Error ? err : new Error(String(err)), 'saveToSent');
        }
      }

      this.hooks.onSend?.(options, result, Date.now() - t0);
      return result;
    } catch (err) {
      const mailErr = toMailError(err);
      this.logger.error('core', `Send failed: ${mailErr.message}`);
      this.hooks.onError?.(mailErr, 'send');
      return { ok: false, error: mailErr, attempts: 1 };
    }
  }

  private async sendSmtp(message: BuiltMessage, signal?: AbortSignal): Promise<SmtpSendResult> {
    const cfg = this.requireSmtpConfig();
    const opts = {
      eightBit: message.requires8BitMime,
      smtpUtf8: message.requiresSmtpUtf8,
      allRecipientsRequired: cfg.allRecipientsRequired,
    };
    if (signal?.aborted) throw new MailTsError('Send aborted', 'EQUEUE', true);

    if (this.poolingDisabled) {
      const client = new SmtpClient(cfg, this.logger);
      const onAbort = (): void => { client.destroy(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await client.connect();
        this.logger.debug('smtp', `Sending message (${message.raw.length} bytes) to ${message.to.join(', ')}`);
        return await client.send(message.from, message.to, message.raw, opts);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        await client.quit().catch(() => {});
      }
    }

    const pool = this.requireSmtp();
    const client = await pool.acquire(signal);
    const onAbort = (): void => { client.destroy(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.logger.debug('smtp', `Sending message (${message.raw.length} bytes) to ${message.to.join(', ')}`);
      return await client.send(message.from, message.to, message.raw, opts);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      pool.release(client);
    }
  }

  /**
   * Render a template then send the result as an HTML email.
   *
   * `template` can be a template string (`"Hello {{name}}"`) or a path to a
   * file.  `data` is merged into the rendering context.  Uses the configured
   * template engine (defaults to built-in `{{variable}}` syntax).
   */
  async sendTemplate(options: TemplateEmailOptions): Promise<SendResult> {
    const { template, data = {}, ...rest } = options;
    const html = this.templateRenderer.render(template, data);
    if (rest.subject) rest.subject = this.templateRenderer.render(rest.subject, data);
    return this.send({ ...rest, html });
  }

  // ─── Shorthand helpers ────────────────────────────────────────────────────

  /**
   * Send a notification email — subject is automatically prefixed with
   * `[NOTIFICATION]`.
   */
  notify(options: EmailOptions): Promise<SendResult> {
    return this.send({
      ...options,
      subject: `[NOTIFICATION] ${options.subject ?? 'New Notification'}`,
    });
  }

  /**
   * Send a high-priority alert email — subject is prefixed with `[ALERT]` and
   * `X-Priority: 1` headers are set.
   */
  alert(options: EmailOptions): Promise<SendResult> {
    return this.send({
      ...options,
      subject: `[ALERT] ${options.subject ?? 'New Alert'}`,
      priority: 'high',
    });
  }

  /**
   * Send a minimal ping email — subject and body are set to "Ping" /
   * "Ping!" automatically.
   */
  ping(options: EmailOptions): Promise<SendResult> {
    return this.send({
      ...options,
      subject: 'Ping',
      text: 'Ping!',
      html: '<p>Ping!</p>',
    });
  }

  // ─── Connection test ──────────────────────────────────────────────────────

  /**
   * Open a throw-away SMTP connection, send a NOOP, and close it.
   * Returns `true` if the server accepted the connection and authenticated
   * successfully.  Does not use the connection pool.
   */
  async testConnection(): Promise<boolean> {
    const smtpCfg = this.smtpConfig;
    if (!smtpCfg) throw new ConfigError('SMTP not configured');

    const client = new SmtpClient(smtpCfg, this.logger);
    try {
      await client.connect();
      const ok = await client.verify();
      this.logger.info('smtp', `Connection test ${ok ? 'passed' : 'failed'}`);
      return ok;
    } catch (err) {
      this.logger.error('smtp', `Connection test failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      await client.quit().catch(() => {});
    }
  }

  // ─── Queue ────────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget queue.  Jobs are processed with configurable concurrency,
   * exponential back-off retry, and a dead-letter queue for permanently failed
   * messages.
   *
   * @example
   * ```ts
   * mail.queue.enqueue({ to: 'user@example.com', subject: 'Hi', text: 'Hello!' });
   * mail.queue.on('dead', (job, errors) => console.error('Permanently failed', job.id));
   * await mail.queue.drain();
   * ```
   */
  get queue(): MailQueue {
    if (!this._queue) this.rebuildQueue();
    return this._queue!;
  }

  /** `true` once the queue has been created (by access or `queue` config). */
  get hasQueue(): boolean {
    return this._queue !== null;
  }

  // ─── IMAP ─────────────────────────────────────────────────────────────────

  /**
   * Open a new IMAP session.  Each access creates a fresh `ImapSession` —
   * call `session.connect()` before using it.
   *
   * @example
   * ```ts
   * const session = mail.imap;
   * await session.connect();
   * await session.open('INBOX');
   * const messages = await session.fetch({ seen: false, limit: 10 });
   * await session.close();
   * ```
   */
  get imap(): ImapSession {
    if (!this.imapConfig) {
      throw new ConfigError('IMAP not configured. Pass imap config to configure() or constructor.');
    }
    return new ImapSession(this.imapConfig, this.logger, { attachmentPolicy: this.attachmentPolicy });
  }

  // ─── Health ───────────────────────────────────────────────────────────────

  /** Run SMTP and IMAP connectivity checks and return a structured result. */
  async health(): Promise<HealthResult> {
    const checker = new HealthChecker(this.smtpConfig, this.imapConfig, this.logger);
    return checker.check();
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  /**
   * Stop the queue, close pooled SMTP connections and the internal IMAP session.
   *
   * Pending mail is **not** discarded by default: an in-memory queue is drained
   * (delivered), a persistent queue keeps unsent jobs for the next start. Pass
   * `{ pending: 'cancel' }` to discard, and `timeoutMs` to bound the wait.
   * A number is accepted as the legacy `shutdown(queueTimeoutMs)` form.
   */
  async shutdown(opts: number | ShutdownOptions = {}): Promise<ShutdownResult | undefined> {
    const result = this._queue ? await this._queue.shutdown(opts) : undefined;
    if (this.pool) await this.pool.drain();
    const session = this.sentSession;
    this.sentSession = null;
    if (session) await session.close().catch(() => {});
    this.logger.info('core', 'MailTs shutdown complete');
    return result;
  }
}

/** Shallow-copy options (and their mutable containers) so middleware edits stay per-attempt. */
function copyOptions(o: EmailOptions): EmailOptions {
  return {
    ...o,
    ...(o.headers ? { headers: { ...o.headers } } : {}),
    ...(o.attachments ? { attachments: o.attachments.map(a => ({ ...a })) } : {}),
    ...(Array.isArray(o.to) ? { to: [...o.to] } : {}),
    ...(Array.isArray(o.cc) ? { cc: [...o.cc] } : {}),
    ...(Array.isArray(o.bcc) ? { bcc: [...o.bcc] } : {}),
  };
}

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)$/;

/** Wrap unknown errors: network failures are retryable, programming/validation errors are not. */
function toMailError(err: unknown): MailTsError {
  if (err instanceof MailTsError) return err;
  const e = err instanceof Error ? err : new Error(String(err));
  const code = (e as { code?: unknown }).code;
  const network = typeof code === 'string' && NETWORK_CODES.test(code);
  const wrapped = new MailTsError(e.message, network ? 'ECONN' : 'EQUEUE', network);
  (wrapped as { cause?: unknown }).cause = e;
  return wrapped;
}
