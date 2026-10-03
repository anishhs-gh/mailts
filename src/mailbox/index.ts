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
} from './Mailbox.js';
export { PollingWatcher } from './Mailbox.js';
export { imapMailbox } from './ImapMailbox.js';
export { GraphMailbox } from './GraphMailbox.js';
export type { GraphMailboxConfig } from './GraphMailbox.js';
export { GmailMailbox, toGmailQuery } from './GmailMailbox.js';
export type { GmailMailboxConfig } from './GmailMailbox.js';
