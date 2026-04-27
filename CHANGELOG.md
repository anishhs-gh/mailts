# Changelog — @mailts/core

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [Unreleased]

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
