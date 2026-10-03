import { ImapSession } from './ImapSession.js';
import type { AttachmentPathPolicy } from '../core/Attachment.js';
import type { Logger } from '../logger/Logger.js';
import type { ImapConfig } from '../types/imap.js';
import { ImapAuthError, ImapError } from '../errors.js';

/** Limits and timeouts for `ImapPool`. */
export interface ImapPoolOptions {
  /** Open sessions across all accounts. Default `100`. */
  maxSessions?: number;
  /**
   * Sessions per account key. Default `1`. Providers cap concurrent IMAP
   * connections per mailbox (Gmail 15, Microsoft 365 about 20, many hosts fewer).
   */
  maxPerAccount?: number;
  /** Close a session after this long unused. Default 5 min; `0` keeps sessions open. */
  idleTimeoutMs?: number;
  /** How long `use()` waits for a free session before rejecting. Default 30 s. */
  acquireTimeoutMs?: number;
  /** `attachmentPolicy` for `appendMessage()` on pooled sessions (unset rejects `path`). */
  attachmentPolicy?: AttachmentPathPolicy;
  /** Logger passed to every pooled session. */
  logger?: Logger;
}

/** IMAP config, or a function returning it — called only when a new session is opened. */
export type ImapConfigSource = ImapConfig | (() => ImapConfig | Promise<ImapConfig>);

/** Snapshot from `pool.stats()`. */
export interface ImapPoolStats {
  /** Accounts with at least one open session. */
  accounts: number;
  /** Open sessions in total. */
  sessions: number;
  /** Sessions lent to a `use()` callback right now. */
  busy: number;
  /** `use()` calls waiting for a session. */
  waiting: number;
}

interface Slot {
  key: string;
  session: ImapSession | null; // null while its config is being resolved
  busy: boolean;
  retired: boolean;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  key: string;
  config: ImapConfigSource;
  resolve(slot: Slot): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Reuses authenticated IMAP sessions per account across requests — for servers
 * that act on many mailboxes (multi-tenant APIs, MCP servers).
 *
 * - `use(key, config, fn)` lends a session **exclusively** to `fn` (the selected
 *   mailbox stays put for the whole callback), then returns it to the pool.
 * - Up to `maxPerAccount` sessions per key and `maxSessions` in total; when full,
 *   the least recently used idle session of another account is closed, otherwise
 *   callers wait (FIFO) up to `acquireTimeoutMs`.
 * - Dropped connections are re-established by the session on next use; a session
 *   that failed authentication is discarded, so the next `use()` resolves the
 *   config again (fresh credentials).
 * - `close(key)` after a sign-out or credential change; `closeAll()` on shutdown.
 *
 * Watching (`session.watch()`) opens its own connection — run watchers outside the pool.
 *
 * @example
 * ```ts
 * const pool = new ImapPool({ maxPerAccount: 2 });
 * const unread = await pool.use(account.id, () => imapConfigFor(account), (s) =>
 *   s.fetch({ seen: false, limit: 20 }));
 * ```
 */
export class ImapPool {
  private readonly slots = new Map<string, Slot[]>();
  private readonly waiters: Waiter[] = [];
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly maxSessions: number;
  private readonly maxPerAccount: number;
  private readonly idleTimeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private closed = false;

  constructor(private readonly options: ImapPoolOptions = {}) {
    this.maxSessions = options.maxSessions ?? 100;
    this.maxPerAccount = options.maxPerAccount ?? 1;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
    if (!(this.maxSessions >= 1) || !(this.maxPerAccount >= 1)) {
      throw new ImapError('ImapPool: maxSessions and maxPerAccount must be at least 1');
    }
  }

  /** Run `fn` with a session for `key` that no other caller uses meanwhile. */
  async use<T>(key: string, config: ImapConfigSource, fn: (session: ImapSession) => Promise<T>): Promise<T> {
    const slot = await this.acquire(key, config);
    let failure: unknown;
    try {
      if (!slot.session) slot.session = await this.open(config);
      return await fn(slot.session);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      this.release(slot, failure);
    }
  }

  /**
   * Close every session of `key` (idle ones now, busy ones when their callback
   * finishes) and reject its waiters. The next `use(key)` opens a fresh session.
   */
  async close(key: string): Promise<void> {
    this.rejectWaiters(w => w.key === key, () => new ImapError(`ImapPool: sessions for "${key}" were closed`));
    for (const slot of this.slots.get(key) ?? []) this.retire(slot);
    await this.settle();
  }

  /** Reject waiters, close idle sessions and wait for busy ones to finish and close. */
  async closeAll(): Promise<void> {
    this.closed = true;
    this.rejectWaiters(() => true, () => new ImapError('ImapPool is closed'));
    for (const list of this.slots.values()) for (const slot of list) this.retire(slot);
    await this.settle();
  }

