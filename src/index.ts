// Main entry point — re-export everything public

export { MailTs } from './core/MailTs.js';
export type { MailTsConfig } from './core/MailTs.js';
export { loadConfig, expandEnv } from './core/Config.js';

// Types
export type {
  EmailAddress,
  Attachment,
  EmailOptions,
  TemplateEmailOptions,
  SendResult,
  AliasConfig,
  TemplateEngine,
  Middleware,
  ICalEvent,
  SmtpAuth,
  SmtpAuthType,
  SmtpConfig,
  SmtpPoolConfig,
  SmtpCapabilities,
  DkimConfig,
  ProxyConfig,
  ImapConfig,
  ImapMailboxStatus,
  ImapMessage,
  ImapEnvelope,
  ImapFetchOptions,
  ImapSearchCriteria,
  ImapAppendResult,
  ImapStatusResult,
  ImapListEntry,
  QueueOptions,
  QueueJob,
  QueueStats,
  RetryBackoff,
  LogLevel,
  LogEvent,
  LogFormat,
  LoggerOptions,
} from './types/index.js';

// Errors
export {
  MailTsError,
  SmtpError,
  SmtpAuthError,
  SmtpConnError,
  SmtpRejectError,
  SmtpTimeoutError,
  SmtpTlsError,
  ImapError,
  QueueError,
  ConfigError,
  MimeError,
  TemplateError,
} from './errors.js';

// Logger
export { Logger } from './logger/Logger.js';
export { Redactor } from './logger/Redactor.js';

// SMTP
export { SmtpClient } from './smtp/SmtpClient.js';
export { SmtpPool } from './smtp/SmtpPool.js';
export { connectThroughProxy } from './smtp/SmtpProxy.js';

// Transports
export type { Transport, TransportResult } from './transports/Transport.js';
export {
  SmtpTransport,
  ResendTransport,
  PostmarkTransport,
  SendGridTransport,
  MailgunTransport,
  SesTransport,
} from './transports/index.js';
export type {
  ResendConfig,
  PostmarkConfig,
  SendGridConfig,
  MailgunConfig,
  SesConfig,
} from './transports/index.js';

// Core utilities
export { signDkim } from './core/Dkim.js';
export { htmlToText } from './core/HtmlToText.js';
export { buildICalString } from './core/ICal.js';

// IMAP
export { ImapClient } from './imap/ImapClient.js';
export { ImapSession } from './imap/ImapSession.js';

// Queue
export { MailQueue } from './queue/MailQueue.js';
export { RetryPolicy } from './queue/RetryPolicy.js';
export { DeadLetterQueue } from './queue/DeadLetterQueue.js';
