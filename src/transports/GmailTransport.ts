import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';
import type { TokenProvider } from '../types/auth.js';
import { authorizedRequest } from './ApiAuth.js';
import { assertOk, parseJson } from './utils.js';

/**
 * Options for `new GmailTransport()`.
 */
export interface GmailTransportConfig {
  /** Account to send as. Also passed to `getToken`. */
  user: string;
  /**
   * Access-token provider with a Gmail API scope — `gmail.send` is enough
   * (`googleWith(SCOPES.google.send)`); `https://mail.google.com/` also works.
   */
  getToken: TokenProvider;
  /**
   * For replies, look up the Gmail thread id of `inReplyTo` so the sent copy
   * joins the conversation in the sender's mailbox. Needs a read scope
   * (`gmail.readonly`/`gmail.modify`/full); recipients thread by headers either way.
   * @default false
   */
  threadLookup?: boolean;
  /** @default 'https://gmail.googleapis.com/gmail/v1' */
  baseUrl?: string;
}

/**
 * Send through the Gmail API (`users.messages.send`) with the MIME built by
 * mailts. Higher quotas than SMTP and no IMAP connection limits. Gmail stores
 * the sent copy itself.
 */
export class GmailTransport implements Transport {
  readonly name = 'gmail';
  private readonly base: string;

  constructor(private readonly config: GmailTransportConfig) {
    this.base = (config.baseUrl ?? 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, '');
  }

  async send(message: BuiltMessage, options: EmailOptions, signal?: AbortSignal): Promise<TransportResult> {
    const auth = { ...this.config, protocol: 'gmail' as const };
    let threadId: string | undefined;
    if (this.config.threadLookup && options.inReplyTo) {
      const id = options.inReplyTo.replace(/^<|>$/g, '');
      const res = await authorizedRequest('gmail', auth, {
        method: 'GET',
        url: `${this.base}/users/me/messages?maxResults=1&q=${encodeURIComponent(`rfc822msgid:${id}`)}`,
        signal,
      });
      if (res.status < 300) threadId = parseJson<{ messages?: Array<{ threadId: string }> }>('gmail', res).messages?.[0]?.threadId;
    }

    const res = await authorizedRequest('gmail', auth, {
      method: 'POST',
      url: `${this.base}/users/me/messages/send`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: message.raw.toString('base64url'), ...(threadId ? { threadId } : {}) }),
      signal,
    });
    assertOk('gmail', res);
    const data = parseJson<{ id: string; threadId?: string }>('gmail', res);
    return {
      messageId: message.messageId,
      accepted: message.to,
      rejected: [],
      providerMessageId: data.id,
      ...(data.threadId ? { threadId: data.threadId } : {}),
    };
  }
}
