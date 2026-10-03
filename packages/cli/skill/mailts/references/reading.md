<!-- Generated from README.md by scripts/build-skill.mjs — do not edit by hand. -->

# Reading mail with mailts

IMAP sessions, fetch modes, search, flags, drafts, watching for new mail, the connection pool, MIME parsing, and the provider-neutral Mailbox API for IMAP, Gmail and Microsoft Graph.

## IMAP

`ImapSession` automatically selects the correct mailbox before each operation and connects lazily. When the
connection drops, the next call reconnects, re-authenticates and re-selects (`reconnect: { retries, delayMs }`,
or `false`); an operation in flight at the moment of the drop rejects with a retryable `ImapConnError` rather
than being replayed. `mail.imap` returns a **new** session on every access — keep a reference and reuse it.

```ts
const mail = new MailTs({
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env.IMAP_PASS },
  },
});

const session = mail.imap;
await session.connect();

// Fetch unread messages — auto-selects INBOX
const messages = await session.fetch({ seen: false, limit: 10, bodies: true });

// Fetch from a specific mailbox — auto-selects that mailbox
const sent = await session.fetch({ mailbox: 'Sent', limit: 5 });

// Concurrent operations on different mailboxes are safely serialized
const [inbox, drafts] = await Promise.all([
  session.fetch({ mailbox: 'INBOX' }),
  session.fetch({ mailbox: 'Drafts' }),
]);

await session.close();
```

### Fetch modes

| Mode | Option | What transfers | Use when |
|---|---|---|---|
| Headers only | _(default)_ | Envelope, flags, size | Inbox listing |
| Full message | `bodies: true` | Complete RFC 822 message (`BODY.PEEK[]`) | Need body + attachments |
| Extra headers | `headers: ['References']` | Named header fields | Threading without the body |
| Text only | `textOnly: true` | BODYSTRUCTURE + text/html sections | Reading body, skipping attachments |
| Structure only | `structure: true` | BODYSTRUCTURE metadata tree | Attachment listing without downloading |

Fetching never marks messages as read — pass `markSeen: true` to set `\Seen`.

```ts
// Full body — text, html, and attachment bytes
const msgs = await session.fetch({ uids: [1, 2, 3], bodies: true });
console.log(msgs[0].body?.text);
console.log(msgs[0].body?.attachments[0]?.filename);

// Text only — bandwidth-efficient for large messages
const msgs = await session.fetch({ seen: false, textOnly: true });
console.log(msgs[0].body?.text);   // populated
console.log(msgs[0].structure);    // BodyNode tree available

// Structure only — list attachment names without downloading content
const msgs = await session.fetch({ uids: [5], structure: true });
const tree = msgs[0].structure!;
```

### BODYSTRUCTURE — selective section fetch

```ts
import type { BodyLeaf, BodyMultipart } from '@mailts/core';

// Get the MIME tree for a single message
const tree = await session.fetchStructure(uid);

// Fetch a specific section as raw bytes
const bytes = await session.fetchSection(uid, '2');   // e.g. the HTML part

// Fetch text/plain + text/html parts only (no attachment bytes transferred)
const [msg] = await session.fetchText([uid]);
console.log(msg.body?.text);
console.log(msg.body?.html);
console.log(msg.structure);   // full BodyNode tree
```

`BodyNode` is either a `BodyLeaf` (single part) or `BodyMultipart` (container):

```ts
function printTree(node: BodyNode, indent = 0): void {
  const prefix = ' '.repeat(indent * 2);
  if (node.type === 'leaf') {
    console.log(`${prefix}[${node.section}] ${node.contentType} (${node.size}B) enc=${node.encoding}`);
    if (node.filename) console.log(`${prefix}    filename: ${node.filename}`);
  } else {
    console.log(`${prefix}${node.contentType}`);
    for (const child of node.parts) printTree(child, indent + 1);
  }
}
```

