# Changelog — @mailts/core

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

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
