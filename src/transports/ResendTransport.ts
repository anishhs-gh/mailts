import { httpRequest } from './HttpClient.js';
import { toAddressStrings, resolveApiAttachments } from './utils.js';
import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface ResendConfig {
  /** Resend API key — starts with `re_`. */
  apiKey: string;
  /** Optional base URL override (e.g. for testing). @default 'https://api.resend.com' */
  baseUrl?: string;
}

/**
 * Send via [Resend](https://resend.com) HTTP API.
 *
 * @example
 * ```ts
 * const mail = new MailTs({
 *   transport: new ResendTransport({ apiKey: process.env.RESEND_API_KEY! }),
 * });
 * ```
 */
export class ResendTransport implements Transport {
  readonly name = 'resend';
  private readonly base: string;

  constructor(private config: ResendConfig) {
    this.base = config.baseUrl ?? 'https://api.resend.com';
  }

  async send(message: BuiltMessage, options: EmailOptions, signal?: AbortSignal): Promise<TransportResult> {
    const from = toAddressStrings(options.from ?? message.from)[0] ?? message.from;
    const attachments = await resolveApiAttachments(options.attachments ?? []);

    const payload: Record<string, unknown> = {
      from,
      to:      toAddressStrings(options.to),
      subject: options.subject ?? '(no subject)',
    };

    if (options.html)  payload['html']     = options.html;
    if (options.text)  payload['text']     = options.text;
    if (options.cc)    payload['cc']       = toAddressStrings(options.cc);
    if (options.bcc)   payload['bcc']      = toAddressStrings(options.bcc);
    if (options.replyTo) payload['reply_to'] = toAddressStrings(options.replyTo)[0];
    if (options.headers) payload['headers'] = options.headers;

    if (attachments.length) {
      payload['attachments'] = attachments.map(a => ({
        filename: a.filename,
        content:  a.data.toString('base64'),
      }));
    }

    const res = await httpRequest({
      method: 'POST',
      url: `${this.base}/emails`,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (res.status >= 400) {
      throw new Error(`Resend error ${res.status}: ${res.body}`);
    }

    const data = JSON.parse(res.body) as { id: string };
    return { messageId: data.id, accepted: message.to, rejected: [] };
  }
}
