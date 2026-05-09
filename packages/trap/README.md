# @mailts/trap

Local SMTP trap for development — captures every outbound email your app sends and displays it in a web UI. No messages ever leave your machine.

## Install

```bash
npm install --save-dev @mailts/trap
```

## Programmatic usage

`@mailts/trap` has no dependencies — it works with any SMTP client (nodemailer, `@mailts/core`, Python's `smtplib`, Go's `net/smtp`, etc.). Just point your mailer at the trap's SMTP port.

```ts
import { TrapServer } from '@mailts/trap';

const trap = new TrapServer({
  smtpPort: 1025,  // point your app's SMTP config here
  httpPort: 1080,  // web UI + REST API
});

await trap.start();

// Use any SMTP client — example with nodemailer:
import nodemailer from 'nodemailer';
const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 1025 });
await transport.sendMail({ from: 'app@example.com', to: 'user@example.com', subject: 'Hello', html: '<p>Hello!</p>' });

// Open http://localhost:1080 to inspect captured emails

await trap.stop();
```

## CLI

```bash
# Start the trap server (SMTP :1025, UI :1080)
npx mailts-trap

# Custom ports
npx mailts-trap --smtp-port 2525 --http-port 2080

# Persist messages across restarts
npx mailts-trap --persist
npx mailts-trap --persist /var/mail/trap

# Bind all interfaces (e.g. staging VM)
npx mailts-trap --host 0.0.0.0

# CI / scripted use — no browser, no output
npx mailts-trap --no-open --quiet
```

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--smtp-port <port>` | `1025` | SMTP listen port |
| `--http-port <port>` | `1080` | HTTP / UI listen port |
| `--host <host>` | `127.0.0.1` | Bind address |
| `--max-messages <n>` | `100` | Max messages kept in memory |
| `--persist [dir]` | — | Persist messages to disk (including read status); omit `dir` for `~/.mailts-trap/` default |
| `--no-open` | `false` | Skip auto-opening the browser |
| `--quiet` | `false` | Suppress startup output |
| `--version` | — | Print version and exit |

### Reading messages from the terminal

While the server is running, query it with `curl` (or any HTTP client):

```bash
# List all captured messages
curl http://localhost:1080/api/messages

# Get full detail for a specific message
curl http://localhost:1080/api/messages/<id>

# Get raw RFC 822 source
curl http://localhost:1080/api/messages/<id>/raw

# Stats (total, unread, storage bytes)
curl http://localhost:1080/api/stats

# Delete one message
curl -X DELETE http://localhost:1080/api/messages/<id>

# Clear all messages
curl -X DELETE http://localhost:1080/api/messages
```

## Web UI

Open `http://localhost:1080` (or your configured `httpPort`) to:

- Browse captured messages in the sidebar
- View HTML, plain-text, and raw headers per message
- Download attachments
- Delete individual messages or clear all
- Real-time updates via Server-Sent Events (no polling)
- Connection status indicator (`● Live` / `○ Disconnected` / `○ Server stopped`) — the Refresh button becomes a **Reconnect** button when the connection is lost, restoring the SSE stream and reloading messages in one click

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/messages` | List all messages (summary) |
| `GET` | `/api/messages/:id` | Full message detail (marks as read) |
| `DELETE` | `/api/messages/:id` | Delete one message |
| `DELETE` | `/api/messages` | Clear all messages |
| `GET` | `/api/messages/:id/raw` | Raw RFC 822 source |
| `GET` | `/api/messages/:id/attachments/:n` | Download attachment |
| `GET` | `/api/stats` | `{ total, unread, storageBytes }` |
| `GET` | `/api/events` | Server-Sent Events stream |

## Options

```ts
new TrapServer({
  smtpPort: 1025,          // SMTP listen port (default: 1025)
  httpPort: 1080,          // HTTP listen port (default: 1080)
  host: '127.0.0.1',       // bind address (default: 127.0.0.1)
  maxMessages: 100,         // max messages kept in memory (default: 100)
  maxSize: 26_214_400,      // max accepted message size in bytes (default: 25 MB)
  persist: true,            // persist to ~/.mailts-trap/ (messages + read status)
  persist: '/path/to/file', // or a custom file path
});
```

### Reading captured messages programmatically

`trap.store` is public — useful in tests to assert on captured mail without going through the HTTP API:

```ts
const messages = trap.store.getAll();       // CapturedMessage[], newest first
const msg = trap.store.getById(id);         // CapturedMessage | undefined
```

## No dependencies

`@mailts/trap` has zero runtime dependencies — it is a standalone Node.js SMTP server built on the standard library. No peer dependencies required.


---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

Part of the [mailts](https://github.com/anishhs-gh/mailts) project.
