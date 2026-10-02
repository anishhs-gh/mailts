import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface TransportResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** Provider-specific id (e.g. Gmail message id), when it differs from the Message-ID. */
  providerMessageId?: string;
  /** Provider thread id, when the provider reports one (Gmail). */
  threadId?: string;
}

/** Common interface all transports must implement. */
export interface Transport {
  /** Human-readable name shown in logs. */
  readonly name: string;
  /**
   * Transmit the message using the underlying provider.
   * @param message - Pre-built MIME message with raw buffer, from, to, and messageId.
   * @param options - Original `EmailOptions` — useful for provider-specific fields.
   * @param signal  - Optional `AbortSignal`; when aborted the in-flight request is cancelled.
   *                  Existing implementations that do not declare this parameter continue to work.
   */
  send(message: BuiltMessage, options: EmailOptions, signal?: AbortSignal): Promise<TransportResult>;
}
