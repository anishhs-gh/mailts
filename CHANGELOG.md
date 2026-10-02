# Changelog — @mailts/core

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [0.5.0] — 2026-09-30

Correctness and security release plus OAuth. See [MIGRATION.md](MIGRATION.md) for behaviour changes. Tracking issue: #17.

### Fixed — IMAP

- **Message bodies were truncated.** The literal reader subtracted the prefix line from the literal size, so multi-line bodies (quoted replies, attachments) were cut short and the remainder parsed as bogus responses. Framing is now byte-exact and O(n).
- **`fetch({ bodies: true })` marked mail as read** (it fetched `RFC822`). It now uses `BODY.PEEK[]`.
- A `NIL` or quoted section returned **another section's bytes**; responses are now decoded from a structured tokenizer instead of regexes, which also fixes ENVELOPE literals, parentheses in names, and body text that looked like FETCH syntax.
- `fetchText()` / `textOnly` returned quoted-printable/base64 text undecoded.
- `LIST` truncated names containing spaces (`[Gmail]/Sent Mail`); modified UTF-7, literal names and NIL delimiters are now handled, and mailbox arguments are encoded.
- A dropped connection left commands hanging until timeout; they now fail immediately with a retryable `ImapConnError`, and `ImapSession` reconnects on the next call.
- IDLE: stop always waited 5 s, the completion was never awaited, commands could be written into an IDLE stream, and the untagged buffer grew without bound.
- XOAUTH2 failures hung the connection (the error challenge was never answered).
- BODYSTRUCTURE read the disposition from the wrong position for non-text parts; RFC 2231 filenames and `message/rfc822` sub-structures are supported.
- `[UNSEEN n]` was reported as the unseen count (it is a sequence number — now `firstUnseen`).
- `APPEND` sent an invalid date-time format; large UID sets exceeded server line limits (now compressed and chunked); `close()` issued `CLOSE`, silently expunging `\Deleted` mail.
- User-supplied flags, sequence sets and sections are validated (no command injection); non-ASCII search terms are sent as literals with `CHARSET UTF-8`.

### Fixed — Queue

- **`shutdown()` cancelled pending mail.** It now takes `{ pending: 'drain' | 'keep' | 'cancel', timeoutMs }`, defaulting to delivering (in-memory) or keeping (persistent) mail, and never hangs.
- **Persistent queue lost restored jobs** (restored before the send function existed) and **sent jobs twice** (re-enqueued under new ids). Jobs now keep their ids, wait for a send function, and are claimed with leases so several processes can share a database safely; a crashed local owner is detected immediately.
- Buffers and Dates did not survive persistence (new versioned `JobCodec`; streams are rejected at enqueue).
- Retry backoff held a concurrency slot; retries are now scheduled and free the slot.
- `drain()` hung while paused; `shutdown(timeout)` could hang after aborting a job.
- Queued sends bypassed `devMode` (real mail was sent in dev mode) and middleware.
- `MailWorker` pulled the whole external queue into memory, spun on empty `dequeue()`, and crashed the process on an `ack`/`nack` rejection.
- `configure()` leaked replaced pools and SQLite handles; documented queue defaults did not match the code.

### Fixed — Transports and proxy

- HTTP transports threw plain `Error`s, so rate limits (429) and outages (5xx) went straight to the DLQ. They now throw `TransportError` (retryable for 408/425/429/5xx and network failures, `retryAfterMs` honoured by the queue; 401/403 → `EAUTH`).
- Replies sent via Resend, SendGrid or Postmark left the thread (In-Reply-To / References were dropped); JSON-API transports now forward threading and unsubscribe headers.
- A non-JSON success body crashed the send; SES had no endpoint override (signing now verified against the AWS SigV4 test vector).
- Connections through an HTTP CONNECT, SOCKS5 or SOCKS4 proxy hung when the SMTP greeting arrived in the same packet as the proxy reply (bytes were discarded).
- `SmtpTransport` reported every recipient as accepted.
- Reusing a job `id` on `SqliteQueue` re-sent an already delivered job; ids are now unique for the lifetime of the database.
- SMTP reply-stream errors (oversized replies) crashed the process via an unhandled `error` event.

### Fixed — SMTP and MIME

