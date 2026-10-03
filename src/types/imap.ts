import type { TLSSocketOptions } from 'tls';
import type { EmailAddress } from './core.js';
import type { MailAuth } from './auth.js';
import type { ImapLimits } from '../imap/ImapParser.js';

/** Connection settings for `ImapClient`, `ImapSession`, `MailboxWatcher` and `ImapPool`. */
export interface ImapConfig {
  /** Server hostname, e.g. `imap.gmail.com`. */
  host: string;
  /** Server port. @default 993 when `secure`, otherwise 143 */
  port?: number;
  /** Connect with implicit TLS (port 993). `false` uses plain TCP + STARTTLS (see `requireTLS`). @default true */
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
  /** TLS options. `minVersion` defaults to `'TLSv1.2'`. */
  tls?: TLSSocketOptions;
  /**
   * Size limits for server responses (protects against hostile or broken
   * servers). Exceeding one fails the command with `LimitError` and closes the
   * connection. Defaults: 64 MiB literal, 128 MiB response, 1 MiB line.
   */
  limits?: ImapLimits;
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
   * Re-issue IDLE this often (ms). Shorter values survive aggressive NAT /
   * firewall idle timeouts; must stay below 29 minutes (RFC 2177). @default 540_000 (9 min)
   */
  idleRenewalMs?: number;
  /**
   * `ImapSession` only: send NOOP after this many ms of inactivity so NATs and
   * servers don't drop an idle connection. `0` disables. @default 0
   */
  keepAliveMs?: number;
}

/** State of a selected mailbox, returned by `open()` / `openReadOnly()`. */
export interface ImapMailboxStatus {
  /** Mailbox name as selected. */
  name: string;
  /** Flags defined in the mailbox (`\\Seen`, `\\Flagged`, custom keywords…). */
  flags: string[];
  /** Flags the client may change permanently (`\\*` = new keywords allowed). */
  permanentFlags?: string[];
  /** Number of messages in the mailbox. */
  exists: number;
  /** Messages with the `\\Recent` flag (new since the last session). */
  recent: number;
  /**
   * Number of unseen messages. Only present when counted — `ImapSession.open()`
   * does; a plain SELECT does not report it.
   */
  unseen?: number;
  /** Sequence number of the first unseen message (`[UNSEEN n]` from SELECT). */
  firstUnseen?: number;
  /** UIDVALIDITY: when it changes, previously stored UIDs are no longer valid — resync. */
  uidValidity: number;
  /** UID the next arriving message will get. */
  uidNext: number;
  /** `true` when opened with EXAMINE (`openReadOnly()`) or the server refused write access. */
  readOnly: boolean;
  /** CONDSTORE: highest mod-sequence value in the mailbox. */
  highestModSeq?: number;
}

