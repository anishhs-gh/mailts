import { describe, it, expect } from 'vitest';
import { buildReply, buildForward, stripSubjectPrefixes } from '../../../src/core/Reply.js';
import { buildMessage } from '../../../src/core/Message.js';
import { parseMessage } from '../../../src/core/MimeParser.js';
import type { ImapMessage } from '../../../src/types/imap.js';

async function original(extra: Record<string, unknown> = {}) {
  const built = await buildMessage({
    from: 'Alice <alice@x.com>',
    to: ['me@x.com', 'bob@x.com'],
    cc: ['carol@x.com', 'ME@x.com'],
    subject: 'RE: AW: Fwd: Q3 plan',
    text: 'Line one\n> earlier quote',
    html: '<p>Line one <img src="cid:logo"></p>',
    messageId: '<orig@x.com>',
    references: ['<root@x.com>'],
    date: new Date('2026-09-01T10:00:00Z'),
    attachments: [
      { filename: 'plan.pdf', content: Buffer.from('%PDF') },
      { filename: 'logo.png', content: Buffer.from([1, 2]), cid: 'logo' },
    ],
    ...extra,
  });
  return { parsed: parseMessage(built.raw), raw: built.raw };
}

describe('stripSubjectPrefixes', () => {
  it.each([
    ['Re: hi', 'hi'], ['RE: Re: hi', 'hi'], ['AW: SV: Antw: hi', 'hi'], ['Fwd: FW: hi', 'hi'],
    ['Re[2]: hi', 'hi'], ['re:hi', 'hi'], ['Reply needed', 'Reply needed'], ['Regarding: x', 'Regarding: x'], ['', ''],
  ])('%s → %s', (input, out) => expect(stripSubjectPrefixes(input)).toBe(out));
});

describe('buildReply', () => {
  it('replies to the sender, in thread, with a normalised subject and quote', async () => {
    const { parsed } = await original();
    const r = buildReply(parsed, { from: 'me@x.com', text: 'Thanks!' });
    expect(r.to).toEqual([{ email: 'alice@x.com', name: 'Alice' }]);
    expect(r.cc).toBeUndefined();
    expect(r.subject).toBe('Re: Q3 plan');
    expect(r.inReplyTo).toBe('<orig@x.com>');
    expect(r.references).toEqual(['<root@x.com>', '<orig@x.com>']);
    expect(r.text).toContain('Thanks!\n\nOn Tue, 01 Sep 2026 10:00:00 GMT, Alice <alice@x.com> wrote:\n> Line one\n>> earlier quote');
  });

  it('reply-all includes To and Cc minus me (case-insensitive) and duplicates', async () => {
    const { parsed } = await original();
    const r = buildReply(parsed, { from: 'Me <me@x.com>', text: 'ok', replyAll: true });
    expect(r.to).toEqual([{ email: 'alice@x.com', name: 'Alice' }, { email: 'bob@x.com' }]);
    expect(r.cc).toEqual([{ email: 'carol@x.com' }]);
  });

  it('honours Reply-To, aliases, and replying to my own sent message', async () => {
    const { parsed } = await original({ replyTo: 'list@x.com' });
    expect(buildReply(parsed, { from: 'me@x.com', text: 'x' }).to).toEqual([{ email: 'list@x.com' }]);
    const r = buildReply(parsed, { from: 'me@x.com', text: 'x', replyAll: true, me: ['bob@x.com'] });
    expect(r.to).toEqual([{ email: 'list@x.com' }]);

    const mine = await original({ from: 'me@x.com', to: ['zed@x.com'], cc: [] });
    expect(buildReply(mine.parsed, { from: 'me@x.com', text: 'x' }).to).toEqual([{ email: 'zed@x.com' }]);
  });

  it('quotes HTML in a blockquote and escapes the header', async () => {
    const { parsed } = await original({ from: { email: 'a@x.com', name: 'A <b>' } });
    const r = buildReply(parsed, { from: 'me@x.com', html: '<p>Hi</p>' });
    expect(r.html).toContain('<blockquote type="cite"><p>Line one <img src="cid:logo"></p></blockquote>');
    expect(r.html).not.toContain('A <b>');
  });

  it('trims long reference chains and works from an ImapMessage', async () => {
    const { parsed } = await original({ references: Array.from({ length: 30 }, (_, i) => `<r${i}@x>`) });
    const asImap: ImapMessage = {
      uid: 1, seq: 1, flags: [], size: 1, internalDate: null,
      envelope: { ...parsed.envelope, references: parsed.references },
      body: { text: parsed.text, html: parsed.html, attachments: parsed.attachments },
    };
    const r = buildReply(asImap, { from: 'me@x.com', text: 'x', quote: false });
    expect(r.references).toHaveLength(20);
    expect((r.references as string[]).at(-1)).toBe('<orig@x.com>');
    expect(r.text).toBe('x');
  });

  it('round-trips through the builder with threading headers intact', async () => {
    const { parsed } = await original();
    const sent = parseMessage((await buildMessage(buildReply(parsed, { from: 'me@x.com', text: 'ok' }))).raw);
    expect(sent.envelope.inReplyTo).toBe('<orig@x.com>');
    expect(sent.references).toEqual(['<root@x.com>', '<orig@x.com>']);
    expect(sent.envelope.subject).toBe('Re: Q3 plan');
  });

  it('requires a body', async () => {
    const { parsed } = await original();
    expect(() => buildReply(parsed, { from: 'me@x.com' })).toThrow(/text or html/);
  });
});

describe('buildForward', () => {
  it('inline: forwarded header, original body and all attachments incl. cid images', async () => {
    const { parsed } = await original();
    const f = buildForward(parsed, { from: 'me@x.com', to: 'boss@x.com', text: 'FYI' });
    expect(f.subject).toBe('Fwd: Q3 plan');
    expect(f.text).toMatch(/^FYI\n\n---------- Forwarded message ---------\nFrom: Alice <alice@x.com>/);
    expect(f.text).toContain('Line one');
    expect(f.attachments!.map(a => [a.filename, a.cid])).toEqual(expect.arrayContaining([['plan.pdf', undefined], ['logo.png', 'logo']]));
    expect(f.attachments).toHaveLength(2);

    const out = parseMessage((await buildMessage(f)).raw);
    expect(out.attachments.find(a => a.filename === 'logo.png')!.contentId).toBe('logo');
    expect(out.html).toContain('cid:logo');
  });

  it('attachment mode embeds the untouched original as message/rfc822', async () => {
    const { parsed, raw } = await original();
    const f = buildForward(parsed, { from: 'me@x.com', to: 'boss@x.com', text: 'see attached', mode: 'attachment', raw });
    const out = parseMessage((await buildMessage(f)).raw);
    const eml = out.attachments.find(a => a.contentType === 'message/rfc822')!;
    expect(eml.filename).toBe('Q3 plan.eml');
    expect(eml.nestedMessage!.envelope.messageId).toBe('<orig@x.com>');
    expect(() => buildForward(parsed, { from: 'me@x.com', to: 'b@x.com', mode: 'attachment' })).toThrow(/raw/);
  });
});
