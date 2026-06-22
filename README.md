# @mailts/core

Modern TypeScript mail library — native SMTP/IMAP over Node.js built-ins, zero runtime dependencies.

```
npm install @mailts/core
```

## Features

- **Native SMTP** — STARTTLS upgrade, AUTH PLAIN / LOGIN / XOAUTH2, PIPELINING, connection pool
- **Native IMAP** — automatic mailbox selection, full MIME parsing (multipart, inline attachments, forwarded messages, charset-aware), BODYSTRUCTURE selective fetch, search, MOVE/COPY/APPEND, CONDSTORE, IDLE push notifications
- **HTTP transports** — Resend, SendGrid, Mailgun, Postmark, Amazon SES (all zero-dep via `node:http/https`)
- **DKIM signing** — rsa-sha256, relaxed/relaxed canonicalization, configurable signed headers
- **iCal invites** — attach calendar invites (`text/calendar`) with attendees, RSVP, timezone
- **HTML to text** — auto-generated plain-text fallback from HTML body
- **Queue + DLQ** — concurrency-limited send queue, exponential backoff + jitter, dead-letter queue, SQLite persistence for cross-process visibility (Node 22+)
- **Health checks** — SMTP + IMAP probe with latency measurement; ready for K8s liveness/readiness endpoints
- **Telemetry hooks** — zero-dependency observability; inject metrics/alerting callbacks for send, error, and queue events
- **Streaming logs** — structured `LogEvent` stream, pluggable log sinks, full protocol trace (credentials auto-redacted)
- **Aliases & templates** — define reusable email configs, plug in any template engine
- **Middleware** — transform every outbound message in a pipeline
- **Config file** — auto-loaded from `.mailtsrc` / `~/.mailts/config.json`, `${ENV_VAR}` expansion
- **Security** — sealed `Credential` value object, header-injection prevention, attachment path traversal prevention, prototype-pollution-safe config parser
- **Zero runtime deps** — only `node:net`, `node:tls`, `node:crypto`, `node:stream`, `node:http`, `node:https`

---

## Quick start

```ts
import { MailTs } from '@mailts/core';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env.SMTP_PASS },
  },
});

const result = await mail.send({
  from: 'you@gmail.com',
  to: 'friend@example.com',
  subject: 'Hello',
  text: 'Sent with mailts!',
});

if (result.ok) {
  console.log('Delivered:', result.messageId);
} else {
  console.error('Failed:', result.error.message);
}
```

---

## Configuration

### Constructor options

```ts
new MailTs({
  smtp: SmtpConfig,    // SMTP transport
  imap: ImapConfig,    // IMAP reader
  queue: QueueOptions, // Send queue behaviour
  logger: LoggerOptions,
  devMode: boolean,    // Log but never transmit (useful in dev/CI)
})
```

### Auto-loading

If no config is passed to `new MailTs()`, it automatically merges:

1. `~/.mailts/config.json` — global defaults
2. `.mailtsrc` or `.mailtsrc.json` in the current working directory — project overrides

`${ENV_VAR}` placeholders in config files are expanded at load time.

```json
{
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "auth": { "type": "plain", "user": "me@gmail.com", "pass": "${SMTP_PASS}" }
  }
}
```

### Timeout options

Both `SmtpConfig` and `ImapConfig` accept:

| Option | Default | Description |
|---|---|---|
| `connectionTimeout` | `10_000` ms | Time to complete the TCP/TLS handshake |
| `socketTimeout` | `30_000` ms | Time to receive a server reply; idle socket timeout |

```ts
const mail = new MailTs({
  smtp: {
    host: 'smtp.example.com',
    connectionTimeout: 5_000,  // fail fast if unreachable
    socketTimeout: 60_000,     // allow large messages extra time
  },
});
```

---

## Sending mail

### Basic send

```ts
await mail.send({
  from: 'sender@example.com',
  to: ['a@example.com', { email: 'b@example.com', name: 'Bob' }],
  cc: 'cc@example.com',
  subject: 'Hello',
  text: 'Plain text fallback',
  html: '<p>HTML body</p>',
  attachments: [
    { filename: 'report.pdf', path: './report.pdf' },
    { filename: 'inline.png', content: buffer, cid: 'logo@mailts' },
  ],
  headers: { 'X-Priority': '1' },
  priority: 'high',       // 'high' | 'normal' | 'low'
  replyTo: 'other@example.com',
});
```

