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
} from './core.js';

export type {
  SmtpAuthType,
  SmtpAuth,
  SmtpPoolConfig,
  SmtpConfig,
  SmtpCapabilities,
  SmtpSendEnvelope,
  DkimConfig,
  ProxyConfig,
} from './smtp.js';

export type {
  ImapConfig,
  ImapMailboxStatus,
  ImapEnvelope,
  ImapBodyPart,
  ImapAttachment,
  ImapMessage,
  ImapAppendResult,
  ImapStatusResult,
  ImapFetchOptions,
  ImapSearchCriteria,
  ImapListEntry,
  BodyNode,
  BodyLeaf,
  BodyMultipart,
} from './imap.js';

export type {
  RetryBackoff,
  RetryPolicyOptions,
  DeadLetterOptions,
  QueueOptions,
  QueueJob,
  QueueStats,
  JobPriority,
  EnqueueOptions,
  ShutdownOptions,
  ShutdownResult,
  ShutdownPendingMode,
} from './queue.js';

export type { MailAuth, MailAuthType, TokenProvider, TokenContext } from './auth.js';

export type { LogLevel, LogPhase, LogDirection, LogEvent, LogFormat, LoggerOptions } from './logger.js';
export { LOG_LEVELS } from './logger.js';