- Credentials could be sent in clear text when a server (or attacker) omitted STARTTLS — `requireTLS` now defaults on when authenticating (loopback hosts exempt).
- Header injection through attachment filenames and content types; invalid header names are rejected instead of silently repaired.
- Non-ASCII subjects and custom headers were sent as raw UTF-8 (now RFC 2047); non-ASCII filenames use RFC 2231.
- One rejected recipient failed the whole send and `rejected` was always empty.
- The pool handed broken connections (aborted, failed RSET) to the next caller and leaked abort listeners.
- XOAUTH2 `334` error challenges poisoned the connection.
- ical-only invites were rejected; `Attachment.encoding` was ignored; quoted-printable left trailing whitespace unprotected.
- Envelope addresses with CR/LF or `<>` could inject SMTP commands; malformed From/To/Cc/Bcc/Reply-To addresses are now rejected by the builder (also protecting HTTP transports).
- HTTP transports re-read `path` attachments outside the attachment policy (with `{ root }`, relative paths resolved against the working directory); `MailTs` now resolves them once under the policy.

### Added

- **One mailbox API** (`@mailts/core/mailbox`, also exported from the root): the `Mailbox` interface with `imapMailbox(session)`, `GraphMailbox` (Microsoft 365 via Graph — experimental) and `GmailMailbox` (Gmail API): list, status, fetch with bodies, search, raw source, flags, move, delete, append, watch.
- **`GraphTransport` / `GmailTransport`** — send through Microsoft Graph (works when SMTP AUTH is disabled; experimental) or the Gmail API, with the MIME mailts built.
- **App-only OAuth**: `googleServiceAccountProvider` (domain-wide delegation) and `microsoftAppOnlyProvider` (client credentials, secret or certificate — experimental); `SCOPES` presets, `microsoft({ api: 'graph' })`, `googleWith(scopes)`.
- **`buildReply` / `buildForward`** — threading, reply-all, quoting, forward inline or as `message/rfc822`.
- **One-click unsubscribe**: `EmailOptions.unsubscribe` (List-Unsubscribe + List-Unsubscribe-Post, DKIM-signed by default), `isOneClickUnsubscribe()`.
- **Queue**: `idempotencyKey` (persisted by SQLite, schema v3), Message-ID pinned at enqueue, `rateLimit` (per second/minute/hour/day, per queue/sender/custom, recipient counting), `throttled` event; `MailWorker` honours `DriverMessage.idempotencyKey`.
- **Limits**: `imap.limits` (literal / response / line bytes → `LimitError`, `ELIMIT`), `parseMessage(raw, { maxParts, maxHeaderBytes, maxDepth })` with `truncated`, SMTP reply caps. TLS `minVersion` defaults to TLSv1.2.
- `TransportError`, `LimitError`; `HttpResponse.raw`; `TransportResult.providerMessageId` / `threadId`.
- **`@mailts/core/oauth`** — Google and Microsoft: `authorizeWithLoopback()` (PKCE, CLI browser flow), `buildAuthorizationUrl()` / `exchangeCode()` (web), `refreshAccessToken()`, cached single-flight `googleTokenProvider()` / `microsoftTokenProvider()` with refresh-token rotation callbacks, `mailConfigFor()` presets.
- `auth.getToken` for XOAUTH2 on SMTP and IMAP — called per connect, refreshed once on rejection.
- `mail.build()`, exported `buildMessage()`, `session.appendMessage()`, `mail.saveToSent()`, `send(opts, { saveToSent })`.
- `parseMessage()` MIME parser; `session.fetchRaw()`; `fetch({ headers })`; `envelope.references`; `findMailbox('\\Sent')`; `ImapListEntry.specialUse`.
- `session.watch()` / `MailboxWatcher` — new mail by UID on a dedicated connection with reconnect and catch-up.
- `ImapSession` lazy connect, `reconnect`, `keepAliveMs`, `isConnected`; `ImapClient.noop()`, `fetchAttributes()`.
- `EmailOptions.inReplyTo` / `references`; `replyTo` accepts a list.
- `attachmentPolicy: 'allow' | 'deny' | { root }`. Leaving it unset behaves as `'allow'` but emits a one-time `MailtsWarning` (`MAILTS_ATTACHMENT_PATH_POLICY`) when a path is read — the default will become `'deny'`.
- Queue: `enqueue(opts, { sendAt, id })`, `scheduled` state and stat, `get()`, `list()`, `maxRetryDelay`, `ShutdownResult`; `QueueDriver.release()` / `cancel()`; `MailWorker` `prefetch`, `idleDelayMs`, `use()`.
- `SmtpClient.send()` returning accepted/rejected; `SMTPUTF8` and `BODY=8BITMIME` when required.
- Errors: `ImapAuthError`, `ImapConnError`, `OAuthError`; `ImapError.responseCode`.

