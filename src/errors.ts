export type ErrorCode =
  | 'ECONFIG'
  | 'ECONN'
  | 'EAUTH'
  | 'EREJECT'
  | 'ETIMEOUT'
  | 'EPIPE'
  | 'ETLS'
  | 'EMIME'
  | 'EQUEUE'
  | 'EIMAP'
  | 'ETEMPLATE';

/** Base error for all mailts failures. Check `code` to distinguish categories. */
export class MailTsError extends Error {
  /** Machine-readable error category. */
  readonly code: ErrorCode;
  /** Whether the operation is safe to retry. */
  readonly retryable: boolean;

  constructor(message: string, code: ErrorCode, retryable: boolean) {
    super(message);
    this.name = 'MailTsError';
    this.code = code;
    this.retryable = retryable;
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }
}

/** SMTP protocol error — carries the numeric reply code and raw reply lines. */
export class SmtpError extends MailTsError {
  /** Three-digit SMTP reply code (e.g. 550). */
  readonly replyCode: number;
  /** Raw reply lines from the server. */
  readonly replyLines: readonly string[];

  constructor(message: string, code: ErrorCode, replyCode: number, lines: string[], retryable: boolean) {
    super(message, code, retryable);
    this.name = 'SmtpError';
    this.replyCode = replyCode;
    this.replyLines = lines;
  }

  /**
   * Factory — maps a raw SMTP reply code to the most specific subclass.
   * Codes 535/534/538 → `SmtpAuthError`, 5xx → `SmtpRejectError`, 4xx → retryable `SmtpError`.
   */
  static fromReply(code: number, lines: string[]): SmtpError {
    const text = lines.map(l => l.slice(4)).join(' ').trim();

    if (code === 535 || code === 534 || code === 538) {
      return new SmtpAuthError(`SMTP authentication failed (${code}): ${text}`, code, lines);
    }
    if (code >= 500) {
      return new SmtpRejectError(`SMTP rejected message (${code}): ${text}`, code, lines);
    }
    if (code >= 400) {
      return new SmtpError(`SMTP transient failure (${code}): ${text}`, 'ECONN', code, lines, true);
    }
    return new SmtpError(`Unexpected SMTP reply (${code}): ${text}`, 'ECONN', code, lines, false);
  }
}

/** Thrown when the server rejects credentials (535/534/538). Never retryable. */
export class SmtpAuthError extends SmtpError {
  constructor(message: string, replyCode: number, lines: string[]) {
    super(message, 'EAUTH', replyCode, lines, false);
    this.name = 'SmtpAuthError';
  }
}

/** Thrown for TCP/TLS connection failures. Always retryable. */
export class SmtpConnError extends SmtpError {
  constructor(message: string, replyCode = 0, lines: string[] = []) {
    super(message, 'ECONN', replyCode, lines, true);
    this.name = 'SmtpConnError';
  }
}

/** Thrown when the server permanently rejects the message (5xx). Never retryable. */
export class SmtpRejectError extends SmtpError {
  constructor(message: string, replyCode: number, lines: string[]) {
    super(message, 'EREJECT', replyCode, lines, false);
    this.name = 'SmtpRejectError';
  }
}

/** Thrown when an SMTP command or connection exceeds its deadline. Retryable. */
export class SmtpTimeoutError extends MailTsError {
  constructor(phase: string) {
    super(`SMTP timeout during phase: ${phase}`, 'ETIMEOUT', true);
    this.name = 'SmtpTimeoutError';
  }
}

/** Thrown on TLS handshake or STARTTLS failures. Never retryable. */
export class SmtpTlsError extends MailTsError {
  constructor(message: string) {
    super(message, 'ETLS', false);
    this.name = 'SmtpTlsError';
  }
}

/** Thrown for IMAP protocol or connection errors. */
export class ImapError extends MailTsError {
  constructor(message: string, retryable = false) {
    super(message, 'EIMAP', retryable);
    this.name = 'ImapError';
  }
}

/** Thrown when the mail queue encounters a non-recoverable state. */
export class QueueError extends MailTsError {
  constructor(message: string) {
    super(message, 'EQUEUE', false);
    this.name = 'QueueError';
  }
}

/** Thrown for invalid or missing configuration. Never retryable. */
export class ConfigError extends MailTsError {
  constructor(message: string) {
    super(message, 'ECONFIG', false);
    this.name = 'ConfigError';
  }
}

/** Thrown when MIME construction or parsing fails. Never retryable. */
export class MimeError extends MailTsError {
  constructor(message: string) {
    super(message, 'EMIME', false);
    this.name = 'MimeError';
  }
}

/** Thrown when template rendering fails. Never retryable. */
export class TemplateError extends MailTsError {
  constructor(message: string) {
    super(message, 'ETEMPLATE', false);
    this.name = 'TemplateError';
  }
}
