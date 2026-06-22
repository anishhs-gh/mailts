import { ImapClient } from './ImapClient.js';
import { decodeBytes } from './ImapParser.js';
import type { BodyLeaf, BodyMultipart, BodyNode } from './ImapBodyStructure.js';
import type { Logger } from '../logger/Logger.js';
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

const DEFAULT_MAILBOX = 'INBOX';

/**
 * High-level IMAP session with automatic mailbox locking.
 *
 * Operations that require a selected mailbox accept an optional `mailbox`
 * parameter (default `'INBOX'`).  The session auto-selects the mailbox
 * when needed and uses an internal lock so that concurrent calls never
 * race between a SELECT and its following commands.
 *
 * @example
 * ```ts
 * const session = mail.imap;
 * await session.connect();
 *
 * // No open() required — auto-selects INBOX
 * const msgs = await session.fetch({ seen: false });
 *
 * // Multi-mailbox — each call auto-selects the right mailbox
 * await session.move(msgs.map(m => m.uid), 'Archive');
 * const sent = await session.fetch({ mailbox: 'Sent', limit: 10 });
 *
 * await session.close();
 * ```
 */
export class ImapSession {
  private client: ImapClient;
  private currentMailbox: ImapMailboxStatus | null = null;
  private stopIdleFn: (() => Promise<void>) | null = null;

  /**
   * Session-level serialization lock.  Ensures the SELECT + subsequent
   * commands of each logical operation execute atomically — no concurrent
   * call can slip a reselect in between.
   */
  private sessionLock: Promise<unknown> = Promise.resolve();

  constructor(config: ImapConfig, logger?: Logger) {
    this.client = new ImapClient(config, logger);
  }

  /** Open the IMAP connection and authenticate. */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  // ─── Locking primitive ────────────────────────────────────────────────────

