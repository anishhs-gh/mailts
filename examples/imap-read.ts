/**
 * IMAP read demo — list unread mail, read full bodies, and watch for new arrivals.
 *
 * Fetching never marks messages as read (BODY.PEEK); pass `markSeen: true` to do so.
 *
 * Run:  IMAP_USER=you@gmail.com IMAP_PASS=<app-password> npx tsx examples/imap-read.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'plain', user: process.env['IMAP_USER'] ?? 'you@gmail.com', pass: process.env['IMAP_PASS']! },
    reconnect: { retries: 3, delayMs: 1_000 }, // default — reconnects transparently after drops
  },
  logger: { level: 'info', format: 'pretty' },
});

// mail.imap creates a new session on every access — keep one and reuse it.
const session = mail.imap;

// Mailboxes, including special-use roles (\Sent, \Drafts, \Trash, …)
const mailboxes = await session.listMailboxes();
console.log('Mailboxes:', mailboxes.map(m => m.specialUse ? `${m.name} (${m.specialUse})` : m.name).join(', '));

// open() returns fresh status including the unseen count
const status = await session.open('INBOX');
console.log(`\nINBOX: ${status.exists} messages, ${status.unseen} unseen`);

// Newest 5 unread, with full bodies and threading headers
const messages = await session.fetch({ seen: false, limit: 5, bodies: true });
console.log(`\nUnread messages (${messages.length}):`);
for (const msg of messages) {
  const from = msg.envelope.from[0] as { name?: string; email: string } | undefined;
  console.log(`  [${msg.uid}] ${msg.envelope.subject} — ${from?.name ?? from?.email ?? '?'}`);
  console.log(`      ${(msg.body?.text ?? '').split('\n')[0]?.slice(0, 80)}`);
  if (msg.body?.attachments.length) {
    console.log(`      attachments: ${msg.body.attachments.map(a => `${a.filename} (${a.size} B)`).join(', ')}`);
  }
  if (msg.envelope.references?.length) console.log(`      thread depth: ${msg.envelope.references.length}`);
}

// Watch INBOX on a dedicated connection — new mail arrives as UIDs
console.log('\nWatching for new messages (30s)…');
const watcher = await session.watch('INBOX');
watcher.on('new', async (uids: number[]) => {
  const fresh = await session.fetch({ uids, textOnly: true });
  for (const m of fresh) console.log(`New: [${m.uid}] ${m.envelope.subject}`);
});
watcher.on('error', (err: Error) => console.warn('watch:', err.message)); // reconnects on its own

await new Promise(r => setTimeout(r, 30_000));
await watcher.stop();
await session.close();
console.log('Done.');