  /** Current counts — for metrics and health endpoints. */
  stats(): ImapPoolStats {
    let sessions = 0;
    let busy = 0;
    for (const list of this.slots.values()) {
      sessions += list.length;
      busy += list.filter(s => s.busy).length;
    }
    return { accounts: this.slots.size, sessions, busy, waiting: this.waiters.length };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private acquire(key: string, config: ImapConfigSource): Promise<Slot> {
    if (this.closed) return Promise.reject(new ImapError('ImapPool is closed'));
    // Earlier waiters keep their turn.
    const slot = this.waiters.length === 0 ? this.tryTake(key) : null;
    if (slot) return Promise.resolve(slot);
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        key, config, resolve, reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new ImapError(`ImapPool: no session for "${key}" within ${this.acquireTimeoutMs} ms`, true, 'ETIMEOUT'));
        }, this.acquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** An idle session of `key`, or a new slot if limits allow (evicting another account's idle session). */
  private tryTake(key: string): Slot | null {
    const list = this.slots.get(key) ?? [];
    const idle = list.find(s => !s.busy && !s.retired);
    if (idle) {
      if (idle.idleTimer) { clearTimeout(idle.idleTimer); idle.idleTimer = null; }
      idle.busy = true;
      return idle;
    }
    if (list.length >= this.maxPerAccount) return null;
    if (this.total() >= this.maxSessions) {
      const victim = this.lruIdle();
      if (!victim) return null;
      victim.retired = true;
      this.remove(victim); // no pump() here — tryTake runs inside pump()
    }
    const slot: Slot = { key, session: null, busy: true, retired: false, lastUsed: Date.now(), idleTimer: null };
    this.slots.set(key, [...list, slot]);
    return slot;
  }

  private async open(config: ImapConfigSource): Promise<ImapSession> {
    const cfg = typeof config === 'function' ? await config() : config;
    return new ImapSession(cfg, this.options.logger, { attachmentPolicy: this.options.attachmentPolicy });
  }

  private release(slot: Slot, failure: unknown): void {
    slot.busy = false;
    slot.lastUsed = Date.now();
    // Bad credentials or a config that could not be resolved: start over next time.
    if (failure instanceof ImapAuthError || !slot.session) slot.retired = true;
    if (slot.retired) this.remove(slot);
    else if (this.idleTimeoutMs > 0) {
      slot.idleTimer = setTimeout(() => this.retire(slot), this.idleTimeoutMs);
      slot.idleTimer.unref?.();
    }
    this.pump();
  }

  /** Mark for closing; closes now when idle, otherwise on release. */
  private retire(slot: Slot): void {
    slot.retired = true;
    if (!slot.busy) {
      this.remove(slot);
      this.pump();
    }
  }

  private remove(slot: Slot): void {
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    const list = (this.slots.get(slot.key) ?? []).filter(s => s !== slot);
    if (list.length) this.slots.set(slot.key, list);
    else this.slots.delete(slot.key);
    if (slot.session) {
      const p = slot.session.close().catch((err: unknown) => {
        this.options.logger?.debug('imap', 'ImapPool: close failed', { error: (err as Error).message });
      });
      this.pendingCloses.add(p);
      void p.finally(() => this.pendingCloses.delete(p));
    }
  }

  /** Serve waiters in order; a waiter that cannot be served yet does not block others' keys. */
  private pump(): void {
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i]!;
      const slot = this.tryTake(w.key);
      if (!slot) { i++; continue; }
      this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(slot);
    }
  }

  private rejectWaiters(match: (w: Waiter) => boolean, error: () => Error): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (!match(w)) continue;
      this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.reject(error());
    }
  }

  /** Wait until every retired slot is released and closed. */
  private async settle(): Promise<void> {
    while (this.hasRetiredBusy() || this.pendingCloses.size) {
      if (this.pendingCloses.size) await Promise.all([...this.pendingCloses]);
      else await new Promise(r => setTimeout(r, 10));
    }
  }

  private hasRetiredBusy(): boolean {
    for (const list of this.slots.values()) if (list.some(s => s.retired && s.busy)) return true;
    return false;
  }

  private total(): number {
    let n = 0;
    for (const list of this.slots.values()) n += list.length;
    return n;
  }

  private lruIdle(): Slot | undefined {
    let best: Slot | undefined;
    for (const list of this.slots.values()) {
      for (const s of list) if (!s.busy && !s.retired && (!best || s.lastUsed < best.lastUsed)) best = s;
    }
    return best;
  }
}
