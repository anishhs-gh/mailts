import { createReadStream } from 'fs';
import { Transform, type TransformCallback } from 'stream';
import { resolve, basename } from 'path';
import type { Attachment } from '../types/core.js';
import { MimeError } from '../errors.js';

/** Streaming base64 encoder — avoids buffering entire attachment in memory. */
export class Base64Transform extends Transform {
  private remainder = Buffer.alloc(0);

  override _transform(chunk: Buffer, _encoding: string, cb: TransformCallback): void {
    const data = Buffer.concat([this.remainder, chunk]);
    const end = Math.floor(data.length / 3) * 3;
    if (end > 0) {
      this.push(data.subarray(0, end).toString('base64'));
    }
    this.remainder = data.subarray(end);
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.remainder.length > 0) {
      this.push(this.remainder.toString('base64'));
    }
    cb();
  }
}

/** Fold base64 output at 76-char lines (RFC 2045). */
export class Base64LineWrapper extends Transform {
  private lineLen = 76;
  private col = 0;
  private buf = '';

  override _transform(chunk: Buffer | string, _enc: string, cb: TransformCallback): void {
    const data = typeof chunk === 'string' ? chunk : chunk.toString();
    this.buf += data;
    const lines: string[] = [];
    while (this.buf.length >= this.lineLen - this.col) {
      const take = this.lineLen - this.col;
      lines.push(this.buf.slice(0, take));
      this.buf = this.buf.slice(take);
      this.col = 0;
    }
    if (lines.length) {
      this.push(lines.join('\r\n') + '\r\n');
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.buf.length) this.push(this.buf + '\r\n');
    cb();
  }
}

export interface ResolvedAttachment {
  filename: string;
  contentType: string;
  disposition: 'attachment' | 'inline';
  encoding: string;
  cid?: string;
  getContent: () => Promise<Buffer>;
}

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function resolveAttachment(att: Attachment): Promise<ResolvedAttachment> {
  const filename = att.filename || (att.path ? basename(att.path) : 'file');
  const contentType = att.contentType ?? guessMime(filename);
  const disposition = att.disposition ?? (att.cid ? 'inline' : 'attachment');
  const encoding = att.encoding ?? 'base64';

  if (att.path !== undefined) {
    // Validate path — prevent traversal by resolving against cwd
    const safePath = resolve(process.cwd(), att.path);
    return {
      filename,
      contentType,
      disposition,
      encoding,
      cid: att.cid,
      getContent: async () => {
        const stream = createReadStream(safePath);
        return streamToBuffer(stream);
      },
    };
  }

  if (att.content !== undefined) {
    const { content } = att;
    return {
      filename,
      contentType,
      disposition,
      encoding,
      cid: att.cid,
      getContent: async () => {
        if (Buffer.isBuffer(content)) return content;
        if (typeof content === 'string') return Buffer.from(content, 'utf8');
        return streamToBuffer(content as NodeJS.ReadableStream);
      },
    };
  }

  throw new MimeError(`Attachment "${filename}" has no content or path`);
}
