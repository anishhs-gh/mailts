import { EventEmitter } from 'events';
import { ImapClient } from './ImapClient.js';
import { MailboxWatcher, type WatchOptions } from './MailboxWatcher.js';
import type { BodyLeaf, BodyMultipart, BodyNode } from './ImapBodyStructure.js';
import { decodeTransfer, decodeText } from '../core/MimeParser.js';
import { buildMessage } from '../core/Message.js';
import type { AttachmentPathPolicy } from '../core/Attachment.js';
import type { Logger } from '../logger/Logger.js';
import type { EmailOptions } from '../types/core.js';
import type {
  ImapConfig,
  ImapMailboxStatus,
  ImapMessage,
  ImapFetchOptions,
  ImapSearchCriteria,
  ImapListEntry,
  ImapAppendResult,
  ImapStatusResult,
} from '../types/imap.js';
import { ImapConnError, ImapAuthError, ImapError } from '../errors.js';

const DEFAULT_MAILBOX = 'INBOX';
const BASE_ITEMS = 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE';

/** Fallback names when the server does not advertise RFC 6154 special-use flags. */
const SPECIAL_USE_FALLBACK: Record<string, string[]> = {
  '\\Sent': ['Sent', 'Sent Items', 'Sent Messages', 'Sent Mail', '[Gmail]/Sent Mail', 'INBOX.Sent'],
  '\\Drafts': ['Drafts', '[Gmail]/Drafts', 'INBOX.Drafts'],
  '\\Trash': ['Trash', 'Deleted Items', 'Deleted Messages', '[Gmail]/Trash', 'INBOX.Trash'],
  '\\Junk': ['Junk', 'Spam', 'Junk Email', '[Gmail]/Spam', 'INBOX.Junk'],
  '\\Archive': ['Archive', 'Archives', '[Gmail]/All Mail', 'INBOX.Archive'],
};

/** Mailbox names are case-sensitive, except INBOX (RFC 3501 §5.1). */
function sameMailbox(a: string, b: string): boolean {
  return a.toUpperCase() === 'INBOX' && b.toUpperCase() === 'INBOX' ? true : a === b;
}

/**
 * High-level IMAP session with automatic mailbox selection, locking and
 * reconnection.
 *
 * - Connects lazily on first use (or explicitly via `connect()`).
 * - Operations that need a mailbox accept an optional `mailbox` (default `'INBOX'`)
 *   and auto-select it under a session lock, so concurrent calls never race.
 * - When the connection drops, the next operation reconnects, re-authenticates
 *   (calling `getToken` again for OAuth) and re-selects. An operation that was
 *   in flight when the connection dropped is **not** retried — it rejects with a
 *   retryable `ImapConnError` so callers decide (APPEND/MOVE are not idempotent).
 *
 * Events: `reconnect` (attempt), `close`, `error`.
 *
 * @example
 * ```ts
 * const session = mail.imap;
 * const unread = await session.fetch({ seen: false, bodies: true });
 * await session.move(unread.map(m => m.uid), 'Archive');
 * await session.close();
 * ```
 */
export class ImapSession extends EventEmitter {
  private client: ImapClient | null = null;
  private connecting: Promise<ImapClient> | null = null;
  private currentMailbox: ImapMailboxStatus | null = null;
  private idleWatcher: MailboxWatcher | null = null;
  private closed = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();

