import type { TLSSocketOptions } from 'tls';
import type { EmailAddress } from './core.js';

export interface ImapConfig {
  host: string;
  port?: number;
  secure?: boolean;
  auth: {
    readonly type: 'plain' | 'login' | 'xoauth2';
    readonly user: string;
    readonly pass?: string;
    readonly token?: string;
  };
  /**
   * Milliseconds to wait for the TCP/TLS handshake to complete.
   * @default 10_000
   */
  connectionTimeout?: number;
  /**
   * Milliseconds to wait for a server reply after sending a command.
   * @default 30_000
   */
  socketTimeout?: number;
  tls?: TLSSocketOptions;
}

export interface ImapMailboxStatus {
  name: string;
  flags: string[];
  exists: number;
  recent: number;
  unseen: number;
  uidValidity: number;
  uidNext: number;
  readOnly: boolean;
  /** CONDSTORE: highest mod-sequence value in the mailbox. */
  highestModSeq?: number;
}

export interface ImapEnvelope {
  date: Date | null;
  subject: string;
  from: EmailAddress[];
  sender: EmailAddress[];
  replyTo: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  inReplyTo: string | null;
  messageId: string | null;
}

export interface ImapBodyPart {
  contentType: string;
  charset?: string;
  content: string;
  encoding?: string;
}

export interface ImapAttachment {
  filename: string;
  contentType: string;
  size: number;
  content?: Buffer;
  /** Present on `Content-Disposition: inline` parts — the bare Content-ID value (no angle brackets). */
  contentId?: string;
  /** True when the part carries `Content-Disposition: inline` (embedded resource rather than download). */
  inline?: boolean;
  /** Populated for `content-type: message/rfc822` parts (forwarded / bounced emails). */
  nestedMessage?: {
    envelope: ImapEnvelope;
    body?: {
      text?: string;
      html?: string;
      attachments: ImapAttachment[];
    };
  };
}

export interface ImapMessage {
  uid: number;
  seq: number;
  flags: string[];
  envelope: ImapEnvelope;
  body?: {
    text?: string;
    html?: string;
    attachments: ImapAttachment[];
  };
  /** Populated when fetched with `structure: true`. Full MIME tree with section numbers. */
  structure?: import('../imap/ImapBodyStructure.js').BodyNode;
  size: number;
  internalDate: Date | null;
  /** CONDSTORE: mod-sequence for this message. */
  modSeq?: number;
}

export interface ImapAppendResult {
  /** UIDVALIDITY of the destination mailbox (from APPENDUID). */
  uidValidity?: number;
  /** UID assigned to the appended message (from APPENDUID). */
  uid?: number;
}

export interface ImapStatusResult {
  messages?: number;
  recent?: number;
  unseen?: number;
  uidNext?: number;
  uidValidity?: number;
  highestModSeq?: number;
}

export type { BodyNode, BodyLeaf, BodyMultipart } from '../imap/ImapBodyStructure.js';

export interface ImapFetchOptions {
  /**
   * Mailbox to operate on.  Defaults to `'INBOX'` if no mailbox has been
   * explicitly opened.  The session auto-selects this mailbox if it is not
   * already selected.
   */
  mailbox?: string;
  seen?: boolean;
  uids?: number[];
  seq?: string;
  limit?: number;
  markSeen?: boolean;
  /** Fetch full RFC822 message and parse the complete MIME body (text, html, attachments). */
  bodies?: boolean;
  /** Fetch BODYSTRUCTURE only — populates `message.structure`, no body content transferred. */
  structure?: boolean;
  /**
   * Fetch text/plain and text/html parts only via selective BODY[n] section fetches.
   * Much more bandwidth-efficient than `bodies: true` for large messages with attachments.
   * Populates `message.body.text` / `message.body.html` and `message.structure`.
   */
  textOnly?: boolean;
}

export interface ImapSearchCriteria {
  seen?: boolean;
  unseen?: boolean;
  flagged?: boolean;
  unflagged?: boolean;
  answered?: boolean;
  deleted?: boolean;
  draft?: boolean;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  text?: string;
  since?: Date;
  before?: Date;
  sentSince?: Date;
  sentBefore?: Date;
  larger?: number;
  smaller?: number;
  uid?: string;
  header?: { name: string; value: string };
  not?: ImapSearchCriteria;
  or?: [ImapSearchCriteria, ImapSearchCriteria];
}

export interface ImapListEntry {
  name: string;
  delimiter: string;
  flags: string[];
}
