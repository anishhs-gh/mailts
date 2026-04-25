import { describe, it, expect } from 'vitest';
import * as http from 'http';
import { httpRequest, buildFormData } from '../../../src/transports/HttpClient.js';

// ── buildFormData ─────────────────────────────────────────────────────────────

describe('buildFormData', () => {
  it('includes boundary delimiter for each field', () => {
    const body = buildFormData('testboundary', [{ name: 'field1', value: 'value1' }]);
    expect(body.toString()).toContain('--testboundary');
    expect(body.toString()).toContain('field1');
    expect(body.toString()).toContain('value1');
  });

  it('includes closing boundary', () => {
    const body = buildFormData('testboundary', [{ name: 'a', value: 'b' }]);
    expect(body.toString()).toContain('--testboundary--');
  });

  it('includes Content-Disposition for each field', () => {
    const body = buildFormData('b', [
      { name: 'foo', value: 'bar' },
      { name: 'baz', value: 'qux' },
    ]);
    const str = body.toString();
    expect(str).toContain('Content-Disposition: form-data; name="foo"');
    expect(str).toContain('Content-Disposition: form-data; name="baz"');
    expect(str).toContain('bar');
    expect(str).toContain('qux');
  });

  it('includes file parts with filename and Content-Type', () => {
    const fileData = Buffer.from('file content');
    const body = buildFormData(
      'bound',
      [{ name: 'message', value: 'hello' }],
      [{ name: 'attachment', filename: 'test.txt', contentType: 'text/plain', data: fileData }],
    );
    const str = body.toString();
    expect(str).toContain('filename="test.txt"');
    expect(str).toContain('Content-Type: text/plain');
    expect(str).toContain('file content');
  });

  it('returns a Buffer', () => {
    const result = buildFormData('b', [{ name: 'x', value: 'y' }]);
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('handles empty fields and files', () => {
    const result = buildFormData('b', []);
    expect(result.toString()).toContain('--b--');
  });

  it('uses CRLF line endings', () => {
    const result = buildFormData('b', [{ name: 'k', value: 'v' }]);
    expect(result.toString()).toContain('\r\n');
  });

  it('places field value between blank line and boundary', () => {
    const result = buildFormData('b', [{ name: 'key', value: 'my-value' }]);
    const str = result.toString();
    // value appears after the double CRLF blank line separator
    const blankLinePos = str.indexOf('\r\n\r\n');
    const valuePos = str.indexOf('my-value');
    expect(blankLinePos).toBeLessThan(valuePos);
  });

  it('includes multiple files', () => {
    const body = buildFormData(
      'b',
      [],
      [
        { name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('aaa') },
        { name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: Buffer.from('bbb') },
      ],
    );
    const str = body.toString();
    expect(str).toContain('a.txt');
    expect(str).toContain('b.txt');
    expect(str).toContain('aaa');
    expect(str).toContain('bbb');
  });
});

// ── httpRequest ───────────────────────────────────────────────────────────────

function makeServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('httpRequest', () => {
  it('sends GET and receives response body', async () => {
    const { server, url } = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    });
    try {
      const resp = await httpRequest({ method: 'GET', url, headers: {} });
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('hello');
    } finally {
      await closeServer(server);
    }
  });

  it('sends POST with body', async () => {
    let received = '';
    const { server, url } = await makeServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = Buffer.concat(chunks).toString();
        res.writeHead(201);
        res.end('created');
      });
    });
    try {
      const resp = await httpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
      });
      expect(resp.status).toBe(201);
      expect(received).toBe('{"key":"value"}');
    } finally {
      await closeServer(server);
    }
  });

  it('returns correct status code', async () => {
    const { server, url } = await makeServer((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    try {
      const resp = await httpRequest({ method: 'GET', url, headers: {} });
      expect(resp.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('returns response headers', async () => {
    const { server, url } = await makeServer((_req, res) => {
      res.writeHead(200, { 'X-Custom': 'test-value' });
      res.end('ok');
    });
    try {
      const resp = await httpRequest({ method: 'GET', url, headers: {} });
      expect(resp.headers['x-custom']).toBe('test-value');
    } finally {
      await closeServer(server);
    }
  });

  it('sends custom request headers', async () => {
    let receivedAuth = '';
    const { server, url } = await makeServer((req, res) => {
      receivedAuth = req.headers['authorization'] as string ?? '';
      res.writeHead(200);
      res.end('ok');
    });
    try {
      await httpRequest({ method: 'GET', url, headers: { Authorization: 'Bearer token123' } });
      expect(receivedAuth).toBe('Bearer token123');
    } finally {
      await closeServer(server);
    }
  });

  it('sends POST with Buffer body', async () => {
    let received = Buffer.alloc(0);
    const { server, url } = await makeServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = Buffer.concat(chunks);
        res.writeHead(200);
        res.end('ok');
      });
    });
    try {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      await httpRequest({ method: 'POST', url, headers: {}, body: payload });
      expect(received).toEqual(payload);
    } finally {
      await closeServer(server);
    }
  });

  it('sets Content-Length automatically for body', async () => {
    let receivedLen = '';
    const { server, url } = await makeServer((req, res) => {
      receivedLen = req.headers['content-length'] as string ?? '';
      res.writeHead(200);
      res.end('ok');
    });
    try {
      await httpRequest({
        method: 'POST',
        url,
        headers: {},
        body: 'hello',
      });
      expect(receivedLen).toBe('5');
    } finally {
      await closeServer(server);
    }
  });

  it('handles empty response body', async () => {
    const { server, url } = await makeServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const resp = await httpRequest({ method: 'DELETE', url, headers: {} });
      expect(resp.status).toBe(204);
      expect(resp.body).toBe('');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects on connection refused', async () => {
    await expect(
      httpRequest({ method: 'GET', url: 'http://127.0.0.1:1', headers: {} }),
    ).rejects.toThrow();
  });
});
