# Changelog — @mailts/trap

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [0.1.0] — 2026-04-25

### Added
- Initial release of `@mailts/trap`.
- In-process SMTP trap server for local development — captures all outbound mail, nothing leaves the machine.
- Web UI at configurable HTTP port with real-time SSE updates, message sidebar, HTML/text/raw views, and attachment downloads.
- REST API: list, get, delete messages; download attachments; stats endpoint (`/api/stats`).
- MIME parser: multipart/alternative, multipart/mixed, multipart/related (CID), attachments, quoted-printable, base64.
- Optional NDJSON persistence across restarts (`persist` option / `--persist` flag).
- CLI entry point (`npx @mailts/trap`) for zero-config startup with `--smtp-port`, `--http-port`, `--host`, and `--persist` flags.

### Fixed
- RFC 822 blank-line separator (`\r\n\r\n`) between headers and body now correctly parsed — plain-text bodies were previously empty due to missing separator in upstream message builder.
- HTML/text tab visibility uses `!= null` check instead of falsy check so empty-string bodies still show the tab.
- `pre` element display set to `block` explicitly (CSS default was `none`, clearing inline style reverted to hidden).
- JavaScript syntax error in served UI caused by literal newline from `'\n'` in TypeScript template literal — changed to `'\\n'`.
