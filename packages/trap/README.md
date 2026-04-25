# @mailts/trap

Local SMTP trap for development — captures every outbound email your app sends and displays it in a web UI. No messages ever leave your machine.

## Install

```bash
npm install --save-dev @mailts/trap
```

## Programmatic usage

```ts
import { TrapServer } from '@mailts/trap';
import { MailTs } from '@mailts/core';

const trap = new TrapServer({
  smtpPort: 1025,  // point your app's SMTP config here
  httpPort: 1080,  // web UI + REST API
});

await trap.start();

// Point mailts (or any SMTP client) at the trap
const mail = new MailTs({
  smtp: { host: '127.0.0.1', port: 1025, pool: false },
});

await mail.send({
  from: 'app@example.com',
  to: 'user@example.com',
  subject: 'Hello',
  html: '<p>Hello!</p>',
});

// Open http://localhost:1080 to inspect captured emails

await trap.stop();
```

## CLI

```bash
# Start the trap server (SMTP :1025, UI :2080)
npx mailts-trap

# Custom ports
npx mailts-trap --smtp-port 2525 --http-port 2080

# Persist messages across restarts
npx mailts-trap --persist
npx mailts-trap --persist /var/mail/trap
```

## Web UI

Open `http://localhost:1080` (or your configured `httpPort`) to:

- Browse captured messages in the sidebar
- View HTML, plain-text, and raw headers per message
- Download attachments
- Delete individual messages or clear all
- Real-time updates via Server-Sent Events (no polling)

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
  persist: true,            // persist to .mailts-trap/ in cwd
  persist: '/path/to/dir',  // or a custom directory
});
```

## Peer dependency

Requires `@mailts/core >= 0.1.0` as a peer dependency when used with the `@mailts/core` client. Works with any SMTP client that can be configured to point at `localhost`.


---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

Part of the [mailts](https://github.com/anishhs-gh/mailts) project.