  /**
   * Acquire the session lock, auto-select `mailbox` if it is not currently
   * selected, then run `fn`.  Releases the lock (even on error) before the
   * next queued operation starts.
   */
  private withMailbox<T>(mailbox: string, fn: () => Promise<T>): Promise<T> {
    const result = this.sessionLock.then(async () => {
      if (
        !this.currentMailbox ||
        this.currentMailbox.name.toLowerCase() !== mailbox.toLowerCase()
      ) {
        this.currentMailbox = await this.client.select(mailbox);
      }
      return fn();
    });
    this.sessionLock = result.then(() => {}, () => {});
    return result as Promise<T>;
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  /** Return the server's CAPABILITY set. */
  async getCapabilities(): Promise<Set<string>> {
    return this.client.getCapabilities();
  }

  // ─── Mailbox listing ───────────────────────────────────────────────────────

  /** List mailboxes matching `pattern` under `ref`. Defaults to all mailboxes. */
  async listMailboxes(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    return this.client.list(ref, pattern);
  }

  /** List subscribed mailboxes matching `pattern` under `ref`. */
  async listSubscribed(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    return this.client.listSubscribed(ref, pattern);
  }

  // ─── Mailbox management ────────────────────────────────────────────────────

  /** Create a new mailbox. Throws if it already exists. */
  async createMailbox(mailbox: string): Promise<void> {
    await this.client.createMailbox(mailbox);
  }

  /** Delete a mailbox and all its messages. */
  async deleteMailbox(mailbox: string): Promise<void> {
    await this.client.deleteMailbox(mailbox);
  }

  /** Rename mailbox `from` to `to`. */
  async renameMailbox(from: string, to: string): Promise<void> {
    await this.client.renameMailbox(from, to);
  }

  /** Subscribe to a mailbox. */
  async subscribe(mailbox: string): Promise<void> {
    await this.client.subscribe(mailbox);
  }

  /** Unsubscribe from a mailbox. */
  async unsubscribe(mailbox: string): Promise<void> {
    await this.client.unsubscribe(mailbox);
  }

  // ─── Mailbox selection ─────────────────────────────────────────────────────

  /**
   * Explicitly select a mailbox and return its status.
   * Use this when you need the fresh mailbox metadata (EXISTS, UIDNEXT, …).
   * Regular operations (fetch, move, …) auto-select without needing this.
   */
  async open(mailbox = DEFAULT_MAILBOX): Promise<ImapMailboxStatus> {
    const result = this.sessionLock.then(async () => {
      // Always re-select to get a fresh status snapshot
      this.currentMailbox = await this.client.select(mailbox);
      return this.currentMailbox;
    });
    this.sessionLock = result.then(() => {}, () => {});
    return result as Promise<ImapMailboxStatus>;
  }

  /**
   * Open a mailbox read-only (EXAMINE).  Flag changes are not allowed
   * while in this mode.  Regular operations that need write access should
   * call `open()` afterwards.
   */
  async openReadOnly(mailbox = DEFAULT_MAILBOX): Promise<ImapMailboxStatus> {
    const result = this.sessionLock.then(async () => {
      this.currentMailbox = await this.client.examine(mailbox);
      return this.currentMailbox;
    });
    this.sessionLock = result.then(() => {}, () => {});
    return result as Promise<ImapMailboxStatus>;
  }

  /**
   * Get STATUS of any mailbox without selecting it.
   * This never changes the currently selected mailbox.
   */
  async getStatus(mailbox: string, items?: string[]): Promise<ImapStatusResult> {
    return this.client.getStatus(mailbox, items);
  }

  // ─── Fetch & search ────────────────────────────────────────────────────────

  /**
   * Fetch messages.  Auto-selects `opts.mailbox` (default `'INBOX'`).
   *
   * @example
   * ```ts
   * // No open() needed
   * const unread = await session.fetch({ seen: false });
   * const recent = await session.fetch({ mailbox: 'Sent', limit: 10 });
   * ```
   */
  async fetch(opts: ImapFetchOptions = {}): Promise<ImapMessage[]> {
    const mailbox = opts.mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mailbox, async () => {
      let uids: number[];

      if (opts.uids) {
        uids = opts.uids;
      } else {
        const query: ImapSearchCriteria = {};
        if (opts.seen === true) query.seen = true;
        if (opts.seen === false) query.unseen = true;
        uids = await this.client.search(query);
        if (opts.limit !== undefined) uids = uids.slice(-opts.limit);
      }

      if (uids.length === 0) return [];

      // ── textOnly: BODYSTRUCTURE + selective text section fetches ──────────
      if (opts.textOnly) {
        return this.fetchTextOnly(uids, opts.markSeen ?? false);
      }

      // ── structure: BODYSTRUCTURE only, no content ─────────────────────────
      if (opts.structure) {
        const messages = await this.client.fetch(
          uids,
          'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE',
        );
        const structures = await this.client.fetchBodyStructure(uids);
        for (const msg of messages) {
          const s = structures.get(msg.uid);
          if (s) msg.structure = s;
        }
        return messages;
      }

      // ── bodies: full RFC822 ───────────────────────────────────────────────
      const items = opts.bodies
        ? 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE RFC822'
        : 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE';

      const messages = await this.client.fetch(uids, items);

      if (opts.markSeen && uids.length > 0) {
        await this.client.setFlagsSilent(uids, ['\\Seen'], true);
      }

      return messages;
    });
  }

  private async fetchTextOnly(uids: number[], markSeen: boolean): Promise<ImapMessage[]> {
    const messages = await this.client.fetch(
      uids,
      'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE',
    );
    const structures = await this.client.fetchBodyStructure(uids);

    // Build per-UID section lists: only text/plain and text/html leaves
    const uidSections = new Map<number, { textSection?: string; htmlSection?: string }>();
    const allSections: string[] = [];

    for (const msg of messages) {
      const tree = structures.get(msg.uid);
      if (!tree) continue;
      msg.structure = tree;
      const text = findLeaf(tree, 'text/plain');
      const html = findLeaf(tree, 'text/html');
      const entry: { textSection?: string; htmlSection?: string } = {};
      if (text) { entry.textSection = text.section; allSections.push(text.section); }
      if (html) { entry.htmlSection  = html.section; allSections.push(html.section); }
      uidSections.set(msg.uid, entry);
    }

    if (allSections.length > 0) {
      const unique = [...new Set(allSections)];
      const fetched = await this.client.fetchSections(uids, unique);

      for (const msg of messages) {
        const entry = uidSections.get(msg.uid);
        if (!entry) continue;
        const sectionMap = fetched.get(msg.uid) ?? new Map<string, Buffer>();
        const tree = structures.get(msg.uid);

        msg.body = { attachments: [] };

        if (entry.textSection) {
          const raw = sectionMap.get(entry.textSection);
          const leaf = tree ? findLeaf(tree, 'text/plain') : undefined;
          if (raw && leaf) msg.body.text = decodeBytes(raw, leaf.charset ?? 'utf-8');
        }
        if (entry.htmlSection) {
          const raw = sectionMap.get(entry.htmlSection);
          const leaf = tree ? findLeaf(tree, 'text/html') : undefined;
          if (raw && leaf) msg.body.html = decodeBytes(raw, leaf.charset ?? 'utf-8');
        }
      }
    }

    if (markSeen && uids.length > 0) {
      await this.client.setFlagsSilent(uids, ['\\Seen'], true);
    }

    return messages;
  }

