import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface TransportResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/** Common interface all transports must implement. */
export interface Transport {
  /** Human-readable name shown in logs. */
  readonly name: string;
  /**
   * Transmit the message using the underlying provider.
   * @param message - Pre-built MIME message with raw buffer, from, to, and messageId.
   * @param options - Original `EmailOptions` — useful for provider-specific fields.
   */
  send(message: BuiltMessage, options: EmailOptions): Promise<TransportResult>;
}
