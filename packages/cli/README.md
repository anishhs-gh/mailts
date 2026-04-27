# @mailts/cli

Command-line interface for `@mailts/core` — configure, test connections, send mail, read your inbox, and manage the send queue from the terminal.

## Install

```bash
npm install -g @mailts/cli
# or run without installing:
npx @mailts/cli <command>
```

## Commands

### `configure`

Interactive wizard that writes SMTP/IMAP settings to `~/.mailts/config.json`.

```bash
mailts configure
```

### `test`

Opens a live SMTP connection, walks through the full handshake, and streams every protocol line to stdout.

```bash
mailts test --host smtp.gmail.com
mailts test --host smtp.gmail.com --port 465 --encryption SSL_TLS
MAILTS_PASSWORD=secret mailts test --host smtp.gmail.com --username me@gmail.com
```

| Option | Default | Description |
|---|---|---|
| `--host` | — | SMTP server hostname (required) |
| `--port` | `587` | TCP port |
| `--encryption` | `STARTTLS` | `STARTTLS` \| `SSL_TLS` \| `NONE` |
| `--username` | — | SMTP username |
| `--password` | — | SMTP password (prefer `MAILTS_PASSWORD` env var) |
| `--client-name` | `mailts.local` | Hostname sent in EHLO |

### `send`

Send a single email from the command line.

```bash
mailts send --to you@example.com --subject "Hello" --text "Hi there"
mailts send --to you@example.com --html ./email.html --attachments report.pdf,logo.png
mailts send --alias welcome --to newuser@example.com
```

| Option | Description |
|---|---|
| `--from` | Sender address (falls back to config) |
| `--to` | Recipient address |
| `--subject` | Subject line |
| `--text` | Plain-text body |
| `--html` | HTML body — file path or inline HTML string |
| `--attachments` | Comma-separated file paths |
| `--alias` | Trigger a predefined alias from config |

### `read`

Connect to IMAP, open a mailbox, and list messages.

```bash
mailts read
mailts read --unseen --limit 20
mailts read --mailbox "Sent"
```

| Option | Default | Description |
|---|---|---|
| `--mailbox` | `INBOX` | Mailbox to open |
| `--limit` | `10` | Max messages to show |
| `--unseen` | false | Show only unread messages |

### `queue`

Manage the in-process send queue.

```bash
mailts queue status          # print counters
mailts queue status --json   # machine-readable JSON
mailts queue drain           # block until queue is empty
mailts queue dlq list        # list dead-letter jobs
mailts queue dlq retry <id>  # re-enqueue a dead job
```

### `trap`

Start a local SMTP trap (requires `@mailts/trap`).

```bash
mailts trap
mailts trap --smtp-port 2525 --http-port 2080
mailts trap --persist
```

## Config files

Auto-loaded from two locations (merged in order):

1. `~/.mailts/config.json` — global defaults
2. `.mailtsrc` or `.mailtsrc.json` in the current directory — project overrides

`${ENV_VAR}` placeholders are expanded at load time:

```json
{
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "auth": { "type": "plain", "user": "me@gmail.com", "pass": "${SMTP_PASS}" }
  },
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "secure": true,
    "auth": { "type": "plain", "user": "me@gmail.com", "pass": "${IMAP_PASS}" }
  }
}
```

Run `mailts configure` to generate this file interactively.

## Examples

```bash
# Verify Gmail SMTP works
MAILTS_PASSWORD=abcd-efgh mailts test --host smtp.gmail.com --username me@gmail.com

# Send a quick email
mailts send --to friend@example.com --subject "Test" --text "It works"

# List last 5 unread messages
mailts read --unseen --limit 5

# Inspect and retry dead-letter jobs
mailts queue dlq list --json
mailts queue dlq retry <job-id>
```

## Peer dependency

Requires `@mailts/core >= 0.1.0`.

---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

Part of the [mailts](https://github.com/anishhs-gh/mailts) project.