### Changed

- Node.js **20.18+** required (build target `node20`).
- CI runs Node 20/22/24 and an integration suite against GreenMail (`npm run test:integration`).
- `npm run typecheck` now also typechecks `examples/`.

### Examples

- New: `oauth-app-only.ts`, `mailbox-any-provider.ts`, `newsletter-unsubscribe.ts`, `oauth-cli.ts` (sign in / send / sign out, Google + Microsoft), `oauth-web-server.ts` (connect-your-mailbox web flow), `reply-and-save-to-sent.ts`, `parse-eml.ts`, `untrusted-input.ts`, `queue-persistence.ts`, `oauth-test.mjs` (interactive live smoke test against the built package, IMAP/SMTP or Gmail API).
- Updated for 0.5: `xoauth2.ts` (token provider), `imap-read.ts` (`watch()`), `imap-manage.ts` (`appendMessage`, `findMailbox`), `queue-lifecycle.ts` (shutdown modes, `sendAt`), `mail-worker-redis.ts` (correct inflight removal, `release`, `JobCodec`).

## [0.4.0] — 2026-06-22

### Added

- **BODYSTRUCTURE parser** — `parseBodyStructure(raw)` converts a raw IMAP `BODYSTRUCTURE` response into a typed `BodyLeaf | BodyMultipart` tree. Each node carries `section`, `contentType`, `charset`, `encoding`, `size`, `filename`, `contentId`, and `disposition`. Exported as `BodyNode`, `BodyLeaf`, `BodyMultipart` from all entry points.
- **`ImapSession.fetchStructure(uid, mailbox?)`** — returns the `BodyNode` tree for a single message without transferring any body content. One round-trip.
- **`ImapSession.fetchSection(uid, section, mailbox?)`** — fetches a single MIME section as raw `Buffer` using `BODY.PEEK[n]` (never sets `\Seen`).
- **`ImapSession.fetchText(uids[], mailbox?)`** — bandwidth-efficient text fetch: issues one `BODYSTRUCTURE` batch then selectively fetches only `text/plain` and `text/html` sections. Populates `message.body.text`, `message.body.html`, and `message.structure`. For a 20 MB email with attachments, transfers only the text sections (~KB) instead of the full message.
- **`ImapFetchOptions.structure`** — `fetch({ structure: true })` returns headers + BODYSTRUCTURE with no body content; populates `message.structure`.
- **`ImapFetchOptions.textOnly`** — `fetch({ textOnly: true })` internally uses `fetchText` — BODYSTRUCTURE-driven selective fetch, bypasses RFC822.
- **`ImapSession.search(criteria, mailbox?)`** — exposes full `ImapSearchCriteria` (`from`, `subject`, `since`, `before`, `flagged`, etc.) through the session lock. Previously only accessible by instantiating `ImapClient` directly.
- **`ImapClient.fetchBodyStructure(uids[])`** — returns `Map<uid, BodyNode>`, fetches all UIDs in a single command.
- **`ImapClient.fetchSection(uid, section)`** — single `BODY.PEEK[n]` fetch.
- **`ImapClient.fetchSections(uids[], sections[])`** — batch multi-section fetch in one round-trip, returns `Map<uid, Map<section, Buffer>>`.
- **`parseSectionResponse(data, section)`** — extract raw `Buffer` for a `BODY[n]` section from a FETCH response string. Exported from `@mailts/core/imap`.
- **`ImapAttachment.contentId`** — bare Content-ID value (angle brackets stripped) for inline parts referenced by `cid:` URLs in HTML.
- **`ImapAttachment.inline`** — `true` when the part carries `Content-Disposition: inline`.
- **`ImapAttachment.nestedMessage`** — present for `content-type: message/rfc822` parts (forwarded / bounced emails). Contains `{ envelope: ImapEnvelope, body?: { text?, html?, attachments[] } }` from recursive parsing of the nested message.
- **`ImapMessage.structure`** — populated when `structure: true` or `textOnly: true` is used.

