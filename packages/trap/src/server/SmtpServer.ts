import * as net from 'net';
import { randomUUID } from 'crypto';
import type { MemoryStore, CapturedMessage } from '../store/MemoryStore.js';
import { parseMime } from './MimeParser.js';

export interface SmtpServerOptions {
  port: number;
  host: string;
  maxSize: number;
  store: MemoryStore;
  onMessage: (msg: CapturedMessage) => void;
}

export class SmtpServer {
  private server: net.Server;
  private opts: SmtpServerOptions;

  constructor(opts: SmtpServerOptions) {
    this.opts = opts;
    this.server = net.createServer(socket => this.handleConnection(socket));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
        else resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    const remoteAddress = socket.remoteAddress ?? '127.0.0.1';
    let envelope = { from: '', to: [] as string[] };
    let dataMode = false;
    let dataBuffer = '';

    socket.write('220 mailts-trap ESMTP ready\r\n');

    socket.on('data', (chunk: Buffer) => {
      const input = chunk.toString('utf8');

      if (dataMode) {
        dataBuffer += input;
        const termIdx = dataBuffer.indexOf('\r\n.\r\n');
        if (termIdx !== -1) {
          const rawData = dataBuffer.slice(0, termIdx);
          dataMode = false;
          dataBuffer = '';

          const raw = Buffer.from(rawData.replace(/^\.\./gm, '.'), 'utf8');

          if (raw.length > this.opts.maxSize) {
            socket.write('552 Message too large\r\n');
            return;
          }

          const msg: CapturedMessage = parseMime(raw, {
            id: randomUUID(),
            receivedAt: new Date(),
            smtpEnvelope: { from: envelope.from, to: [...envelope.to], remoteAddress },
            raw,
            size: raw.length,
            read: false,
          });

          this.opts.store.add(msg);
          this.opts.onMessage(msg);
          envelope = { from: '', to: [] };
          socket.write('250 OK\r\n');
        }
        return;
      }

      for (const line of input.split('\r\n')) {
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write(`250-mailts-trap\r\n250-PIPELINING\r\n250-SIZE ${this.opts.maxSize}\r\n250 OK\r\n`);
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          envelope.from = line.slice(10).replace(/<|>/g, '').trim();
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          envelope.to.push(line.slice(8).replace(/<|>/g, '').trim());
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          dataMode = true;
          socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
        } else if (upper === 'RSET') {
          envelope = { from: '', to: [] };
          socket.write('250 OK\r\n');
        } else if (upper === 'NOOP') {
          socket.write('250 OK\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        }
      }
    });

    socket.on('error', () => socket.destroy());
  }
}