### Search

```ts
// Full criteria search — returns UIDs
const uids = await session.search({
  from: 'boss@example.com',
  unseen: true,
  since: new Date('2025-01-01'),
  subject: 'report',
});

const messages = await session.fetch({ uids, textOnly: true });
```

### Parsed MIME body

When `bodies: true` or `textOnly: true`, `message.body` is populated:

```ts
const [msg] = await session.fetch({ uids: [1], bodies: true });

msg.body?.text          // string | undefined — decoded plain text
msg.body?.html          // string | undefined — decoded HTML

// Attachments
for (const att of msg.body?.attachments ?? []) {
  att.filename          // decoded filename (RFC 2047 encoded names supported)
  att.contentType       // "application/pdf", "image/png", …
  att.size              // byte size
  att.content           // Buffer — raw bytes
  att.inline            // true for Content-Disposition: inline parts
  att.contentId         // bare Content-ID for cid: references in HTML

  // Forwarded / bounced email (message/rfc822)
  if (att.contentType === 'message/rfc822') {
    att.nestedMessage?.envelope.subject   // subject of the forwarded message
    att.nestedMessage?.body?.text         // decoded body of the nested message
  }
}
```

Charset decoding is handled automatically. ISO-8859-1, ISO-8859-2…16, Windows-1250…1258, ISO-2022-JP, GBK, Big5, EUC-KR and all other WHATWG Encoding Standard charsets are decoded correctly via Node.js built-in `TextDecoder` — no additional dependencies.

### Explicit selection

Call `open()` when you need a fresh mailbox snapshot (EXISTS, UIDNEXT, HIGHESTMODSEQ, …):

```ts
const status = await session.open('INBOX');
console.log(status.exists, 'messages,', status.unseen, 'unseen');

// Read-only (EXAMINE) — flag changes not allowed while open
const roStatus = await session.openReadOnly('Archive');

// STATUS without selecting
const counts = await session.getStatus('INBOX', ['MESSAGES', 'UNSEEN']);
```

### Flag operations

```ts
await session.markSeen([101, 102, 103]);
await session.markUnseen([104], 'Sent');
await session.markFlagged([105]);
await session.markUnflagged([105]);
await session.setFlags([106], ['\\Answered'], true);
```

### Copy, move, delete

```ts
// Move from INBOX to Archive (uses MOVE extension when available, falls back to COPY+DELETE)
await session.move([101, 102], 'Archive');

// Copy without removing
await session.copy([103], 'Backup', 'Sent');

// Delete (marks \\Deleted + EXPUNGE)
await session.delete([104]);

// Expunge without deleting
await session.expunge('INBOX');
```

### Append (save to Sent / Drafts)

```ts
// Build from EmailOptions and upload — no selected mailbox needed
await session.appendMessage('Drafts', { from, to, subject: 'Draft', text: '…' }, ['\\Draft']);

// Raw bytes
await session.append('Sent', rawMessageBuffer, ['\\Seen'], new Date());

// Find special-use mailboxes (RFC 6154, with common-name fallback)
const sent = await session.findMailbox('\\Sent');

// Full raw source of a message (for forwarding or parseMessage())
const raw = await session.fetchRaw(uid);
```

Many providers (unlike Gmail) do not store SMTP-sent mail. `send()` can do it for you, appending the exact bytes that were sent:

```ts
await mail.send(options, { saveToSent: true });      // SPECIAL-USE \Sent, or pass a mailbox name
await mail.saveToSent(options, { mailbox: 'Sent' }); // standalone
const built = await mail.build(options);             // raw RFC 5322 bytes without sending
```

### CONDSTORE — incremental sync

```ts
const status = await session.open('INBOX');
const highestModSeq = status.highestModSeq ?? 0;

// Later — fetch only messages changed since last sync
const changed = await session.fetchChanged(highestModSeq, 'INBOX');
```

### Mailbox management