  /** Session-level lock: SELECT + the following commands run atomically. */
  private sessionLock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ImapConfig,
    private readonly logger?: Logger,
    /** `attachmentPolicy` for `appendMessage()` with `path` attachments (unset rejects them). */
    private readonly options: { attachmentPolicy?: AttachmentPathPolicy } = {},
  ) {
    super();
    this.on('error', () => {});
  }

  /** Open the IMAP connection and authenticate. Optional — operations connect lazily. */
  async connect(): Promise<void> {
    this.closed = false;
    await this.ensureClient();
  }

  /** `true` while the underlying connection is open. */
  get isConnected(): boolean {
    return this.client?.isConnected ?? false;
  }

  // ─── Connection management ────────────────────────────────────────────────

  private async ensureClient(): Promise<ImapClient> {
    if (this.closed) throw new ImapError('Session is closed');
    if (this.client?.isConnected) return this.client;
    if (this.connecting) return this.connecting;

    const reconnect = this.config.reconnect === false ? { retries: 0, delayMs: 0 } : {
      retries: this.config.reconnect?.retries ?? 3,
      delayMs: this.config.reconnect?.delayMs ?? 1_000,
    };
    const wasConnected = this.client !== null;

    this.connecting = (async () => {
      let attempt = 0;
      for (;;) {
        const client = new ImapClient(this.config, this.logger);
        try {
          if (wasConnected || attempt > 0) this.emit('reconnect', attempt + 1);
          await client.connect();
          client.on('close', () => {
            if (this.client === client) {
              this.currentMailbox = null;
              this.emit('close');
            }
          });
          this.client = client;
          this.currentMailbox = null;
          this.startKeepAlive();
          return client;
        } catch (err) {
          const retryable = err instanceof ImapConnError && !(err instanceof ImapAuthError);
          if (!retryable || attempt >= reconnect.retries) throw err;
          this.emit('error', err);
          await new Promise(r => setTimeout(r, reconnect.delayMs * 2 ** attempt));
          attempt++;
        }
      }
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private startKeepAlive(): void {
    const ms = this.config.keepAliveMs ?? 0;
    if (ms <= 0 || this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastActivity < ms || !this.client?.isConnected) return;
      this.locked(c => c.noop()).catch(() => {});
    }, Math.max(1_000, Math.floor(ms / 2)));
    this.keepAliveTimer.unref?.();
  }

  /** Run `fn` under the session lock with a connected client. */
  private locked<T>(fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const result = this.sessionLock.then(async () => {
      const client = await this.ensureClient();
      this.lastActivity = Date.now();
      return fn(client);
    });
    this.sessionLock = result.then(() => {}, () => {});
    return result;
  }

  /** Acquire the lock, auto-select `mailbox` if needed, then run `fn`. */
  private withMailbox<T>(mailbox: string, fn: (client: ImapClient) => Promise<T>): Promise<T> {
    return this.locked(async (client) => {
      if (!this.currentMailbox || !client.selectedMailbox || !sameMailbox(this.currentMailbox.name, mailbox)) {
        this.currentMailbox = await client.select(mailbox);
      }
      return fn(client);
    });
  }

  private mailboxOr(mailbox?: string): string {
    return mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  /** Return the server's CAPABILITY set. */
  async getCapabilities(): Promise<Set<string>> {
    return this.locked(c => c.getCapabilities());
  }

  // ─── Mailbox listing ───────────────────────────────────────────────────────

  /** List mailboxes matching `pattern` under `ref`. Defaults to all mailboxes. */
  async listMailboxes(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    return this.locked(c => c.list(ref, pattern));
  }

  /** List subscribed mailboxes matching `pattern` under `ref`. */
  async listSubscribed(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    return this.locked(c => c.listSubscribed(ref, pattern));
  }

  /**
   * Find the mailbox with an RFC 6154 special-use role (`\\Sent`, `\\Drafts`,
   * `\\Trash`, `\\Junk`, `\\Archive`, …), falling back to common names.
   * Returns `undefined` when none exists.
   */
  async findMailbox(specialUse: string): Promise<string | undefined> {
    const boxes = await this.listMailboxes();
    const want = specialUse.toLowerCase();
    const byFlag = boxes.find(b => b.specialUse?.toLowerCase() === want || b.flags.some(f => f.toLowerCase() === want));
    if (byFlag) return byFlag.name;
    const key = Object.keys(SPECIAL_USE_FALLBACK).find(k => k.toLowerCase() === want);
    for (const name of key ? SPECIAL_USE_FALLBACK[key]! : []) {
      const hit = boxes.find(b => b.name.toLowerCase() === name.toLowerCase());
      if (hit) return hit.name;
    }
    return undefined;
  }

  // ─── Mailbox management ────────────────────────────────────────────────────

  /** Create a new mailbox. Throws if it already exists. */
  async createMailbox(mailbox: string): Promise<void> {
    await this.locked(c => c.createMailbox(mailbox));
  }

  /** Delete a mailbox and all its messages. */
  async deleteMailbox(mailbox: string): Promise<void> {
    await this.locked(async c => {
      await c.deleteMailbox(mailbox);
      if (this.currentMailbox && sameMailbox(this.currentMailbox.name, mailbox)) this.currentMailbox = null;
    });
  }

  /** Rename mailbox `from` to `to`. */
  async renameMailbox(from: string, to: string): Promise<void> {
    await this.locked(c => c.renameMailbox(from, to));
  }

  /** Subscribe to a mailbox. */
  async subscribe(mailbox: string): Promise<void> {
    await this.locked(c => c.subscribe(mailbox));
  }

  /** Unsubscribe from a mailbox. */
  async unsubscribe(mailbox: string): Promise<void> {
    await this.locked(c => c.unsubscribe(mailbox));
  }

  // ─── Mailbox selection ─────────────────────────────────────────────────────

  /**
   * Select a mailbox and return fresh status, including the `unseen` count.
   * Regular operations auto-select without needing this.
   */
  async open(mailbox = DEFAULT_MAILBOX): Promise<ImapMailboxStatus> {
    return this.locked(async (c) => {
      const counts = await c.getStatus(mailbox, ['UNSEEN']).catch(() => ({} as ImapStatusResult));
      const status = await c.select(mailbox);
      if (counts.unseen !== undefined) status.unseen = counts.unseen;
      this.currentMailbox = status;
      return status;
    });
  }

  /**
   * Open a mailbox read-only (EXAMINE). Flag changes are not allowed while in
   * this mode; the next write operation re-selects read-write.
   */
  async openReadOnly(mailbox = DEFAULT_MAILBOX): Promise<ImapMailboxStatus> {
    return this.locked(async (c) => {
      this.currentMailbox = await c.examine(mailbox);
      return this.currentMailbox;
    });
  }

  /** Get STATUS of any mailbox without selecting it. */
  async getStatus(mailbox: string, items?: string[]): Promise<ImapStatusResult> {
    return this.locked(c => c.getStatus(mailbox, items));
  }

  // ─── Fetch & search ────────────────────────────────────────────────────────

  /**
   * Fetch messages. Auto-selects `opts.mailbox` (default: current or `'INBOX'`).
   * Never sets `\\Seen` unless `markSeen: true`.
   */
  async fetch(opts: ImapFetchOptions = {}): Promise<ImapMessage[]> {
    const mailbox = this.mailboxOr(opts.mailbox);
    return this.withMailbox(mailbox, async (client) => {
      let uids: number[];
      if (opts.uids) {
        uids = opts.uids;
      } else {
        const query: ImapSearchCriteria = { ...(opts.search ?? {}) };
        if (opts.seen === true) query.seen = true;
        if (opts.seen === false) query.unseen = true;
        uids = await client.search(query);
        uids.sort((a, b) => a - b);
        if (opts.limit !== undefined) uids = opts.limit > 0 ? uids.slice(-opts.limit) : [];
      }
      if (uids.length === 0) return [];

      let messages: ImapMessage[];
      if (opts.textOnly) {
        messages = await this.fetchTextOnly(client, uids);
      } else {
        const headerItem = opts.headers?.length
          ? ` BODY.PEEK[HEADER.FIELDS (${opts.headers.map(h => h.replace(/[^A-Za-z0-9-]/g, '')).join(' ')})]`
          : '';
        const items = BASE_ITEMS
          + (opts.structure ? ' BODYSTRUCTURE' : '')
          + (opts.bodies ? ' BODY.PEEK[]' : '')
          + headerItem;
        messages = await client.fetch(uids, items);
      }

      if (opts.markSeen) await client.setFlagsSilent(uids, ['\\Seen'], true);
      return messages;
    });
  }

  private async fetchTextOnly(client: ImapClient, uids: number[]): Promise<ImapMessage[]> {
    const messages = await client.fetch(uids, `${BASE_ITEMS} BODYSTRUCTURE`);

    const leaves = new Map<number, { text?: BodyLeaf; html?: BodyLeaf }>();
    const sections = new Set<string>();
    for (const msg of messages) {
      if (!msg.structure) continue;
      const text = findLeaf(msg.structure, 'text/plain');
      const html = findLeaf(msg.structure, 'text/html');
      leaves.set(msg.uid, { text, html });
      if (text) sections.add(text.section);
      if (html) sections.add(html.section);
    }
    if (sections.size === 0) return messages;

    const fetched = await client.fetchSections(uids, [...sections]);
    for (const msg of messages) {
      const entry = leaves.get(msg.uid);
      if (!entry) continue;
      const bySection = fetched.get(msg.uid);
      msg.body = { attachments: [] };
      const decode = (leaf: BodyLeaf | undefined) => {
        const raw = leaf ? bySection?.get(leaf.section) : undefined;
        if (!leaf || !raw) return undefined;
        return decodeText(decodeTransfer(raw.toString('latin1'), leaf.encoding), leaf.charset);
      };
      const text = decode(entry.text);
      const html = decode(entry.html);
      if (text !== undefined) msg.body.text = text;
      if (html !== undefined) msg.body.html = html;
    }
    return messages;
  }

  /** Search `mailbox` (default: current or `'INBOX'`) and return matching UIDs. */
  async search(criteria: ImapSearchCriteria, mailbox?: string): Promise<number[]> {
    return this.withMailbox(this.mailboxOr(mailbox), c => c.search(criteria));
  }

  /** Fetch the MIME structure tree for a single message without downloading content. */
  async fetchStructure(uid: number, mailbox?: string): Promise<BodyNode | undefined> {
    return this.withMailbox(this.mailboxOr(mailbox), async (c) => (await c.fetchBodyStructure([uid])).get(uid));
  }

  /**
   * Fetch one MIME section as raw bytes (still transfer-encoded). Uses BODY.PEEK —
   * never sets `\\Seen`. `section` is `"1"`, `"2"`, `"3.1"`, … — or `''` for the
   * complete RFC 5322 message (useful for forwarding and `parseMessage()`).
   */
  async fetchSection(uid: number, section: string, mailbox?: string): Promise<Buffer> {
    return this.withMailbox(this.mailboxOr(mailbox), c => c.fetchSection(uid, section));
  }

  /** Fetch the complete raw RFC 5322 source of a message (`BODY.PEEK[]`). */
  async fetchRaw(uid: number, mailbox?: string): Promise<Buffer> {
    return this.fetchSection(uid, '', mailbox);
  }

  /**
   * Fetch text/plain and text/html parts only — no attachment bytes transferred.
   * Also populates `message.structure` with the full MIME tree.
   */
  async fetchText(uids: number[], mailbox?: string): Promise<ImapMessage[]> {
    return this.withMailbox(this.mailboxOr(mailbox), c => this.fetchTextOnly(c, uids));
  }

  /** Fetch messages changed since a CONDSTORE mod-sequence. */
  async fetchChanged(modseq: number, mailbox?: string, uids = '1:*'): Promise<ImapMessage[]> {
    return this.withMailbox(this.mailboxOr(mailbox), c => c.fetchChanged(uids, modseq));
  }

  // ─── Flag operations ───────────────────────────────────────────────────────

  /** Mark UIDs as seen. */
  async markSeen(uids: number[], mailbox?: string): Promise<void> {
    return this.setFlags(uids, ['\\Seen'], true, mailbox);
  }

  /** Mark UIDs as unseen. */
  async markUnseen(uids: number[], mailbox?: string): Promise<void> {
    return this.setFlags(uids, ['\\Seen'], false, mailbox);
  }

  /** Set \\Flagged on UIDs. */
  async markFlagged(uids: number[], mailbox?: string): Promise<void> {
    return this.setFlags(uids, ['\\Flagged'], true, mailbox);
  }

  /** Clear \\Flagged on UIDs. */
  async markUnflagged(uids: number[], mailbox?: string): Promise<void> {
    return this.setFlags(uids, ['\\Flagged'], false, mailbox);
  }

  /** Set or remove arbitrary flags. */
  async setFlags(uids: number[], flags: string[], add: boolean, mailbox?: string): Promise<void> {
    return this.withWritable(this.mailboxOr(mailbox), c => c.setFlags(uids, flags, add));
  }

  /** Like `withMailbox`, but re-selects read-write when the mailbox was EXAMINEd. */
  private withWritable<T>(mailbox: string, fn: (client: ImapClient) => Promise<T>): Promise<T> {
    return this.locked(async (client) => {
      const cur = this.currentMailbox;
      if (!cur || !client.selectedMailbox || !sameMailbox(cur.name, mailbox) || cur.readOnly) {
        this.currentMailbox = await client.select(mailbox);
      }
      return fn(client);
    });
  }

  // ─── Copy / Move / Delete ──────────────────────────────────────────────────

  /** Copy UIDs to `destMailbox` from `sourceMailbox` (default: current or INBOX). */
  async copy(uids: number[], destMailbox: string, sourceMailbox?: string): Promise<void> {
    return this.withMailbox(this.mailboxOr(sourceMailbox), c => c.copy(uids, destMailbox));
  }

  /** Move UIDs to `destMailbox` (MOVE extension, or COPY + delete). */
  async move(uids: number[], destMailbox: string, sourceMailbox?: string): Promise<void> {
    return this.withWritable(this.mailboxOr(sourceMailbox), c => c.move(uids, destMailbox));
  }

  /**
   * Mark UIDs \\Deleted and expunge **only those UIDs** (UIDPLUS); without UIDPLUS
   * a plain EXPUNGE runs, which also removes other messages already flagged \\Deleted.
   */
  async delete(uids: number[], mailbox?: string): Promise<void> {
    return this.withWritable(this.mailboxOr(mailbox), async (c) => {
      await c.setFlagsSilent(uids, ['\\Deleted'], true);
      await c.expungeUids(uids);
    });
  }

  /** Expunge all messages flagged \\Deleted. */
  async expunge(mailbox?: string): Promise<void> {
    return this.withWritable(this.mailboxOr(mailbox), c => c.expunge());
  }

  // ─── Append ────────────────────────────────────────────────────────────────

  /**
   * Upload a raw RFC 5322 message to `mailbox` (e.g. Sent or Drafts).
   * Does not require a selected mailbox.
   */
  async append(
    mailbox: string,
    raw: Buffer | string,
    flags: string[] = ['\\Seen'],
    internalDate?: Date,
  ): Promise<ImapAppendResult> {
    return this.locked(c => c.append(mailbox, raw, flags, internalDate));
  }

  /**
   * Build a message from `EmailOptions` (or take raw bytes) and APPEND it.
   *
   * @example
   * ```ts
   * await session.appendMessage('Drafts', { from, to, subject, text }, ['\\Draft']);
   * ```
   */
  async appendMessage(
    mailbox: string,
    message: EmailOptions | Buffer | string,
    flags: string[] = ['\\Seen'],
    internalDate?: Date,
  ): Promise<ImapAppendResult & { messageId?: string }> {
    if (Buffer.isBuffer(message) || typeof message === 'string') {
      return this.append(mailbox, message, flags, internalDate);
    }
    const built = await buildMessage(message, { attachmentPolicy: this.options.attachmentPolicy });
    const res = await this.append(mailbox, built.raw, flags, internalDate ?? message.date);
    return { ...res, messageId: built.messageId };
  }

  // ─── Watching / IDLE ───────────────────────────────────────────────────────

  /**
   * Watch a mailbox on a dedicated connection and receive **UIDs** of new
   * messages (IDLE, or polling when unsupported). Reconnects automatically.
   * Stop with `watcher.stop()`.
   *
   * @example
   * ```ts
   * const watcher = await session.watch('INBOX');
   * watcher.on('new', async (uids) => {
   *   const msgs = await session.fetch({ uids, textOnly: true });
   * });
   * ```
   */
  async watch(mailbox = DEFAULT_MAILBOX, opts?: WatchOptions): Promise<MailboxWatcher> {
    const watcher = new MailboxWatcher(this.config, mailbox, opts, this.logger);
    await watcher.start();
    return watcher;
  }

  /**
   * Enter IDLE on `mailbox`. `callback` fires with `{ uid, seq }` for each new
   * message. Runs on a dedicated connection, so other session calls keep working.
   * Call `stopIdle()` to exit. Prefer `watch()` for new code.
   */
  async idle(callback: (msg: Partial<ImapMessage>) => void, mailbox?: string): Promise<void> {
    await this.stopIdle();
    const watcher = await this.watch(this.mailboxOr(mailbox));
    watcher.on('new', (uids: number[]) => { for (const uid of uids) callback({ uid }); });
    this.idleWatcher = watcher;
  }

  /** Exit IDLE started with `idle()`. */
  async stopIdle(): Promise<void> {
    const w = this.idleWatcher;
    this.idleWatcher = null;
    await w?.stop();
  }

  // ─── Close ─────────────────────────────────────────────────────────────────

  /** Stop IDLE if active, then log out and close the connection. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    await this.stopIdle();
    const client = this.client;
    this.client = null;
    this.currentMailbox = null;
    await client?.close();
  }

  /** The status of the currently selected mailbox, or `null` if none. */
  get status(): ImapMailboxStatus | null {
    return this.currentMailbox;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** First leaf of `contentType` that is not an attachment. */
function findLeaf(node: BodyNode, contentType: string): BodyLeaf | undefined {
  if (node.type === 'leaf') {
    return node.contentType === contentType && node.disposition !== 'attachment' ? node : undefined;
  }
  for (const child of (node as BodyMultipart).parts) {
    const found = findLeaf(child, contentType);
    if (found) return found;
  }
  return undefined;
}
