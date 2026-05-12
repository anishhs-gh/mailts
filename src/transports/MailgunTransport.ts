import { randomBytes } from 'crypto';
import { httpRequest, buildFormData } from './HttpClient.js';
import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface MailgunConfig {
  /** Mailgun API key. */
  apiKey: string;
  /** Your Mailgun sending domain (e.g. `mg.example.com`). */
  domain: string;
  /**
   * API region — US uses `api.mailgun.net`, EU uses `api.eu.mailgun.net`.
   * @default 'us'
   */
  region?: 'us' | 'eu';
  /** Optional base URL override. */
  baseUrl?: string;
}

/**
 * Send via [Mailgun](https://mailgun.com) `messages.mime` HTTP API.
 *
 * Passes the fully-built RFC 5322 message (including DKIM if configured) directly
 * to Mailgun, so all MIME features work without re-serialisation.
 *
 * @example
 * ```ts
 * const mail = new MailTs({
 *   transport: new MailgunTransport({
 *     apiKey: process.env.MAILGUN_API_KEY!,
 *     domain: 'mg.example.com',
 *   }),
 * });
 * ```
 */
export class MailgunTransport implements Transport {
  readonly name = 'mailgun';
  private readonly base: string;

  constructor(private config: MailgunConfig) {
    const host = config.region === 'eu'
      ? 'api.eu.mailgun.net'
      : 'api.mailgun.net';
    this.base = config.baseUrl ?? `https://${host}`;
  }

  async send(message: BuiltMessage, _options: EmailOptions, signal?: AbortSignal): Promise<TransportResult> {
    const boundary = randomBytes(16).toString('hex');

    // Use the messages.mime endpoint — pass the raw RFC 5322 message as-is
    const body = buildFormData(
      boundary,
      [{ name: 'to', value: message.to.join(', ') }],
      [{
        name:        'message',
        filename:    'message.mime',
        contentType: 'message/rfc2822',
        data:        message.raw,
      }],
    );

    const auth = Buffer.from(`api:${this.config.apiKey}`).toString('base64');
    const res = await httpRequest({
      method: 'POST',
      url: `${this.base}/v3/${this.config.domain}/messages.mime`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal,
    });

    if (res.status >= 400) {
      throw new Error(`Mailgun error ${res.status}: ${res.body}`);
    }

    const data = JSON.parse(res.body) as { id: string; message: string };
    return { messageId: data.id, accepted: message.to, rejected: [] };
  }
}
