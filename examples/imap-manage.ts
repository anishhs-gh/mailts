/**
 * IMAP message management — flags, copy, move, delete, append, CONDSTORE sync.
 *
 * Run:  IMAP_PASS=<app-password> npx tsx examples/imap-manage.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env['IMAP_PASS']! },
  },
  logger: { level: 'info', format: 'pretty' },
});

const session = mail.imap;
await session.connect();

// ── Status without selecting ──────────────────────────────────────────────
// getStatus() never changes the active mailbox — safe for background polling.
const inboxStatus = await session.getStatus('INBOX', ['MESSAGES', 'UNSEEN', 'UIDNEXT']);
console.log(`INBOX: ${inboxStatus.messages} total, ${inboxStatus.unseen} unseen`);

const archiveStatus = await session.getStatus('Archive');
console.log(`Archive: ${archiveStatus.messages ?? 0} messages`);

// ── Fetch unread messages ─────────────────────────────────────────────────
const unread = await session.fetch({ seen: false, limit: 10, mailbox: 'INBOX' });
console.log(`\nUnread (${unread.length}):`);
for (const m of unread) {
  const from = m.envelope.from[0];
  const sender = typeof from === 'string' ? from : `${from?.name ?? ''} <${(from as { email: string })?.email ?? ''}>`;
  console.log(`  [${m.uid}] ${m.envelope.subject}  — ${sender}`);
}

const uids = unread.map(m => m.uid);

// ── Flag operations ───────────────────────────────────────────────────────
if (uids.length > 0) {
  // Mark all fetched messages as read
  await session.markSeen(uids);
  console.log(`\nMarked ${uids.length} messages as read`);

  // Star the first one
  await session.markFlagged([uids[0]!]);
  console.log(`Starred UID ${uids[0]}`);

  // Mark as answered (custom flag)
  await session.setFlags([uids[0]!], ['\\Answered'], true);
  console.log(`Flagged UID ${uids[0]} as Answered`);

  // Unstar it
  await session.markUnflagged([uids[0]!]);
  console.log(`Unstarred UID ${uids[0]}`);
}

// ── Copy messages ─────────────────────────────────────────────────────────
if (uids.length >= 2) {
  await session.copy(uids.slice(0, 2), 'Archive');   // destination must exist
  console.log('\nCopied 2 messages to Archive');
}

// ── Move messages (uses MOVE extension when server supports it) ───────────
if (uids.length >= 3) {
  await session.move([uids[2]!], 'Archive');
  console.log(`Moved UID ${uids[2]} to Archive`);
}

// ── Delete messages ───────────────────────────────────────────────────────
// delete() = mark \\Deleted + EXPUNGE in one call
if (uids.length >= 4) {
  await session.delete([uids[3]!]);
  console.log(`Deleted UID ${uids[3]}`);
}

// ── Fetch from a different mailbox (no open() needed) ────────────────────
const sent = await session.fetch({ mailbox: 'Sent', limit: 5 });
console.log(`\nSent (last 5): ${sent.map(m => m.envelope.subject).join(', ')}`);

// ── Append a message to Sent / Drafts ────────────────────────────────────
// Useful for saving a copy of messages sent via SMTP.
const raw = [
  `From: you@gmail.com`,
  `To: colleague@example.com`,
  `Subject: Meeting agenda`,
  `Date: ${new Date().toUTCString()}`,
  `MIME-Version: 1.0`,
  `Content-Type: text/plain`,
  ``,
  `Agenda:\n1. Q2 review\n2. Roadmap`,
].join('\r\n');

const appended = await session.append('Sent', Buffer.from(raw), ['\\Seen']);
if (appended.uid) console.log(`\nAppended to Sent as UID ${appended.uid}`);

// ── CONDSTORE: incremental sync (only messages changed since last modseq) ─
// highestModSeq is returned by open() on servers that advertise CONDSTORE.
const status = await session.open('INBOX');
if (status.highestModSeq) {
  const lastKnownModSeq = status.highestModSeq - 1n;   // in practice, store this across runs
  const changed = await session.fetchChanged(Number(lastKnownModSeq));
  console.log(`\nCONDSTORE: ${changed.length} messages changed since modseq ${lastKnownModSeq}`);
}

// ── Mailbox management ────────────────────────────────────────────────────
await session.createMailbox('MyFolder');
console.log('Created mailbox: MyFolder');

await session.renameMailbox('MyFolder', 'MyRenamedFolder');
console.log('Renamed to: MyRenamedFolder');

await session.deleteMailbox('MyRenamedFolder');
console.log('Deleted mailbox: MyRenamedFolder');

await session.close();
