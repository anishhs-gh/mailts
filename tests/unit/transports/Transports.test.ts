/**
 * HTTP API transports against a local server: exact request shape, auth,
 * attachments, threading headers, and error mapping (retryable vs not).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { createHash, createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import { MailTs } from '../../../src/core/MailTs.js';
import { buildMessage } from '../../../src/core/Message.js';
import { ResendTransport, SendGridTransport, MailgunTransport, PostmarkTransport, SesTransport } from '../../../src/transports/index.js';
import { TransportError } from '../../../src/errors.js';
import type { Transport } from '../../../src/transports/Transport.js';
import type { EmailOptions } from '../../../src/types/core.js';

interface Captured { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
type Reply = { status?: number; headers?: Record<string, string>; body?: string };

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))); });

async function api(reply: Reply | ((req: Captured) => Reply)): Promise<{ base: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const cap = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(cap);
      const r = typeof reply === 'function' ? reply(cap) : reply;
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers }).end(r.body ?? '{}');
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const email: EmailOptions = {
  from: { email: 'me@x.com', name: 'Me' },
  to: ['a@x.com', { email: 'b@x.com', name: 'Bee' }],
  cc: 'c@x.com',
  bcc: 'd@x.com',
  replyTo: 'r@x.com',
  subject: 'Hello',
  text: 'plain',
  html: '<p>html <img src="cid:logo"></p>',
  headers: { 'X-Campaign': 'q3' },
  inReplyTo: '<parent@x.com>',
  references: ['<root@x.com>', '<parent@x.com>'],
  attachments: [
    { filename: 'r.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
    { filename: 'logo.png', content: Buffer.from([1, 2, 3]), contentType: 'image/png', cid: 'logo' },
  ],
};

async function sendWith(t: Transport, opts: EmailOptions = email) {
  return t.send(await buildMessage(opts), opts);
}
const json = (c: Captured) => JSON.parse(c.body.toString()) as Record<string, unknown>;

describe('ResendTransport', () => {
  it('posts the documented payload with threading headers and cid attachments', async () => {
    const s = await api({ body: '{"id":"re_123"}' });
    const r = await sendWith(new ResendTransport({ apiKey: 're_key', baseUrl: s.base }));
    expect(r.messageId).toBe('re_123');
    const req = s.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/emails');
    expect(req.headers.authorization).toBe('Bearer re_key');
    const body = json(req);
    expect(body).toMatchObject({
      from: 'Me <me@x.com>', to: ['a@x.com', 'Bee <b@x.com>'], cc: ['c@x.com'], bcc: ['d@x.com'],
      reply_to: 'r@x.com', subject: 'Hello', text: 'plain',
    });
    expect(body['headers']).toMatchObject({
      'X-Campaign': 'q3', 'In-Reply-To': '<parent@x.com>', References: '<root@x.com> <parent@x.com>',
    });
    expect(body['attachments']).toEqual([
      { filename: 'r.pdf', content: Buffer.from('%PDF').toString('base64'), content_type: 'application/pdf' },
      { filename: 'logo.png', content: 'AQID', content_type: 'image/png', content_id: 'logo' },
    ]);
  });
});

describe('SendGridTransport', () => {
  it('builds personalizations, content, inline attachments and reads x-message-id', async () => {
    const s = await api({ status: 202, headers: { 'x-message-id': 'sg_1' }, body: '' });
    const r = await sendWith(new SendGridTransport({ apiKey: 'SG.k', baseUrl: s.base }));
    expect(r.messageId).toBe('sg_1');
    const body = json(s.requests[0]!);
    expect(s.requests[0]!.url).toBe('/v3/mail/send');
    expect(body['personalizations']).toEqual([{
      to: [{ email: 'a@x.com' }, { email: 'b@x.com', name: 'Bee' }], cc: [{ email: 'c@x.com' }], bcc: [{ email: 'd@x.com' }],
    }]);
    expect(body['content']).toEqual([{ type: 'text/plain', value: 'plain' }, { type: 'text/html', value: '<p>html <img src="cid:logo"></p>' }]);
    expect((body['attachments'] as Array<Record<string, string>>)[1]).toMatchObject({ disposition: 'inline', content_id: 'logo' });
    expect((body['headers'] as Record<string, string>)['References']).toBe('<root@x.com> <parent@x.com>');
  });
});

describe('PostmarkTransport', () => {
  it('uses the server token, message stream and Name/Value headers', async () => {
    const s = await api({ body: '{"MessageID":"pm-1"}' });
    const r = await sendWith(new PostmarkTransport({ serverToken: 'tok', messageStream: 'broadcast', baseUrl: s.base }));
    expect(r.messageId).toBe('<pm-1>');
    const req = s.requests[0]!;
    expect(req.headers['x-postmark-server-token']).toBe('tok');
    const body = json(req);
    expect(body).toMatchObject({ To: 'a@x.com, Bee <b@x.com>', MessageStream: 'broadcast', ReplyTo: 'r@x.com' });
    expect(body['Headers']).toEqual(expect.arrayContaining([{ Name: 'In-Reply-To', Value: '<parent@x.com>' }]));
    expect((body['Attachments'] as Array<Record<string, string>>)[1]).toMatchObject({ ContentID: 'cid:logo' });
  });
});

describe('MailgunTransport', () => {
  it('sends the exact built MIME via messages.mime with basic auth', async () => {
    const s = await api({ body: '{"id":"<mg@x>","message":"Queued"}' });
    const built = await buildMessage(email);
    const r = await new MailgunTransport({ apiKey: 'key-1', domain: 'mg.x.com', baseUrl: s.base }).send(built, email);
    expect(r.messageId).toBe('<mg@x>');
    const req = s.requests[0]!;
    expect(req.url).toBe('/v3/mg.x.com/messages.mime');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('api:key-1').toString('base64')}`);
    expect(req.body.includes(built.raw)).toBe(true);                // byte-exact MIME
    expect(req.body.toString()).toContain('a@x.com, b@x.com, c@x.com, d@x.com'); // envelope incl. bcc
  });

  it('uses the EU host for region eu', () => {
    const t = new MailgunTransport({ apiKey: 'k', domain: 'd', region: 'eu' }) as unknown as { base: string };
    expect(t.base).toBe('https://api.eu.mailgun.net');
  });
});

describe('SesTransport', () => {
  it('derives the AWS SigV4 signing key from the documented test vector', () => {
    // https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
    const t = new SesTransport({ region: 'us-east-1', accessKeyId: 'x', secretAccessKey: 'x' });
    const key = t.deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });

  it('sends raw MIME with a signature the server can verify', async () => {
    const secret = 'secretKEY';
    let verified = false;
    const s = await api((req) => {
      // Independent re-implementation of the server side of SigV4
      const auth = String(req.headers.authorization);
      const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/ses\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth)!;
      const [, keyId, date, region, signed, sig] = m;
      const names = signed!.split(';');
      const canonHeaders = names.map(n => `${n}:${String(req.headers[n]).trim()}\n`).join('');
      const canon = ['POST', '/v2/email/outbound-emails', '', canonHeaders, signed, createHash('sha256').update(req.body).digest('hex')].join('\n');
      const scope = `${date}/${region}/ses/aws4_request`;
      const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, createHash('sha256').update(canon).digest('hex')].join('\n');
      const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
      const kSign = h(h(h(h(`AWS4${secret}`, date!), region!), 'ses'), 'aws4_request');
      verified = keyId === 'AKID' && createHmac('sha256', kSign).update(sts).digest('hex') === sig;
      return { body: '{"MessageId":"ses-1"}' };
    });
    const t = new SesTransport({ region: 'eu-west-1', accessKeyId: 'AKID', secretAccessKey: secret, sessionToken: 'sess', endpoint: s.base });
    const built = await buildMessage(email);
    const r = await t.send(built, email);
    expect(r.messageId).toBe('<ses-1>');
    expect(verified).toBe(true);
    const req = s.requests[0]!;
    expect(req.headers['x-amz-security-token']).toBe('sess');
    expect(Buffer.from((json(req)['Content'] as { Raw: { Data: string } }).Raw.Data, 'base64').equals(built.raw)).toBe(true);
  });
});

describe('error mapping (all HTTP transports)', () => {
  const make: Array<[string, (base: string) => Transport]> = [
    ['resend', b => new ResendTransport({ apiKey: 'k', baseUrl: b })],
    ['sendgrid', b => new SendGridTransport({ apiKey: 'k', baseUrl: b })],
    ['postmark', b => new PostmarkTransport({ serverToken: 'k', baseUrl: b })],
    ['mailgun', b => new MailgunTransport({ apiKey: 'k', domain: 'd', baseUrl: b })],
    ['ses', b => new SesTransport({ region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's', endpoint: b })],
  ];

  for (const [name, factory] of make) {
    it(`${name}: 429 is retryable with Retry-After, 422 is not, 401 is an auth error`, async () => {
      let status = 429;
      const s = await api(() => ({ status, headers: { 'retry-after': '7' }, body: '{"message":"slow down"}' }));
      const t = factory(s.base);
      const e429 = await sendWith(t, { from: 'me@x.com', to: 'a@x.com', text: 't' }).catch(e => e);
      expect(e429).toBeInstanceOf(TransportError);
      expect(e429).toMatchObject({ provider: name, status: 429, retryable: true, retryAfterMs: 7_000 });

      status = 422;
      const e422 = await sendWith(t, { from: 'me@x.com', to: 'a@x.com', text: 't' }).catch(e => e);
      expect(e422).toMatchObject({ status: 422, retryable: false, code: 'EREJECT' });

      status = 401;
      expect(await sendWith(t, { from: 'me@x.com', to: 'a@x.com', text: 't' }).catch(e => e)).toMatchObject({ code: 'EAUTH', retryable: false });
    });
  }

  it('network failures are retryable; aborts are not', async () => {
    const t = new ResendTransport({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
    expect(await sendWith(t, { from: 'me@x.com', to: 'a@x.com', text: 't' }).catch(e => e)).toMatchObject({ status: 0, retryable: true });

    const s = await api(() => ({ body: '{}' }));
    const ac = new AbortController();
    ac.abort();
    const msg = await buildMessage({ from: 'me@x.com', to: 'a@x.com', text: 't' });
    const aborted = await new ResendTransport({ apiKey: 'k', baseUrl: s.base }).send(msg, { from: 'me@x.com', to: 'a@x.com', text: 't' }, ac.signal).catch(e => e);
    expect(aborted).toMatchObject({ retryable: false });
  });

  it('a non-JSON 2xx body becomes a retryable TransportError, not a crash', async () => {
    const s = await api({ body: '<html>gateway</html>' });
    expect(await sendWith(new ResendTransport({ apiKey: 'k', baseUrl: s.base })).catch(e => e)).toMatchObject({ retryable: true });
  });

  it('the queue retries a 503 after Retry-After and then succeeds', async () => {
    let n = 0;
    const s = await api(() => (++n === 1 ? { status: 503, headers: { 'retry-after': '0.05' }, body: '{}' } : { body: '{"id":"ok"}' }));
    const mail = new MailTs({ transport: new ResendTransport({ apiKey: 'k', baseUrl: s.base }), queue: { retryDelay: 1, jitter: false } });
    const job = mail.queue.enqueue({ from: 'me@x.com', to: 'a@x.com', text: 't' });
    const t0 = Date.now();
    await mail.queue.drain();
    expect(job.status).toBe('success');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });
});
