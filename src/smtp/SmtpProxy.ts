import * as net from 'net';

export interface ProxyConfig {
  /** Proxy protocol. */
  type: 'http' | 'socks5' | 'socks4';
  /** Proxy server hostname. */
  host: string;
  /** Proxy server port. */
  port: number;
  /** Optional credentials (supported by HTTP CONNECT and SOCKS5). */
  auth?: { user: string; pass: string };
}

/**
 * Opens a TCP connection through a proxy and returns the tunneled socket.
 * The returned socket is ready to use as a plain TCP pipe to `targetHost:targetPort`.
 */
export async function connectThroughProxy(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = await tcpConnect(proxy.host, proxy.port, timeoutMs);

  try {
    if (proxy.type === 'http') {
      await httpConnect(socket, targetHost, targetPort, proxy.auth, timeoutMs);
    } else if (proxy.type === 'socks5') {
      await socks5Connect(socket, targetHost, targetPort, proxy.auth, timeoutMs);
    } else {
      await socks4Connect(socket, targetHost, targetPort, timeoutMs);
    }
  } catch (err) {
    socket.destroy();
    throw err;
  }

  return socket;
}

// ── TCP helper ─────────────────────────────────────────────────────────────────

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy TCP connection timeout (${host}:${port})`));
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (e) => { clearTimeout(timer); reject(new Error(`Proxy connect failed: ${e.message}`)); });
  });
}

// ── HTTP CONNECT ───────────────────────────────────────────────────────────────

function httpConnect(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  auth: ProxyConfig['auth'],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let headers = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
    if (auth) {
      const creds = Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
      headers += `Proxy-Authorization: Basic ${creds}\r\n`;
    }
    headers += '\r\n';

    const timer = setTimeout(() => reject(new Error('HTTP CONNECT timeout')), timeoutMs);

    let response = '';
    const onData = (chunk: Buffer) => {
      response += chunk.toString('binary');
      if (response.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        const statusLine = response.split('\r\n')[0] ?? '';
        const code = parseInt(statusLine.split(' ')[1] ?? '0', 10);
        if (code === 200) {
          resolve();
        } else {
          reject(new Error(`HTTP CONNECT failed: ${statusLine}`));
        }
      }
    };

    socket.on('data', onData);
    socket.write(headers);
  });
}

// ── SOCKS5 ────────────────────────────────────────────────────────────────────

function socks5Connect(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  auth: ProxyConfig['auth'],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SOCKS5 handshake timeout')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.removeAllListeners('data'); };

    const hostBuf = Buffer.from(targetHost, 'utf8');
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);

    let step: 'greeting' | 'auth' | 'connect' | 'response' = 'greeting';
    let buf = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (step === 'greeting') {
        if (buf.length < 2) return;
        const [ver, method] = [buf[0], buf[1]];
        buf = buf.subarray(2);
        if (ver !== 0x05) { cleanup(); reject(new Error('SOCKS5: invalid version')); return; }

        if (method === 0x00) {
          // No auth — send connect
          step = 'connect';
          sendConnect();
        } else if (method === 0x02 && auth) {
          // Username/password auth
          step = 'auth';
          const u = Buffer.from(auth.user, 'utf8');
          const p = Buffer.from(auth.pass, 'utf8');
          socket.write(Buffer.from([0x01, u.length, ...u, p.length, ...p]));
        } else {
          cleanup(); reject(new Error('SOCKS5: no acceptable auth method')); return;
        }
      } else if (step === 'auth') {
        if (buf.length < 2) return;
        const [, status] = [buf[0], buf[1]];
        buf = buf.subarray(2);
        if (status !== 0x00) { cleanup(); reject(new Error('SOCKS5: auth failed')); return; }
        step = 'connect';
        sendConnect();
      } else if (step === 'connect') {
        // Minimal response: 4 bytes + address + 2 port bytes
        if (buf.length < 4) return;
        const [, rep, , atyp] = [buf[0], buf[1], buf[2], buf[3]];
        if (rep !== 0x00) { cleanup(); reject(new Error(`SOCKS5: connection failed (${rep})`)); return; }
        // Skip bound address: IPv4=4, IPv6=16, domain=1+len
        let addrLen = 0;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = 1 + (buf[4] ?? 0);
        if (buf.length < 4 + addrLen + 2) return;
        cleanup(); resolve();
      }
    };

    const sendConnect = () => {
      socket.write(Buffer.from([
        0x05, 0x01, 0x00, 0x03,     // ver, CMD=CONNECT, RSV, ATYP=DOMAINNAME
        hostBuf.length, ...hostBuf, // host
        ...portBuf,                 // port
      ]));
    };

    socket.on('data', onData);

    // Greeting: offer no-auth (0x00) and user/pass (0x02) if auth provided
    const methods = auth ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
  });
}

// ── SOCKS4 (SOCKS4A — hostname support) ──────────────────────────────────────

function socks4Connect(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SOCKS4 handshake timeout')), timeoutMs);

    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    const hostBuf = Buffer.from(targetHost, 'utf8');

    // SOCKS4A: IP = 0.0.0.1, null user ID, then hostname + null
    const req = Buffer.concat([
      Buffer.from([0x04, 0x01]),  // version, CMD=CONNECT
      portBuf,
      Buffer.from([0x00, 0x00, 0x00, 0x01]),  // SOCKS4A marker IP
      Buffer.from([0x00]),        // null user ID
      hostBuf,
      Buffer.from([0x00]),        // null-terminate hostname
    ]);

    socket.write(req);

    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;

      clearTimeout(timer);
      socket.removeListener('data', onData);

      const status = buf[1];
      if (status === 0x5a) {
        resolve();
      } else {
        reject(new Error(`SOCKS4 connect failed (status ${status})`));
      }
    };

    socket.on('data', onData);
  });
}
