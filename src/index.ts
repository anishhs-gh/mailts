// Main entry point — re-export everything public

export { MailTs } from './core/MailTs.js';
export type { MailTsConfig, SendCallOptions } from './core/MailTs.js';
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
  JobPriority,
  EnqueueOptions,
  RetryBackoff,
  LogLevel,
  LogEvent,
  LogFormat,
  LoggerOptions,
  MailAuth,
  MailAuthType,
  TokenProvider,
  TokenContext,
  ShutdownOptions,
  ShutdownResult,
  ShutdownPendingMode,
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
  ImapAuthError,
  ImapConnError,
  QueueError,
  OAuthError,
  LimitError,
  TransportError,
  ConfigError,
  MimeError,
  TemplateError,
} from './errors.js';

// Logger
export { Logger } from './logger/Logger.js';
export { Redactor } from './logger/Redactor.js';

// SMTP
export { SmtpClient } from './smtp/SmtpClient.js';
export type { SmtpSendResult, SmtpSendOptions } from './smtp/SmtpClient.js';
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
  GraphTransport,
  GmailTransport,
} from './transports/index.js';
export type {
  ResendConfig,
  PostmarkConfig,
  SendGridConfig,
  MailgunConfig,
  SesConfig,
  GraphTransportConfig,
  GmailTransportConfig,
} from './transports/index.js';

// Core utilities
export { buildMessage } from './core/Message.js';
export { unsubscribeHeaders, isOneClickUnsubscribe } from './core/Unsubscribe.js';
export { buildReply, buildForward, stripSubjectPrefixes } from './core/Reply.js';
export type { ReplyOptions, ForwardOptions, SourceMessage } from './core/Reply.js';
export type { UnsubscribeOptions } from './core/Unsubscribe.js';
export type { BuiltMessage, BuildOptions } from './core/Message.js';
export type { AttachmentPathPolicy } from './core/Attachment.js';
export { parseMessage, parseAddressHeader, MimeHeaders, envelopeFromHeaders } from './core/MimeParser.js';
export type { ParsedMessage, MimePart, MimeLimits } from './core/MimeParser.js';
export { signDkim } from './core/Dkim.js';
export { htmlToText } from './core/HtmlToText.js';
export { buildICalString } from './core/ICal.js';

// IMAP
export { ImapClient } from './imap/ImapClient.js';
export { ImapSession } from './imap/ImapSession.js';
export { ImapPool } from './imap/ImapPool.js';
export type { ImapPoolOptions, ImapPoolStats, ImapConfigSource } from './imap/ImapPool.js';
export { MailboxWatcher } from './imap/MailboxWatcher.js';
export type { ImapLimits } from './imap/ImapParser.js';
export type { WatchOptions } from './imap/MailboxWatcher.js';
export { parseBodyStructure } from './imap/ImapBodyStructure.js';
export type { BodyNode, BodyLeaf, BodyMultipart } from './imap/ImapBodyStructure.js';

// Queue
export { MailQueue } from './queue/MailQueue.js';
export { RetryPolicy } from './queue/RetryPolicy.js';
export { DeadLetterQueue } from './queue/DeadLetterQueue.js';
export { SqliteQueue, resolveQueueDbPath } from './queue/SqliteQueue.js';
export { JobController } from './queue/JobController.js';
export type { ControlReason } from './queue/JobController.js';
export { MailWorker } from './queue/MailWorker.js';
export { encodeOptions, decodeOptions, encodeJob, decodeJob } from './queue/JobCodec.js';
export type { MailWorkerConfig } from './queue/MailWorker.js';
export type { QueueDriver, DriverMessage } from './queue/QueueDriver.js';

// Health
export { HealthChecker } from './health/HealthChecker.js';
export type { HealthResult, SmtpHealth, ImapHealth } from './health/HealthChecker.js';

// Telemetry
export type { TelemetryHooks } from './telemetry/index.js';

// Provider-neutral mailbox API — IMAP, Microsoft Graph, Gmail API
export { imapMailbox, PollingWatcher, GraphMailbox, GmailMailbox, toGmailQuery } from './mailbox/index.js';
export type {
  Mailbox,
  MailboxProvider,
  MailFolder,
  MailFolderStatus,
  MailMessage,
  MailSearch,
  MailFetchOptions,
  MailAppendOptions,
  MailWatcher,
  GraphMailboxConfig,
  GmailMailboxConfig,
} from './mailbox/index.js';
