import type { SmtpCapabilities } from '../types/smtp.js';
import { MimeError } from '../errors.js';

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
  /** `params` may be a SIZE number (legacy) or a list like `['SIZE=1234', 'SMTPUTF8']`. */
  mailFrom: (email: string, params?: number | string[]) => {
    const list = typeof params === 'number' ? [`SIZE=${params}`] : params ?? [];
    return `MAIL FROM:<${envelopeAddr(email)}>${list.length ? ' ' + list.join(' ') : ''}`;
  },
  rcptTo: (email: string) => `RCPT TO:<${envelopeAddr(email)}>`,
  data: () => 'DATA',
  quit: () => 'QUIT',
  noop: () => 'NOOP',
  rset: () => 'RSET',
  vrfy: (address: string) => `VRFY ${address}`,
};

/** Envelope addresses must never carry CR/LF, `<`, `>` or spaces (command injection). */
function envelopeAddr(email: string): string {
  if (/[\r\n<>\s]/.test(email)) throw new MimeError(`Invalid envelope address: ${JSON.stringify(email)}`);
  return email;
}

/**
 * Dot-stuff a message body per RFC 5321 §4.5.2 and append the terminator.
 * Returns the complete DATA payload ending in `\r\n.\r\n`.
 */
export function dotStuff(raw: Buffer): Buffer {
  let str = raw.toString('binary');
  if (str.startsWith('.')) str = '.' + str;
  str = str.replace(/\n\./g, '\n..');
  const tail = str.endsWith('\r\n') ? '.\r\n' : '\r\n.\r\n';
  return Buffer.from(str + tail, 'binary');
}
