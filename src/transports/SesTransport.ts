import { createHash, createHmac } from 'crypto';
import { httpRequest } from './HttpClient.js';
import type { Transport, TransportResult } from './Transport.js';
import type { BuiltMessage } from '../core/Message.js';
import type { EmailOptions } from '../types/core.js';

export interface SesConfig {
  /** AWS region (e.g. `us-east-1`). */
  region: string;
  /** AWS access key ID. */
  accessKeyId: string;
  /** AWS secret access key. */
  secretAccessKey: string;
  /** Temporary session token (when using STS / instance profiles). */
  sessionToken?: string;
}

/**
 * Send via [AWS SES](https://aws.amazon.com/ses/) v2 HTTP API.
 *
 * Sends the raw RFC 5322 message directly — all MIME features and DKIM signatures
 * are preserved. Credentials are signed with AWS Signature Version 4.
 *
 * @example
 * ```ts
 * const mail = new MailTs({
 *   transport: new SesTransport({
 *     region: 'us-east-1',
 *     accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *   }),
 * });
 * ```
 */
export class SesTransport implements Transport {
  readonly name = 'ses';

  constructor(private config: SesConfig) {}

  async send(message: BuiltMessage, _options: EmailOptions): Promise<TransportResult> {
    const { region } = this.config;
    const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;

    // SES v2 SendEmail with raw content
    const body = JSON.stringify({
      Content: {
        Raw: {
          Data: message.raw.toString('base64'),
        },
      },
    });

    const headers = await this.sign('POST', url, body);

    const res = await httpRequest({ method: 'POST', url, headers, body });

    if (res.status >= 400) {
      throw new Error(`SES error ${res.status}: ${res.body}`);
    }

    const data = JSON.parse(res.body) as { MessageId: string };
    return { messageId: `<${data.MessageId}>`, accepted: message.to, rejected: [] };
  }

  // ── AWS Signature Version 4 ────────────────────────────────────────────────

  private async sign(
    method: string,
    urlStr: string,
    body: string,
  ): Promise<Record<string, string>> {
    const { accessKeyId, secretAccessKey, sessionToken, region } = this.config;
    const service = 'ses';

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);

    const url = new URL(urlStr);
    const host = url.hostname;

    const bodyHash = sha256Hex(body);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Host':         host,
      'X-Amz-Date':  amzDate,
    };
    if (sessionToken) headers['X-Amz-Security-Token'] = sessionToken;

    // Canonical headers (sorted lowercase)
    const signedHeaderNames = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames
      .map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)!]!.trim()}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      url.pathname,
      '', // no query string
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = this.deriveSigningKey(secretAccessKey, dateStamp, region, service);
    const signature = hmacHex(signingKey, stringToSign);

    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { ...headers, Authorization: authHeader };
  }

  private deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
    const kDate    = hmacBuf(Buffer.from(`AWS4${secret}`, 'utf8'), date);
    const kRegion  = hmacBuf(kDate, region);
    const kService = hmacBuf(kRegion, service);
    return hmacBuf(kService, 'aws4_request');
  }
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacBuf(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}
