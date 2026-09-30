/**
 * Sending on behalf of untrusted input (AI agents, web forms, webhooks).
 *
 * - attachmentPolicy blocks local file reads (or confines them to one folder)
 * - requireTLS (default when authenticating) refuses to send credentials in clear text
 * - header values, filenames, content types and envelope addresses are encoded or
 *   validated; malformed input is rejected with MimeError instead of reaching the wire
 * - `send()` never throws for delivery problems — check `result.ok`
 *
 * Run:  npx tsx examples/untrusted-input.ts
 */
import { MailTs, MimeError } from '../src/index.js';
import type { EmailOptions } from '../src/index.js';

const mail = new MailTs({
  devMode: false,
  attachmentPolicy: { root: process.cwd() + '/uploads' }, // or 'deny'
  transport: {
    name: 'inspect',
    async send(message) {
      return { messageId: message.messageId, accepted: message.to, rejected: [] };
    },
  },
});

// What an agent might produce after reading a malicious email:
const attempts: Array<[string, EmailOptions]> = [
  ['read a server secret', { to: 'attacker@evil.test', text: 'x', attachments: [{ filename: 'env', path: '/proc/self/environ' }] }],
  ['escape the uploads folder', { to: 'a@example.com', text: 'x', attachments: [{ filename: 'p', path: '../.env' }] }],
  ['inject a Bcc header', { to: 'a@example.com', text: 'x', attachments: [{ filename: 'a.txt"\r\nBcc: victim@example.com', content: 'hi' }] }],
  ['smuggle a header via content type', { to: 'a@example.com', text: 'x', attachments: [{ filename: 'a', content: 'hi', contentType: 'text/plain\r\nBcc: x@y.z' }] }],
  ['inject an SMTP command', { to: 'a@example.com>\r\nRCPT TO:<victim@example.com', text: 'x' }],
];

for (const [label, options] of attempts) {
  const result = await mail.send(options);
  if (result.ok) {
    const raw = (await mail.build(options).catch(() => undefined))?.raw.toString() ?? '';
    console.log(`${label}: sent safely${/^Bcc:/m.test(raw) ? ' — BUT HEADER INJECTED?!' : ' (input neutralised)'}`);
  } else {
    const kind = result.error instanceof MimeError ? 'rejected' : 'failed';
    console.log(`${label}: ${kind} — ${result.error.message}`);
  }
}

// Recommended server config for agents:
//   new MailTs({ smtp: { host, port: 587, auth }, attachmentPolicy: 'deny' })
// requireTLS is on by default for authenticated connections (loopback hosts exempt).