### Inline attachments (CID)

Reference attachments by `cid` in your HTML. mailts wraps them in `multipart/related` automatically.

```ts
await mail.send({
  from: 'sender@example.com',
  to: 'user@example.com',
  subject: 'Logo email',
  html: '<img src="cid:company-logo">',
  attachments: [
    { filename: 'logo.png', content: logoBuffer, contentType: 'image/png', cid: 'company-logo' },
  ],
});
```

### iCal invites

Attach a calendar invite to any message. The `ical` field maps to RFC 5545 `VEVENT` properties.

```ts
await mail.send({
  from: 'organizer@example.com',
  to: 'attendee@example.com',
  subject: 'Team Sync',
  text: 'You have been invited.',
  ical: {
    summary: 'Team Sync',
    // Use local Date constructor — the wall-clock values are treated as the specified timezone.
    // Recipients in other timezones automatically see the equivalent local time.
    start: new Date(2024, 5, 1, 14, 0, 0),  // 2:00 PM
    end:   new Date(2024, 5, 1, 15, 0, 0),  // 3:00 PM
    timezone: 'America/New_York',            // or Intl.DateTimeFormat().resolvedOptions().timeZone
    organizer: { name: 'Alice', email: 'alice@example.com' },
    attendees: [
      { email: 'bob@example.com', name: 'Bob', rsvp: true },
    ],
    location: 'Conference Room A',
    description: 'Weekly sync',
    method: 'REQUEST',    // REQUEST | CANCEL | REPLY | COUNTER
  },
});
```

### Forwarded / embedded messages

Attach a raw RFC 5322 message as `message/rfc822`:

```ts
await mail.send({
  from: 'you@example.com',
  to: 'boss@example.com',
  subject: 'FWD: Important email',
  text: 'See forwarded message below.',
  attachments: [
    { filename: 'original.eml', rfc822: rawMessageBuffer },
  ],
});
```

### HTML auto-text

When only `html` is provided (no `text`), mailts automatically generates a plain-text fallback using the built-in HTML-to-text converter. You can always pass an explicit `text` to override.

### Reply type

```ts
const result = await mail.send({ ... });

if (result.ok) {
  result.messageId  // string — SMTP accepted message-id
  result.accepted   // string[] — accepted recipients
  result.rejected   // string[] — rejected recipients
} else {
  result.error      // MailTsError with .code and .retryable
}
```

---

## HTTP transports

For API-based delivery services, use a transport instead of SMTP:

```ts
import { ResendTransport } from '@mailts/core/transports';

const mail = new MailTs({
  transport: new ResendTransport({ apiKey: process.env.RESEND_API_KEY }),
});
```

Available transports:

| Transport | Import |
|---|---|
| Resend | `ResendTransport` |
| SendGrid | `SendGridTransport` |
| Mailgun | `MailgunTransport` |
| Postmark | `PostmarkTransport` |
| Amazon SES (HTTP) | `SesTransport` |

All transports implement the same `Transport` interface, so you can swap them without changing your send code.

---

## DKIM signing

```ts
const mail = new MailTs({
  smtp: { ... },
  dkim: {
    domainName: 'example.com',
    keySelector: 'mail',
    privateKey: process.env.DKIM_PRIVATE_KEY,
    // headerFieldNames: ['from','to','subject','date','message-id'], // optional override
  },
});

// Every outbound message is automatically signed
await mail.send({ ... });
```

Or sign a raw buffer directly:

```ts
import { signDkim } from '@mailts/core';

const signed = signDkim(rawBuffer, {
  domainName: 'example.com',
  keySelector: 'mail',
  privateKey: privateKeyPem,
});
```

---

## IMAP

`ImapSession` automatically selects the correct mailbox before each operation. You never need to call `open()` first — just call what you need.

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
| Full message | `bodies: true` | Complete RFC 822 message | Need body + attachments |
| Text only | `textOnly: true` | BODYSTRUCTURE + text/html sections | Reading body, skipping attachments |
| Structure only | `structure: true` | BODYSTRUCTURE metadata tree | Attachment listing without downloading |

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
// Does not require a mailbox to be selected
await session.append('Sent', rawMessageBuffer, ['\\Seen'], new Date());
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

### IDLE push notifications

