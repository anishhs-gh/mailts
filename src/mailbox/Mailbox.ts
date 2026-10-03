/**
 * Provider-neutral mailbox API. Implemented by:
 * - `imapMailbox(session)` — any IMAP server
 * - `GraphMailbox` — Microsoft 365 / Outlook via Microsoft Graph
 * - `GmailMailbox` — Gmail / Google Workspace via the Gmail API
 *
 * Code written against `Mailbox` works with all three. Message ids are opaque
 * strings scoped to the provider (an IMAP UID, a Graph id, a Gmail id).
 */
import { EventEmitter } from 'events';
import type { ImapAttachment, ImapEnvelope } from '../types/imap.js';

/** Backend behind a `Mailbox`. */
export type MailboxProvider = 'imap' | 'graph' | 'gmail';

/** A folder (IMAP mailbox, Graph mail folder, Gmail label). */
export interface MailFolder {
  /** Provider id (IMAP: the name; Graph: folder id; Gmail: label id). */
  id: string;
  /** Display name / path. */
  name: string;
  /** RFC 6154-style role: `\\Sent`, `\\Drafts`, `\\Trash`, `\\Junk`, `\\Archive`, `\\Flagged`, … */
  specialUse?: string;
}

/** Message counts of a folder. */
export interface MailFolderStatus {
  /** Messages in the folder. */
  total?: number;
  /** Unread messages. */
  unread?: number;
}

/** A message in provider-neutral form. Flags use IMAP names (`\\Seen`, `\\Flagged`, `\\Draft`, `\\Answered`). */
export interface MailMessage {
  /** Provider message id (IMAP: the UID as a string; Graph: message id; Gmail: message id). */
  id: string;
  /** Folder the message was fetched from (for IMAP, ids are only unique within it). */
  mailbox: string;
  /** IMAP-style flags (`\\Seen`, `\\Flagged`, `\\Draft`, `\\Answered`). */
  flags: string[];
  /** Parsed headers: from, to, subject, date, message ids. */
  envelope: ImapEnvelope;
  /** Received / internal date. */
  date: Date | null;
  /** Size in bytes, when the provider reports it. */
  size?: number;
  /** Provider thread / conversation id when available (Gmail threadId, Graph conversationId). */
  threadId?: string;
  /** Short text preview when the provider supplies one. */
  snippet?: string;
  /** Present when fetched with `bodies: true`. */
  body?: { text?: string; html?: string; attachments: ImapAttachment[] };
}

/** Search criteria every provider supports. */
export interface MailSearch {
  /** `true` = read only, `false` = unread only. */
  seen?: boolean;
  /** `true` = flagged / starred only, `false` = not flagged. */
  flagged?: boolean;
  /** Sender contains this text. */
  from?: string;
  /** Recipient contains this text. */
  to?: string;
  /** Subject contains this text. */
  subject?: string;
  /** Full-text match (subject + body). */
  text?: string;
  /** Received on or after this date. */
  since?: Date;
  /** Received before this date. */
  before?: Date;
}

/** What `Mailbox.fetch()` returns. */
export interface MailFetchOptions {
  /** Folder id or name; well-known names (`INBOX`, `Sent`, `Drafts`, `Trash`) resolve per provider. @default INBOX */
  mailbox?: string;
  /** Fetch these ids instead of searching. */
  ids?: string[];
  /** Only messages matching these criteria. */
  search?: MailSearch;
  /** Newest `limit` messages. @default 50 */
  limit?: number;
  /** Include text / html / attachments (downloads the full message). */
  bodies?: boolean;
}

/** Flags for `Mailbox.append()`. */
export interface MailAppendOptions {
  /** Mark as read. @default true */
  seen?: boolean;
  /** Store as a draft. */
  draft?: boolean;
}

/** Emits `new` (ids: string[]), `error` (Error); stop with `stop()`. */
export interface MailWatcher extends EventEmitter {
  /** Stop watching and release the connection / timer. */
  stop(): Promise<void>;
}

/**
 * One API for reading and organising mail over IMAP (`imapMailbox`), Microsoft Graph
 * (`GraphMailbox`, experimental) and the Gmail API (`GmailMailbox`).
 */
export interface Mailbox {
  /** Which backend this is. */
  readonly provider: MailboxProvider;
  /** All folders / labels. */
  listMailboxes(): Promise<MailFolder[]>;
  /** Resolve a well-known role (`\\Sent`, `\\Drafts`, …) to a folder id. */
  findMailbox(specialUse: string): Promise<string | undefined>;
  /** Total and unread counts of a folder. @default mailbox 'INBOX' */
  status(mailbox?: string): Promise<MailFolderStatus>;
  /** Newest messages of a folder (or `ids`), optionally filtered and with bodies. Never marks mail read. */
  fetch(opts?: MailFetchOptions): Promise<MailMessage[]>;
  /** Ids of messages matching `criteria`. */
  search(criteria: MailSearch, mailbox?: string): Promise<string[]>;
  /** Complete RFC 5322 source (for forwarding, archiving, `parseMessage`). */
  fetchRaw(id: string, mailbox?: string): Promise<Buffer>;
  /** Mark read (`true`) or unread (`false`). */
  setSeen(ids: string[], seen: boolean, mailbox?: string): Promise<void>;
  /** Flag / star (`true`) or clear it (`false`). */
  setFlagged(ids: string[], flagged: boolean, mailbox?: string): Promise<void>;
  /** Move messages to `destination` (folder id or well-known name). */
  move(ids: string[], destination: string, mailbox?: string): Promise<void>;
  /** Move to Trash (Graph / Gmail) or delete and expunge (IMAP). */
  delete(ids: string[], mailbox?: string): Promise<void>;
  /** Store a raw message in a folder (drafts, save-to-Sent). */
  append(mailbox: string, raw: Buffer, opts?: MailAppendOptions): Promise<{ id?: string }>;
  /** Watch a folder for new messages (push where available, else polling). */
  watch(mailbox?: string, opts?: { pollMs?: number }): Promise<MailWatcher>;
  /** Release connections. IMAP closes the session; HTTP providers have nothing to close. */
  close(): Promise<void>;
}

/**
 * Polling helper for mailbox implementations: run `check()` every `pollMs` and emit `new`
 * with the returned ids. Errors are emitted and polling continues.
 */
export class PollingWatcher extends EventEmitter implements MailWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly check: () => Promise<string[]>, private readonly pollMs: number) {
    super();
    this.on('error', () => {});
  }

  /** Run the first check now, then every `pollMs`. */
  start(): this {
    this.schedule(0);
    return this;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const ids = await this.check();
        if (ids.length && !this.stopped) this.emit('new', ids);
      } catch (err) {
        this.emit('error', err);
      }
      this.schedule(this.pollMs);
    }, ms);
  }

  /** Stop polling. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
