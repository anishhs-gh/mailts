/**
 * Reuse IMAP connections per account in a multi-tenant server (API, MCP server, worker).
 *
 * Opening an IMAP connection costs a TLS handshake + login (often 300–1000 ms) and providers cap
 * concurrent connections per mailbox. ImapPool keeps one authenticated session per account,
 * lends it to one request at a time, and closes it after a quiet period.
 *
 * Run:  IMAP_USER=you@gmail.com IMAP_PASS=<app password> npx tsx examples/imap-pool.ts
 */
import { ImapPool } from '@mailts/core';
import type { ImapConfig } from '@mailts/core';

// In a real server this comes from your account store (and an OAuth getToken per account).
function imapConfigFor(accountId: string): ImapConfig {
  console.log(`  (opening a session for ${accountId})`);
  return {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'plain', user: process.env['IMAP_USER']!, pass: process.env['IMAP_PASS']! },
  };
}

const pool = new ImapPool({
  maxPerAccount: 2,          // parallel requests per mailbox (Gmail allows 15 connections)
  maxSessions: 200,          // across all accounts; the least recently used idle one is closed when full
  idleTimeoutMs: 5 * 60_000, // log out after 5 quiet minutes
  attachmentPolicy: 'deny',  // appendMessage() never reads local files
});

// Each "request" borrows the account's session — no reconnect, no re-login after the first.
async function listUnread(accountId: string) {
  return pool.use(accountId, () => imapConfigFor(accountId), session =>
    session.fetch({ seen: false, limit: 5 }));
}

for (let i = 1; i <= 3; i++) {
  const t = Date.now();
  const unread = await listUnread('account-1');
  console.log(`request ${i}: ${unread.length} unread in ${Date.now() - t} ms`);
}
console.log(pool.stats()); // { accounts: 1, sessions: 1, busy: 0, waiting: 0 }

// The callback has the session to itself, so multi-step work on one mailbox is safe:
await pool.use('account-1', () => imapConfigFor('account-1'), async (session) => {
  const uids = await session.search({ seen: false }, 'INBOX');
  if (uids.length) await session.markSeen(uids.slice(0, 1));
});

// Sign-out or new credentials: drop the account's sessions; the next use() logs in again.
await pool.close('account-1');

// Process shutdown (e.g. SIGTERM on Cloud Run).
await pool.closeAll();
