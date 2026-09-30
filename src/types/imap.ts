import type { TLSSocketOptions } from 'tls';
import type { EmailAddress } from './core.js';
import type { MailAuth } from './auth.js';

export interface ImapConfig {
  host: string;
  port?: number;
  secure?: boolean;
  /** Credentials — password (`plain`/`login`) or OAuth (`xoauth2` with `token` or `getToken`). */
  auth: MailAuth;
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
  /**
   * On a plain (non-`secure`) connection, upgrade with STARTTLS when offered and
   * refuse to log in in clear text otherwise. Defaults to `true`, except for
   * loopback hosts (`localhost`, `127.0.0.1`, `::1`), e.g. Proton Bridge.
   */
  requireTLS?: boolean;
  /**
   * `ImapSession` only: reconnect automatically when the connection drops.
   * The next operation re-connects, re-authenticates (calling `getToken` again)
   * and re-selects the mailbox. `false` disables. @default { retries: 3, delayMs: 1000 }
   */
  reconnect?: false | { retries?: number; delayMs?: number };
  /**
   * `ImapSession` only: send NOOP after this many ms of inactivity so NATs and
   * servers don't drop an idle connection. `0` disables. @default 0
   */
  keepAliveMs?: number;
}

export interface ImapMailboxStatus {
  name: string;
  flags: string[];
  /** Flags the client may change permanently (`\\*` = new keywords allowed). */
  permanentFlags?: string[];
  exists: number;
  recent: number;
  /**
   * Number of unseen messages. Only present when counted — `ImapSession.open()`
   * does; a plain SELECT does not report it.
   */
  unseen?: number;
  /** Sequence number of the first unseen message (`[UNSEEN n]` from SELECT). */
  firstUnseen?: number;
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
  /**
   * Message-IDs from the `References` header, oldest first. Populated by
   * `fetch({ bodies })`, `fetch({ headers: ['references'] })` and `parseMessage()`.
   */
  references?: string[];
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
  /** Additional search criteria (ignored when `uids` is given). */
  search?: ImapSearchCriteria;
  uids?: number[];
  seq?: string;
  /** Return only the newest `limit` matches (by UID). */
  limit?: number;
  /** Set `\\Seen` on the fetched messages. Fetching never marks mail read otherwise. */
  markSeen?: boolean;
  /**
   * Fetch the full message (`BODY.PEEK[]`, never sets `\\Seen`) and parse the
   * complete MIME body (text, html, attachments) plus `envelope.references`.
   */
  bodies?: boolean;
  /**
   * Extra header fields to fetch, e.g. `['References']` — populates
   * `envelope.references` without downloading the body.
   */
  headers?: string[];
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
  /** Mailbox name (modified UTF-7 decoded). */
  name: string;
  /** Hierarchy delimiter; `''` when the server reports NIL (flat namespace). */
  delimiter: string;
  flags: string[];
  /** RFC 6154 special-use attribute, e.g. `\\Sent`, `\\Drafts`, `\\Trash`. */
  specialUse?: string;
}
