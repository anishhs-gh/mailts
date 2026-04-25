import { EventEmitter } from 'events';
import { SmtpClient } from './SmtpClient.js';
import type { Logger } from '../logger/Logger.js';
import type { SmtpConfig } from '../types/smtp.js';
import { SmtpConnError } from '../errors.js';

interface PoolEntry {
  client: SmtpClient;
  inUse: boolean;
}

type WaitingSlot = {
  resolve: (client: SmtpClient) => void;
  reject: (err: Error) => void;
};

const DEFAULT_MAX_CONNECTIONS = 5;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_IDLE_TIMEOUT = 60_000;

/**
 * Manages a pool of persistent `SmtpClient` connections.
 * Connections are reused across sends and retired after `maxMessages`.
 * Idle connections are closed after `idleTimeout` ms.
 */
export class SmtpPool extends EventEmitter {
  private entries: PoolEntry[] = [];
  private waiting: WaitingSlot[] = [];
  private idleTimers: Map<SmtpClient, ReturnType<typeof setTimeout>> = new Map();
  private closing = false;

  readonly config: SmtpConfig;
  private readonly logger: Logger | null;
  private readonly maxConnections: number;
  private readonly maxMessages: number;
  private readonly idleTimeout: number;

  constructor(config: SmtpConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger ?? null;
    const pool = typeof config.pool === 'object' ? config.pool : {};
    this.maxConnections = pool.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxMessages = pool.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.idleTimeout = pool.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  }

  /**
   * Lease a ready `SmtpClient` from the pool.
   * Establishes a new connection if under `maxConnections`; otherwise queues the request.
   * Always call `release()` when done.
   */
  async acquire(): Promise<SmtpClient> {
    if (this.closing) throw new SmtpConnError('Pool is closing');

    // Find an idle, ready client
    const idle = this.entries.find(e => !e.inUse && e.client.isReady);
    if (idle) {
      idle.inUse = true;
      this.clearIdleTimer(idle.client);
      this.logger?.debug('smtp', `Pool: acquired existing connection (pool size: ${this.entries.length})`);
      return idle.client;
    }

    // Spin up a new connection if under limit
    if (this.entries.length < this.maxConnections) {
      const client = new SmtpClient(this.config, this.logger ?? undefined);
      const entry: PoolEntry = { client, inUse: true };
      this.entries.push(entry);

      client.on('close', () => this.onClientClose(client));
      client.on('error', (err: Error) => {
        this.logger?.error('smtp', `Pool: client error: ${err.message}`);
        this.removeClient(client);
      });

      try {
        await client.connect();
        this.logger?.info('smtp', `Pool: new connection established (pool size: ${this.entries.length})`);
        return client;
      } catch (err) {
        this.removeClient(client);
        throw err;
      }
    }

    // Wait for a connection to become available
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  /**
   * Return a client to the pool.
   * Serves queued waiters first; starts the idle timer if none are waiting.
   * Retires and closes the connection if it has reached `maxMessages`.
   */
  release(client: SmtpClient): void {
    const entry = this.entries.find(e => e.client === client);
    if (!entry) return;

    // Retire connection if it has hit max messages
    if (client.messageCount >= this.maxMessages) {
      this.logger?.debug('smtp', `Pool: retiring connection (${client.messageCount} messages sent)`);
      this.removeClient(client);
      client.quit().catch(() => {});
      this.dispatchWaiting();
      return;
    }

    entry.inUse = false;

    // Serve waiting callers before going idle
    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      entry.inUse = true;
      waiter.resolve(client);
      return;
    }

    // Start idle timer
    const timer = setTimeout(() => {
      this.logger?.debug('smtp', 'Pool: closing idle connection');
      this.removeClient(client);
      client.quit().catch(() => {});
    }, this.idleTimeout);
    this.idleTimers.set(client, timer);
  }

  private clearIdleTimer(client: SmtpClient): void {
    const timer = this.idleTimers.get(client);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(client);
    }
  }

  private removeClient(client: SmtpClient): void {
    this.clearIdleTimer(client);
    const idx = this.entries.findIndex(e => e.client === client);
    if (idx !== -1) this.entries.splice(idx, 1);
  }

  private onClientClose(client: SmtpClient): void {
    const entry = this.entries.find(e => e.client === client);
    if (!entry) return;

    this.removeClient(client);
    this.dispatchWaiting();
  }

  private async dispatchWaiting(): Promise<void> {
    if (this.waiting.length === 0 || this.closing) return;

    const waiter = this.waiting.shift();
    if (!waiter) return;

    try {
      const client = await this.acquire();
      waiter.resolve(client);
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Stop accepting new leases, reject waiting callers, and close all idle connections. */
  async drain(): Promise<void> {
    this.closing = true;

    // Reject all waiting slots
    for (const w of this.waiting.splice(0)) {
      w.reject(new SmtpConnError('Pool is draining'));
    }

    // Quit all idle connections
    const quits = this.entries
      .filter(e => !e.inUse)
      .map(e => e.client.quit().catch(() => {}));

    await Promise.all(quits);

    // Wait for in-use connections to finish
    await new Promise<void>(resolve => {
      const check = () => {
        if (this.entries.every(e => !e.inUse)) resolve();
        else setTimeout(check, 100);
      };
      check();
    });

    this.entries = [];
    this.emit('drained');
  }

  /** Total number of connections (in-use + idle). */
  get size(): number {
    return this.entries.length;
  }

  /** Number of idle connections ready to be leased immediately. */
  get available(): number {
    return this.entries.filter(e => !e.inUse && e.client.isReady).length;
  }
}