### Fixed

- **Body always empty** (`bodies: true` non-functional) — `parseFetchResponse` now parses `RFC822` literals and runs a full inline MIME parser. Previously `BODY[TEXT]` was requested but the response was silently discarded.
- **Folded headers** — `Content-Type` boundaries split across lines (`\r\n\t`) are now correctly unfolded before parsing, fixing multipart boundary extraction for virtually all Gmail messages.
- **RFC 2047 charset ignored** — `decodeRfc2047` now uses `TextDecoder` with the declared charset instead of always decoding as UTF-8. Correct output for ISO-8859-1, ISO-8859-2…16, Windows-1250…1258, and (on full-ICU Node.js 18+) ISO-2022-JP, GBK, Big5, EUC-KR — zero new runtime dependencies.
- **Inline attachments not captured** — `Content-Disposition: inline` parts with a `filename` or `Content-ID` are now exposed as `ImapAttachment` entries with `inline: true` and `contentId` set. Previously they fell through to the text routing and were lost.
- **`message/rfc822` treated as plain text** — forwarded and bounced emails embedded as `message/rfc822` parts are now recursively parsed and exposed via `ImapAttachment.nestedMessage`.
- **`splitPartHeadersAndBody` false separator** — regex `\n\s*\n` replaced with `\n\n` to prevent a whitespace-only continuation line from being misidentified as the header/body separator.
- **`decodeContent` default encoding** — changed from `Buffer.from(raw, 'utf8')` to `Buffer.from(raw, 'latin1')` so raw bytes are preserved before charset-aware decoding, fixing 7bit/8bit ISO-8859-1 body parts.

### Tests

- Added `tests/unit/imap/ImapBodyStructure.test.ts` — 11 tests covering leaf, multipart/alternative, multipart/mixed, three-level nesting, section numbering, RFC 2047 filename decoding.
- Added `tests/unit/imap/ImapFetch.test.ts` — 14 tests covering text/plain, text/html, multipart/alternative, attachments, inline parts with `contentId`, `message/rfc822` nested parsing, ISO-8859-1 charset decoding, `parseSectionResponse`.
- Extended `tests/unit/imap/ImapParser.test.ts` — 8 new tests for charset-aware `decodeRfc2047` (ISO-8859-1 base64, ISO-8859-1 QP, UTF-8 regression, unknown charset fallback) and `decodeBytes`.

## [0.3.0] — 2026-05-12

