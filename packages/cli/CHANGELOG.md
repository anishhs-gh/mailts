# Changelog — @mailts/cli

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [0.1.6] — 2026-05-12

### Added
- `mailts queue cancel <job-id>` — write a cancel request to the SQLite `queue_control` table; the running app acts within 5 s. Requires `queue.persist` in config.
- `mailts queue interrupt <job-id>` — interrupt a running job, returning it to the front of its priority bucket without counting the attempt.
- `mailts queue abort <job-id>` — abort a running job; normal retry / DLQ policy applies.
- `mailts queue status` now shows a `Cancelled` row in addition to the existing counters.
- DLQ list now shows `priority=` field per job.

### Changed
- Requires `@mailts/core >= 0.3.0` for priority and lifecycle control features.

## [0.1.5] — 2026-05-09

### Added
- `mailts send --host <host> --port <port>` — override the configured SMTP host and port per invocation. Useful for targeting a local trap server (`--host 127.0.0.1 --port 1025`) without changing the global config.
- `cli.mjs` thin wrapper as the new `bin` entry point. Loads `dist/index.js` via a dynamic import so that a module-level `SyntaxError` from an outdated `@mailts/core` (missing named export) is caught and shown as a clear, actionable message instead of a raw Node crash.

### Fixed
- **Version mismatch handling** — when `@mailts/core` is outdated and missing an export used by the `queue` command, the CLI now shows a friendly error with the missing export name and fix instructions (`npx --yes @mailts/cli@latest <command>` or `npm install -g @mailts/cli`). Previously the entire CLI crashed with an unreadable `SyntaxError` even for unrelated commands like `trap`.
- `queue` command now uses a dynamic import for `SqliteQueue` so commands unrelated to the queue (`trap`, `send`, `test`, etc.) continue to work normally even when `@mailts/core` is outdated.

## [0.1.3] — 2026-05-06

### Changed
- `queue` commands now read state directly from the SQLite persistence file via `SqliteQueue` static methods, instead of creating a `MailTs` instance. Enables true cross-process visibility: the CLI can inspect a queue owned by a running application. Requires `queue.persist` in config and Node 22+. Depends on `@mailts/core` ≥ 0.2.0.

## [0.1.2] — 2026-04-30

### Added
- `mailts configure --local` — saves SMTP settings to `.mailtsrc` in the current directory instead of `~/.mailts/config.json`, enabling per-project config without touching global state.

### Fixed
- `send`, `read`, and `queue` commands were reading only `~/.mailts/config.json` and never checking for a local `.mailtsrc` / `.mailtsrc.json` in the current directory. All commands now use the same config resolution order as `@mailts/core`: local file overrides global, with `${ENV_VAR}` expansion applied once.
- Error messages updated to mention `.mailtsrc` as a config source alongside `~/.mailts/config.json`.

## [0.1.1] — 2026-04-27

### Added
- `mailts trap` command — starts a local SMTP trap server (delegates to `@mailts/trap`, which is an optional peer dependency).

## [0.1.0] — 2026-04-25

### Added
- Initial release of `@mailts/cli`.
- `configure` command — interactive wizard that writes SMTP/IMAP settings to `~/.mailts/config.json`.
- `test` command — opens a live SMTP connection and streams every protocol line to stdout.
- `send` command — send email from the terminal with full flag support (`--from`, `--to`, `--subject`, `--html`, `--attachments`, `--alias`).
- `read` command — list and read messages via IMAP (`--mailbox`, `--limit`, `--unseen`).
- `queue` subcommand — inspect queue status, drain, and retry dead-letter jobs.
- Config file auto-loading from `.mailtsrc` / `~/.mailts/config.json` with `${ENV_VAR}` expansion.
