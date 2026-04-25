import { httpRequest } from './HttpClient.js';
import { toAddressObjects, resolveApiAttachments } from './utils.js';
import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface SendGridConfig {
  /** SendGrid API key — starts with `SG.`. */
  apiKey: string;
  /** Optional base URL override. @default 'https://api.sendgrid.com' */
  baseUrl?: string;
}

/**
 * Send via [SendGrid](https://sendgrid.com) HTTP API (v3).
 *
 * @example
 * ```ts
 * const mail = new MailTs({
 *   transport: new SendGridTransport({ apiKey: process.env.SENDGRID_API_KEY! }),
 * });
 * ```
 */
export class SendGridTransport implements Transport {
  readonly name = 'sendgrid';
  private readonly base: string;

  constructor(private config: SendGridConfig) {
    this.base = config.baseUrl ?? 'https://api.sendgrid.com';
  }

  async send(message: BuiltMessage, options: EmailOptions): Promise<TransportResult> {
    const fromObj = toAddressObjects(options.from ?? message.from)[0] ?? { email: message.from };
    const attachments = await resolveApiAttachments(options.attachments ?? []);

    const personalization: Record<string, unknown> = {
      to: toAddressObjects(options.to),
    };
    const cc = toAddressObjects(options.cc);
    const bcc = toAddressObjects(options.bcc);
    if (cc.length)  personalization['cc']  = cc;
    if (bcc.length) personalization['bcc'] = bcc;

    const content: { type: string; value: string }[] = [];
    if (options.text) content.push({ type: 'text/plain', value: options.text });
    if (options.html) content.push({ type: 'text/html',  value: options.html });

    const payload: Record<string, unknown> = {
      personalizations: [personalization],
      from:    fromObj,
      subject: options.subject ?? '(no subject)',
      content,
    };

    if (options.replyTo) {
      const rt = toAddressObjects(options.replyTo)[0];
      if (rt) payload['reply_to'] = rt;
    }

    if (options.headers) payload['headers'] = options.headers;

    if (attachments.length) {
      payload['attachments'] = attachments.map(a => ({
        filename:    a.filename,
        content:     a.data.toString('base64'),
        type:        a.contentType,
        disposition: a.cid ? 'inline' : 'attachment',
        ...(a.cid ? { content_id: a.cid } : {}),
      }));
    }

    const res = await httpRequest({
      method: 'POST',
      url: `${this.base}/v3/mail/send`,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.status >= 400) {
      throw new Error(`SendGrid error ${res.status}: ${res.body}`);
    }

    // SendGrid responds 202 Accepted with no body
    const msgId = res.headers['x-message-id'];
    const id = Array.isArray(msgId) ? (msgId[0] ?? message.messageId) : (msgId ?? message.messageId);
    return { messageId: id, accepted: message.to, rejected: [] };
  }
}