```ts
const mailboxes = await session.listMailboxes();
const subscribed = await session.listSubscribed();

await session.createMailbox('Projects/Alpha');
await session.renameMailbox('Projects/Alpha', 'Projects/Beta');
await session.deleteMailbox('Projects/Beta');

await session.subscribe('Newsletter');
await session.unsubscribe('Newsletter');
```

### Watching for new mail

`watch()` runs IDLE (or NOOP polling when IDLE is unsupported) on a **dedicated connection**, reports new
messages by **UID**, reconnects automatically and catches up on anything missed while disconnected.

```ts
const watcher = await session.watch('INBOX');
watcher.on('new', async (uids) => {
  const msgs = await session.fetch({ uids, textOnly: true });
});
watcher.on('expunge', (seq) => { /* removed */ });
watcher.on('reset', () => { /* UIDVALIDITY changed — resync */ });

await watcher.stop();
```

The older `session.idle(cb)` / `stopIdle()` still work and now deliver `{ uid }`.

### Connection pool (multi-tenant servers)

Servers that act on many mailboxes (APIs, MCP servers) should not log in per request. `ImapPool` keeps
authenticated sessions per account and lends each one to a single callback at a time:

```ts
import { ImapPool } from '@mailts/core';

const pool = new ImapPool({ maxPerAccount: 2, maxSessions: 200, idleTimeoutMs: 5 * 60_000 });

const unread = await pool.use(account.id, () => imapConfigFor(account), (session) =>
  session.fetch({ seen: false, limit: 20 }));

await pool.close(account.id); // sign-out / credentials changed — next use() logs in again
await pool.closeAll();        // shutdown
```

| Option | Default | |
|---|---|---|
| `maxPerAccount` | `1` | Parallel sessions per account (providers cap connections per mailbox) |
| `maxSessions` | `100` | Total; when full, the least recently used idle session is closed |
| `idleTimeoutMs` | 5 min | Log out unused sessions (`0` keeps them) |
| `acquireTimeoutMs` | 30 s | Waiting longer rejects with a retryable `ETIMEOUT` `ImapError` |

The config is only resolved when a session is opened, so it can be async (token lookup). A session whose
login failed is discarded. Watchers open their own connection — run them outside the pool.

## One mailbox API: IMAP, Microsoft Graph, Gmail API

`Mailbox` is a provider-neutral interface — write mail-handling code once and run it against any provider:

```ts
import { imapMailbox, GraphMailbox, GmailMailbox, type Mailbox } from '@mailts/core';

const boxes: Mailbox[] = [
  imapMailbox(mail.imap),                                        // any IMAP server
  new GraphMailbox({ user: 'me@contoso.com', getToken: msGraph }), // Microsoft 365 via Graph (experimental)
  new GmailMailbox({ user: 'me@gmail.com', getToken: gmailApi }),  // Gmail via the Gmail API
];

for (const box of boxes) {
  const unread = await box.fetch({ search: { seen: false, from: 'boss@x.com' }, limit: 10 });
  if (!unread.length) continue;
  const [first] = await box.fetch({ ids: [unread[0]!.id], bodies: true });   // text, html, attachments
  await box.setSeen([first!.id], true);
  await box.move([first!.id], 'Archive');
  await box.append('Drafts', (await mail.build(reply)).raw, { draft: true });
  const watcher = await box.watch('INBOX');
  watcher.on('new', (ids) => { /* … */ });
}
```

Ids are strings (IMAP UID, Graph id, Gmail id); flags use IMAP names (`\Seen`, `\Flagged`, `\Draft`); folder
names like `INBOX`, `Sent`, `Drafts`, `Trash` resolve per provider (Gmail mailboxes are labels).
Provider limits: Graph `append()` creates drafts only; Graph and Gmail `watch()` poll (Graph receive time, Gmail
history) — push needs a public webhook / Pub/Sub topic.
