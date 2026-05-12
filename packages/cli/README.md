# @mailts/cli

Command-line interface for `@mailts/core` — configure, test connections, send mail, read your inbox, and manage the send queue from the terminal.

## Install

```bash
npm install -g @mailts/cli
```

Once installed, the `mailts` command is available globally.

## Commands

### `configure`

Interactive wizard that writes SMTP/IMAP settings to a config file.

```bash
mailts configure           # writes to ~/.mailts/config.json  (global)
mailts configure --local   # writes to .mailtsrc in the current directory (project-local)
```

| Option | Description |
|---|---|
| `--local` | Save to `.mailtsrc` in the current directory instead of `~/.mailts/config.json` |

Use `--local` when you want per-project SMTP settings committed alongside your code (without credentials — use `${ENV_VAR}` placeholders for secrets).

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
mailts send --host 127.0.0.1 --port 1025 --to you@example.com --text "trap test"
mailts send --alias welcome --to newuser@example.com
```

| Option | Description |
|---|---|
| `--host` | Override configured SMTP host (e.g. `127.0.0.1` for a local trap) |
| `--port` | Override configured SMTP port |
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

Manage the send queue. Requires `queue.persist` in config for cross-process commands (`cancel`, `interrupt`, `abort`) — the running app acts within 5 s.

```bash
mailts queue status                # print counters (pending/running/succeeded/dead/cancelled)
mailts queue status --json         # machine-readable JSON
mailts queue cancel <job-id>       # cancel a pending or running job
mailts queue interrupt <job-id>    # interrupt a running job — returns it to front of queue
mailts queue abort <job-id>        # abort a running job — counts as failed attempt
mailts queue drain                 # in-process only: block until queue is empty
mailts queue dlq list              # list dead-letter jobs
mailts queue dlq list --json       # machine-readable JSON
mailts queue dlq retry <id>        # re-enqueue a dead job
mailts queue dlq clear             # clear the dead-letter queue
```

| Subcommand | Needs `persist`? | Description |
|-----------|-----------------|-------------|
| `status` | Yes | Show queue counters |
| `cancel <id>` | Yes | Cancel pending or running job |
| `interrupt <id>` | Yes | Return running job to queue without counting the attempt |
| `abort <id>` | Yes | Force-fail running job; retry/DLQ apply |
| `drain` | — | In-process drain signal (informational only via CLI) |
| `dlq list` | Yes | List dead-letter jobs |
| `dlq retry <id>` | Yes | Re-enqueue a dead job |
| `dlq clear` | Yes | Clear the dead-letter queue |

### `trap`

Start a local SMTP trap (requires `@mailts/trap`).

```bash
mailts trap
mailts trap --smtp-port 2525 --http-port 2080
mailts trap --persist
mailts trap --persist /var/mail/trap   # custom persist directory
mailts trap --host 0.0.0.0            # bind all interfaces
mailts trap --no-open --quiet         # CI / scripted use
```

| Option | Default | Description |
|---|---|---|
| `--smtp-port` | `1025` | SMTP listen port |
| `--http-port` | `1080` | HTTP / UI listen port |
| `--host` | `127.0.0.1` | Bind address |
| `--max-messages` | `100` | Max messages kept in memory |
| `--persist [dir]` | — | Persist to disk; omit `dir` for `.mailts-trap/` in cwd |
| `--no-open` | `false` | Skip auto-opening the browser |
| `--quiet` | `false` | Suppress startup output |

Once running, open `http://localhost:1080` to inspect captured mail. The trap also exposes a REST API for scripted access — see [`@mailts/trap`](https://www.npmjs.com/package/@mailts/trap) for the full API reference.

> `mailts read` connects to IMAP and cannot read from the trap server.

## Config files

Auto-loaded from two locations (merged in order, local wins):

| Location | Purpose |
|---|---|
| `~/.mailts/config.json` | Global defaults — shared across all projects |
| `.mailtsrc` or `.mailtsrc.json` in cwd | Project-local overrides — check into your repo |

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

Generate interactively:

```bash
mailts configure          # global  → ~/.mailts/config.json
mailts configure --local  # project → .mailtsrc in current directory
```

## Examples

```bash
# Set up global SMTP config interactively
mailts configure

# Set up project-local SMTP config (writes .mailtsrc in current directory)
mailts configure --local

# Verify Gmail SMTP works
MAILTS_PASSWORD=abcd-efgh mailts test --host smtp.gmail.com --username me@gmail.com

# Send a quick email
mailts send --to friend@example.com --subject "Test" --text "It works"

# List last 5 unread messages
mailts read --unseen --limit 5

# Inspect and retry dead-letter jobs
mailts queue dlq list --json
mailts queue dlq retry <job-id>

# Start a local SMTP trap (requires @mailts/trap)
mailts trap
mailts trap --smtp-port 2525 --http-port 8080 --no-open
```

## Peer dependencies

| Package | Version | Required |
|---------|---------|----------|
| `@mailts/core` | `>=0.1.0` | Yes |
| `@mailts/trap` | `>=0.1.0` | No — only needed for `mailts trap` |

---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

Part of the [mailts](https://github.com/anishhs-gh/mailts) project.
