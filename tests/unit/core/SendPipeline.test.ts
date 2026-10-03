import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MailTs } from '../../../src/core/MailTs.js';
import { MailWorker } from '../../../src/queue/MailWorker.js';
import { buildMessage } from '../../../src/core/Message.js';
import type { Transport } from '../../../src/transports/Transport.js';
import type { EmailOptions } from '../../../src/types/core.js';
import type { QueueDriver } from '../../../src/queue/QueueDriver.js';

afterEach(() => vi.restoreAllMocks());

const capture = () => {
  const seen: EmailOptions[] = [];
  const transport: Transport = { name: 'cap', async send(m, o) { seen.push(o); return { messageId: m.messageId, accepted: m.to, rejected: [] }; } };
  return { seen, transport };
};

describe('address validation in buildMessage', () => {
  it('rejects malformed addresses instead of passing them to transports', async () => {
    for (const bad of ['no-at-sign', 'a b@x.com', 'a@x.com>RCPT TO:<v@x.com', '"q"@x.com', 'a@b@c']) {
      await expect(buildMessage({ from: 'a@x.com', to: bad, text: 'x' })).rejects.toThrow(/Invalid email address/);
    }
    await expect(buildMessage({ from: 'a@x.com', to: 'b@x.com', bcc: 'x y@z.com', text: 'x' })).rejects.toThrow();
    await expect(buildMessage({ from: 'a@x.com', to: 'b@x.com', replyTo: 'bad', text: 'x' })).rejects.toThrow();
    await expect(buildMessage({ from: 'a@x.com', to: ['用户@例子.广告', 'o\'brien+tag@x.co.uk'], text: 'x' })).resolves.toBeTruthy();
  });
});

describe('attachment path policy', () => {
  it('rejects path attachments when no policy is set, without reading the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailts-deny-'));
    writeFileSync(join(dir, 'f.txt'), 'secret');
    const { seen, transport } = capture();
    const mail = new MailTs({ transport });
    const r = await mail.send({ from: 'a@x.com', to: 'b@x.com', text: 'x', attachments: [{ filename: 'f', path: join(dir, 'f.txt') }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/disabled by default/);
    expect(seen).toHaveLength(0);
    await expect(buildMessage({ from: 'a@x.com', to: 'b@x.com', text: 'x', attachments: [{ filename: 'f', path: join(dir, 'f.txt') }] }))
      .rejects.toThrow(/attachmentPolicy/);

    const explicit = new MailTs({ transport, attachmentPolicy: 'allow' });
    expect((await explicit.send({ from: 'a@x.com', to: 'b@x.com', text: 'x', attachments: [{ filename: 'f', path: join(dir, 'f.txt') }] })).ok).toBe(true);
    expect((seen[0]!.attachments![0]!.content as Buffer).toString()).toBe('secret');
  });

  it('HTTP transports receive file content resolved under { root } (regression)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mailts-root-'));
    writeFileSync(join(root, 'report.csv'), 'a,b');
    const { seen, transport } = capture();
    const mail = new MailTs({ transport, attachmentPolicy: { root } });
    const r = await mail.send({ from: 'a@x.com', to: 'b@x.com', text: 'x', attachments: [{ filename: 'report.csv', path: 'report.csv' }] });
    expect(r.ok).toBe(true);
    const att = seen[0]!.attachments![0]!;
    expect(att.path).toBeUndefined();
    expect((att.content as Buffer).toString()).toBe('a,b');
  });
});

describe('MailWorker driver hooks', () => {
  function driver(withCancel: boolean) {
    let given = false;
    const calls: string[] = [];
    const d: QueueDriver = {
      async dequeue() {
        if (given) return null;
        given = true;
        return { id: 'm1', data: { to: 'a@x.com', text: 'x' } };
      },
      async ack(id) { calls.push(`ack:${id}`); },
      async nack(id) { calls.push(`nack:${id}`); },
      ...(withCancel ? { async cancel(id: string) { calls.push(`cancel:${id}`); } } : {}),
    };
    return { d, calls };
  }

  for (const withCancel of [true, false]) {
    it(`cancelled jobs are ${withCancel ? 'reported via driver.cancel' : 'acked when cancel() is not implemented'}`, async () => {
      const { d, calls } = driver(withCancel);
      const slow: Transport = {
        name: 'slow',
        send: (m, _o, signal) => new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ messageId: m.messageId, accepted: m.to, rejected: [] }), 1_000);
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        }),
      };
      const w = new MailWorker(d, { transport: slow, queue: { concurrency: 1 }, idleDelayMs: 5 });
      await w.start();
      await new Promise(r => setTimeout(r, 20));
      const [job] = w.queue.list();
      expect(job!.status).toBe('running');
      w.cancel(job!.id);
      await new Promise(r => setTimeout(r, 20));
      expect(calls).toEqual([withCancel ? 'cancel:m1' : 'ack:m1']);
      await w.shutdown();
    });
  }

  it('worker.use() middleware and devMode apply to worker sends', async () => {
    const { d } = driver(false);
    const { seen, transport } = capture();
    const w = new MailWorker(d, { transport, idleDelayMs: 5 });
    w.use((o, next) => { o.subject = 'from middleware'; return next(); });
    await w.start();
    await new Promise(r => setTimeout(r, 30));
    await w.shutdown();
    expect(seen[0]!.subject).toBe('from middleware');

    const dev = driver(false);
    const devCap = capture();
    const wd = new MailWorker(dev.d, { transport: devCap.transport, devMode: true, idleDelayMs: 5 });
    await wd.start();
    await new Promise(r => setTimeout(r, 30));
    await wd.shutdown();
    expect(devCap.seen).toHaveLength(0);
    expect(dev.calls).toEqual(['ack:m1']);
  });
});
