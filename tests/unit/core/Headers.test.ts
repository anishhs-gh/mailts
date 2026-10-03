import { describe, it, expect } from 'vitest';
import {
  encodeUnstructured, encodeWords, encodeDisplayName, formatParam, foldHeader,
  normalizeMsgId, checkHeaderName, checkContentType, formatRfc5322Date,
} from '../../../src/core/Headers.js';
import { decodeRfc2047 } from '../../../src/imap/ImapParser.js';

describe('RFC 2047 encoding', () => {
  it('keeps every encoded word ≤ 75 chars and never splits a character', () => {
    const text = '日本語のテキストと絵文字🎉を含む長い件名'.repeat(5);
    const words = encodeWords(text);
    expect(words.every(w => w.length <= 75)).toBe(true);
    expect(decodeRfc2047(words.join(' '))).toBe(text);
  });

  it('leaves ASCII alone and strips CR/LF/NUL', () => {
    expect(encodeUnstructured('Hello\r\nBcc: x')).toBe('HelloBcc: x');
    expect(encodeUnstructured('plain')).toBe('plain');
  });

  it('quotes display names only when needed', () => {
    expect(encodeDisplayName('Alice')).toBe('Alice');
    expect(encodeDisplayName('Doe, John')).toBe('"Doe, John"');
    expect(encodeDisplayName('A "B" \\C')).toBe('"A \\"B\\" \\\\C"');
    expect(encodeDisplayName('Zoë')).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe('MIME parameters', () => {
  it('uses tokens, quoted strings, and RFC 2231 with fallback', () => {
    expect(formatParam('charset', 'UTF-8')).toBe('charset=UTF-8');
    expect(formatParam('filename', 'my file.pdf')).toBe('filename="my file.pdf"');
    expect(formatParam('filename', 'é.pdf')).toBe(`filename="e_.pdf"; filename*=UTF-8''%C3%A9.pdf`);
    const long = formatParam('filename', 'é'.repeat(30));
    expect(long).toMatch(/filename\*0\*=UTF-8''/);
    expect(long).toMatch(/filename\*1\*=/);
    expect(long).not.toMatch(/%.?;/); // no split %XX triplet
  });
});

describe('folding and validation', () => {
  it('folds long headers at whitespace without splitting words', () => {
    const value = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const folded = foldHeader('Subject', value);
    expect(folded.split('\r\n').every(l => l.length <= 78)).toBe(true);
    expect(folded.replace(/\r\n /g, ' ')).toBe(`Subject: ${value}`);
  });

  it('validates header names, content types and message ids', () => {
    expect(() => checkHeaderName('X-Ok')).not.toThrow();
    expect(() => checkHeaderName('Bad Name')).toThrow();
    expect(() => checkHeaderName('X:Y')).toThrow();
    expect(checkContentType('Application/PDF')).toBe('application/pdf');
    expect(() => checkContentType('text/plain; x=1')).toThrow();
    expect(normalizeMsgId('abc@x')).toBe('<abc@x>');
    expect(() => normalizeMsgId('<a b@x>')).toThrow();
    expect(formatRfc5322Date(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('Fri, 02 Jan 2026 03:04:05 +0000');
  });
});