  /**
   * Search for messages matching `criteria` in `mailbox` (default `'INBOX'`).
   * Returns UIDs. Auto-selects the mailbox.
   *
   * @example
   * ```ts
   * const uids = await session.search({ from: 'boss@example.com', unseen: true });
   * const msgs  = await session.fetch({ uids, bodies: true });
   * ```
   */
  async search(
    criteria: ImapSearchCriteria,
    mailbox = DEFAULT_MAILBOX,
  ): Promise<number[]> {
    return this.withMailbox(mailbox, () => this.client.search(criteria));
  }

  /**
   * Fetch the MIME structure tree for a single message without downloading any content.
   * Use the returned `BodyNode` to inspect parts and decide which sections to fetch.
   *
   * @example
   * ```ts
   * const tree = await session.fetchStructure(uid);
   * // tree is a BodyMultipart or BodyLeaf describing the full MIME tree
   * ```
   */
  async fetchStructure(uid: number, mailbox?: string): Promise<BodyNode | undefined> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, async () => {
      const map = await this.client.fetchBodyStructure([uid]);
      return map.get(uid);
    });
  }

  /**
   * Fetch a single MIME section as raw bytes. Uses BODY.PEEK — never sets \\Seen.
   * `section` is the IMAP section number: "1", "2", "3.1", etc.
   *
   * @example
   * ```ts
   * const bytes = await session.fetchSection(uid, '2');  // fetch HTML part
   * ```
   */
  async fetchSection(uid: number, section: string, mailbox?: string): Promise<Buffer> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () => this.client.fetchSection(uid, section));
  }

  /**
   * Fetch text/plain and text/html parts only — no attachment bytes transferred.
   * Far more bandwidth-efficient than `fetch({ bodies: true })` for large messages.
   * Also populates `message.structure` with the full MIME tree.
   *
   * @example
   * ```ts
   * const msgs = await session.fetchText([uid1, uid2]);
   * console.log(msgs[0].body?.text);
   * ```
   */
  async fetchText(uids: number[], mailbox?: string): Promise<ImapMessage[]> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () => this.fetchTextOnly(uids, false));
  }

  /**
   * Fetch messages changed since a CONDSTORE mod-sequence.
   * Requires the server to advertise CONDSTORE capability.
   * Auto-selects `mailbox` (default: last opened or `'INBOX'`).
   */
  async fetchChanged(
    modseq: number,
    mailbox?: string,
    uids = '1:*',
  ): Promise<ImapMessage[]> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () => this.client.fetchChanged(uids, modseq));
  }

  // ─── Flag operations ───────────────────────────────────────────────────────

  /** Mark UIDs as seen.  Auto-selects `mailbox` (default `'INBOX'`). */
  async markSeen(uids: number[], mailbox?: string): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () =>
      this.client.setFlags(uids, ['\\Seen'], true),
    );
  }

  /** Mark UIDs as unseen.  Auto-selects `mailbox` (default `'INBOX'`). */
  async markUnseen(uids: number[], mailbox?: string): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () =>
      this.client.setFlags(uids, ['\\Seen'], false),
    );
  }

  /** Set \\Flagged on UIDs.  Auto-selects `mailbox`. */
  async markFlagged(uids: number[], mailbox?: string): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () =>
      this.client.setFlags(uids, ['\\Flagged'], true),
    );
  }

  /** Clear \\Flagged on UIDs.  Auto-selects `mailbox`. */
  async markUnflagged(uids: number[], mailbox?: string): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () =>
      this.client.setFlags(uids, ['\\Flagged'], false),
    );
  }

  /** Set or remove arbitrary flags.  Auto-selects `mailbox`. */
  async setFlags(
    uids: number[],
    flags: string[],
    add: boolean,
    mailbox?: string,
  ): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () =>
      this.client.setFlags(uids, flags, add),
    );
  }

  // ─── Copy / Move / Delete ──────────────────────────────────────────────────

  /**
   * Copy UIDs to `destMailbox`.
   * `sourceMailbox` defaults to the currently selected mailbox or `'INBOX'`.
   */
  async copy(
    uids: number[],
    destMailbox: string,
    sourceMailbox?: string,
  ): Promise<void> {
    const mb = sourceMailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () => this.client.copy(uids, destMailbox));
  }

  /**
   * Move UIDs to `destMailbox`.  Uses MOVE extension when available,
   * falls back to COPY + STORE \\Deleted + EXPUNGE.
   * `sourceMailbox` defaults to the currently selected mailbox or `'INBOX'`.
   */
  async move(
    uids: number[],
    destMailbox: string,
    sourceMailbox?: string,
  ): Promise<void> {
    const mb = sourceMailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () => this.client.move(uids, destMailbox));
  }

  /**
   * Mark UIDs \\Deleted then EXPUNGE.
   * Auto-selects `mailbox` (default `'INBOX'`).
   */
  async delete(uids: number[], mailbox?: string): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, async () => {
      await this.client.setFlags(uids, ['\\Deleted'], true);
      await this.client.expunge();
    });
  }

  /** Expunge deleted messages.  Auto-selects `mailbox`. */
  async expunge(mailbox?: string): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    return this.withMailbox(mb, () => this.client.expunge());
  }

  // ─── Append ────────────────────────────────────────────────────────────────

  /**
   * Upload a raw RFC 5322 message to `mailbox` (e.g. save to Sent or Drafts).
   * Does NOT require a mailbox to be selected — APPEND works on any mailbox.
   */
  async append(
    mailbox: string,
    raw: Buffer | string,
    flags: string[] = ['\\Seen'],
    internalDate?: Date,
  ): Promise<ImapAppendResult> {
    return this.client.append(mailbox, raw, flags, internalDate);
  }

  // ─── IDLE ──────────────────────────────────────────────────────────────────

  /**
   * Enter IDLE mode on `mailbox` (default `'INBOX'`).
   * `callback` fires with a partial `ImapMessage` (just `seq`) when new mail arrives.
   * Call `stopIdle()` to exit.
   */
  async idle(
    callback: (msg: Partial<ImapMessage>) => void,
    mailbox?: string,
  ): Promise<void> {
    const mb = mailbox ?? this.currentMailbox?.name ?? DEFAULT_MAILBOX;
    // Acquire the session lock for the duration of IDLE — no other
    // mailbox operation should run while we are in IDLE.
    const idlePromise = this.sessionLock.then(async () => {
      if (
        !this.currentMailbox ||
        this.currentMailbox.name.toLowerCase() !== mb.toLowerCase()
      ) {
        this.currentMailbox = await this.client.select(mb);
      }
      this.stopIdleFn = await this.client.idle(callback);
    });
    this.sessionLock = idlePromise.then(() => {}, () => {});
    await idlePromise;
  }

  /** Exit IDLE mode and release the session lock. */
  async stopIdle(): Promise<void> {
    if (this.stopIdleFn) {
      await this.stopIdleFn();
      this.stopIdleFn = null;
    }
  }

  // ─── Close ─────────────────────────────────────────────────────────────────

  /** Stop IDLE if active, then close the IMAP connection. */
  async close(): Promise<void> {
    if (this.stopIdleFn) await this.stopIdle();
    await this.client.close();
  }

  // ─── Status accessors ─────────────────────────────────────────────────────

  /** The status of the currently selected mailbox, or `null` if none. */
  get status(): ImapMailboxStatus | null {
    return this.currentMailbox;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function findLeaf(node: BodyNode, contentType: string): BodyLeaf | undefined {
  if (node.type === 'leaf') {
    return node.contentType === contentType ? node : undefined;
  }
  for (const child of (node as BodyMultipart).parts) {
    const found = findLeaf(child, contentType);
    if (found) return found;
  }
  return undefined;
}
