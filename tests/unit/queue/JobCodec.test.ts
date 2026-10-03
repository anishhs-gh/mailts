import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { encodeOptions, decodeOptions, encodeJob, decodeJob } from '../../../src/queue/JobCodec.js';
import { MailTsError } from '../../../src/errors.js';
import type { QueueJob } from '../../../src/types/queue.js';

describe('JobCodec', () => {
  it('round-trips Buffers (incl. nested) and Dates', () => {
    const date = new Date('2026-01-02T03:04:05Z');
    const opts = {
      to: 'a@x.com', text: 't', date,
      attachments: [{ filename: 'b', content: Buffer.from([0, 255]) }, { filename: 'e', rfc822: Buffer.from('raw') }],
      ical: { summary: 's', start: date, end: date, organizer: { email: 'o@x.com' } },
    };
    const back = decodeOptions(encodeOptions(opts));
    expect(back.date).toEqual(date);
    expect([...(back.attachments![0]!.content as Buffer)]).toEqual([0, 255]);
    expect(Buffer.isBuffer(back.attachments![1]!.rfc822)).toBe(true);
    expect(back.ical!.start).toEqual(date);
  });

  it('decodes legacy 0.4 rows (plain JSON, Buffer.toJSON, ISO dates)', () => {
    const legacy = JSON.stringify({
      to: 'a@x.com', date: '2026-01-02T03:04:05.000Z',
      attachments: [{ filename: 'b', content: Buffer.from('hi') }],
      ical: { summary: 's', start: '2026-01-02T03:04:05.000Z', end: '2026-01-02T04:04:05.000Z', organizer: { email: 'o@x.com' } },
    });
    const back = decodeOptions(legacy);
    expect(back.date).toBeInstanceOf(Date);
    expect((back.attachments![0]!.content as Buffer).toString()).toBe('hi');
    expect(back.ical!.end).toBeInstanceOf(Date);
  });

  it('rejects streams and functions with a clear path', () => {
    expect(() => encodeOptions({ to: 'a@x.com', attachments: [{ filename: 's', content: Readable.from(['x']) }] }))
      .toThrow(/options\.attachments\[0\]\.content/);
    expect(() => encodeOptions({ to: 'a@x.com', headers: { x: (() => 1) as unknown as string } })).toThrow(/function/);
  });

  it('round-trips whole jobs including errors and schedule', () => {
    const job: QueueJob = {
      id: 'j1', options: { to: 'a@x.com', text: 't' }, attempts: 2,
      errors: [new MailTsError('boom', 'ECONN', true)], createdAt: new Date(), lastAttemptAt: new Date(),
      status: 'scheduled', priority: 'high', notBefore: new Date(Date.now() + 1000),
    };
    const back = decodeJob(encodeJob(job));
    expect(back).toMatchObject({ id: 'j1', attempts: 2, status: 'scheduled', priority: 'high' });
    expect(back.errors[0]).toBeInstanceOf(MailTsError);
    expect(back.errors[0]!.retryable).toBe(true);
    expect(back.notBefore!.getTime()).toBe(job.notBefore!.getTime());
  });
});
