import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | string;
  /** Optional abort signal — aborts the in-flight HTTP request. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Minimal `node:https` wrapper — zero deps. */
export function httpRequest(opts: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.url);
    const lib = url.protocol === 'https:' ? https : http;

    const bodyBuf = opts.body == null
      ? undefined
      : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method,
        headers: {
          ...opts.headers,
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
        },
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** Build a `multipart/form-data` body from a list of text fields and file parts. */
export function buildFormData(
  boundary: string,
  fields: { name: string; value: string }[],
  files: { name: string; filename: string; contentType: string; data: Buffer }[] = [],
): Buffer {
  const parts: Buffer[] = [];

  for (const f of fields) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`,
    ));
  }

  for (const f of files) {
    parts.push(Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
        `Content-Type: ${f.contentType}\r\n\r\n`,
      ),
      f.data,
      Buffer.from('\r\n'),
    ]));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}
