import type { ICalEvent } from '../core/ICal.js';

export type { ICalEvent };

/** A recipient address — bare email string or `{ email, name }` object. */
export type EmailAddress = string | { email: string; name?: string };

/** An email attachment — supply either `content` (inline) or `path` (file). */
export interface Attachment {
  /** File name shown to the recipient. */
  filename: string;
  /** Inline content: string, Buffer, or a readable stream. */
  content?: string | Buffer | NodeJS.ReadableStream;
  /** Path to a file on disk — read and encoded at send time. */
  path?: string;
  /** MIME type (auto-detected from filename if omitted). */
  contentType?: string;
  /** Transfer encoding.  Defaults to `base64`. */
  encoding?: 'base64' | 'quoted-printable' | '7bit' | '8bit';
  /** Content-ID for inline images referenced via `cid:` in HTML. */
  cid?: string;
  /** `attachment` (download) or `inline` (embedded).  Defaults to `attachment` unless `cid` is set. */
  disposition?: 'attachment' | 'inline';
  /**
   * Embed a forwarded email as a `message/rfc822` part.
   * Supply the raw RFC 5322 bytes or string of the forwarded message.
   * When set, `content` / `path` / `contentType` / `encoding` are ignored.
   */
  rfc822?: Buffer | string;
}

/** Options for a single outbound email. */
export interface EmailOptions {
  /** Sender address — falls back to `undefined` (server may reject). */
  from?: EmailAddress;
  /** Display name for the sender when `from` is a bare string. */
  fromName?: string;
  /** Primary recipient(s). */
  to: EmailAddress | EmailAddress[];
  /** Display name when `to` is a single bare string. */
  toName?: string;
  /** CC recipient(s). */
  cc?: EmailAddress | EmailAddress[];
  /** Display name when `cc` is a single bare string. */
  ccName?: string;
  /** BCC recipient(s) — included in envelope but not in message headers. */
  bcc?: EmailAddress | EmailAddress[];
  /** Display name when `bcc` is a single bare string. */
  bccName?: string;
  /** Reply-To address. */
  replyTo?: EmailAddress;
  /** Subject line.  CR/LF stripped to prevent header injection. */
  subject?: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body.  When both `text` and `html` are set, a multipart/alternative part is built. */
  html?: string;
  /** File attachments. */
  attachments?: Attachment[];
  /** Additional RFC 5322 headers.  Values are sanitised (CR/LF stripped). */
  headers?: Record<string, string>;
  /** Message priority.  Sets `X-Priority` / `Importance` headers. */
  priority?: 'high' | 'normal' | 'low';
  /** Override the generated Message-ID. */
  messageId?: string;
  /** Override the `Date` header.  Defaults to `new Date()`. */
  date?: Date;
  /**
   * Attach a calendar invite (`text/calendar` MIME part).
   * When provided, a `.ics` file is added and the `Content-Type` of the
   * enclosing part becomes `multipart/mixed`.
   */
  ical?: ICalEvent;
}

/** Options for a template-rendered email. `html` is produced by the template engine. */
export interface TemplateEmailOptions extends Omit<EmailOptions, 'html'> {
  /** Template string (inline) or path to a template file. */
  template: string;
  /** Data passed to the template engine's `render()` function. */
  data?: Record<string, unknown>;
}

/**
 * Result of a `send()` call.
 *
 * Discriminated union — check `result.ok` before accessing further fields:
 * ```ts
 * if (result.ok) {
 *   console.log(result.messageId);
 * } else {
 *   console.error(result.error.message, 'retryable:', result.error.retryable);
 * }
 * ```
 */
export type SendResult =
  | { ok: true;  messageId: string; accepted: string[]; rejected: string[] }
  | { ok: false; error: import('../errors.js').MailTsError; attempts: number };

/** A reusable email configuration registered via `mail.define()`. */
export interface AliasConfig extends Partial<EmailOptions> {
  /** Controls which send helper to use when the alias is triggered. */
  type?: 'notify' | 'alert' | 'ping' | 'send';
  /** Template string or file path — triggers `sendTemplate()`. */
  template?: string;
  /** Default template data merged with trigger-time overrides. */
  data?: Record<string, unknown>;
}

/**
 * A pluggable template engine interface.
 *
 * @example
 * ```ts
 * // Minimal custom engine
 * mail.setTemplateEngine({
 *   render: (compiled, data) =>
 *     (compiled as string).replace(/\{\{(\w+)\}\}/g, (_, k) => String(data[k] ?? '')),
 * });
 * ```
 */
export interface TemplateEngine {
  /** Optional pre-compilation step — called once per template string. */
  compile?: (template: string) => unknown;
  /** Render the compiled template with the provided data. */
  render: (compiled: unknown, data: Record<string, unknown>) => string;
}

/**
 * A middleware function executed before each `send()` call.
 * Call `next()` to pass control to the next middleware (or the transport).
 */
export type Middleware = (
  options: EmailOptions,
  next: () => Promise<void>,
) => Promise<void> | void;
