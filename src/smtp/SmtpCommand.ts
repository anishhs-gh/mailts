import type { SmtpCapabilities } from '../types/smtp.js';

/** Parse EHLO response lines into a capabilities object. */
export function parseCapabilities(lines: readonly string[]): SmtpCapabilities {
  const caps: SmtpCapabilities = {
    starttls: false,
    pipelining: false,
    size: null,
    auth: [],
    eightBitMime: false,
    smtpUtf8: false,
    chunking: false,
  };

  for (const line of lines.slice(1)) {
    const keyword = line.slice(4).toUpperCase();
    if (keyword === 'STARTTLS') caps.starttls = true;
    else if (keyword === 'PIPELINING') caps.pipelining = true;
    else if (keyword === '8BITMIME') caps.eightBitMime = true;
    else if (keyword === 'SMTPUTF8') caps.smtpUtf8 = true;
    else if (keyword === 'CHUNKING') caps.chunking = true;
    else if (keyword.startsWith('SIZE')) {
      const n = parseInt(keyword.slice(5).trim(), 10);
      caps.size = isNaN(n) ? 0 : n;
    } else if (keyword.startsWith('AUTH')) {
      caps.auth = keyword.slice(5).split(/\s+/).filter(Boolean);
    }
  }

  return caps;
}

export const Cmd = {
  ehlo: (clientName: string) => `EHLO ${clientName}`,
  helo: (clientName: string) => `HELO ${clientName}`,
  starttls: () => 'STARTTLS',
  authPlain: (payload: string) => `AUTH PLAIN ${payload}`,
  authLogin: () => 'AUTH LOGIN',
  authXOAuth2: (payload: string) => `AUTH XOAUTH2 ${payload}`,
  mailFrom: (email: string, size?: number) =>
    size !== undefined ? `MAIL FROM:<${email}> SIZE=${size}` : `MAIL FROM:<${email}>`,
  rcptTo: (email: string) => `RCPT TO:<${email}>`,
  data: () => 'DATA',
  quit: () => 'QUIT',
  noop: () => 'NOOP',
  rset: () => 'RSET',
  vrfy: (address: string) => `VRFY ${address}`,
};

/** Dot-stuff a message body per RFC 5321 §4.5.2. */
export function dotStuff(raw: Buffer): Buffer {
  const str = raw.toString('binary');
  const stuffed = str.replace(/^\.(.*)$/gm, '..$1');
  return Buffer.from(stuffed + '\r\n.', 'binary');
}
