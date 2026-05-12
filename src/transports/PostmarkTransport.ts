import { httpRequest } from './HttpClient.js';
import { toAddressStrings, resolveApiAttachments } from './utils.js';
import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface PostmarkConfig {
  /** Postmark server token. */
  serverToken: string;
  /**
   * Message stream ID.
   * @default 'outbound'
   */
  messageStream?: string;
  /** Optional base URL override. @default 'https://api.postmarkapp.com' */
  baseUrl?: string;
}

/**
 * Send via [Postmark](https://postmarkapp.com) HTTP API.
 *
 * @example
 * ```ts
 * const mail = new MailTs({
 *   transport: new PostmarkTransport({ serverToken: process.env.POSTMARK_TOKEN! }),
 * });
 * ```
 */
export class PostmarkTransport implements Transport {
  readonly name = 'postmark';
  private readonly base: string;

  constructor(private config: PostmarkConfig) {
    this.base = config.baseUrl ?? 'https://api.postmarkapp.com';
  }

  async send(message: BuiltMessage, options: EmailOptions, signal?: AbortSignal): Promise<TransportResult> {
    const from = toAddressStrings(options.from ?? message.from)[0] ?? message.from;
    const attachments = await resolveApiAttachments(options.attachments ?? []);

    const payload: Record<string, unknown> = {
      From:          from,
      To:            toAddressStrings(options.to).join(', '),
      Subject:       options.subject ?? '(no subject)',
      MessageStream: this.config.messageStream ?? 'outbound',
    };

    if (options.html)    payload['HtmlBody'] = options.html;
    if (options.text)    payload['TextBody']  = options.text;
    if (options.cc)      payload['Cc']        = toAddressStrings(options.cc).join(', ');
    if (options.bcc)     payload['Bcc']       = toAddressStrings(options.bcc).join(', ');
    if (options.replyTo) payload['ReplyTo']   = toAddressStrings(options.replyTo)[0];

    if (options.headers) {
      payload['Headers'] = Object.entries(options.headers).map(([Name, Value]) => ({ Name, Value }));
    }

    if (attachments.length) {
      payload['Attachments'] = attachments.map(a => ({
        Name:        a.filename,
        Content:     a.data.toString('base64'),
        ContentType: a.contentType,
        ...(a.cid ? { ContentID: `cid:${a.cid}` } : {}),
      }));
    }

    const res = await httpRequest({
      method: 'POST',
      url: `${this.base}/email`,
      headers: {
        'X-Postmark-Server-Token': this.config.serverToken,
        'Content-Type':            'application/json',
        'Accept':                  'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (res.status >= 400) {
      throw new Error(`Postmark error ${res.status}: ${res.body}`);
    }

    const data = JSON.parse(res.body) as { MessageID: string };
    return { messageId: `<${data.MessageID}>`, accepted: message.to, rejected: [] };
  }
}
