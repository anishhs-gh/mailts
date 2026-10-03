/**
 * Reply in-thread, keep a copy in Sent, and save a draft — the typical
 * "email assistant" loop.
 *
 * - buildReply() handles Re: subjects, reply / reply-all recipients, quoting and threading headers
 * - saveToSent appends the exact bytes that were sent (Gmail does this itself;
 *   Fastmail, iCloud, Outlook IMAP, most custom domains do not)
 *
 * Run:  MAIL_USER=you@example.com MAIL_PASS=<app-password> IMAP_HOST=… SMTP_HOST=… \
 *         npx tsx examples/reply-and-save-to-sent.ts
 */
import { MailTs, buildReply, buildForward } from '../src/index.js';

const user = process.env['MAIL_USER']!;
const auth = { type: 'plain' as const, user, pass: process.env['MAIL_PASS']! };

const mail = new MailTs({
  imap: { host: process.env['IMAP_HOST'] ?? 'imap.fastmail.com', port: 993, secure: true, auth },
  smtp: { host: process.env['SMTP_HOST'] ?? 'smtp.fastmail.com', port: 465, secure: true, auth },
});
const session = mail.imap;

// 1. Fetch the newest message with its body and threading headers
const [original] = await session.fetch({ limit: 1, bodies: true, headers: ['References'] });
if (!original) {
  console.log('INBOX is empty');
  process.exit(0);
}

// 2. Reply-all in the same thread and keep a copy in Sent
const reply = buildReply(original, { from: user, text: 'Thanks — got it.', replyAll: true });
const result = await mail.send(reply, { saveToSent: true });   // or { saveToSent: 'Sent Items' }
console.log(result.ok ? `Replied to ${JSON.stringify(reply.to)}: ${result.messageId}` : `Failed: ${result.error.message}`);
if (result.ok && result.rejected.length) console.warn('Rejected recipients:', result.rejected);

// 3. Save a follow-up as a draft instead of sending it
const drafts = await session.findMailbox('\\Drafts') ?? 'Drafts';
await session.appendMessage(drafts, buildReply(original, { from: user, text: 'Follow-up (draft)…' }), ['\\Draft']);
console.log(`Draft saved to ${drafts}`);

// 4. Forward the original as an attachment (byte-exact)
const raw = await session.fetchRaw(original.uid);
const fwd = buildForward(original, { from: user, to: user, text: 'FYI', mode: 'attachment', raw });
console.log('Forward prepared:', fwd.subject, `(${fwd.attachments?.length} attachment)`);

await session.close();
await mail.shutdown();
