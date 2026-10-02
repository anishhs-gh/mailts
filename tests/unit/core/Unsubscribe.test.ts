import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { buildMessage } from '../../../src/core/Message.js';
import { signDkim } from '../../../src/core/Dkim.js';
import { parseMessage } from '../../../src/core/MimeParser.js';
import { unsubscribeHeaders, isOneClickUnsubscribe } from '../../../src/core/Unsubscribe.js';

const base = { from: 'news@x.com', to: 'a@x.com', subject: 'Newsletter', text: 'hi' };

describe('unsubscribe headers', () => {
  it('emits List-Unsubscribe and the one-click Post header', async () => {
    const built = await buildMessage({ ...base, unsubscribe: { url: 'https://x.com/u?t=abc', mailto: 'unsub@x.com?subject=stop' } });
    const h = parseMessage(built.raw).headers;
    expect(h.get('list-unsubscribe')).toBe('<https://x.com/u?t=abc>, <mailto:unsub@x.com?subject=stop>');
    expect(h.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
  });

  it('mailto-only and oneClick: false omit the Post header', () => {
    expect(unsubscribeHeaders({ mailto: 'mailto:u@x.com' })).toEqual([['List-Unsubscribe', '<mailto:u@x.com>']]);
    expect(unsubscribeHeaders({ url: 'https://x.com/u', oneClick: false })).toHaveLength(1);
  });

  it('rejects http, header-breaking characters and empty options', () => {
    expect(() => unsubscribeHeaders({ url: 'http://x.com/u' })).toThrow(/https/);
    expect(() => unsubscribeHeaders({ url: 'https://x.com/u>,<https://evil' })).toThrow(/not allowed/);
    expect(() => unsubscribeHeaders({ url: 'https://x.com/u\r\nBcc: v@x.com' })).toThrow();
    expect(() => unsubscribeHeaders({ mailto: 'not-an-address' })).toThrow(/mailto/);
    expect(() => unsubscribeHeaders({})).toThrow(/url or a mailto/);
  });

  it('a hand-written header still works, but not together with `unsubscribe`', async () => {
    const manual = await buildMessage({ ...base, headers: { 'List-Unsubscribe': '<mailto:u@x.com>' } });
    expect(parseMessage(manual.raw).headers.get('list-unsubscribe')).toBe('<mailto:u@x.com>');
    await expect(buildMessage({ ...base, unsubscribe: { mailto: 'u@x.com' }, headers: { 'List-Unsubscribe': '<mailto:v@x.com>' } }))
      .rejects.toThrow(/managed by the builder/);
  });

  it('DKIM signs both headers by default (required for one-click)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const built = await buildMessage({ ...base, unsubscribe: { url: 'https://x.com/u?t=1' } });
    const signed = signDkim(built.raw, { domainName: 'x.com', keySelector: 's1', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() });
    const sig = /DKIM-Signature:[\s\S]*?h=([^;]+);/.exec(signed.toString())![1]!.replace(/\s+/g, '');
    expect(sig.split(':')).toEqual(expect.arrayContaining(['list-unsubscribe', 'list-unsubscribe-post']));
  });
});

describe('isOneClickUnsubscribe', () => {
  it('recognises form-encoded and multipart one-click POSTs only', () => {
    expect(isOneClickUnsubscribe({ method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'List-Unsubscribe=One-Click' })).toBe(true);
    expect(isOneClickUnsubscribe({ method: 'post', body: Buffer.from('List-Unsubscribe=One-Click') })).toBe(true);
    const mp = '--b\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b--';
    expect(isOneClickUnsubscribe({ method: 'POST', contentType: 'multipart/form-data; boundary=b', body: mp })).toBe(true);
    expect(isOneClickUnsubscribe({ method: 'GET', body: 'List-Unsubscribe=One-Click' })).toBe(false);
    expect(isOneClickUnsubscribe({ method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'List-Unsubscribe=Other' })).toBe(false);
    expect(isOneClickUnsubscribe({ method: 'POST', contentType: 'application/json', body: '{"List-Unsubscribe":"One-Click"}' })).toBe(false);
  });
});
