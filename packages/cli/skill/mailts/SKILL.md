---
name: mailts
description: Build email features in TypeScript/Node.js with @mailts/core — send over SMTP or provider APIs (Resend, SendGrid, Mailgun, Postmark, SES, Gmail API, Microsoft Graph), read/search/watch mail over IMAP, Gmail and Graph, Google & Microsoft OAuth (XOAUTH2), queues with retries and persistence, DKIM, attachments, calendar invites, replies, unsubscribe headers, schema.org/AMP inbox content, and local testing with @mailts/trap and @mailts/testing. Use when code imports @mailts/*, or when the user wants to send, receive, parse or process email in a Node.js project.
---

# mailts

`@mailts/core` is a zero-dependency TypeScript mail SDK (Node.js 22+). One class, `MailTs`, sends and reads mail; subpath modules add OAuth (`@mailts/core/oauth`), provider-neutral mailboxes (`@mailts/core/mailbox`) and HTTP transports (`@mailts/core/transports`). Every export is typed and documented — hover a symbol to read its contract.

```bash
npm install @mailts/core            # SDK
npm install -D @mailts/trap @mailts/testing   # local SMTP trap + Vitest helpers
```

## Rules that prevent most bugs

1. **`send()` does not throw for delivery failures.** It returns `{ ok: true, messageId, accepted, rejected }` or `{ ok: false, error }`. Always branch on `result.ok`; `error.retryable` tells whether to retry.
2. **Always set `from`.** There is no default sender.
3. **File attachments need a policy.** `{ path }` attachments are rejected unless `attachmentPolicy` is set on `MailTs` (`{ root: '/dir' }` or `'allow'` for trusted code). Prefer `{ content: Buffer }`. Never use `'allow'` when message input comes from users or AI agents.
4. **`mail.imap` creates a new `ImapSession` on every access.** Store it once: `const session = mail.imap;` and `await session.close()` when done.
5. **Fetching never marks mail read.** Pass `markSeen: true` to opt in.
6. **Shut down cleanly.** `await mail.shutdown()` closes the SMTP pool and stops the queue without dropping mail. Scripts can use `smtp: { ..., pool: false }` instead.
7. **OAuth uses a token provider, not a static token.** `auth: { type: 'xoauth2', user, getToken }` refreshes automatically; build `getToken` with `@mailts/core/oauth`.
8. **TLS is required before login** (`requireTLS` defaults on, loopback hosts exempt). Use port 465 + `secure: true`, or 587 with STARTTLS.
9. **Experimental:** `GraphTransport`, `GraphMailbox`, `microsoftAppOnlyProvider` (not yet verified against a live tenant). Protocol helpers marked *Low-level* (`ImapParser`, `tokenize`, `ImapCmd`, `SmtpReply`…) may change in minor releases — don't build on them.

## Send

```ts
import { MailTs } from '@mailts/core';

const mail = new MailTs({
  smtp: { host: 'smtp.gmail.com', port: 587, auth: { type: 'plain', user: 'me@gmail.com', pass: process.env.SMTP_PASS! } },
});

const result = await mail.send({
  from: { email: 'me@gmail.com', name: 'My App' },
  to: ['a@example.com', { email: 'b@example.com', name: 'Bee' }],
  subject: 'Hello',
  html: '<p>Hi!</p>',            // text is generated from html when omitted
  attachments: [{ filename: 'report.pdf', content: pdfBuffer }],
});
if (!result.ok) console.error(result.error.code, result.error.message, result.error.retryable);
```

Swap SMTP for an API without changing send code: `new MailTs({ transport: new ResendTransport({ apiKey }) })` (import from `@mailts/core/transports`).

## Read

```ts
const mail = new MailTs({ imap: { host: 'imap.gmail.com', auth: { type: 'plain', user, pass } } });
const session = mail.imap;

const unread = await session.fetch({ seen: false, limit: 20, bodies: true });
for (const m of unread) console.log(m.uid, m.envelope.subject, m.body?.text);

const watcher = await session.watch('INBOX');           // new mail by UID, auto-reconnect
watcher.on('new', async (uids: number[]) => { /* session.fetch({ uids, textOnly: true }) */ });
```

## Sign in with Google / Microsoft

```ts
import { authorizeWithLoopback, google, googleTokenProvider, mailConfigFor } from '@mailts/core/oauth';

const tokens = await authorizeWithLoopback({ provider: google, clientId, clientSecret });   // CLI / desktop
const getToken = googleTokenProvider({ clientId, clientSecret, refreshToken: tokens.refreshToken! });
const mail = new MailTs(mailConfigFor(google, { user: tokens.email!, getToken }));         // IMAP + SMTP
```

## Queue

```ts
const mail = new MailTs({ smtp, queue: { concurrency: 5, maxRetries: 3, persist: true } });
mail.queue.enqueue({ from, to, subject, text }, { priority: 'critical', idempotencyKey: 'welcome:42' });
await mail.shutdown();   // in-memory: delivers pending; persistent: keeps them for the next start
```

## Test locally

```ts
import { useTrapServer } from '@mailts/testing';     // Vitest/Jest with globals: true

const trap = useTrapServer({ smtpPort: 2025 });       // real in-process SMTP trap for the suite

test('sends a welcome email', async () => {
  const mail = new MailTs({ smtp: { host: '127.0.0.1', port: 2025, pool: false } });
  await mail.send({ from: 'app@example.com', to: 'alice@example.com', subject: 'Welcome', text: 'Hi' });
  const msg = await trap.waitForMessage({ subject: 'Welcome' });
  expect(msg.to[0]!.email).toBe('alice@example.com');
});
```

## Reference — read the file for the task at hand

| Task | File |
|---|---|
| Send options, attachments, inline images, iCal, replies/forwards, unsubscribe, schema.org / AMP / Adaptive Cards, OTP emails, DKIM, HTTP transports, `build()` / `saveToSent()` | [references/sending.md](references/sending.md) |
| IMAP fetch modes, search, flags, move, drafts, watch, BODYSTRUCTURE, `parseMessage()`, `ImapPool`, the `Mailbox` API for Gmail/Graph | [references/reading.md](references/reading.md) |
| OAuth: loopback, web flow, token providers and rotation, scopes, service accounts, app-only | [references/oauth.md](references/oauth.md) |
| Queue options, lifecycle, persistence, idempotency, rate limits, `MailWorker` + drivers (Redis, Postgres, many instances) | [references/queue.md](references/queue.md) |
| Configuration files, security, errors, health checks, telemetry, logs, middleware, templates, dev mode, testing, the `mailts` CLI | [references/production.md](references/production.md) |

Docs: https://mailts.anishhs.com · Source and runnable examples: https://github.com/anishhs-gh/mailts/tree/master/examples
