import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { buildMessage } from '../../../src/core/Message.js';
import { GraphMailbox } from '../../../src/mailbox/index.js';

interface Req { method: string; path: string; query: URLSearchParams; body: string; auth?: string }
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))); });

const MESSAGES = [
  {
    id: 'm2', subject: 'Second', isRead: false, isDraft: false, flag: { flagStatus: 'flagged' },
    from: { emailAddress: { name: 'Bob', address: 'bob@x.com' } }, toRecipients: [{ emailAddress: { address: 'me@contoso.com' } }],
    receivedDateTime: '2026-10-02T10:00:00Z', sentDateTime: '2026-10-02T09:59:00Z', internetMessageId: '<m2@x>', conversationId: 'c1', bodyPreview: 'hi',
  },
  {
    id: 'm1', subject: 'First', isRead: true, isDraft: false, flag: { flagStatus: 'notFlagged' },
    from: { emailAddress: { address: 'alice@x.com' } }, receivedDateTime: '2026-10-01T10:00:00Z',
  },
];

async function fakeGraph() {
  const reqs: Req[] = [];
  const mime = (await buildMessage({ from: 'bob@x.com', to: 'me@contoso.com', subject: 'Second', text: 'body text', inReplyTo: '<p@x>', references: ['<p@x>'] })).raw;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const path = decodeURIComponent(url.pathname).replace('/v1.0/users/me@contoso.com', '');
      reqs.push({ method: req.method!, path, query: url.searchParams, body, auth: req.headers.authorization });
      const send = (status: number, data?: unknown, raw?: Buffer) => {
        res.writeHead(status, { 'Content-Type': raw ? 'message/rfc822' : 'application/json' });
        res.end(raw ?? (data === undefined ? '' : JSON.stringify(data)));
      };
      if (req.method === 'GET' && path === '/mailFolders') {
        return send(200, { value: [{ id: 'F-INBOX', displayName: 'Inbox' }, { id: 'F-SENT', displayName: 'Sent Items' }, { id: 'F-PROJ', displayName: 'Projects' }] });
      }
      const wk = /^\/mailFolders\/(inbox|sentitems|drafts|deleteditems|junkemail|archive)$/.exec(path);
      if (req.method === 'GET' && wk) {
        if (url.searchParams.get('$select') === 'id') {
          const ids: Record<string, string> = { inbox: 'F-INBOX', sentitems: 'F-SENT', drafts: 'F-DRAFTS', deleteditems: 'F-TRASH', junkemail: 'F-JUNK' };
          return ids[wk[1]!] ? send(200, { id: ids[wk[1]!] }) : send(404, { error: { code: 'ErrorFolderNotFound' } });
        }
        return send(200, { totalItemCount: 2, unreadItemCount: 1 });
      }
      if (req.method === 'GET' && /^\/mailFolders\/[^/]+\/messages$/.test(path)) return send(200, { value: MESSAGES });
      if (req.method === 'GET' && /^\/messages\/m\d\/\$value$/.test(path)) return send(200, undefined, mime);
      if (req.method === 'GET' && /^\/messages\/m\d$/.test(path)) return send(200, MESSAGES.find(m => path.endsWith(m.id)));
      if (req.method === 'PATCH' && /^\/messages\//.test(path)) return send(200, {});
      if (req.method === 'POST' && /\/move$/.test(path)) return send(201, { id: 'moved' });
      if (req.method === 'POST' && path === '/messages') return send(201, { id: 'draft-1' });
      return send(404, { error: { code: 'NotFound', path } });
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1.0`;
  return { reqs, mime, box: new GraphMailbox({ user: 'me@contoso.com', getToken: () => 'tok', baseUrl: base }) };
}

describe('GraphMailbox', () => {
  it('lists folders with roles and resolves well-known names', async () => {
    const { box } = await fakeGraph();
    const folders = await box.listMailboxes();
    expect(folders).toEqual([
      { id: 'F-INBOX', name: 'Inbox' },
      { id: 'F-SENT', name: 'Sent Items', specialUse: '\\Sent' },
      { id: 'F-PROJ', name: 'Projects' },
    ]);
    expect(await box.findMailbox('\\Sent')).toBe('F-SENT');
    expect(await box.findMailbox('\\Drafts')).toBe('F-DRAFTS');
    expect(await box.status('Inbox')).toEqual({ total: 2, unread: 1 });
  });

  it('fetches with flags, envelope, thread and preview; filters map to $filter', async () => {
    const { box, reqs } = await fakeGraph();
    const msgs = await box.fetch({ mailbox: 'INBOX', limit: 10, search: { seen: false, since: new Date('2026-10-01T00:00:00Z') } });
    expect(msgs[0]).toMatchObject({
      id: 'm2', mailbox: 'INBOX', flags: ['\\Flagged'], threadId: 'c1', snippet: 'hi',
      envelope: { subject: 'Second', from: [{ email: 'bob@x.com', name: 'Bob' }], messageId: '<m2@x>' },
    });
    const q = reqs.find(r => r.path === '/mailFolders/inbox/messages')!.query;
    // receivedDateTime leads the filter because it is the $orderby property (Graph InefficientFilter rule)
    expect(q.get('$filter')).toBe('receivedDateTime ge 2026-10-01T00:00:00.000Z and isRead eq false');
    expect(q.get('$orderby')).toBe('receivedDateTime desc');
    expect(reqs.every(r => r.auth === 'Bearer tok')).toBe(true);
  });

  it('text criteria use KQL $search and apply seen/flagged locally', async () => {
    const { box, reqs } = await fakeGraph();
    const msgs = await box.fetch({ search: { from: 'bob@x.com', subject: 'Q3 "plan"', flagged: false } });
    const q = reqs.find(r => r.path.endsWith('/messages'))!.query;
    expect(q.get('$search')).toBe('"from:bob@x.com AND subject:Q3  plan"');
    expect(q.get('$filter')).toBeNull();
    expect(msgs.map(m => m.id)).toEqual(['m1']); // m2 is flagged → filtered out locally
  });

  it('bodies come from raw MIME, with threading headers', async () => {
    const { box, mime } = await fakeGraph();
    const [m] = await box.fetch({ ids: ['m2'], bodies: true });
    expect(m!.body!.text).toBe('body text');
    expect(m!.envelope.inReplyTo).toBe('<p@x>');
    expect(m!.envelope.references).toEqual(['<p@x>']);
    expect((await box.fetchRaw('m2')).equals(mime)).toBe(true);
  });

  it('flags, moves to folders by name, deletes to Deleted Items', async () => {
    const { box, reqs } = await fakeGraph();
    await box.setSeen(['m1'], true);
    await box.setFlagged(['m1'], true);
    await box.move(['m1'], 'Projects');
    await box.delete(['m2']);
    const writes = reqs.filter(r => r.method !== 'GET').map(r => [r.method, r.path, r.body]);
    expect(writes).toEqual([
      ['PATCH', '/messages/m1', '{"isRead":true}'],
      ['PATCH', '/messages/m1', '{"flag":{"flagStatus":"flagged"}}'],
      ['POST', '/messages/m1/move', '{"destinationId":"F-PROJ"}'],
      ['POST', '/messages/m2/move', '{"destinationId":"deleteditems"}'],
    ]);
  });

  it('append creates drafts from MIME and refuses non-draft folders', async () => {
    const { box, reqs } = await fakeGraph();
    const raw = (await buildMessage({ from: 'me@contoso.com', to: 'a@x.com', text: 'draft' })).raw;
    expect(await box.append('Drafts', raw)).toEqual({ id: 'draft-1' });
    const post = reqs.find(r => r.method === 'POST' && r.path === '/messages')!;
    expect(Buffer.from(post.body, 'base64').equals(raw)).toBe(true);
    await expect(box.append('Sent', raw)).rejects.toThrow(/only create drafts/);
  });

  it('watch() baselines, then reports newly received ids once', async () => {
    const { box, reqs } = await fakeGraph();
    const w = await box.watch('INBOX', { pollMs: 20 });
    const ids = await new Promise<string[]>(r => w.on('new', r));
    expect(ids.sort()).toEqual(['m1', 'm2']);
    const poll = reqs.filter(r => r.path === '/mailFolders/inbox/messages').at(-1)!.query;
    expect(poll.get('$filter')).toMatch(/^receivedDateTime ge /);
    await new Promise(r => setTimeout(r, 60));
    await w.stop();
  });
});
