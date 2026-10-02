import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { buildMessage } from '../../../src/core/Message.js';
import { GmailMailbox, toGmailQuery } from '../../../src/mailbox/index.js';

interface Req { method: string; path: string; query: URLSearchParams; body: string }
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))); });

async function fakeGmail(opts: { historyGone?: boolean } = {}) {
  const reqs: Req[] = [];
  const raw = (await buildMessage({ from: 'Bob <bob@x.com>', to: 'me@gmail.com', subject: 'Plan', text: 'body', references: ['<root@x>'] })).raw;
  let historyCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const path = url.pathname.replace('/gmail/v1/users/me', '');
      reqs.push({ method: req.method!, path, query: url.searchParams, body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (path === '/labels') return send(200, { labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'SENT', name: 'SENT', type: 'system' },
        { id: 'UNREAD', name: 'UNREAD', type: 'system' }, { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
        { id: 'Label_7', name: 'Projects', type: 'user' },
      ] });
      if (path.startsWith('/labels/')) return send(200, { messagesTotal: 10, messagesUnread: 3 });
      if (req.method === 'GET' && path === '/messages') {
        return send(200, url.searchParams.get('pageToken')
          ? { messages: [{ id: 'g3' }] }
          : { messages: [{ id: 'g1' }, { id: 'g2' }], nextPageToken: 'p2' });
      }
      const one = /^\/messages\/(g\d)$/.exec(path);
      if (req.method === 'GET' && one) {
        const base = { id: one[1], threadId: 't-' + one[1], labelIds: one[1] === 'g1' ? ['INBOX', 'UNREAD'] : ['INBOX', 'STARRED'], snippet: 'snip', internalDate: '1759399200000', sizeEstimate: 42 };
        if (url.searchParams.get('format') === 'raw') return send(200, { ...base, raw: raw.toString('base64url') });
        return send(200, { ...base, payload: { headers: [
          { name: 'From', value: 'Bob <bob@x.com>' }, { name: 'Subject', value: '=?UTF-8?B?w4ljbGFpcg==?=' },
          { name: 'Message-ID', value: `<${one[1]}@x>` }, { name: 'References', value: '<root@x>' },
        ] } });
      }
      if (path === '/messages/batchModify') { res.writeHead(204).end(); return; }
      if (/\/trash$/.test(path)) return send(200, { id: 'x' });
      if (req.method === 'POST' && path === '/drafts') return send(200, { id: 'r-1', message: { id: 'd1' } });
      if (req.method === 'POST' && path === '/messages') return send(200, { id: 'i1' });
      if (path === '/profile') return send(200, { historyId: '100' });
      if (path === '/history') {
        historyCalls++;
        if (opts.historyGone && historyCalls === 1) return send(404, { error: { message: 'Requested entity was not found.' } });
        return send(200, { historyId: '105', history: [{ messagesAdded: [{ message: { id: 'n1' } }] }, { messagesAdded: [{ message: { id: 'n1' } }, { message: { id: 'n2' } }] }] });
      }
      return send(404, { error: { message: `no route ${path}` } });
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gmail/v1`;
  return { reqs, raw, box: new GmailMailbox({ user: 'me@gmail.com', getToken: () => 'tok', baseUrl }) };
}

describe('toGmailQuery', () => {
  it('maps criteria to Gmail search syntax', () => {
    expect(toGmailQuery({
      from: 'bob@x.com', subject: 'Q3 "plan"', text: 'invoice', seen: false, flagged: true,
      since: new Date('2026-09-01T00:00:00Z'), before: new Date('2026-10-01T00:00:00Z'),
    })).toBe('from:"bob@x.com" subject:"Q3  plan" "invoice" after:2026/9/1 before:2026/10/1 is:unread is:starred');
    expect(toGmailQuery({})).toBe('');
  });
});

describe('GmailMailbox', () => {
  it('lists labels (hiding category/unread) with roles, finds and counts', async () => {
    const { box } = await fakeGmail();
    expect(await box.listMailboxes()).toEqual([
      { id: 'INBOX', name: 'INBOX' }, { id: 'SENT', name: 'SENT', specialUse: '\\Sent' }, { id: 'Label_7', name: 'Projects' },
    ]);
    expect(await box.findMailbox('\\Trash')).toBe('TRASH');
    expect(await box.status('Projects')).toEqual({ total: 10, unread: 3 });
  });

  it('fetches metadata with flags from labels, decoded headers and references; pages through search', async () => {
    const { box, reqs } = await fakeGmail();
    const msgs = await box.fetch({ limit: 3, search: { seen: false } });
    expect(msgs.map(m => m.id)).toEqual(['g1', 'g2', 'g3']);
    expect(msgs[0]).toMatchObject({ flags: [], threadId: 't-g1', snippet: 'snip', size: 42, envelope: { subject: 'Éclair', references: ['<root@x>'] } });
    expect(msgs[1]!.flags).toEqual(['\\Seen', '\\Flagged']);
    const list = reqs.find(r => r.path === '/messages' && r.method === 'GET')!.query;
    expect(list.get('labelIds')).toBe('INBOX');
    expect(list.get('q')).toBe('is:unread');
    expect(reqs.find(r => r.path === '/messages/g1')!.query.getAll('metadataHeaders')).toContain('References');
  });

  it('bodies come from format=raw MIME', async () => {
    const { box, raw } = await fakeGmail();
    const [m] = await box.fetch({ ids: ['g1'], bodies: true });
    expect(m!.body!.text).toBe('body');
    expect(m!.envelope.references).toEqual(['<root@x>']);
    expect((await box.fetchRaw('g1')).equals(raw)).toBe(true);
  });

  it('flags, moves (label swap), trashes', async () => {
    const { box, reqs } = await fakeGmail();
    await box.setSeen(['g1'], true);
    await box.setFlagged(['g1', 'g2'], true);
    await box.move(['g1'], 'Projects');
    await box.move(['g2'], 'Trash');
    const writes = reqs.filter(r => r.method === 'POST').map(r => [r.path, r.body]);
    expect(writes).toEqual([
      ['/messages/batchModify', '{"ids":["g1"],"addLabelIds":[],"removeLabelIds":["UNREAD"]}'],
      ['/messages/batchModify', '{"ids":["g1","g2"],"addLabelIds":["STARRED"],"removeLabelIds":[]}'],
      ['/messages/batchModify', '{"ids":["g1"],"addLabelIds":["Label_7"],"removeLabelIds":["INBOX"]}'],
      ['/messages/g2/trash', ''],
    ]);
  });

  it('append: drafts via drafts.create, other labels via messages.insert', async () => {
    const { box, reqs, raw } = await fakeGmail();
    expect(await box.append('Drafts', raw)).toEqual({ id: 'd1' });
    expect(await box.append('Projects', raw, { seen: false })).toEqual({ id: 'i1' });
    const insert = reqs.find(r => r.method === 'POST' && r.path === '/messages')!;
    expect(JSON.parse(insert.body)).toEqual({ raw: raw.toString('base64url'), labelIds: ['Label_7', 'UNREAD'] });
    expect(insert.query.get('internalDateSource')).toBe('dateHeader');
  });

  it('watch() reports added ids from history once per poll', async () => {
    const { box, reqs } = await fakeGmail();
    const w = await box.watch('INBOX', { pollMs: 20 });
    expect(await new Promise<string[]>(r => w.on('new', r))).toEqual(['n1', 'n2']);
    const h = reqs.find(r => r.path === '/history')!.query;
    expect(h.get('startHistoryId')).toBe('100');
    expect(h.get('labelId')).toBe('INBOX');
    await w.stop();
  });

  it('watch() re-baselines and emits reset when history expired', async () => {
    const { box } = await fakeGmail({ historyGone: true });
    const w = await box.watch('INBOX', { pollMs: 20 });
    await new Promise<void>(r => w.once('reset', () => r()));
    expect(await new Promise<string[]>(r => w.on('new', r))).toEqual(['n1', 'n2']);
    await w.stop();
  });
});
