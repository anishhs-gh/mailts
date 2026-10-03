<!-- Generated from README.md by scripts/build-skill.mjs — do not edit by hand. -->

# Running mailts in production

Configuration, security, errors, health checks, telemetry, logs, middleware, templates, dev mode, stability guarantees, examples, and the trap / testing / CLI packages.

## Configuration

### Constructor options

```ts
new MailTs({
  smtp: SmtpConfig,                       // SMTP server (pooled by default)
  imap: ImapConfig,                       // IMAP server for reading
  transport: Transport,                   // send through an HTTP API instead of SMTP
  queue: QueueOptions,                    // retries, priorities, rate limits, persistence
  attachmentPolicy: 'deny' | 'allow' | { root }, // local file attachments (unset = rejected)
  logger: LoggerOptions,                  // level, format, protocol trace
  telemetry: TelemetryHooks,              // metrics / alerting callbacks
  devMode: boolean,                       // log but never transmit (dev / CI)
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

## Security for untrusted input

Attachments given by local `path` are **rejected unless you set `attachmentPolicy`**, so a message built from
untrusted input (AI agents, web forms) cannot attach `/etc/passwd` or `.env`. Pass `content` (Buffer/string) instead,
or opt in:

```ts
const mail = new MailTs({
  smtp,
  attachmentPolicy: { root: '/srv/uploads' },  // only files inside root — symlinks resolved, escapes rejected
  // attachmentPolicy: 'allow',                 // any path — trusted code only (scripts, CLIs)
});
// requireTLS defaults to true when authenticating (loopback hosts exempt); SMTP and IMAP
// refuse to send credentials if STARTTLS is missing.
```

The same policy applies to `mail.build()`, `saveToSent()`, `session.appendMessage()` and `ImapPool`. mailts never
fetches URLs, so attachment SSRF is not possible through it.

Header values, filenames, content types, IMAP flags, sequence sets and all addresses (From/To/Cc/Bcc/Reply-To)
are encoded or validated — malformed input is rejected with `MimeError` instead of being written to the wire.

**Hostile servers and messages:** IMAP responses are size-limited while they arrive (`imap.limits`: 64 MiB per
literal, 128 MiB per response, 1 MiB per line — exceeding one fails the command with `LimitError` and closes the
connection); `parseMessage(raw, { maxParts, maxHeaderBytes, maxDepth })` truncates (`truncated: true`) instead of
exhausting memory; SMTP replies are capped. TLS defaults to `minVersion: 'TLSv1.2'` (override via `tls`).

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
| `ImapError` | `EIMAP` | varies |
| `ImapAuthError` | `EAUTH` | No |
| `ImapConnError` | `ECONN` | Yes |
| `OAuthError` | `EAUTH` | varies (`invalid_grant` = sign in again) |
| `QueueError` | `EQUEUE` | No |
| `TransportError` | `EAUTH` / `EREJECT` / `ECONN` | 408/429/5xx and network: yes (`retryAfterMs`) |
| `LimitError` | `ELIMIT` | No |
| `ConfigError` | `ECONFIG` | No |
| `MimeError` | `EMIME` | No |
| `TemplateError` | `ETEMPLATE` | No |

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

## Middleware

```ts
// Runs before every send — can mutate EmailOptions
mail.use(async (msg, next) => {
  msg.headers = { ...msg.headers, 'X-Mailer': 'myapp/1.0' };
  await next();
});
```

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

## Dev mode

```ts
const mail = new MailTs({ smtp: { ... }, devMode: true });

