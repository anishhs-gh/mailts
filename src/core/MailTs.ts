import { SmtpPool } from '../smtp/SmtpPool.js';
import { SmtpClient } from '../smtp/SmtpClient.js';
import { buildMessage } from './Message.js';
import { signDkim } from './Dkim.js';
import { TemplateRenderer } from './Template.js';
import { MailQueue } from '../queue/MailQueue.js';
import { Logger } from '../logger/Logger.js';
import { ImapSession } from '../imap/ImapSession.js';
import { loadConfig } from './Config.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { ImapConfig } from '../types/imap.js';
import type { QueueOptions } from '../types/queue.js';
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
import { ConfigError, MailTsError } from '../errors.js';

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
   * outbound mail.  Use the built-in transports from `mailts/transports` or
   * implement the `Transport` interface yourself.
   *
   * @example
   * ```ts
   * import { ResendTransport } from 'mailts/transports';
   * new MailTs({ transport: new ResendTransport({ apiKey: '...' }) });
   * ```
   */
  transport?: Transport;
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

    if (config.smtp) {
      this.smtpConfig = config.smtp;
      this.poolingDisabled = config.smtp.pool === false;
      this.pool = this.poolingDisabled ? null : new SmtpPool(config.smtp, this.logger);
    }

    if (config.imap) {
      this.imapConfig = config.imap;
    }

    if (config.queue !== undefined) {
      this.queueOpts = config.queue;
      this.rebuildQueue();
    }
  }

  private rebuildQueue(): void {
    const q = new MailQueue(this.queueOpts, this.logger);
    q.setSendFn((opts) => this.sendDirect(opts));
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
  async send(options: EmailOptions): Promise<SendResult> {
    if (this.devMode) {
      this.logger.info('core', `[devMode] Would send email to ${JSON.stringify(options.to)}`);
      this.logger.debug('core', '[devMode] Full options logged at debug level');
      return { ok: true, messageId: `dev-${Date.now()}@local`, accepted: [], rejected: [] };
    }

    let index = 0;
    const next = async (): Promise<void> => {
      if (index < this.middlewares.length) {
        const fn = this.middlewares[index++]!;
        await fn(options, next);
      }
    };
    await next();

    return this.sendDirect(options);
  }

  private async sendDirect(options: EmailOptions): Promise<SendResult> {
    try {
      const built = await buildMessage(options);
      const raw = this.smtpConfig?.dkim ? signDkim(built.raw, this.smtpConfig.dkim) : built.raw;
      const message = { ...built, raw };

      if (this.transportOverride) {
        const transport = this.transportOverride;
        this.logger.debug('core', `Sending via ${transport.name} (${raw.length} bytes)`);
        const result = await transport.send(message, options);
        this.logger.info('core', `Message sent (${result.messageId})`);
        return { ok: true, messageId: result.messageId, accepted: result.accepted, rejected: result.rejected };
      }

      if (this.poolingDisabled) {
        const client = new SmtpClient(this.requireSmtpConfig(), this.logger);
        await client.connect();
        try {
          this.logger.debug('smtp', `Sending message (${raw.length} bytes) to ${built.to.join(', ')}`);
          const serverId = await client.sendMessage(built.from, built.to, raw);
          this.logger.info('smtp', `Message sent (${built.messageId}) — server id: ${serverId}`);
          return { ok: true, messageId: built.messageId, accepted: built.to, rejected: [] };
        } finally {
          await client.quit().catch(() => {});
        }
      }

      const pool = this.requireSmtp();
      const client = await pool.acquire();
      try {
        this.logger.debug('smtp', `Sending message (${raw.length} bytes) to ${built.to.join(', ')}`);
        const serverId = await client.sendMessage(built.from, built.to, raw);
        this.logger.info('smtp', `Message sent (${built.messageId}) — server id: ${serverId}`);
        return { ok: true, messageId: built.messageId, accepted: built.to, rejected: [] };
      } finally {
        pool.release(client);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.logger.error('core', `Send failed: ${e.message}`);
      const mailErr = err instanceof MailTsError
        ? err
        : new MailTsError(e.message, 'ECONN', true);
      return { ok: false, error: mailErr, attempts: 1 };
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
    return new ImapSession(this.imapConfig, this.logger);
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  /**
   * Gracefully drain the queue and close all pooled SMTP connections.
   * Await this before process exit to ensure in-flight messages are delivered.
   */
  async shutdown(): Promise<void> {
    if (this._queue) await this._queue.drain();
    if (this.pool) await this.pool.drain();
    this.logger.info('core', 'MailTs shutdown complete');
  }
}
