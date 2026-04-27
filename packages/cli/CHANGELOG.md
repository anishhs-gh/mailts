# Changelog — @mailts/cli

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [Unreleased]

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
