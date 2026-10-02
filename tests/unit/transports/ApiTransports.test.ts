import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { GraphTransport, GmailTransport } from '../../../src/transports/index.js';
import { buildMessage } from '../../../src/core/Message.js';
import { parseMessage } from '../../../src/core/MimeParser.js';
import { MailTs } from '../../../src/core/MailTs.js';
import { microsoft, googleWith, SCOPES } from '../../../src/oauth/index.js';
import type { EmailOptions } from '../../../src/types/core.js';

interface Req { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))); });

async function api(handler: (r: Req) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const reqs: Req[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body };
      reqs.push(r);
      const out = handler(r);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json', ...out.headers }).end(out.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reqs };
}

const email: EmailOptions = {
  from: 'me@contoso.com', to: 'a@x.com', subject: 'Re: plan', text: 'ok',
  inReplyTo: '<parent@x.com>', references: ['<parent@x.com>'],
  unsubscribe: { url: 'https://x.com/u' },
  attachments: [{ filename: 'a.bin', content: Buffer.from([0, 255]) }],
};

function tokens(valid = 'good') {
  const calls: Array<{ protocol: string; invalid: boolean }> = [];
  const getToken = ({ protocol, invalid }: { protocol: string; invalid: boolean }) => {
    calls.push({ protocol, invalid });
    return invalid ? valid : calls.length === 1 && valid !== 'stale' ? 'stale' : valid;
  };
  return { calls, getToken };
}

describe('scope presets', () => {
  it('requests Graph scopes for api: graph and keeps IMAP/SMTP as default', () => {
    expect(microsoft({ api: 'graph' }).scopes).toEqual(expect.arrayContaining(['https://graph.microsoft.com/Mail.Send', 'offline_access']));
    expect(microsoft({ api: 'graph' }).scopes.some(s => s.includes('outlook.office.com'))).toBe(false);
    expect(microsoft().scopes).toEqual(expect.arrayContaining(SCOPES.microsoft.imapSmtp));
    expect(googleWith(SCOPES.google.send).scopes).toEqual(['https://www.googleapis.com/auth/gmail.send', 'openid', 'email']);
  });
});

describe('GraphTransport', () => {
  it('posts base64 MIME to /users/{user}/sendMail and refreshes once on 401', async () => {
    const { calls, getToken } = tokens();
    const s = await api(r => (r.headers.authorization === 'Bearer good' ? { status: 202 } : { status: 401, body: '{"error":{"code":"InvalidAuthenticationToken"}}' }));
    const built = await buildMessage(email);
    const res = await new GraphTransport({ user: 'me@contoso.com', getToken, baseUrl: s.base }).send(built, email);

    expect(res.messageId).toBe(built.messageId);
    expect(calls).toEqual([{ protocol: 'graph', invalid: false }, { protocol: 'graph', invalid: true }]);
    const req = s.reqs[1]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/users/me%40contoso.com/sendMail');
    expect(req.headers['content-type']).toBe('text/plain');
    const mime = Buffer.from(req.body, 'base64');
    expect(mime.equals(built.raw)).toBe(true);
    const parsed = parseMessage(mime);
    expect(parsed.envelope.inReplyTo).toBe('<parent@x.com>');
    expect(parsed.headers.get('list-unsubscribe')).toBe('<https://x.com/u>');
  });

  it('maps throttling to a retryable TransportError with Retry-After', async () => {
    const s = await api(() => ({ status: 429, headers: { 'retry-after': '3' }, body: '{"error":{"code":"ApplicationThrottled"}}' }));
    const err = await new GraphTransport({ user: 'u@x.com', getToken: () => 'good', baseUrl: s.base })
      .send(await buildMessage(email), email).catch(e => e);
    expect(err).toMatchObject({ provider: 'graph', status: 429, retryable: true, retryAfterMs: 3_000 });
  });

  it('works end to end through MailTs', async () => {
    const s = await api(() => ({ status: 202 }));
    const mail = new MailTs({ transport: new GraphTransport({ user: 'me@contoso.com', getToken: () => 't', baseUrl: s.base }) });
    expect((await mail.send(email)).ok).toBe(true);
  });
});

describe('GmailTransport', () => {
  it('sends base64url raw MIME and returns Gmail ids', async () => {
    const s = await api(() => ({ body: '{"id":"18f","threadId":"t1","labelIds":["SENT"]}' }));
    const built = await buildMessage(email);
    const res = await new GmailTransport({ user: 'me@gmail.com', getToken: () => 'good', baseUrl: s.base }).send(built, email);
    expect(res).toMatchObject({ messageId: built.messageId, providerMessageId: '18f', threadId: 't1' });
    const req = s.reqs[0]!;
    expect(req.url).toBe('/users/me/messages/send');
    const body = JSON.parse(req.body) as { raw: string; threadId?: string };
    expect(body.raw).not.toMatch(/[+/=]/);                       // base64url
    expect(Buffer.from(body.raw, 'base64url').equals(built.raw)).toBe(true);
    expect(body.threadId).toBeUndefined();
  });

  it('threadLookup finds the thread of In-Reply-To and sends into it', async () => {
    const s = await api(r => (r.method === 'GET'
      ? { body: '{"messages":[{"id":"p1","threadId":"thread-9"}]}' }
      : { body: '{"id":"n1","threadId":"thread-9"}' }));
    await new GmailTransport({ user: 'me@gmail.com', getToken: () => 'good', baseUrl: s.base, threadLookup: true })
      .send(await buildMessage(email), email);
    expect(decodeURIComponent(s.reqs[0]!.url)).toContain('q=rfc822msgid:parent@x.com');
    expect(JSON.parse(s.reqs[1]!.body).threadId).toBe('thread-9');
  });

  it('refreshes on 401, and a persistent 403 is a non-retryable auth error', async () => {
    const { calls, getToken } = tokens();
    const s1 = await api(r => (r.headers.authorization === 'Bearer good' ? { body: '{"id":"x"}' } : { status: 401, body: '{}' }));
    await new GmailTransport({ user: 'me@gmail.com', getToken, baseUrl: s1.base }).send(await buildMessage(email), email);
    expect(calls.map(c => c.invalid)).toEqual([false, true]);

    const s2 = await api(() => ({ status: 403, body: '{"error":{"message":"Insufficient Permission"}}' }));
    const err = await new GmailTransport({ user: 'me@gmail.com', getToken: () => 'good', baseUrl: s2.base }).send(await buildMessage(email), email).catch(e => e);
    expect(err).toMatchObject({ code: 'EAUTH', retryable: false, status: 403 });
  });
});
