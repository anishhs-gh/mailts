/**
 * IMAP read demo — lists unread messages and listens for new arrivals via IDLE.
 *
 * IMAP_PASS=<your-app-password> npx tsx examples/imap-read.ts
 */
import { MailTs } from '../src/index.js';
import type { ImapMessage } from '../src/types/index.js';

const mail = new MailTs({
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      type: 'plain',
      user: 'you@gmail.com',
      pass: process.env['IMAP_PASS']!,
    },
  },
  logger: { level: 'info', format: 'pretty' },
});

const session = mail.imap;
await session.connect();

// List all mailboxes
const mailboxes = await session.listMailboxes();
console.log('Mailboxes:', mailboxes.map(m => m.name).join(', '));

// Open INBOX
const status = await session.open('INBOX');
console.log(`\nINBOX: ${status.exists} messages, ${status.unseen} unseen`);

// Fetch last 5 unread messages
const messages = await session.fetch({ seen: false, limit: 5 });

console.log(`\nUnread messages (${messages.length}):`);
for (const msg of messages) {
  const from = (msg.envelope.from[0] as { name?: string; email: string } | undefined);
  const fromStr = from?.name ? `${from.name} <${from.email}>` : from?.email ?? '?';
  console.log(`  [${msg.uid}] ${msg.envelope.subject} — from: ${fromStr}`);
}

// Watch for new messages for 10 seconds using IDLE
console.log('\nWatching for new messages (10s)...');
await session.idle((msg: Partial<ImapMessage>) => {
  console.log('New message arrived! seq:', msg.seq);
});

await new Promise(r => setTimeout(r, 10_000));
await session.stopIdle();
await session.close();
console.log('Done.');