### Added
- **Priority scheduling** — `enqueue(options, { priority: 'critical' | 'high' | 'normal' | 'low' })`. Jobs are drained critical → high → normal → low. `QueueOptions.defaultPriority` sets the instance-wide default. `QueueJob.priority` is always present (defaults to `'normal'`).
- **`JobController`** — reason-aware `AbortController` attached to each running job. Exported as `JobController` / `ControlReason` from the main entry point and `@mailts/core/queue`.
- **`MailQueue.play()`** — alias for `resume()`.
- **`MailQueue.cancel(jobId)`** — cancel a pending or running job. Pending: removed immediately. Running: abort signal sent, job stops after the current send attempt.
- **`MailQueue.cancelAll()`** — cancel all pending jobs; returns the count removed.
- **`MailQueue.interrupt(jobId)`** — interrupt a running job; it is returned to the **front** of its priority bucket without the attempt counter being incremented.
- **`MailQueue.interruptAll()`** — interrupt all running jobs.
- **`MailQueue.abort(jobId)`** — abort a running job; counts as a failed attempt and feeds into the normal retry / DLQ policy.
- **`MailQueue.abortAll()`** — abort all running jobs.
- **`MailQueue.shutdown(timeoutMs?)`** — graceful stop: pause, cancel pending, wait for running. If `timeoutMs` is provided and exceeded, remaining running jobs are aborted.
- **`MailQueue` events** — `'cancelled'` `(job)` and `'interrupted'` `(job)`.
- **`QueueStats.cancelled`** — count of jobs removed via cancel since the instance started.
- **`TelemetryHooks.onQueueCancelled`** and **`onQueueInterrupted`** — optional hooks for new events.
- **`SqliteQueue` cross-process control** — `SqliteQueue.requestCancel(dbPath, jobId)`, `requestInterrupt`, `requestAbort` static methods write to a new `queue_control` table; the running app processes them within 5 s via its existing poll loop.
- **AbortSignal threading** — `Transport.send(message, options, signal?)` gains an optional third parameter. All six built-in transports (SMTP, Mailgun, Postmark, SES, SendGrid, Resend) pass the signal to the underlying connection / `http.request`. `SmtpPool.acquire(signal?)` rejects immediately if aborted while waiting for a pool slot.
- **`MailTs.shutdown(queueTimeoutMs?)`** — forwards the optional timeout to `queue.shutdown()`.
- **`QueueDriver<T>` interface** — three-method contract (`dequeue`, `ack`, `nack`) for bridging any external queue backend (Redis, SQS, Cloud Tasks, BullMQ, database poll, …) with `MailQueue`'s lifecycle controls.
- **`DriverMessage<T>` interface** — typed envelope returned by `QueueDriver.dequeue()`: `{ id, data, priority? }`. The `id` is the external message identifier used for ack/nack; the queue generates its own internal job IDs.
- **`MailWorker`** — bridges a `QueueDriver` with an internal `MailQueue`. External system owns persistence; `MailWorker` owns execution: concurrency, priority scheduling, retry, play/pause/cancel/interrupt/abort. `ack()` is called on the driver on success; `nack()` on permanent failure (DLQ).
- **`MailWorkerConfig`** — `MailTsConfig` minus `queue.persist` (persistence is the driver's responsibility). Accepts all SMTP/transport/telemetry/logger config plus `queue` execution options.
- **`MailTs.dispatch(options, signal?)`** — public low-level send that bypasses the internal queue and threads `AbortSignal` directly to the transport. Used by `MailWorker`; available for advanced callers managing their own concurrency.
- New examples: `examples/queue-lifecycle.ts` — demonstrates all five lifecycle operations; `examples/mail-worker-redis.ts` — complete Redis reliable-queue pattern with producer, consumer, pause/resume, and graceful shutdown.

### Changed
- `QueueJob.status` union extended with `'cancelled'` — additive, existing exhaustive checks may need updating.
- `MailQueue.enqueue()` accepts an optional second argument `EnqueueOptions { priority? }` — fully backward-compatible.
- `SqliteQueue` schema auto-migrates existing databases on open: adds `priority TEXT DEFAULT 'normal'` and `cancelled_at TEXT` columns, and creates the `queue_control` table if absent.

## [0.2.0] — 2026-05-06

### Added
- `HealthChecker` — pings SMTP (EHLO + NOOP) and IMAP (connect + open INBOX), measures latency, returns a structured result. Accessible via `mail.health()` or directly `new HealthChecker(smtpCfg, imapCfg).check()`. Suitable for K8s liveness/readiness probes.
- `TelemetryHooks` — zero-dependency observability injection. Six optional hooks: `onSend`, `onError`, `onQueueEnqueue`, `onQueueSuccess`, `onQueueDead`, `onQueueRetry`. Pass as `telemetry` in `MailTsConfig`.
- `SqliteQueue` — extends `MailQueue` with `node:sqlite` persistence (Node 22+). Enables cross-process queue visibility: the CLI can read queue state from a running app without sharing process memory. Exports `resolveQueueDbPath` helper.

### Fixed
- Removed unused private fields `replyLines`/`replyCode` from `SmtpClient` (never wired to `SmtpStream`).
- Removed unused `bccList` variable in `buildMessage` (BCC is correctly included in the SMTP envelope via `extractEmails`; the `Bcc:` header is intentionally absent per RFC 5322 §3.6.3).
- Removed unused `parseList` import in `ImapFetch` and `toAddressObjects` import in `ResendTransport`.
- `ImapClient.selectedMailbox` getter — previously the field was written after `select()`/`examine()` but never exposed; now accessible as a public getter for direct `ImapClient` consumers.

## [0.1.2] — 2026-04-30

### Added
- New examples: `cc-bcc-replyto.ts`, `xoauth2.ts`, `imap-manage.ts`, `smtp-pool-config.ts` — covering CC/BCC/Reply-To, XOAUTH2 auth, full IMAP management (flags, copy, move, delete, append, CONDSTORE), and SMTP pool tuning.
- GitHub Actions workflow (`.github/workflows/sync-gists.yml`) + `scripts/sync-gists.mjs` — automatically upserts one public GitHub Gist per example file on every push to `master`, with import rewriting (`../src/...` → `@mailts/core`) and a rendered `README.md` per gist.

### Fixed
- `loadConfig()` now accepts an optional `globalConfigPath` parameter — makes the function testable without ESM module mocking and fixes two pre-existing test isolation failures caused by the developer's `~/.mailts/config.json` leaking into the test suite.

### Tests
- Added: `notify()` subject prefix, `alert()` subject prefix + priority headers, `configure()` hot-swap, pool config + parallel send (`smtp.test.ts`).
- Added: `markFlagged`, `markUnflagged`, `setFlags` arbitrary flags, `fetchChanged` CONDSTORE (`ImapSession.test.ts`).
- Added: `loadConfig()` global + local merge test (`Config.test.ts`).

## [0.1.1] — 2026-04-27

### Fixed
- iCal `timezone` field now uses wall-clock semantics — the `Date`'s local values are stamped with the specified TZID rather than being converted from UTC. Previously, running on a server whose timezone differed from the specified `timezone` would shift the wall-clock time in the emitted iCal. Recipients in other timezones continue to see the correct local equivalent via their calendar client.

## [0.1.0] — 2026-04-25

### Added
- Initial release of `@mailts/core` — native TypeScript SMTP/IMAP library, zero runtime dependencies.
- SMTP client with TLS, STARTTLS, PLAIN/LOGIN/XOAUTH2 auth, SOCKS5 and HTTP CONNECT proxy.
- Connection pool with configurable `maxConnections`, `maxMessages`, `idleTimeout`.
- `pool: false` option — disables pooling for scripts/CLIs; connection opens, sends, and closes per send with no `shutdown()` required.
- DKIM signing (rsa-sha256, relaxed/relaxed) via `smtp.dkim` or standalone `signDkim()`.
- IMAP client: IDLE, CONDSTORE, flag operations, mailbox management, FETCH, APPEND.
- Queue with concurrency limiting, exponential/linear/fixed backoff, ±30% jitter, `jobTimeout` (aborts hung sends as transient failures), and dead-letter queue.
- Five HTTP transports: Resend, SendGrid, Postmark, Mailgun, AWS SES (SigV4). Custom `Transport` interface.
- Template engine with `{{variable}}` syntax; pluggable (Handlebars, EJS, etc.).
- Middleware pipeline (`mail.use()`), named aliases (`mail.define()` / `mail.trigger()`).
- iCal invite generation (REQUEST / CANCEL) and RFC 822 message embedding.
- HTML-to-text auto-conversion and shorthand helpers (`notify`, `alert`, `ping`).
- Structured logger with credential redaction, pretty/JSON formats, event streaming.
- Dev mode — `send()` logs but never transmits.
- Config file auto-loading from `.mailtsrc` / `~/.mailts/config.json` with `${ENV_VAR}` expansion.

### Fixed
- RFC 822 message builder was missing the blank-line separator (`\r\n\r\n`) between headers and body, causing plain-text and HTML bodies to be parsed as empty by MIME parsers.
- IMAP RFC 2047 Q-encoded multi-byte UTF-8 sequences decoded byte-by-byte producing mojibake — bytes are now collected and decoded as a single UTF-8 buffer.
- Whitespace between adjacent RFC 2047 encoded words is now discarded per spec (was preserved, causing spurious spaces).
- IMAP raw UTF-8 strings in server responses now correctly re-decoded from `binary` to `utf-8`.
- `RetryPolicy.shouldRetry` boundary changed from `>=` to `>` so `maxRetries: N` correctly allows N retries.