// send() resolves immediately — nothing is transmitted
await mail.send({ ... });
```

## Stability & versioning

From **1.0.0**, `@mailts/core` follows [semantic versioning](https://semver.org): breaking changes to the public API
only in a major release. The public API is everything exported from `@mailts/core` and its subpaths
(`/smtp`, `/imap`, `/queue`, `/logger`, `/transports`, `/oauth`, `/mailbox`), as typed and documented — every export
carries a tooltip in your editor.

Two groups are excluded and say so in their tooltips:

| Group | Exports | Why |
|---|---|---|
| **Experimental** (`@experimental`) | `GraphTransport`, `GraphMailbox`, `microsoftAppOnlyProvider` and their option types | Not yet verified against a live Microsoft 365 tenant; may change in a minor release |
| **Low-level** | Protocol helpers: `ImapParser`, `ImapCmd`, `ImapParts`, `buildSearchCommand`, `buildSearchParts`, `checkFlags`, `tokenize`, `ImapToken`, `uidSets`, `encodeMailboxName`, `decodeMailboxName`, `parseFetchResponse`, `parseFetchAttributes`, `FetchAttributes`, `parseSectionResponse`, `SmtpStream`, `SmtpReply`, `Cmd`, `parseCapabilities`, `dotStuff` | Internals exported for advanced use; may change in a minor release |

Bug fixes can change behaviour that was wrong (for example a mis-encoded header) in a minor or patch release. Dropping
support for a Node.js version is a major change. `@mailts/trap`, `@mailts/cli` and `@mailts/testing` are versioned
separately and declare the `@mailts/core` range they support.

## Examples

Runnable examples live in [`examples/`](https://github.com/anishhs-gh/mailts/blob/master/examples) (run with `npx tsx examples/<file>.ts`; all are typechecked in CI):

| Example | Shows |
|---|---|
| [`basic-send.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/basic-send.ts) | Plain-text + HTML send |
| [`oauth-cli.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/oauth-cli.ts) | Google / Microsoft sign-in for CLIs, refresh-token storage, sign out |
| [`oauth-web-server.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/oauth-web-server.ts) | "Connect your mailbox" web flow for hosted apps — read inbox, send, disconnect (`cp examples/.env.example examples/.env`, then `npm run example:oauth-web`) |
| [`oauth-test.mjs`](https://github.com/anishhs-gh/mailts/blob/master/examples/oauth-test.mjs) | Interactive live test: sign in → read → send → log out, over IMAP/SMTP or the Gmail API (`node examples/oauth-test.mjs` after `npm run build`) |
| [`xoauth2.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/xoauth2.ts) | XOAUTH2 SMTP + IMAP with automatic token refresh |
| [`oauth-app-only.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/oauth-app-only.ts) | Organisation-wide access: Google service account / Microsoft client credentials |
| [`mailbox-any-provider.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/mailbox-any-provider.ts) | One `Mailbox` code path for IMAP, Microsoft Graph and the Gmail API |
| [`newsletter-unsubscribe.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/newsletter-unsubscribe.ts) | One-click unsubscribe, rate limits and idempotency for bulk sends |
| [`imap-read.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/imap-read.ts) | Unread mail, full bodies, `watch()` for new mail |
| [`imap-pool.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/imap-pool.ts) | Per-account IMAP connection pool for multi-tenant servers |
| [`imap-manage.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/imap-manage.ts) | Flags, move, delete, drafts, CONDSTORE, mailbox management |
| [`reply-and-save-to-sent.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/reply-and-save-to-sent.ts) | Threaded replies, save to Sent, drafts |
| [`parse-eml.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/parse-eml.ts) | `parseMessage()` for `.eml` / raw messages |
| [`rich-inbox-email.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/rich-inbox-email.ts) | Gmail order/parcel cards, inbox button, Promotions annotations, AMP, Outlook Adaptive Card |
| [`otp-email.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/otp-email.ts) | Verification-code email that clients detect ("Copy code", AutoFill) |
| [`untrusted-input.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/untrusted-input.ts) | `attachmentPolicy` and injection guards for AI agents / forms |
| [`queue-lifecycle.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/queue-lifecycle.ts) | Priority, pause/resume, cancel/interrupt/abort, shutdown modes, `sendAt` |
| [`queue-persistence.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/queue-persistence.ts) | Crash-safe SQLite queue |
| [`queue-and-dlq.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/queue-and-dlq.ts) | Retries, dead-letter queue, telemetry |
| [`mail-worker-redis.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/mail-worker-redis.ts) | External queue driver (Redis) with `MailWorker` |
| [`queue-driver-postgres.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/queue-driver-postgres.ts) | Durable queue shared by many instances (Cloud Run, Kubernetes) on Postgres |
| [`attachments-and-inline.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/attachments-and-inline.ts) · [`ical-invite.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/ical-invite.ts) · [`cc-bcc-replyto.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/cc-bcc-replyto.ts) | Message building |
| [`transports.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/transports.ts) · [`dkim-and-proxy.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/dkim-and-proxy.ts) · [`smtp-pool-config.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/smtp-pool-config.ts) | Delivery options |
| [`middleware-and-devmode.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/middleware-and-devmode.ts) · [`aliases-and-templates.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/aliases-and-templates.ts) · [`streaming-logs.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/streaming-logs.ts) · [`health-checks.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/health-checks.ts) | App integration |
| [`trap-local-dev.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/trap-local-dev.ts) · [`trap-testing.test.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/trap-testing.test.ts) | Local dev and tests with `@mailts/trap` / `@mailts/testing` |

## Ecosystem

| Package | Description |
|---|---|
| [`@mailts/cli`](https://github.com/anishhs-gh/mailts/tree/master/packages/cli) | Terminal CLI — send mail, verify SMTP connections, manage the queue and DLQ, install the mailts skill for AI coding agents |
| [`@mailts/trap`](https://github.com/anishhs-gh/mailts/tree/master/packages/trap) | Local SMTP trap — captures outbound emails in development and previews them in a web UI at `localhost:1080` |
| [`@mailts/testing`](https://github.com/anishhs-gh/mailts/tree/master/packages/testing) | Vitest helpers — `useTrapServer()` spins up a real in-process SMTP trap for integration tests, no mocks |

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

const trap = useTrapServer({ smtpPort: 2025 });   // real in-process SMTP trap for this suite

test('sends welcome email', async () => {
  const mail = new MailTs({ smtp: { host: '127.0.0.1', port: 2025, pool: false } });
  await mail.send({ from: 'app@example.com', to: 'alice@example.com', subject: 'Welcome!', text: 'Hi' });

  const msg = await trap.waitForMessage({ subject: 'Welcome!' });
  expect(msg.to[0]!.email).toBe('alice@example.com');
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
mailts skill install                    # teach your AI coding agent (Claude Code) to use mailts
```
