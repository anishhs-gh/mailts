/**
 * Reply in-thread, keep a copy in Sent, and save a draft — the typical
 * "email assistant" loop.
 *
 * - inReplyTo / references keep the reply in the same conversation in every client
 * - saveToSent appends the exact bytes that were sent (Gmail does this itself;
 *   Fastmail, iCloud, Outlook IMAP, most custom domains do not)
 *
 * Run:  MAIL_USER=you@example.com MAIL_PASS=<app-password> IMAP_HOST=… SMTP_HOST=… \
 *         npx tsx examples/reply-and-save-to-sent.ts
 */
import { MailTs } from '../src/index.js';

const user = process.env['MAIL_USER']!;
const auth = { type: 'plain' as const, user, pass: process.env['MAIL_PASS']! };

const mail = new MailTs({
  imap: { host: process.env['IMAP_HOST'] ?? 'imap.fastmail.com', port: 993, secure: true, auth },
  smtp: { host: process.env['SMTP_HOST'] ?? 'smtp.fastmail.com', port: 465, secure: true, auth },
});
const session = mail.imap;

// 1. Pick the newest message and fetch its threading headers (no body download)
const [original] = await session.fetch({ limit: 1, headers: ['References'] });
if (!original) {
  console.log('INBOX is empty');
  process.exit(0);
}
const { subject, messageId, references = [], replyTo, from } = original.envelope;
const replyAddress = (replyTo[0] ?? from[0]) as { email: string } | undefined;

// 2. Reply in the same thread and store a copy in the Sent mailbox
const result = await mail.send({
  from: user,
  to: replyAddress?.email ?? user,
  subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
  text: 'Thanks — got it.',
  ...(messageId ? { inReplyTo: messageId, references: [...references, messageId] } : {}),
}, { saveToSent: true });   // or { saveToSent: 'Sent Items' } to pick the mailbox
console.log(result.ok ? `Replied: ${result.messageId}` : `Failed: ${result.error.message}`);
if (result.ok && result.rejected.length) console.warn('Rejected recipients:', result.rejected);

// 3. Save a follow-up as a draft instead of sending it
const drafts = await session.findMailbox('\\Drafts') ?? 'Drafts';
await session.appendMessage(drafts, {
  from: user,
  to: replyAddress?.email ?? user,
  subject: `Re: ${subject}`,
  text: 'Follow-up (draft)…',
  ...(messageId ? { inReplyTo: messageId, references: [...references, messageId] } : {}),
}, ['\\Draft']);
console.log(`Draft saved to ${drafts}`);

await session.close();
await mail.shutdown();
