# Changelog — @mailts/trap

All notable changes to this package are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

## [0.1.2] — 2026-05-09

### Added
- Connection status indicator in the web UI header: `● Live` when connected, `○ Disconnected` on unexpected drop, `○ Server stopped` after a clean shutdown.
- Refresh button morphs into a **Reconnect** button when disconnected or after server stop. Clicking it re-establishes the SSE connection and reloads messages in one action.
- `MemoryStore.markRead()` method; `PersistStore` overrides it to rewrite the persistence file so read/unread status survives server restarts when using `--persist`.

### Fixed
- **SSE reconnection loop** — browser's native `EventSource` auto-reconnects on any connection drop. When the server quit, a race between the `shutdown` SSE event and the TCP close caused the browser to see an error instead, so `es.close()` was never called and the UI entered an infinite retry loop filling the network tab. Fixed by: (1) adding an `error` handler that calls `es.close()` to stop native retries, (2) a `shuttingDown` flag to distinguish intentional stop from unexpected disconnect, and (3) a 50 ms flush delay in `HttpServer.close()` so the browser receives the `shutdown` event before the connection drops.
- **`ERR_SERVER_NOT_RUNNING` crash on Ctrl+C** — both `HttpServer` and `SmtpServer` now treat this error code as a successful close instead of rejecting, preventing an unhandled rejection crash on exit.
- Detail view now clears when the currently open message is removed (deleted externally or cleared) and the list refreshes — previously the sidebar removed the entry but the detail pane kept showing the stale message.

## [0.1.1] — 2026-05-06

### Fixed
- `PersistStore.delete()` now rewrites the NDJSON file after removal. Previously, deleting a message in-session removed it from memory but the file was not updated, so the message reappeared after a restart.
- `GET /api/messages/:id` no longer includes the `raw` buffer or `attachments[].content` buffers in the JSON response — these are binary fields that inflated payload size and were not needed by the UI.
- Server now broadcasts a `shutdown` SSE event to all connected clients before closing. Clients that listen for this event (the web UI does) can cleanly close the `EventSource` instead of receiving a stream of `ERR_CONNECTION_REFUSED` errors after the server stops.

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