```ts
await session.idle((msg) => {
  console.log('New message, seq:', msg.seq);
}, 'INBOX');

setTimeout(() => session.stopIdle(), 30_000);

await session.close();
```

---

## Queue

Use `mail.queue` for fire-and-forget sending with automatic retries, priority scheduling, and full lifecycle control.

```ts
const mail = new MailTs({
  smtp: { ... },
  queue: {
    concurrency: 5,             // parallel sends
    maxRetries: 3,              // retries per job
    retryDelay: 1_000,          // base delay (ms)
    retryBackoff: 'exponential',
    jitter: true,
    jobTimeout: 30_000,
    deadLetter: { enabled: true },
    defaultPriority: 'normal',  // 'critical' | 'high' | 'normal' | 'low'
  },
});

// Enqueue with optional priority
mail.queue.enqueue({ to: 'user@example.com', subject: 'Hi', text: 'Hello' });
mail.queue.enqueue({ to: 'vip@example.com',  subject: 'VIP', text: 'Hi!' }, { priority: 'critical' });

// Wait until all jobs finish
await mail.queue.drain();
```

### Priority scheduling

Jobs are processed in tier order: `critical` → `high` → `normal` → `low`. Within the same tier, FIFO ordering is preserved.

### Lifecycle control

```ts
// Play / pause
mail.queue.pause();             // stop dispatching new jobs (in-flight jobs finish)
mail.queue.play();              // resume — alias for resume()

// Cancel — remove permanently, no retry, no DLQ
mail.queue.cancel(jobId);       // pending or running job
mail.queue.cancelAll();         // all pending jobs; returns count

// Interrupt — return to front of queue, attempt counter NOT incremented
mail.queue.interrupt(jobId);    // running job only
mail.queue.interruptAll();

// Abort — count as a failed attempt; retry policy and DLQ apply
mail.queue.abort(jobId);        // running job only
mail.queue.abortAll();

// Graceful shutdown
await mail.queue.shutdown();            // pause + cancelAll + wait for running
await mail.queue.shutdown(5_000);       // same, but abort stragglers after 5 s
```

### Queue events

```ts
mail.queue.on('success',     (job, result) => { ... });
mail.queue.on('retry',       (job, attempt, delay) => { ... });
mail.queue.on('dead',        (job) => { ... });
mail.queue.on('cancelled',   (job) => { ... });
mail.queue.on('interrupted', (job) => { ... });
```

### Stats

```ts
const { pending, running, succeeded, dead, cancelled } = mail.queue.stats();
```

---

## MailWorker — external queue + lifecycle control

Use `MailWorker` when persistence lives outside your process (Redis, SQS, Cloud Tasks, BullMQ, database poll, …) but you still want full lifecycle control: play / pause / cancel / interrupt / abort.

Implement the `QueueDriver` interface for your backend — three methods — and pass it to `MailWorker`. Everything else is automatic.

```ts
import { MailWorker } from '@mailts/core';
import type { QueueDriver, DriverMessage } from '@mailts/core';

// ── 1. Implement your backend ─────────────────────────────────────────────
class RedisDriver implements QueueDriver {
  async dequeue(): Promise<DriverMessage | null> {
    const raw = await redis.brpoplpush('mail:pending', 'mail:inflight', 1);
    return raw ? JSON.parse(raw) : null;
  }
  async ack(id: string)  { await redis.lrem('mail:inflight', 1, id); }
  async nack(id: string) { await redis.lmove('mail:inflight', 'mail:dlq', 'LEFT', 'RIGHT'); }
}

// ── 2. Create the worker ──────────────────────────────────────────────────
const worker = new MailWorker(new RedisDriver(), {
  smtp: { host: 'smtp.example.com', port: 587, auth: { type: 'plain', user: '…', pass: '…' } },
  queue: { concurrency: 5, maxRetries: 3, defaultPriority: 'normal' },
});

worker.on('success',     (job) => console.log('sent',       job.id));
worker.on('dead',        (job) => console.error('dead',     job.id));  // nack called automatically
worker.on('cancelled',   (job) => console.log('cancelled',  job.id));
worker.on('interrupted', (job) => console.log('interrupted',job.id));

await worker.start();

// ── 3. Full lifecycle control ─────────────────────────────────────────────
worker.pause();              // stop pulling from Redis AND stop queue
worker.resume();             // restart both

worker.cancel(jobId);        // cancel a specific in-flight job
worker.interrupt(jobId);     // requeue at front, no penalty
worker.abort(jobId);         // force-fail → retry/DLQ

await worker.shutdown(5_000); // graceful drain, abort stragglers after 5 s
```

