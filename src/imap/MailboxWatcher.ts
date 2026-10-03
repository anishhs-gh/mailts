import { EventEmitter } from 'events';
import { ImapClient } from './ImapClient.js';
import type { FetchAttributes } from './ImapFetch.js';
import type { Logger } from '../logger/Logger.js';
import type { ImapConfig } from '../types/imap.js';
import { ImapAuthError } from '../errors.js';

/** Options for `session.watch()` / `new MailboxWatcher()`. */
export interface WatchOptions {
  /** Poll interval when the server lacks IDLE. @default 30_000 */
  pollMs?: number;
  /** Delay before reconnecting after a dropped connection (doubles, max 60 s). @default 1_000 */
  reconnectDelayMs?: number;
}

/**
 * Watches one mailbox on a dedicated connection and reports changes by UID.
 *
 * Events:
 * - `new` `(uids: number[])` — messages that arrived since the last check
 * - `expunge` `(seq: number)` — a message was removed
 * - `flags` `({ uid, flags })` — flags changed
 * - `reset` `(uidValidity: number)` — UIDVALIDITY changed; previously seen UIDs are invalid
 * - `error` `(err)` — connection problems (the watcher keeps reconnecting)
 * - `ready` — watching (after the initial connect and every reconnect)
 *
 * Uses IDLE when available, otherwise NOOP polling. Missed messages during a
 * reconnect are caught up from the last known UIDNEXT.
 */
export class MailboxWatcher extends EventEmitter {
  private client: ImapClient | null = null;
  /** Connection being opened (so stop() can abort it). */
  private connecting: ImapClient | null = null;
  private stopped = false;
  private stopIdle: (() => Promise<void>) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private uidNext = 0;
  private uidValidity = 0;
  private checking: Promise<void> | null = null;
  private recheck = false;
  private readonly opts: Required<WatchOptions>;

  constructor(
    private readonly config: ImapConfig,
    readonly mailbox: string,
    opts: WatchOptions = {},
    private readonly logger?: Logger,
  ) {
    super();
    this.opts = { pollMs: opts.pollMs ?? 30_000, reconnectDelayMs: opts.reconnectDelayMs ?? 1_000 };
    this.on('error', () => {}); // errors are informational; the watcher self-heals
  }

  /** Connect and start watching. Resolves once the first IDLE / poll is active. */
  async start(): Promise<void> {
    await this.open();
  }

  /** Stop watching and close the connection. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.connecting?.destroy();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    const stopIdle = this.stopIdle;
    this.stopIdle = null;
    await stopIdle?.().catch(() => {});
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private async open(): Promise<void> {
    const client = new ImapClient(this.config, this.logger);
    this.connecting = client;
    try {
      await client.connect();
    } finally {
      this.connecting = null;
    }
    if (this.stopped) { await client.close().catch(() => {}); return; } // stop() raced with the connect
    const status = await client.examine(this.mailbox);

    if (this.uidValidity && status.uidValidity !== this.uidValidity) {
      this.uidNext = status.uidNext;
      this.emit('reset', status.uidValidity);
    }
    this.uidValidity = status.uidValidity;
    const catchUpFrom = this.uidNext;
    if (!this.uidNext) this.uidNext = status.uidNext;

    this.client = client;
    client.on('exists', () => this.scheduleCheck());
    client.on('fetch', (a: FetchAttributes) => {
      if (a.uid !== undefined && a.flags) this.emit('flags', { uid: a.uid, flags: a.flags });
    });
    client.on('expunge', (seq: number) => this.emit('expunge', seq));
    client.once('close', () => this.onDropped());

    if (catchUpFrom && catchUpFrom < status.uidNext) this.scheduleCheck();

    if (client.hasCapability('IDLE')) {
      this.stopIdle = await client.idle();
    } else {
      this.pollTimer = setInterval(() => {
        client.noop().then(() => this.scheduleCheck(), () => {});
      }, this.opts.pollMs);
      this.pollTimer.unref?.();
    }
    this.emit('ready');
  }

  /** Coalesce EXISTS bursts into one UID FETCH. */
  private scheduleCheck(): void {
    if (this.checking) { this.recheck = true; return; }
    this.checking = this.checkNew()
      .catch((e: Error) => { this.emit('error', e); })
      .finally(() => {
        this.checking = null;
        if (this.recheck && !this.stopped) { this.recheck = false; this.scheduleCheck(); }
      });
  }

  private async checkNew(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    const from = Math.max(this.uidNext, 1);
    // `N:*` always matches the highest UID, so filter to genuinely new ones
    const found = await client.search({ uid: `${from}:*` });
    const fresh = found.filter(u => u >= from).sort((a, b) => a - b);
    if (fresh.length) {
      this.uidNext = fresh[fresh.length - 1]! + 1;
      this.emit('new', fresh);
    }
  }

  private onDropped(): void {
    this.client = null;
    this.stopIdle = null;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.stopped) return;
    void this.reconnect(this.opts.reconnectDelayMs);
  }

  private async reconnect(delay: number): Promise<void> {
    while (!this.stopped) {
      await new Promise(r => setTimeout(r, delay));
      if (this.stopped) return;
      try {
        await this.open();
        return;
      } catch (err) {
        this.emit('error', err);
        if (err instanceof ImapAuthError) { this.stopped = true; return; }
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }
}
