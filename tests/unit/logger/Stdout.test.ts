import { describe, it, expect, vi, afterEach } from 'vitest';
import { MailTs } from '../../../src/core/MailTs.js';

afterEach(() => vi.restoreAllMocks());

describe('stdout hygiene (stdio MCP servers depend on it)', () => {
  it('never writes to stdout with the default logger — sends, queue, failures, shutdown', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as never);

    const mail = new MailTs({
      logger: { level: 'debug' },
      transport: { name: 't', async send(m) { return { messageId: m.messageId, accepted: m.to, rejected: [] }; } },
    });
    await mail.send({ from: 'a@x.com', to: 'b@x.com', subject: 's', text: 't' });
    await mail.send({ from: 'a@x.com', to: [], text: 't' });
    mail.queue.enqueue({ from: 'a@x.com', to: 'b@x.com', subject: 's', text: 't' });
    await mail.queue.drain();
    await mail.shutdown();

    expect(writes).toEqual([]);
  });
});
