import { describe, it, expect } from 'vitest';
import { SmtpStream } from '../../../src/smtp/SmtpStream.js';
import { SmtpReply } from '../../../src/smtp/SmtpReply.js';
import { Readable } from 'stream';

function collectReplies(data: string): Promise<SmtpReply[]> {
  return new Promise((resolve, reject) => {
    const stream = new SmtpStream();
    const replies: SmtpReply[] = [];
    stream.on('data', (r: SmtpReply) => replies.push(r));
    stream.on('end', () => resolve(replies));
    stream.on('error', reject);
    stream.write(Buffer.from(data, 'utf8'));
    stream.end();
  });
}

describe('SmtpStream', () => {
  it('parses a single-line reply', async () => {
    const replies = await collectReplies('250 OK\r\n');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.code).toBe(250);
    expect(replies[0]!.lines).toEqual(['250 OK']);
  });

  it('parses a multi-line reply into one SmtpReply', async () => {
    const raw = '250-smtp.example.com\r\n250-SIZE 10485760\r\n250-STARTTLS\r\n250 OK\r\n';
    const replies = await collectReplies(raw);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.code).toBe(250);
    expect(replies[0]!.lines).toHaveLength(4);
  });

  it('parses multiple consecutive replies', async () => {
    const raw = '220 smtp.example.com ESMTP\r\n250 OK\r\n235 Authenticated\r\n';
    const replies = await collectReplies(raw);
    expect(replies).toHaveLength(3);
    expect(replies[0]!.code).toBe(220);
    expect(replies[1]!.code).toBe(250);
    expect(replies[2]!.code).toBe(235);
  });

  it('handles split chunks (partial reads)', async () => {
    return new Promise<void>((resolve, reject) => {
      const stream = new SmtpStream();
      const replies: SmtpReply[] = [];
      stream.on('data', (r: SmtpReply) => replies.push(r));
      stream.on('end', () => {
        try {
          expect(replies).toHaveLength(1);
          expect(replies[0]!.code).toBe(250);
          resolve();
        } catch (e) { reject(e); }
      });
      stream.on('error', reject);

      // Write in chunks
      stream.write(Buffer.from('250 ', 'utf8'));
      stream.write(Buffer.from('OK\r\n', 'utf8'));
      stream.end();
    });
  });

  it('emits an error for lines exceeding max length', async () => {
    const longLine = 'A'.repeat(9000) + '\r\n';
    await expect(collectReplies(longLine)).rejects.toThrow('maximum length');
  });
});
