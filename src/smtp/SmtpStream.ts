import { Transform, type TransformCallback } from 'stream';
import { SmtpReply } from './SmtpReply.js';

const MAX_LINE = 8192; // guard against malformed servers

/**
 * Transform stream that accumulates raw bytes from a socket and emits
 * complete, parsed SmtpReply objects once a multi-line response finishes.
 *
 * Single-line:  "250 OK\r\n"          → SmtpReply(250, ["250 OK"])
 * Multi-line:   "250-A\r\n250 B\r\n"  → SmtpReply(250, ["250-A", "250 B"])
 */
export class SmtpStream extends Transform {
  private buf = '';
  private currentCode: number | null = null;
  private currentLines: string[] = [];

  constructor() {
    super({ objectMode: true, readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.buf += chunk.toString('binary');

    let crlf: number;
    while ((crlf = this.buf.indexOf('\r\n')) !== -1) {
      const line = this.buf.slice(0, crlf);
      this.buf = this.buf.slice(crlf + 2);

      if (line.length > MAX_LINE) {
        cb(new Error(`SMTP line exceeds maximum length (${MAX_LINE})`));
        return;
      }

      this.processLine(line);
    }

    cb();
  }

  override _flush(cb: TransformCallback): void {
    // Flush any incomplete line (shouldn't happen in normal operation)
    if (this.buf.length > 0) {
      this.processLine(this.buf);
      this.buf = '';
    }
    cb();
  }

  private processLine(line: string): void {
    const code = parseInt(line.slice(0, 3), 10);
    if (isNaN(code)) {
      // Emit as-is for unexpected server banners etc.
      this.push(new SmtpReply(0, [line]));
      return;
    }

    const separator = line[3];
    this.currentCode = code;
    this.currentLines.push(line);

    if (separator === '-') {
      // Continuation — more lines coming
      return;
    }

    // Space (or end of string) = last line of reply
    const reply = new SmtpReply(this.currentCode, this.currentLines);
    this.currentCode = null;
    this.currentLines = [];
    this.push(reply);
  }
}