### How ack / nack work

| Event | Called | Meaning |
|---|---|---|
| `success` | `driver.ack(id)` | Remove from external queue |
| `dead` | `driver.nack(id, lastError)` | Move to external DLQ or delete |
| `cancelled` | — | Job never reached the transport; stays in external queue |

### QueueDriver interface

```ts
interface QueueDriver<T = EmailOptions> {
  dequeue(): Promise<DriverMessage<T> | null>;  // return null when idle (long-poll inside)
  ack(id: string): Promise<void>;
  nack(id: string, reason?: Error): Promise<void>;
}

interface DriverMessage<T = EmailOptions> {
  id: string;            // external message ID used for ack/nack
  data: T;               // EmailOptions payload
  priority?: JobPriority;
}
```

See `examples/mail-worker-redis.ts` for a complete working Redis example.

---

## Streaming logs

```ts
import { createWriteStream } from 'fs';

const mail = new MailTs({
  smtp: { ... },
  logger: {
    level: 'debug',
    format: 'pretty',
    protocol: true,  // include raw SMTP/IMAP protocol lines
  },
});

// Event listener
mail.logger.onEvent((e) => {
  if (e.level === 'error') process.stderr.write(e.message + '\n');
});

// Pipe to a file as newline-delimited JSON
mail.logger.stream({ format: 'json' }).pipe(createWriteStream('/tmp/mail.log'));

// Pretty-print to stdout
mail.logger.stream({ format: 'pretty' }).pipe(process.stdout);
```

All `AUTH` credentials are automatically scrubbed from the protocol trace before they reach any log sink.

---

## Aliases & templates

### Define a reusable alias

```ts
mail.define('welcome', {
  from: { email: 'welcome@example.com', name: 'Acme Team' },
  subject: 'Welcome, {{name}}!',
  template: 'Hi {{name}},\n\nYour account is ready.',
});

await mail.trigger('welcome', {
  to: 'newuser@example.com',
  data: { name: 'Alice' },
});
```

### Built-in template syntax

The built-in engine supports `{{variable}}` and dotted paths (`{{user.name}}`). Missing variables resolve to empty string.

### Custom template engine

```ts
import Handlebars from 'handlebars';

mail.setTemplateEngine({
  compile: (source) => Handlebars.compile(source),
  render:  (compiled, data) => (compiled as HandlebarsTemplateDelegate)(data),
});
```

---

## Middleware

```ts
// Runs before every send — can mutate EmailOptions
mail.use(async (msg, next) => {
  msg.headers = { ...msg.headers, 'X-Mailer': 'myapp/1.0' };
  await next();
});
```

---

## Connections & pool

By default mailts keeps a pool of persistent SMTP connections for reuse across sends. Call `shutdown()` before process exit to drain the pool cleanly.

```ts
smtp: {
  host: 'smtp.example.com',
  pool: {
    maxConnections: 5,   // max simultaneous connections
    maxMessages: 100,    // recycle connection after N messages
    idleTimeout: 60_000, // close idle connections after 60 s
  },
}
```

**Disable pooling** for scripts and CLIs — a fresh connection is opened and closed per send, so the process exits naturally with no `shutdown()` required:

```ts
const mail = new MailTs({
  smtp: { host: 'smtp.example.com', pool: false },
});

await mail.send({ ... });
// process exits automatically — no shutdown() needed
```

---

## Proxy support

Route SMTP/IMAP connections through a SOCKS5 or HTTP CONNECT proxy:

```ts
const mail = new MailTs({
  smtp: {
    host: 'smtp.example.com',
    proxy: { host: '127.0.0.1', port: 1080, type: 'socks5' },
  },
});
```

---

## Errors

All errors extend `MailTsError` and carry `.code` and `.retryable`:

```ts
import { SmtpAuthError, SmtpRejectError, SmtpConnError, ImapError } from '@mailts/core';

try {
  await mail.send({ ... });
} catch (e) {
  if (e instanceof SmtpAuthError) { /* bad credentials */ }
  if (e instanceof SmtpRejectError) { /* 5xx reject */ }
  if (e instanceof SmtpConnError && e.retryable) { /* transient */ }
}
```

