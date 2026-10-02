import { SmtpPool } from '../smtp/SmtpPool.js';
import type { Logger } from '../logger/Logger.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { EmailOptions } from '../types/core.js';
import type { BuiltMessage } from '../core/Message.js';
import type { Transport, TransportResult } from './Transport.js';

/**
 * Default transport — sends mail directly over SMTP using a connection pool.
 * This is what `new MailTs({ smtp: { ... } })` uses internally.
 */
export class SmtpTransport implements Transport {
  readonly name = 'smtp';
  private pool: SmtpPool;
  private readonly allRecipientsRequired?: boolean;

  constructor(config: SmtpConfig, logger?: Logger) {
    this.pool = new SmtpPool(config, logger);
    this.allRecipientsRequired = config.allRecipientsRequired;
  }

  async send(message: BuiltMessage, _options: EmailOptions, signal?: AbortSignal): Promise<TransportResult> {
    const client = await this.pool.acquire(signal);
    const onAbort = (): void => { client.destroy(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await client.send(message.from, message.to, message.raw, {
        eightBit: message.requires8BitMime,
        smtpUtf8: message.requiresSmtpUtf8,
        allRecipientsRequired: this.allRecipientsRequired,
      });
      return { messageId: message.messageId, accepted: r.accepted, rejected: r.rejected };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.pool.release(client);  // no-op if client was already destroyed and removed
    }
  }

  async shutdown(): Promise<void> {
    await this.pool.drain();
  }
}
