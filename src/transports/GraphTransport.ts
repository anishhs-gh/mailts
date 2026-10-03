import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';
import type { TokenProvider } from '../types/auth.js';
import { authorizedRequest } from './ApiAuth.js';
import { assertOk } from './utils.js';

/**
 * Options for `new GraphTransport()`.
 * @experimental Not yet verified against a live Microsoft 365 tenant.
 */
export interface GraphTransportConfig {
  /** Mailbox to send as (UPN / email). Also passed to `getToken`. */
  user: string;
  /**
   * Access-token provider for Microsoft Graph — e.g.
   * `microsoftTokenProvider({ …, provider: microsoft({ api: 'graph-send' }) })`.
   * Delegated tokens need `Mail.Send`; app-only tokens need the `Mail.Send` application permission.
   */
  getToken: TokenProvider;
  /** @default 'https://graph.microsoft.com/v1.0' (sovereign clouds: graph.microsoft.us, …) */
  baseUrl?: string;
}

/**
 * Send through Microsoft Graph (`POST /users/{user}/sendMail`) with the MIME
 * built by mailts — attachments, threading headers, unsubscribe headers and
 * custom headers are preserved. Works when the tenant disables SMTP AUTH.
 * Graph saves a copy to Sent Items.
 *
 * Note: Graph limits a single request to ~4 MB; larger messages need upload
 * sessions, which this transport does not do yet.
 *
 * @experimental Not yet verified against a live Microsoft 365 tenant.
 */
export class GraphTransport implements Transport {
  readonly name = 'graph';
  private readonly base: string;

  constructor(private readonly config: GraphTransportConfig) {
    this.base = (config.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  }

  async send(message: BuiltMessage, _options: EmailOptions, signal?: AbortSignal): Promise<TransportResult> {
    const res = await authorizedRequest('graph', { ...this.config, protocol: 'graph' }, {
      method: 'POST',
      url: `${this.base}/users/${encodeURIComponent(this.config.user)}/sendMail`,
      headers: { 'Content-Type': 'text/plain' },  // Graph's MIME send: base64 MIME in a text/plain body
      body: message.raw.toString('base64'),
      signal,
    });
    assertOk('graph', res);
    return { messageId: message.messageId, accepted: message.to, rejected: [] };
  }
}