| Class | Code | Retryable |
|---|---|---|
| `SmtpAuthError` | `EAUTH` | No |
| `SmtpRejectError` | `EREJECT` | No |
| `SmtpConnError` | `ECONN` | Yes |
| `SmtpTimeoutError` | `ETIMEOUT` | Yes |
| `ImapError` | `EIMAP` | — |
| `ConfigError` | `ECONFIG` | No |
| `MimeError` | `EMIME` | No |
| `TemplateError` | `ETEMPLATE` | No |

---

## Health checks

```ts
const result = await mail.health();
// {
//   smtp:      { ok: true,  latencyMs: 42 },
//   imap:      { ok: true,  latencyMs: 18 },
//   timestamp: '2026-05-06T10:00:00.000Z'
// }
```

Pings SMTP (EHLO + NOOP) and IMAP (connect + open INBOX), measures latency, and returns a structured result. Fields are omitted when the corresponding transport is not configured.

```ts
// K8s readiness probe
import http from 'http';
http.createServer(async (_req, res) => {
  const h = await mail.health();
  res.writeHead(h.smtp?.ok ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(h));
}).listen(8080);
```

---

## Telemetry hooks

Zero-dependency observability — inject callbacks without pulling in a metrics library:

```ts
const mail = new MailTs({
  smtp: { ... },
  telemetry: {
    onSend:           (opts, result, latencyMs) => metrics.histogram('mail.send', latencyMs),
    onError:          (err, phase) => logger.error({ phase, err }),
    onQueueEnqueue:   (job) => metrics.increment('queue.enqueued'),
    onQueueSuccess:   (job) => metrics.increment('queue.success'),
    onQueueDead:      (job) => alerting.fire(`Dead-letter: ${job.id}`),
    onQueueRetry:     (job, attempt, delay) => logger.warn({ attempt, delay }),
  },
});
```

All hooks are optional and fire synchronously after the event. Throwing inside a hook does not affect the send/queue operation.

---

## Dev mode

```ts
const mail = new MailTs({ smtp: { ... }, devMode: true });

// send() resolves immediately — nothing is transmitted
await mail.send({ ... });
```

---

## Ecosystem

| Package | Description |
|---|---|
| [`@mailts/cli`](https://github.com/anishhs-gh/mailts/tree/main/packages/cli) | Terminal CLI — send mail, verify SMTP connections, manage the queue and DLQ from the command line |
| [`@mailts/trap`](https://github.com/anishhs-gh/mailts/tree/main/packages/trap) | Local SMTP trap — captures outbound emails in development and previews them in a web UI at `localhost:1080` |
| [`@mailts/testing`](https://github.com/anishhs-gh/mailts/tree/main/packages/testing) | Vitest helpers — `useTrapServer()` spins up a real in-process SMTP trap for integration tests, no mocks |

### Quick example with `@mailts/trap`

```ts
import { TrapServer } from '@mailts/trap';
import { MailTs } from '@mailts/core';

const trap = new TrapServer({ smtpPort: 1025, httpPort: 1080 });
await trap.start();

const mail = new MailTs({ smtp: { host: '127.0.0.1', port: 1025, pool: false } });
await mail.send({ from: 'app@example.com', to: 'dev@example.com', subject: 'Test', text: 'Hello!' });
// open http://localhost:1080 to inspect the captured email
```

### Quick example with `@mailts/testing`

```ts
import { useTrapServer } from '@mailts/testing';
import { MailTs } from '@mailts/core';

const { getTrap } = useTrapServer();

test('sends welcome email', async () => {
  const mail = new MailTs({ smtp: { host: '127.0.0.1', port: getTrap().smtpPort, pool: false } });
  await mail.send({ from: 'app@example.com', to: 'alice@example.com', subject: 'Welcome!', text: 'Hi' });

  const [msg] = getTrap().store.getAll();
  expect(msg!.subject).toBe('Welcome!');
});
```

### Quick example with `@mailts/cli`

```bash
npm install -g @mailts/cli

mailts configure                        # interactive SMTP/IMAP setup (global)
mailts configure --local                # write .mailtsrc in current directory
mailts test --host smtp.gmail.com       # verify connection
mailts send --to you@example.com --subject "Hi" --text "Hello"
mailts read --unseen --limit 5
mailts queue status
```

---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

---

## License

MIT
