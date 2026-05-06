import * as http from 'http';
import type { MemoryStore, CapturedMessage } from '../store/MemoryStore.js';
import { UI_HTML } from '../ui.js';

type SseClient = http.ServerResponse;

export interface HttpServerOptions {
  port: number;
  host: string;
  store: MemoryStore;
}

export class HttpServer {
  private server: http.Server;
  private sseClients: Set<SseClient> = new Set();
  private opts: HttpServerOptions;

  constructor(opts: HttpServerOptions) {
    this.opts = opts;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.broadcast('shutdown', {});
      for (const client of this.sseClients) client.end();
      this.server.close(err => err ? reject(err) : resolve());
    });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      client.write(payload);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    res.setHeader('Access-Control-Allow-Origin', '*');

    // SSE
    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    // Stats
    if (path === '/api/stats' && method === 'GET') {
      return this.json(res, 200, this.opts.store.stats);
    }

    // List messages
    if (path === '/api/messages' && method === 'GET') {
      const msgs = this.opts.store.getAll().map(m => ({
        id: m.id,
        receivedAt: m.receivedAt,
        subject: m.subject,
        from: m.from,
        to: m.to,
        size: m.size,
        read: m.read,
        hasHtml: m.html !== null,
        attachments: m.attachments.length,
      }));
      return this.json(res, 200, msgs);
    }

    // Clear all messages
    if (path === '/api/messages' && method === 'DELETE') {
      this.opts.store.clear();
      this.broadcast('cleared', {});
      return this.json(res, 200, { ok: true });
    }

    // Single message
    const msgMatch = path.match(/^\/api\/messages\/([^/]+)$/);
    if (msgMatch) {
      const id = msgMatch[1]!;
      const msg = this.opts.store.getById(id);
      if (!msg) return this.json(res, 404, { error: 'Not found' });

      if (method === 'GET') {
        msg.read = true;
        const { raw, attachments, ...rest } = msg;
        return this.json(res, 200, {
          ...rest,
          attachments: attachments.map(({ content, ...a }) => a),
        });
      }
      if (method === 'DELETE') {
        this.opts.store.delete(id);
        this.broadcast('deleted', { id });
        return this.json(res, 200, { ok: true });
      }
    }

    // Raw message source
    const rawMatch = path.match(/^\/api\/messages\/([^/]+)\/raw$/);
    if (rawMatch && method === 'GET') {
      const msg = this.opts.store.getById(rawMatch[1]!);
      if (!msg) return this.json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'message/rfc822' });
      res.end(msg.raw);
      return;
    }

    // Attachment download
    const attMatch = path.match(/^\/api\/messages\/([^/]+)\/attachments\/(\d+)$/);
    if (attMatch && method === 'GET') {
      const msg = this.opts.store.getById(attMatch[1]!);
      const idx = parseInt(attMatch[2]!, 10);
      const att = msg?.attachments[idx];
      if (!att) return this.json(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': att.contentType,
        'Content-Disposition': `attachment; filename="${att.filename}"`,
      });
      res.end(att.content);
      return;
    }

    // UI
    if (method === 'GET' && !path.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
      return;
    }

    this.json(res, 404, { error: 'Not found' });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }
}