/** Parsed message headers (IMAP ENVELOPE). Encoded words are decoded. */
export interface ImapEnvelope {
  /** `Date` header, or `null` when missing or unparseable. */
  date: Date | null;
  /** Decoded `Subject` (empty string when missing). */
  subject: string;
  /** `From` addresses. */
  from: EmailAddress[];
  /** `Sender` (the actual submitter when it differs from From). */
  sender: EmailAddress[];
  /** `Reply-To` addresses. */
  replyTo: EmailAddress[];
  /** `To` addresses. */
  to: EmailAddress[];
  /** `Cc` addresses. */
  cc: EmailAddress[];
  /** `Bcc` addresses (usually only present on sent/draft copies). */
  bcc: EmailAddress[];
  /** `In-Reply-To` Message-ID, with angle brackets. */
  inReplyTo: string | null;
  /** `Message-ID`, with angle brackets. */
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

/** A fetched message. Which fields are filled depends on the fetch options. */
export interface ImapMessage {
  /** Unique id within the mailbox (stable while `uidValidity` is unchanged). */
  uid: number;
  /** Message sequence number (position; changes when messages are expunged). */
  seq: number;
  /** Flags such as `\\Seen`, `\\Flagged`, `\\Answered`, `\\Draft` and custom keywords. */
  flags: string[];
  /** Parsed headers. */
  envelope: ImapEnvelope;
  /** Decoded body — filled by `fetch({ bodies: true })` or `textOnly: true`. */
  body?: {
    text?: string;
    html?: string;
    attachments: ImapAttachment[];
  };
  /** Populated when fetched with `structure: true`. Full MIME tree with section numbers. */
  structure?: import('../imap/ImapBodyStructure.js').BodyNode;
  /** Size of the full message in bytes (RFC822.SIZE). */
  size: number;
  /** When the server received the message (INTERNALDATE). */
  internalDate: Date | null;
  /** CONDSTORE: mod-sequence for this message. */
  modSeq?: number;
}

/** Result of `append()` / `appendMessage()`. Fields are set when the server supports UIDPLUS. */
export interface ImapAppendResult {
  /** UIDVALIDITY of the destination mailbox (from APPENDUID). */
  uidValidity?: number;
  /** UID assigned to the appended message (from APPENDUID). */
  uid?: number;
}

/** Counters from `getStatus()` (IMAP STATUS) — read without selecting the mailbox. Only requested items are set. */
export interface ImapStatusResult {
  /** Number of messages. */
  messages?: number;
  /** Messages with `\\Recent`. */
  recent?: number;
  /** Messages without `\\Seen`. */
  unseen?: number;
  /** UID the next message will get. */
  uidNext?: number;
  /** Current UIDVALIDITY. */
  uidValidity?: number;
  /** CONDSTORE: highest mod-sequence. */
  highestModSeq?: number;
}

export type { BodyNode, BodyLeaf, BodyMultipart } from '../imap/ImapBodyStructure.js';

/** What `ImapSession.fetch()` selects and how much of each message it downloads. */
export interface ImapFetchOptions {
  /**
   * Mailbox to operate on.  Defaults to `'INBOX'` if no mailbox has been
   * explicitly opened.  The session auto-selects this mailbox if it is not
   * already selected.
   */
  mailbox?: string;
  /** `false` = unread only, `true` = read only, unset = all. */
  seen?: boolean;
  /** Additional search criteria (ignored when `uids` is given). */
  search?: ImapSearchCriteria;
  /** Fetch exactly these UIDs (skips searching). */
  uids?: number[];
  /** Sequence set, e.g. `'1:10'` or `'5,7,9'`. */
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

/**
 * IMAP SEARCH criteria. All given criteria must match (AND); use `or` / `not` to combine.
 * Text matches are case-insensitive substrings; non-ASCII is sent as UTF-8.
 */
export interface ImapSearchCriteria {
  /** Has `\\Seen`. */
  seen?: boolean;
  /** Lacks `\\Seen`. */
  unseen?: boolean;
  /** Has `\\Flagged`. */
  flagged?: boolean;
  /** Lacks `\\Flagged`. */
  unflagged?: boolean;
  /** Has `\\Answered`. */
  answered?: boolean;
  /** Has `\\Deleted` (marked, not yet expunged). */
  deleted?: boolean;
  /** Has `\\Draft`. */
  draft?: boolean;
  /** `From` contains this text. */
  from?: string;
  /** `To` contains this text. */
  to?: string;
  /** `Cc` contains this text. */
  cc?: string;
  /** `Subject` contains this text. */
  subject?: string;
  /** Body contains this text. */
  body?: string;
  /** Headers or body contain this text. */
  text?: string;
  /** Received on or after this date (date part only, server time zone). */
  since?: Date;
  /** Received before this date. */
  before?: Date;
  /** `Date` header on or after this date. */
  sentSince?: Date;
  /** `Date` header before this date. */
  sentBefore?: Date;
  /** Larger than this many bytes. */
  larger?: number;
  /** Smaller than this many bytes. */
  smaller?: number;
  /** UID set, e.g. `'100:*'`. */
  uid?: string;
  /** Header `name` contains `value`. */
  header?: { name: string; value: string };
  /** Messages that do not match these criteria. */
  not?: ImapSearchCriteria;
  /** Messages matching either set of criteria. */
  or?: [ImapSearchCriteria, ImapSearchCriteria];
}

/** A mailbox from `listMailboxes()` / `listSubscribed()`. */
export interface ImapListEntry {
  /** Mailbox name (modified UTF-7 decoded). */
  name: string;
  /** Hierarchy delimiter; `''` when the server reports NIL (flat namespace). */
  delimiter: string;
  /** LIST attributes, e.g. `\\HasChildren`, `\\Noselect`, `\\Sent`. */
  flags: string[];
  /** RFC 6154 special-use attribute, e.g. `\\Sent`, `\\Drafts`, `\\Trash`. */
  specialUse?: string;
}
