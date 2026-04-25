# mailts

Modern TypeScript mail library — native SMTP/IMAP over Node.js built-ins, zero runtime dependencies.

```
npm install mailts
```

## Features

- **Native SMTP** — STARTTLS upgrade, AUTH PLAIN / LOGIN / XOAUTH2, PIPELINING, connection pool
- **Native IMAP** — automatic mailbox selection, fetch, search, MOVE/COPY/APPEND, mailbox management, CONDSTORE, IDLE push notifications, full MIME parsing
- **HTTP transports** — Resend, SendGrid, Mailgun, Postmark, Amazon SES (all zero-dep via `node:http/https`)
- **DKIM signing** — rsa-sha256, relaxed/relaxed canonicalization, configurable signed headers
- **iCal invites** — attach calendar invites (`text/calendar`) with attendees, RSVP, timezone
- **HTML to text** — auto-generated plain-text fallback from HTML body
- **Queue + DLQ** — concurrency-limited send queue, exponential backoff + jitter, dead-letter queue
- **Streaming logs** — structured `LogEvent` stream, pluggable log sinks, full protocol trace (credentials auto-redacted)
- **Aliases & templates** — define reusable email configs, plug in any template engine
- **Middleware** — transform every outbound message in a pipeline
- **Config file** — auto-loaded from `.mailtsrc` / `~/.mailts/config.json`, `${ENV_VAR}` expansion
- **Security** — sealed `Credential` value object, header-injection prevention, attachment path traversal prevention, prototype-pollution-safe config parser
- **Zero runtime deps** — only `node:net`, `node:tls`, `node:crypto`, `node:stream`, `node:http`, `node:https`

---

## Quick start

```ts
import { MailTs } from 'mailts';

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
    start: new Date('2024-06-01T14:00:00Z'),
    end: new Date('2024-06-01T15:00:00Z'),
    organizer: { name: 'Alice', email: 'alice@example.com' },
    attendees: [
      { email: 'bob@example.com', name: 'Bob', rsvp: true },
    ],
    location: 'Conference Room A',
    description: 'Weekly sync',
    method: 'REQUEST',    // REQUEST | CANCEL | REPLY | COUNTER
    timezone: 'America/New_York',
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
import { ResendTransport } from 'mailts/transports';

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
import { signDkim } from 'mailts';

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

Use `mail.queue` for fire-and-forget sending with automatic retries.

```ts
const mail = new MailTs({
  smtp: { ... },
  queue: {
    concurrency: 5,        // parallel sends
    maxRetries: 3,         // retries per job (1 initial + 3 retries = 4 total attempts)
    retryDelay: 1_000,     // base delay (ms)
    retryBackoff: 'exponential', // 'exponential' | 'linear' | 'fixed'
    jitter: true,          // ±30% randomisation to avoid thundering-herd
    jobTimeout: 30_000,    // abort a hung send after 30 s (treated as transient, triggers retry)
    deadLetter: { enabled: true },
  },
});

// Enqueue without awaiting
mail.queue.enqueue({ to: 'user@example.com', subject: 'Hi', text: 'Hello' });

// Wait until all enqueued jobs finish
await mail.queue.drain();

// Inspect dead-letter queue
const failed = mail.queue.dlq.getAll();
for (const job of failed) {
  console.log(job.id, job.errors.at(-1)?.message);
  mail.queue.dlq.retry(job.id);  // re-enqueue
}
```

### Queue events

```ts
mail.queue.on('success', (job, result) => { ... });
mail.queue.on('retry',   (job, attempt, delay) => { ... });
mail.queue.on('dead',    (job) => { ... });
```

### Pause / resume

```ts
mail.queue.pause();   // stops dispatching new jobs
mail.queue.resume();  // resumes from where it stopped
```

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
import { SmtpAuthError, SmtpRejectError, SmtpConnError, ImapError } from 'mailts';

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
import { MailTs } from 'mailts';

const trap = new TrapServer({ smtpPort: 1025, httpPort: 1080 });
await trap.start();

const mail = new MailTs({ smtp: { host: '127.0.0.1', port: 1025, pool: false } });
await mail.send({ from: 'app@example.com', to: 'dev@example.com', subject: 'Test', text: 'Hello!' });
// open http://localhost:1080 to inspect the captured email
```

### Quick example with `@mailts/testing`

```ts
import { useTrapServer } from '@mailts/testing';
import { MailTs } from 'mailts';

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

mailts configure                        # interactive SMTP/IMAP setup
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
