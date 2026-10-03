import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { ImapParser } from '../../../src/imap/ImapParser.js';
import { parseFetchAttributes } from '../../../src/imap/ImapFetch.js';

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const TRICKY = ['', ')', '(', '{5}', '\r\n', '* 1 FETCH', 'M0001 OK', '"', '\\', 'BODY[1] {3}\r\n'];

describe('IMAP framing property', () => {
  it('round-trips arbitrary literal bodies at arbitrary chunk boundaries', () => {
    const rand = rng(42);
    for (let iter = 0; iter < 300; iter++) {
      const parts: Buffer[] = [];
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        const pieces = [randomBytes(Math.floor(rand() * 200))];
        for (let k = 0; k < 3; k++) pieces.push(Buffer.from(TRICKY[Math.floor(rand() * TRICKY.length)]!, 'latin1'));
        parts.push(Buffer.concat(pieces.sort(() => rand() - 0.5)));
      }
      const uid = 1 + Math.floor(rand() * 1e6);
      const head = Buffer.from(`* ${iter + 1} FETCH (UID ${uid} FLAGS (\\Seen)`, 'latin1');
      const items = parts.map((p, i) => Buffer.concat([Buffer.from(` BODY[${i + 1}] {${p.length}}\r\n`, 'latin1'), p]));
      const wire = Buffer.concat([head, ...items, Buffer.from(')\r\nM0001 OK done\r\n')]);

      const parser = new ImapParser();
      const out = [];
      for (let pos = 0; pos < wire.length; ) {
        const size = 1 + Math.floor(rand() * 64);
        out.push(...parser.feed(wire.subarray(pos, pos + size)));
        pos += size;
      }
      expect(out.map(r => r.type)).toEqual(['untagged', 'tagged']);
      const attrs = parseFetchAttributes(out[0]!.data)!;
      expect(attrs.uid).toBe(uid);
      expect(attrs.flags).toEqual(['\\Seen']);
      parts.forEach((p, i) => expect(attrs.sections.get(String(i + 1))!.equals(p)).toBe(true));
    }
  });
});
