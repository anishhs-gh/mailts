# Migrating to @mailts/core 0.5

0.5 fixes data-loss and security bugs. Most code keeps working unchanged; the items below are the
behaviour changes to check. Tracking issue: [#17](https://github.com/anishhs-gh/mailts/issues/17).

## Requirements

- **Node.js 22+** (was 18). Node 18 and 20 are end-of-life. The SQLite queue (`queue.persist`) needs 22.13+.

## Behaviour changes

| Area | 0.4 | 0.5 | What to do |
|---|---|---|---|
| `fetch({ bodies: true })` | Set `\Seen` on every fetched message (RFC822 fetch) | Never marks mail read (`BODY.PEEK[]`) | Pass `markSeen: true` if you relied on it |
| `shutdown()` (queue and `MailTs`) | Cancelled all pending mail | In-memory: delivers pending mail; persistent: keeps it for the next start | Pass `{ pending: 'cancel' }` to discard; `{ timeoutMs }` to bound the wait |
| `shutdown(timeoutMs)` stragglers | Aborted (counted as failure) | Interrupted back to pending | — |
| SMTP / IMAP without TLS | Logged in over plain text if STARTTLS was missing | Refuses (`SmtpTlsError` / `ImapError` code `ETLS`) — loopback hosts exempt | Set `requireTLS: false` for trusted plain-text servers |
| Rejected recipients | One rejected recipient failed the whole send | Delivered to accepted recipients; `result.rejected` lists the rest | `smtp.allRecipientsRequired: true` restores the old behaviour |
| Queued sends in `devMode` | Were actually sent | Logged only, like `send()` | — |
| Queue middleware | Not applied to `mail.queue` jobs | Applied per attempt, on a fresh copy of the options | Make middleware idempotent if it has side effects |
| `ImapMailboxStatus.unseen` | Held the sequence number of the first unseen message | Unseen **count**, present only after `session.open()`; the old value is `firstUnseen` | Read `firstUnseen` or call `open()` |
| `drain()` while paused | Hung forever | Rejects with `QueueError` | `resume()` first |
| `ImapClient.close()` / `ImapSession.close()` | Sent `CLOSE` (silently expunged `\Deleted` mail) | Sends `LOGOUT` only | Call `expunge()` explicitly if you relied on it |
| `ImapSession.delete()` | `EXPUNGE` removed every `\Deleted` message in the mailbox | `UID EXPUNGE` of just those UIDs (UIDPLUS); falls back to `EXPUNGE` otherwise | — |
| `session.idle(cb)` | `cb({ seq })` on the session connection | `cb({ uid })` on a dedicated connection | Prefer `session.watch()` |
| Non-network errors in the queue | Retried as `ECONN` | Not retried (`EQUEUE`, `retryable: false`) | — |
| Custom headers | CR/LF stripped silently | Invalid header names / content types throw `MimeError` | Fix the input |
| Addresses | Malformed addresses reached the transport | From/To/Cc/Bcc/Reply-To must look like `local@domain` (no spaces, brackets, quotes) — otherwise `send()` returns a `MimeError` | Validate or clean addresses before sending |
| `path` attachments with no `attachmentPolicy` | Read silently | **Rejected** (`MimeError`; `send()` returns `ok: false`) | Pass `content`, or set `attachmentPolicy`: `{ root }` for one folder, `'allow'` for trusted code (0.4 behaviour) |
| `QueueStats` | — | New `scheduled` field; `QueueJob.status` may be `'scheduled'` | Update exhaustive switches |
| HTTP transport failures | Plain `Error`, never retried | `TransportError` with `status`, `provider`, `retryAfterMs`; 429/5xx retried by the queue | Catch `TransportError` instead of matching message text |
| `enqueue(…, { id })` on `SqliteQueue` | Reusing an id re-sent the job | Throws `QueueError` for any id already in the database | Use `idempotencyKey` for "at most once per key" |
| Queued `options.messageId` | Generated at send time (new per attempt) | Generated at enqueue and stored on the job | Read `job.options.messageId` if you track ids |
| TLS | Node default minimum | `minVersion: 'TLSv1.2'` | Set `tls: { minVersion: 'TLSv1' }` only for legacy servers |
| DKIM default signed headers | from…cc | Also In-Reply-To, References, List-Unsubscribe, List-Unsubscribe-Post (when present) | — |

## Persistent queue databases

Existing `queue.persist` databases are migrated automatically on first open (new columns, `user_version = 2`,
WAL mode). Rows written by 0.4 are restored under their original ids and delivered once. Older rows that
stored Buffer attachments as `{ type: 'Buffer', data: [...] }` are decoded back to Buffers.

## New APIs worth adopting

- `Mailbox` (IMAP / Microsoft Graph / Gmail API), `GraphTransport`, `GmailTransport`, app-only OAuth providers.
- `buildReply` / `buildForward`, `unsubscribe`, queue `idempotencyKey` and `rateLimit`, `imap.limits`.

- OAuth: `auth: { type: 'xoauth2', user, getToken }` and `@mailts/core/oauth` (Google, Microsoft).
- `mail.build()`, `buildMessage()`, `session.appendMessage()`, `mail.saveToSent()`, `send(opts, { saveToSent })`.
- `parseMessage(raw)` — full MIME parser for `.eml` files and `session.fetchRaw(uid)`.
- `session.watch(mailbox)` — new-mail events by UID with automatic reconnect.
- `session.findMailbox('\\Sent')`, `fetch({ headers: ['References'] })`, `envelope.references`.
- `EmailOptions.inReplyTo` / `references`, ical-only invites, `Attachment.encoding`.
- `attachmentPolicy: 'allow' | 'deny' | { root }` (unset rejects `path` attachments).
- `ImapPool` — reuse IMAP sessions per account in multi-tenant servers.
- `enqueue(opts, { sendAt })`, `queue.get(id)`, `queue.list()`, `encodeJob` / `decodeJob`.
- `QueueDriver.release()` / `cancel()` and `MailWorker` `prefetch` / `idleDelayMs`.

## Removing workarounds

If you worked around 0.4 bugs, these are no longer needed:

- A patched IMAP line parser (truncated bodies) — delete it.
- Draining the queue before `shutdown()` — the default now delivers pending mail.
- Avoiding `queue.persist` because restored jobs vanished or were sent twice — safe to enable.
- Building raw messages through a capturing `Transport` — use `mail.build()`.
