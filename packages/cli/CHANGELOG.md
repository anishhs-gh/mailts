# Changelog — @mailts/cli

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [Unreleased]

### Added
- Initial release of `@mailts/cli`.
- `send` command — send email from the terminal with full flag support.
- `verify` command — test SMTP connection without sending.
- `trap` command — start a local SMTP trap (delegates to `@mailts/trap`).
- Config file auto-loading from `.mailtsrc` / `.mailtsrc.json` with `${ENV_VAR}` expansion.
