# @mailts/core

Modern TypeScript mail library — native SMTP/IMAP over Node.js built-ins, zero runtime dependencies.

```
npm install @mailts/core
```

Requires Node.js 22+ (SQLite queue persistence needs 22.13+). Upgrading from 0.4? See [MIGRATION.md](MIGRATION.md).

## Features

- **Native SMTP** — STARTTLS (required before AUTH by default), AUTH PLAIN / LOGIN / XOAUTH2, PIPELINING, SMTPUTF8, partial-recipient reporting, connection pool
- **Native IMAP** — byte-exact protocol parser, automatic mailbox selection and reconnection, full MIME parsing (multipart, inline attachments, forwarded messages, RFC 2231/2047, charset-aware), BODYSTRUCTURE selective fetch, search (incl. non-ASCII), MOVE/COPY/APPEND, CONDSTORE, `watch()` push by UID, special-use mailboxes, internationalised mailbox names, per-account connection pool (`ImapPool`) for multi-tenant servers
- **OAuth 2.0** — Gmail / Google Workspace and Microsoft 365 / Outlook.com: browser sign-in (PKCE, loopback for CLIs), token refresh with rotation, `getToken` hook — `@mailts/core/oauth`
- **HTTP transports** — Resend, SendGrid, Mailgun, Postmark, Amazon SES, **Microsoft Graph**, **Gmail API** (all zero-dep), with retryable rate-limit/outage errors
- **One mailbox API for IMAP, Microsoft Graph and the Gmail API** — read, search, flag, move, draft and watch with the same code
- **Reply / forward builders** — threading, reply-all, quoting, forward inline or as attachment
- **Bulk-sender ready** — List-Unsubscribe + one-click (RFC 8058), queue rate limits, idempotency keys
- **DKIM signing** — rsa-sha256, relaxed/relaxed canonicalization, configurable signed headers
- **iCal invites** — attach calendar invites (`text/calendar`) with attendees, RSVP, timezone
- **Smart inbox content** — schema.org JSON-LD builders (orders, parcel tracking, reservations, inbox actions, Gmail Promotions), AMP for Email, Outlook Actionable Messages; OTP and BIMI guides
- **HTML to text** — auto-generated plain-text fallback from HTML body
- **Queue + DLQ** — priority queue, scheduled sends, exponential backoff + jitter, dead-letter queue, shutdown that never drops mail, crash-safe SQLite persistence with multi-process leases (Node 22.13+), external queue drivers (Postgres multi-instance example)
- **Health checks** — SMTP + IMAP probe with latency measurement; ready for K8s liveness/readiness endpoints
- **Telemetry hooks** — zero-dependency observability; inject metrics/alerting callbacks for send, error, and queue events
- **Streaming logs** — structured `LogEvent` stream, pluggable log sinks, full protocol trace (credentials auto-redacted)
- **Aliases & templates** — define reusable email configs, plug in any template engine
- **Middleware** — transform every outbound message in a pipeline
- **Config file** — auto-loaded from `.mailtsrc` / `~/.mailts/config.json`, `${ENV_VAR}` expansion
- **Security** — sealed `Credential` value object, encoded/validated headers (no injection via subjects, names, filenames or content types), IMAP/SMTP command-injection guards, `requireTLS`, local file attachments off by default (`attachmentPolicy`), prototype-pollution-safe config parser
- **Zero runtime deps** — only `node:net`, `node:tls`, `node:crypto`, `node:stream`, `node:http`, `node:https`

---

## Quick start

```ts
import { MailTs } from '@mailts/core';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env.SMTP_PASS },
  },
});

const result = await mail.send({
  from: 'you@gmail.com',
  to: 'friend@example.com',
  subject: 'Hello',
  text: 'Sent with mailts!',
});

if (result.ok) {
  console.log('Delivered:', result.messageId);
} else {
  console.error('Failed:', result.error.message);
}
```

---

## Configuration

### Constructor options

```ts
new MailTs({
  smtp: SmtpConfig,    // SMTP transport
  imap: ImapConfig,    // IMAP reader
  queue: QueueOptions, // Send queue behaviour
  logger: LoggerOptions,
  devMode: boolean,    // Log but never transmit (useful in dev/CI)
})
```

### Auto-loading

If no config is passed to `new MailTs()`, it automatically merges:

1. `~/.mailts/config.json` — global defaults
2. `.mailtsrc` or `.mailtsrc.json` in the current working directory — project overrides

`${ENV_VAR}` placeholders in config files are expanded at load time.

```json
{
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "auth": { "type": "plain", "user": "me@gmail.com", "pass": "${SMTP_PASS}" }
  }
}
```

### Timeout options

Both `SmtpConfig` and `ImapConfig` accept:

| Option | Default | Description |
|---|---|---|
| `connectionTimeout` | `10_000` ms | Time to complete the TCP/TLS handshake |
| `socketTimeout` | `30_000` ms | Time to receive a server reply; idle socket timeout |

```ts
const mail = new MailTs({
  smtp: {
    host: 'smtp.example.com',
    connectionTimeout: 5_000,  // fail fast if unreachable
    socketTimeout: 60_000,     // allow large messages extra time
  },
});
```

---

## Sending mail

### Basic send

```ts
await mail.send({
  from: 'sender@example.com',
  to: ['a@example.com', { email: 'b@example.com', name: 'Bob' }],
  cc: 'cc@example.com',
  subject: 'Hello',
  text: 'Plain text fallback',
  html: '<p>HTML body</p>',
  attachments: [
    { filename: 'report.pdf', path: './report.pdf' },  // needs attachmentPolicy — see Security
    { filename: 'inline.png', content: buffer, cid: 'logo@mailts' },
  ],
  headers: { 'X-Priority': '1' },
  priority: 'high',       // 'high' | 'normal' | 'low'
  replyTo: 'other@example.com',
});
```

### Inline attachments (CID)

Reference attachments by `cid` in your HTML. mailts wraps them in `multipart/related` automatically.

```ts
await mail.send({
  from: 'sender@example.com',
  to: 'user@example.com',
  subject: 'Logo email',
  html: '<img src="cid:company-logo">',
  attachments: [
    { filename: 'logo.png', content: logoBuffer, contentType: 'image/png', cid: 'company-logo' },
  ],
});
```

### iCal invites

Attach a calendar invite to any message. The `ical` field maps to RFC 5545 `VEVENT` properties.

```ts
await mail.send({
  from: 'organizer@example.com',
  to: 'attendee@example.com',
  subject: 'Team Sync',
  text: 'You have been invited.',
  ical: {
    summary: 'Team Sync',
    // Use local Date constructor — the wall-clock values are treated as the specified timezone.
    // Recipients in other timezones automatically see the equivalent local time.
    start: new Date(2024, 5, 1, 14, 0, 0),  // 2:00 PM
    end:   new Date(2024, 5, 1, 15, 0, 0),  // 3:00 PM
    timezone: 'America/New_York',            // or Intl.DateTimeFormat().resolvedOptions().timeZone
    organizer: { name: 'Alice', email: 'alice@example.com' },
    attendees: [
      { email: 'bob@example.com', name: 'Bob', rsvp: true },
    ],
    location: 'Conference Room A',
    description: 'Weekly sync',
    method: 'REQUEST',    // REQUEST | CANCEL | REPLY | COUNTER
  },
});
```

### Forwarded / embedded messages

Attach a raw RFC 5322 message as `message/rfc822`:

```ts
await mail.send({
  from: 'you@example.com',
  to: 'boss@example.com',
  subject: 'FWD: Important email',
  text: 'See forwarded message below.',
  attachments: [
    { filename: 'original.eml', rfc822: rawMessageBuffer },
  ],
});
```

### HTML auto-text

When only `html` is provided (no `text`), mailts automatically generates a plain-text fallback using the built-in HTML-to-text converter. You can always pass an explicit `text` to override.

### Reply type

```ts
const result = await mail.send({ ... });

if (result.ok) {
  result.messageId  // string — SMTP accepted message-id
  result.accepted   // string[] — accepted recipients
  result.rejected   // string[] — rejected recipients
} else {
  result.error      // MailTsError with .code and .retryable
}
```

### Replying and forwarding

`buildReply()` / `buildForward()` turn a fetched (or parsed) message into ready-to-send `EmailOptions`:
`Re:`/`Fwd:` subjects (localized prefixes stripped), reply / reply-all recipients (honours `Reply-To`, drops your
own addresses), `In-Reply-To` + `References` so it stays in the thread, and quoting.

```ts
import { buildReply, buildForward } from '@mailts/core';

const [orig] = await session.fetch({ uids: [uid], bodies: true, headers: ['References'] });
await mail.send(buildReply(orig, { from: 'me@x.com', text: 'Thanks!', replyAll: true }), { saveToSent: true });

// Forward inline (original attachments and inline images carried over)…
await mail.send(buildForward(orig, { from: 'me@x.com', to: 'boss@x.com', text: 'FYI' }));
// …or attach the untouched original
await mail.send(buildForward(orig, { from: 'me@x.com', to: 'boss@x.com', mode: 'attachment', raw: await session.fetchRaw(uid) }));
```

### Unsubscribe headers (bulk senders)

Gmail and Yahoo require one-click unsubscribe from bulk senders. `unsubscribe` adds `List-Unsubscribe` and
`List-Unsubscribe-Post`; both are DKIM-signed by default (required for one-click to be honoured).

```ts
await mail.send({ ...newsletter, unsubscribe: { url: `https://app.com/u/${token}`, mailto: 'unsubscribe@app.com' } });

// In your endpoint (providers POST "List-Unsubscribe=One-Click"):
import { isOneClickUnsubscribe } from '@mailts/core';
if (isOneClickUnsubscribe({ method: req.method, contentType: req.headers['content-type'], body })) { /* unsubscribe */ }
```

### Smart inbox features

Mail clients can show more than the body: purchase and tracking cards, buttons in the inbox list, deal badges,
live AMP content, approval cards, a "copy code" chip, a brand logo. Clients that don't support a feature show
the normal html, so it is always safe to add. Full example: [`rich-inbox-email.ts`](examples/rich-inbox-email.ts).

| Feature | mailts | Shown by | Sender needs |
|---|---|---|---|
| Calendar invite card | `ical` | Almost every client | — |
| Unsubscribe button | `unsubscribe` | Gmail, Apple Mail, Outlook, Yahoo | — |
| Order, parcel tracking, reservation cards; inbox buttons | `structuredData` + `schemaOrg.*` | Gmail | SPF/DKIM pass; Google sender registration for most types |
| Promotions deal badge / image card | `schemaOrg.discountOffer` / `promotionCard` | Gmail Promotions tab | SPF/DKIM pass |
| Live, interactive content | `amp` | Gmail, Yahoo, Mail.ru | Registration with each provider |
| Approve / reject cards | `adaptiveCard` | Outlook, Microsoft 365 | `originator` id from Microsoft |
| "Copy code" / code AutoFill | content only — see [OTP emails](#otp--verification-code-emails) | Gmail, Apple Mail, Outlook mobile | — |
| Brand logo next to the sender | DNS — see [BIMI](#bimi-brand-logo) | Gmail, Apple Mail, Yahoo | DMARC enforcement (+ certificate) |

**schema.org (JSON-LD).** `structuredData` takes one node or an array; it is rendered into the html `<head>`
(escaped, kept out of the generated plain text) for SMTP and every HTTP transport.

```ts
import { schemaOrg } from '@mailts/core';

await mail.send({
  to, subject: 'Your Acme order #1234', html,
  structuredData: [
    schemaOrg.order({ merchant: 'Acme', orderNumber: '1234', price: 39.9, priceCurrency: 'EUR', status: 'processing',
      items: [{ name: 'Coffee mug', quantity: 2 }] }),
    schemaOrg.viewAction({ url: 'https://shop.example/orders/1234', name: 'View order' }),
  ],
});
```

Builders: `order`, `parcelDelivery`, `flightReservation`, `lodgingReservation`, `eventReservation`,
`foodReservation`, `viewAction`, `discountOffer`, `promotionCard` — each validates its required fields and accepts
`extra` for provider-specific properties. Any other type can be passed as a raw `{ '@type': … }` node. Check
markup with Google's Email Markup Tester before registering.

**AMP for Email.** `amp` adds a `text/x-amp-html` part between the text and html parts (html stays the fallback).
It must be an AMP document (`<html ⚡4email>`) and needs `html`. SMTP, SES, Mailgun, the Gmail API and SendGrid
carry it; Resend and Postmark reject it instead of dropping it silently.

**Outlook Actionable Messages.** `adaptiveCard` takes an Adaptive Card (`type: 'AdaptiveCard'`) with your
registered `originator` id and renders it into the html `<head>`.

### OTP / verification code emails

There is no markup for one-time codes — Gmail ("Copy code"), Apple Mail (code AutoFill on iOS/macOS) and Outlook
mobile detect them from the content. Make detection reliable ([`otp-email.ts`](examples/otp-email.ts)):

- put the code in the subject next to the word "code": `483920 is your Acme verification code`
- one code per email, and no other long numbers nearby (order ids, phone numbers)
- keep a plain-text part (generated from html automatically) and a short, single-purpose message
- state the expiry; never put the code only in a link or an image
- generate codes with `crypto.randomInt`, not `Math.random`

The `@domain #code` format (WebOTP) is for SMS only and has no effect in email.

### BIMI (brand logo)

BIMI shows your logo next to the sender name. It is set up in DNS, not in the message:

1. **Authenticate and enforce:** SPF and DKIM aligned with your From domain (`smtp.dkim` in mailts) and DMARC at
   `p=quarantine` or `p=reject`.
2. **Logo:** a square SVG in the SVG Tiny PS profile, served over HTTPS.
3. **Certificate:** Gmail and Apple Mail require a Verified Mark Certificate (VMC, needs a registered trademark);
   Gmail also accepts a Common Mark Certificate (CMC). Requirements change — check each provider.
4. **DNS record** (TXT at `default._bimi.<your domain>`):

```
v=BIMI1; l=https://example.com/bimi/logo.svg; a=https://example.com/bimi/vmc.pem
```

---

## HTTP transports

For API-based delivery services, use a transport instead of SMTP:

```ts
import { ResendTransport } from '@mailts/core/transports';

const mail = new MailTs({
  transport: new ResendTransport({ apiKey: process.env.RESEND_API_KEY }),
});
```

Available transports:

| Transport | Import |
|---|---|
| Resend | `ResendTransport` |
| SendGrid | `SendGridTransport` |
| Mailgun | `MailgunTransport` |
| Postmark | `PostmarkTransport` |
| Amazon SES (HTTP) | `SesTransport` |
| Microsoft Graph | `GraphTransport` |
| Gmail API | `GmailTransport` |

All transports implement the same `Transport` interface, so you can swap them without changing your send code.
Provider errors are `TransportError`s: 408/429/5xx are retryable (the queue waits for `Retry-After`), 401/403 are
`EAUTH`, other 4xx `EREJECT`. JSON-API transports forward threading and unsubscribe headers.

**Graph and Gmail API** send the MIME mailts built (attachments, threading, DKIM-independent headers intact) using
an OAuth `getToken` provider — useful when a Microsoft 365 tenant disables SMTP AUTH, or for Gmail's higher quotas:

```ts
import { GraphTransport, GmailTransport } from '@mailts/core';
import { microsoft, microsoftTokenProvider } from '@mailts/core/oauth';

const getToken = microsoftTokenProvider({ provider: microsoft({ api: 'graph-send' }), clientId, refreshToken });
const mail = new MailTs({ transport: new GraphTransport({ user: 'me@contoso.com', getToken }) });
// Gmail: new GmailTransport({ user: 'me@gmail.com', getToken }) with a Gmail API scope
```

`GraphTransport` and `GraphMailbox` are **experimental** (tested against a mock Graph API, not yet a live tenant).

---

## DKIM signing

```ts
const mail = new MailTs({
  smtp: { ... },
  dkim: {
    domainName: 'example.com',
    keySelector: 'mail',
    privateKey: process.env.DKIM_PRIVATE_KEY,
    // headerFieldNames: ['from','to','subject','date','message-id'], // optional override
  },
});

// Every outbound message is automatically signed
await mail.send({ ... });
```

Or sign a raw buffer directly:

```ts
import { signDkim } from '@mailts/core';

const signed = signDkim(rawBuffer, {
  domainName: 'example.com',
  keySelector: 'mail',
  privateKey: privateKeyPem,
});
```

---

## OAuth (Google & Microsoft)

Password login is disabled for most Microsoft 365 tenants and discouraged by Google. Use XOAUTH2 with a
`getToken` provider — it is called on every (re)connect, and once more with `invalid: true` when the server
rejects a token, so expired tokens are refreshed transparently.

```ts
import { MailTs } from '@mailts/core';
import { google, microsoft, googleTokenProvider, mailConfigFor } from '@mailts/core/oauth';

const getToken = googleTokenProvider({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  refreshToken: await keychain.get('refresh-token'),
});

const mail = new MailTs(mailConfigFor(google, { user: 'me@gmail.com', getToken }));
```

**Signing in (CLI / desktop)** — opens the browser, receives the redirect on `127.0.0.1`, exchanges the code with PKCE:

```ts
import { authorizeWithLoopback, microsoft, microsoftTokenProvider } from '@mailts/core/oauth';

const tokens = await authorizeWithLoopback({
  provider: microsoft(),                       // tenant: 'common' | 'organizations' | 'consumers' | <id>
  clientId: process.env.MS_CLIENT_ID!,
  onAuthUrl: (url) => process.stderr.write(`Open ${url}\n`),   // also opens the browser by default
});
await keychain.set('refresh-token', tokens.refreshToken!);

const getToken = microsoftTokenProvider({
  clientId: process.env.MS_CLIENT_ID!,
  refreshToken: tokens.refreshToken!,
  onRefreshToken: (rt) => keychain.set('refresh-token', rt),   // Microsoft rotates refresh tokens
});
```

**Web apps / backends** use the same pieces with their own redirect: `createPkce()`, `createState()`,
`buildAuthorizationUrl()`, then `exchangeCode()` in the callback; store the refresh token (encrypted) per user and
build a `createTokenProvider()` when you need the mailbox. Use a Google "Web application" client (Microsoft: "Web"
platform) and register the exact callback URI — see [`examples/oauth-web-server.ts`](examples/oauth-web-server.ts). `refreshAccessToken()` throws
`OAuthError` with `oauthCode: 'invalid_grant'` when the user has to sign in again.

| Provider | IMAP | SMTP | Scopes |
|---|---|---|---|
| `google` | imap.gmail.com:993 | smtp.gmail.com:465 | `https://mail.google.com/` (restricted scope — needs Google verification for public apps) |
| `microsoft()` | outlook.office365.com:993 | smtp.office365.com:587 (STARTTLS) | `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` |

A static `auth: { type: 'xoauth2', user, token }` still works when you manage tokens yourself.

**Scopes per API:** one Microsoft token serves one API — use `microsoft()` for IMAP/SMTP and
`microsoft({ api: 'graph' })` for Graph. `SCOPES` and `googleWith(SCOPES.google.send)` cover narrower Google scopes.

**Organisation-wide (app-only) access** — an admin authorises the app once and your backend uses any mailbox,
no user sign-in:

```ts
import { googleServiceAccountProvider, microsoftAppOnlyProvider } from '@mailts/core/oauth';

// Google Workspace: service account with domain-wide delegation
const google = googleServiceAccountProvider({ credentials: serviceAccountJson, subject: 'support@company.com' });

// Microsoft 365: client credentials (secret or certificate); api: 'graph' for Graph
const ms = microsoftAppOnlyProvider({ tenant: 'contoso.com', clientId, certificate: { privateKey, thumbprint } });

new MailTs({ imap: { host: 'outlook.office365.com', port: 993, secure: true,
                     auth: { type: 'xoauth2', user: 'support@contoso.com', getToken: ms } } });
```

Admin setup steps are in the TSDoc of each function. The Microsoft app-only path is **experimental** (not yet
verified on a live tenant).

---

## IMAP

`ImapSession` automatically selects the correct mailbox before each operation and connects lazily. When the
connection drops, the next call reconnects, re-authenticates and re-selects (`reconnect: { retries, delayMs }`,
or `false`); an operation in flight at the moment of the drop rejects with a retryable `ImapConnError` rather
than being replayed. `mail.imap` returns a **new** session on every access — keep a reference and reuse it.

```ts
const mail = new MailTs({
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env.IMAP_PASS },
  },
});

const session = mail.imap;
await session.connect();

// Fetch unread messages — auto-selects INBOX
const messages = await session.fetch({ seen: false, limit: 10, bodies: true });

// Fetch from a specific mailbox — auto-selects that mailbox
const sent = await session.fetch({ mailbox: 'Sent', limit: 5 });

// Concurrent operations on different mailboxes are safely serialized
const [inbox, drafts] = await Promise.all([
  session.fetch({ mailbox: 'INBOX' }),
  session.fetch({ mailbox: 'Drafts' }),
]);

await session.close();
```

### Fetch modes

| Mode | Option | What transfers | Use when |
|---|---|---|---|
| Headers only | _(default)_ | Envelope, flags, size | Inbox listing |
| Full message | `bodies: true` | Complete RFC 822 message (`BODY.PEEK[]`) | Need body + attachments |
| Extra headers | `headers: ['References']` | Named header fields | Threading without the body |
| Text only | `textOnly: true` | BODYSTRUCTURE + text/html sections | Reading body, skipping attachments |
| Structure only | `structure: true` | BODYSTRUCTURE metadata tree | Attachment listing without downloading |

Fetching never marks messages as read — pass `markSeen: true` to set `\Seen`.

```ts
// Full body — text, html, and attachment bytes
const msgs = await session.fetch({ uids: [1, 2, 3], bodies: true });
console.log(msgs[0].body?.text);
console.log(msgs[0].body?.attachments[0]?.filename);

// Text only — bandwidth-efficient for large messages
const msgs = await session.fetch({ seen: false, textOnly: true });
console.log(msgs[0].body?.text);   // populated
console.log(msgs[0].structure);    // BodyNode tree available

// Structure only — list attachment names without downloading content
const msgs = await session.fetch({ uids: [5], structure: true });
const tree = msgs[0].structure!;
```

### BODYSTRUCTURE — selective section fetch

```ts
import type { BodyLeaf, BodyMultipart } from '@mailts/core';

// Get the MIME tree for a single message
const tree = await session.fetchStructure(uid);

// Fetch a specific section as raw bytes
const bytes = await session.fetchSection(uid, '2');   // e.g. the HTML part

// Fetch text/plain + text/html parts only (no attachment bytes transferred)
const [msg] = await session.fetchText([uid]);
console.log(msg.body?.text);
console.log(msg.body?.html);
console.log(msg.structure);   // full BodyNode tree
```

`BodyNode` is either a `BodyLeaf` (single part) or `BodyMultipart` (container):

```ts
function printTree(node: BodyNode, indent = 0): void {
  const prefix = ' '.repeat(indent * 2);
  if (node.type === 'leaf') {
    console.log(`${prefix}[${node.section}] ${node.contentType} (${node.size}B) enc=${node.encoding}`);
    if (node.filename) console.log(`${prefix}    filename: ${node.filename}`);
  } else {
    console.log(`${prefix}${node.contentType}`);
    for (const child of node.parts) printTree(child, indent + 1);
  }
}
```

### Search

```ts
// Full criteria search — returns UIDs
const uids = await session.search({
  from: 'boss@example.com',
  unseen: true,
  since: new Date('2025-01-01'),
  subject: 'report',
});

const messages = await session.fetch({ uids, textOnly: true });
```

### Parsed MIME body

When `bodies: true` or `textOnly: true`, `message.body` is populated:

```ts
const [msg] = await session.fetch({ uids: [1], bodies: true });

msg.body?.text          // string | undefined — decoded plain text
msg.body?.html          // string | undefined — decoded HTML

// Attachments
for (const att of msg.body?.attachments ?? []) {
  att.filename          // decoded filename (RFC 2047 encoded names supported)
  att.contentType       // "application/pdf", "image/png", …
  att.size              // byte size
  att.content           // Buffer — raw bytes
  att.inline            // true for Content-Disposition: inline parts
  att.contentId         // bare Content-ID for cid: references in HTML

  // Forwarded / bounced email (message/rfc822)
  if (att.contentType === 'message/rfc822') {
    att.nestedMessage?.envelope.subject   // subject of the forwarded message
    att.nestedMessage?.body?.text         // decoded body of the nested message
  }
}
```

Charset decoding is handled automatically. ISO-8859-1, ISO-8859-2…16, Windows-1250…1258, ISO-2022-JP, GBK, Big5, EUC-KR and all other WHATWG Encoding Standard charsets are decoded correctly via Node.js built-in `TextDecoder` — no additional dependencies.

### Explicit selection

Call `open()` when you need a fresh mailbox snapshot (EXISTS, UIDNEXT, HIGHESTMODSEQ, …):

```ts
const status = await session.open('INBOX');
console.log(status.exists, 'messages,', status.unseen, 'unseen');

// Read-only (EXAMINE) — flag changes not allowed while open
const roStatus = await session.openReadOnly('Archive');

// STATUS without selecting
const counts = await session.getStatus('INBOX', ['MESSAGES', 'UNSEEN']);
```

### Flag operations

```ts
await session.markSeen([101, 102, 103]);
await session.markUnseen([104], 'Sent');
await session.markFlagged([105]);
await session.markUnflagged([105]);
await session.setFlags([106], ['\\Answered'], true);
```

### Copy, move, delete

```ts
// Move from INBOX to Archive (uses MOVE extension when available, falls back to COPY+DELETE)
await session.move([101, 102], 'Archive');

// Copy without removing
await session.copy([103], 'Backup', 'Sent');

// Delete (marks \\Deleted + EXPUNGE)
await session.delete([104]);

// Expunge without deleting
await session.expunge('INBOX');
```

### Append (save to Sent / Drafts)

```ts
// Build from EmailOptions and upload — no selected mailbox needed
await session.appendMessage('Drafts', { from, to, subject: 'Draft', text: '…' }, ['\\Draft']);

// Raw bytes
await session.append('Sent', rawMessageBuffer, ['\\Seen'], new Date());

// Find special-use mailboxes (RFC 6154, with common-name fallback)
const sent = await session.findMailbox('\\Sent');

// Full raw source of a message (for forwarding or parseMessage())
const raw = await session.fetchRaw(uid);
```

Many providers (unlike Gmail) do not store SMTP-sent mail. `send()` can do it for you, appending the exact bytes that were sent:

```ts
await mail.send(options, { saveToSent: true });      // SPECIAL-USE \Sent, or pass a mailbox name
await mail.saveToSent(options, { mailbox: 'Sent' }); // standalone
const built = await mail.build(options);             // raw RFC 5322 bytes without sending
```

### CONDSTORE — incremental sync

```ts
const status = await session.open('INBOX');
const highestModSeq = status.highestModSeq ?? 0;

// Later — fetch only messages changed since last sync
const changed = await session.fetchChanged(highestModSeq, 'INBOX');
```

### Mailbox management

```ts
const mailboxes = await session.listMailboxes();
const subscribed = await session.listSubscribed();

await session.createMailbox('Projects/Alpha');
await session.renameMailbox('Projects/Alpha', 'Projects/Beta');
await session.deleteMailbox('Projects/Beta');

await session.subscribe('Newsletter');
await session.unsubscribe('Newsletter');
```

### Watching for new mail

`watch()` runs IDLE (or NOOP polling when IDLE is unsupported) on a **dedicated connection**, reports new
messages by **UID**, reconnects automatically and catches up on anything missed while disconnected.

```ts
const watcher = await session.watch('INBOX');
watcher.on('new', async (uids) => {
  const msgs = await session.fetch({ uids, textOnly: true });
});
watcher.on('expunge', (seq) => { /* removed */ });
watcher.on('reset', () => { /* UIDVALIDITY changed — resync */ });

await watcher.stop();
```

The older `session.idle(cb)` / `stopIdle()` still work and now deliver `{ uid }`.

### Connection pool (multi-tenant servers)

Servers that act on many mailboxes (APIs, MCP servers) should not log in per request. `ImapPool` keeps
authenticated sessions per account and lends each one to a single callback at a time:

```ts
import { ImapPool } from '@mailts/core';

const pool = new ImapPool({ maxPerAccount: 2, maxSessions: 200, idleTimeoutMs: 5 * 60_000 });

const unread = await pool.use(account.id, () => imapConfigFor(account), (session) =>
  session.fetch({ seen: false, limit: 20 }));

await pool.close(account.id); // sign-out / credentials changed — next use() logs in again
await pool.closeAll();        // shutdown
```

| Option | Default | |
|---|---|---|
| `maxPerAccount` | `1` | Parallel sessions per account (providers cap connections per mailbox) |
| `maxSessions` | `100` | Total; when full, the least recently used idle session is closed |
| `idleTimeoutMs` | 5 min | Log out unused sessions (`0` keeps them) |
| `acquireTimeoutMs` | 30 s | Waiting longer rejects with a retryable `ETIMEOUT` `ImapError` |

The config is only resolved when a session is opened, so it can be async (token lookup). A session whose
login failed is discarded. Watchers open their own connection — run them outside the pool.

---

## One mailbox API: IMAP, Microsoft Graph, Gmail API

`Mailbox` is a provider-neutral interface — write mail-handling code once and run it against any provider:

```ts
import { imapMailbox, GraphMailbox, GmailMailbox, type Mailbox } from '@mailts/core';

const boxes: Mailbox[] = [
  imapMailbox(mail.imap),                                        // any IMAP server
  new GraphMailbox({ user: 'me@contoso.com', getToken: msGraph }), // Microsoft 365 via Graph (experimental)
  new GmailMailbox({ user: 'me@gmail.com', getToken: gmailApi }),  // Gmail via the Gmail API
];

for (const box of boxes) {
  const unread = await box.fetch({ search: { seen: false, from: 'boss@x.com' }, limit: 10 });
  const [first] = await box.fetch({ ids: [unread[0].id], bodies: true });   // text, html, attachments
  await box.setSeen([first.id], true);
  await box.move([first.id], 'Archive');
  await box.append('Drafts', (await mail.build(reply)).raw, { draft: true });
  const watcher = await box.watch('INBOX');
  watcher.on('new', (ids) => { /* … */ });
}
```

Ids are strings (IMAP UID, Graph id, Gmail id); flags use IMAP names (`\Seen`, `\Flagged`, `\Draft`); folder
names like `INBOX`, `Sent`, `Drafts`, `Trash` resolve per provider (Gmail mailboxes are labels).
Provider limits: Graph `append()` creates drafts only; Graph and Gmail `watch()` poll (Graph receive time, Gmail
history) — push needs a public webhook / Pub/Sub topic.

---

## Queue

Use `mail.queue` for fire-and-forget sending with automatic retries, priority scheduling, and full lifecycle control.

```ts
const mail = new MailTs({
  smtp: { ... },
  queue: {
    concurrency: 5,             // parallel sends
    maxRetries: 3,              // retries per job
    retryDelay: 1_000,          // base delay (ms)
    retryBackoff: 'exponential',
    jitter: true,
    jobTimeout: 30_000,
    deadLetter: { enabled: true },
    defaultPriority: 'normal',  // 'critical' | 'high' | 'normal' | 'low'
  },
});

// Enqueue with optional priority
mail.queue.enqueue({ to: 'user@example.com', subject: 'Hi', text: 'Hello' });
mail.queue.enqueue({ to: 'vip@example.com',  subject: 'VIP', text: 'Hi!' }, { priority: 'critical' });

// Wait until all jobs finish
await mail.queue.drain();
```

### Priority scheduling

Jobs are processed in tier order: `critical` → `high` → `normal` → `low`. Within the same tier, FIFO ordering is preserved.

### Lifecycle control

```ts
// Play / pause
mail.queue.pause();             // stop dispatching new jobs (in-flight jobs finish)
mail.queue.play();              // resume — alias for resume()

// Cancel — remove permanently, no retry, no DLQ
mail.queue.cancel(jobId);       // pending or running job
mail.queue.cancelAll();         // all pending jobs; returns count

// Interrupt — return to front of queue, attempt counter NOT incremented
mail.queue.interrupt(jobId);    // running job only
mail.queue.interruptAll();

// Abort — count as a failed attempt; retry policy and DLQ apply
mail.queue.abort(jobId);        // running job only
mail.queue.abortAll();

// Scheduled send
mail.queue.enqueue(options, { sendAt: new Date(Date.now() + 3_600_000) });

// Graceful shutdown — never discards mail unless asked
await mail.shutdown();                                        // in-memory: deliver pending; persistent: keep for next start
await mail.shutdown({ timeoutMs: 10_000 });                   // bound the wait; stragglers go back to pending
await mail.queue.shutdown({ pending: 'cancel' });             // explicitly discard pending jobs
```

**Never send twice:** `enqueue(options, { idempotencyKey: 'order-42-receipt' })` returns the existing job for a
repeated key (within `idempotencyWindowMs`, default 7 days — persisted by the SQLite queue), and every queued job
gets a fixed Message-ID so a resend after a crash carries the same id.

**Rate limits** keep you under provider caps (over-limit jobs wait without holding a slot):

```ts
new MailTs({ smtp, queue: { rateLimit: { perMinute: 30, perDay: 10_000, by: 'sender', countRecipients: true } } });
```

Retries wait in a `scheduled` state and do not occupy a concurrency slot. `drain()` rejects (instead of
hanging) when the queue is paused with work left. Queued sends honour `devMode` and run middleware on a
fresh copy of the options for each attempt.

### Persistence

```ts
const mail = new MailTs({ smtp, queue: { persist: true } }); // ~/.mailts/queue.db (Node 22+)
```

Jobs keep their ids across restarts, a job enqueued before a crash is delivered exactly once, and several
processes can share one database file safely (each claims jobs with a lease). Attachments must be Buffers or
file paths — streams cannot be persisted. The same `encodeJob` / `decodeJob` codec is exported for
`QueueDriver` implementations.

SQLite leases only coordinate processes on **one disk**. For several instances (Cloud Run, Kubernetes), keep jobs
in a shared database and run a `MailWorker` per instance — see
[`queue-driver-postgres.ts`](examples/queue-driver-postgres.ts) (`FOR UPDATE SKIP LOCKED`, leases, cross-instance
idempotency keys; any Postgres incl. Cloud SQL).

### Queue events

```ts
mail.queue.on('success',     (job, result) => { ... });
mail.queue.on('retry',       (job, attempt, delay) => { ... });
mail.queue.on('dead',        (job) => { ... });
mail.queue.on('cancelled',   (job) => { ... });
mail.queue.on('interrupted', (job) => { ... });
```

### Stats

```ts
const { pending, scheduled, running, succeeded, dead, cancelled } = mail.queue.stats();
```

---

## MailWorker — external queue + lifecycle control

Use `MailWorker` when persistence lives outside your process (Redis, SQS, Cloud Tasks, BullMQ, database poll, …) but you still want full lifecycle control: play / pause / cancel / interrupt / abort.

Implement the `QueueDriver` interface for your backend — three methods — and pass it to `MailWorker`. Everything else is automatic.

```ts
import { MailWorker } from '@mailts/core';
import type { QueueDriver, DriverMessage } from '@mailts/core';

// ── 1. Implement your backend ─────────────────────────────────────────────
class RedisDriver implements QueueDriver {
  async dequeue(): Promise<DriverMessage | null> {
    const raw = await redis.brpoplpush('mail:pending', 'mail:inflight', 1);
    return raw ? JSON.parse(raw) : null;
  }
  async ack(id: string)  { await redis.lrem('mail:inflight', 1, id); }
  async nack(id: string) { await redis.lmove('mail:inflight', 'mail:dlq', 'LEFT', 'RIGHT'); }
}

// ── 2. Create the worker ──────────────────────────────────────────────────
const worker = new MailWorker(new RedisDriver(), {
  smtp: { host: 'smtp.example.com', port: 587, auth: { type: 'plain', user: '…', pass: '…' } },
  queue: { concurrency: 5, maxRetries: 3, defaultPriority: 'normal' },
});

worker.on('success',     (job) => console.log('sent',       job.id));
worker.on('dead',        (job) => console.error('dead',     job.id));  // nack called automatically
worker.on('cancelled',   (job) => console.log('cancelled',  job.id));
worker.on('interrupted', (job) => console.log('interrupted',job.id));

await worker.start();

// ── 3. Full lifecycle control ─────────────────────────────────────────────
worker.pause();              // stop pulling from Redis AND stop queue
worker.resume();             // restart both

worker.cancel(jobId);        // cancel a specific in-flight job
worker.interrupt(jobId);     // requeue at front, no penalty
worker.abort(jobId);         // force-fail → retry/DLQ

await worker.shutdown(5_000); // graceful drain, abort stragglers after 5 s
```

### How ack / nack work

| Event | Called | Meaning |
|---|---|---|
| `success` | `driver.ack(id)` | Remove from external queue |
| `dead` | `driver.nack(id, lastError)` | Move to external DLQ or delete |
| `cancelled` | `driver.cancel(id)` (falls back to `ack`) | Cancelled by the app; removed without sending |
| shutdown | `driver.release(id)` (optional) | Received but not started; hand back to other consumers now |

### QueueDriver interface

```ts
interface QueueDriver<T = EmailOptions> {
  dequeue(): Promise<DriverMessage<T> | null>;  // return null when idle (long-poll inside)
  ack(id: string): Promise<void>;
  nack(id: string, reason?: Error): Promise<void>;
  release?(id: string): Promise<void>;          // optional: unstarted message at shutdown
  cancel?(id: string): Promise<void>;           // optional: defaults to ack
}

interface DriverMessage<T = EmailOptions> {
  id: string;            // external message ID used for ack/nack
  data: T;               // EmailOptions payload
  priority?: JobPriority;
  idempotencyKey?: string;
}
```

Complete drivers: [`mail-worker-redis.ts`](examples/mail-worker-redis.ts) (Redis) and
[`queue-driver-postgres.ts`](examples/queue-driver-postgres.ts) (Postgres, many instances).

---

## Streaming logs

```ts
import { createWriteStream } from 'fs';

const mail = new MailTs({
  smtp: { ... },
  logger: {
    level: 'debug',
    format: 'pretty',
    protocol: true,  // include raw SMTP/IMAP protocol lines
  },
});

// Event listener
mail.logger.onEvent((e) => {
  if (e.level === 'error') process.stderr.write(e.message + '\n');
});

// Pipe to a file as newline-delimited JSON
mail.logger.stream({ format: 'json' }).pipe(createWriteStream('/tmp/mail.log'));

// Pretty-print to stdout
mail.logger.stream({ format: 'pretty' }).pipe(process.stdout);
```

All `AUTH` credentials are automatically scrubbed from the protocol trace before they reach any log sink.

---

## Aliases & templates

### Define a reusable alias

```ts
mail.define('welcome', {
  from: { email: 'welcome@example.com', name: 'Acme Team' },
  subject: 'Welcome, {{name}}!',
  template: 'Hi {{name}},\n\nYour account is ready.',
});

await mail.trigger('welcome', {
  to: 'newuser@example.com',
  data: { name: 'Alice' },
});
```

### Built-in template syntax

The built-in engine supports `{{variable}}` and dotted paths (`{{user.name}}`). Missing variables resolve to empty string.

### Custom template engine

```ts
import Handlebars from 'handlebars';

mail.setTemplateEngine({
  compile: (source) => Handlebars.compile(source),
  render:  (compiled, data) => (compiled as HandlebarsTemplateDelegate)(data),
});
```

---

## Middleware

```ts
// Runs before every send — can mutate EmailOptions
mail.use(async (msg, next) => {
  msg.headers = { ...msg.headers, 'X-Mailer': 'myapp/1.0' };
  await next();
});
```

---

## Connections & pool

By default mailts keeps a pool of persistent SMTP connections for reuse across sends. Call `shutdown()` before process exit to drain the pool cleanly.

```ts
smtp: {
  host: 'smtp.example.com',
  pool: {
    maxConnections: 5,   // max simultaneous connections
    maxMessages: 100,    // recycle connection after N messages
    idleTimeout: 60_000, // close idle connections after 60 s
  },
}
```

**Disable pooling** for scripts and CLIs — a fresh connection is opened and closed per send, so the process exits naturally with no `shutdown()` required:

```ts
const mail = new MailTs({
  smtp: { host: 'smtp.example.com', pool: false },
});

await mail.send({ ... });
// process exits automatically — no shutdown() needed
```

---

## Proxy support

Route SMTP/IMAP connections through a SOCKS5 or HTTP CONNECT proxy:

```ts
const mail = new MailTs({
  smtp: {
    host: 'smtp.example.com',
    proxy: { host: '127.0.0.1', port: 1080, type: 'socks5' },
  },
});
```

---

## Security for untrusted input

Attachments given by local `path` are **rejected unless you set `attachmentPolicy`**, so a message built from
untrusted input (AI agents, web forms) cannot attach `/etc/passwd` or `.env`. Pass `content` (Buffer/string) instead,
or opt in:

```ts
const mail = new MailTs({
  smtp,
  attachmentPolicy: { root: '/srv/uploads' },  // only files inside root — symlinks resolved, escapes rejected
  // attachmentPolicy: 'allow',                 // any path — trusted code only (scripts, CLIs)
});
// requireTLS defaults to true when authenticating (loopback hosts exempt); SMTP and IMAP
// refuse to send credentials if STARTTLS is missing.
```

The same policy applies to `mail.build()`, `saveToSent()`, `session.appendMessage()` and `ImapPool`. mailts never
fetches URLs, so attachment SSRF is not possible through it.

Header values, filenames, content types, IMAP flags, sequence sets and all addresses (From/To/Cc/Bcc/Reply-To)
are encoded or validated — malformed input is rejected with `MimeError` instead of being written to the wire.

**Hostile servers and messages:** IMAP responses are size-limited while they arrive (`imap.limits`: 64 MiB per
literal, 128 MiB per response, 1 MiB per line — exceeding one fails the command with `LimitError` and closes the
connection); `parseMessage(raw, { maxParts, maxHeaderBytes, maxDepth })` truncates (`truncated: true`) instead of
exhausting memory; SMTP replies are capped. TLS defaults to `minVersion: 'TLSv1.2'` (override via `tls`).

---

## Errors

All errors extend `MailTsError` and carry `.code` and `.retryable`:

```ts
import { SmtpAuthError, SmtpRejectError, SmtpConnError, ImapError } from '@mailts/core';

try {
  await mail.send({ ... });
} catch (e) {
  if (e instanceof SmtpAuthError) { /* bad credentials */ }
  if (e instanceof SmtpRejectError) { /* 5xx reject */ }
  if (e instanceof SmtpConnError && e.retryable) { /* transient */ }
}
```

| Class | Code | Retryable |
|---|---|---|
| `SmtpAuthError` | `EAUTH` | No |
| `SmtpRejectError` | `EREJECT` | No |
| `SmtpConnError` | `ECONN` | Yes |
| `SmtpTimeoutError` | `ETIMEOUT` | Yes |
| `ImapError` | `EIMAP` | varies |
| `ImapAuthError` | `EAUTH` | No |
| `ImapConnError` | `ECONN` | Yes |
| `OAuthError` | `EAUTH` | varies (`invalid_grant` = sign in again) |
| `QueueError` | `EQUEUE` | No |
| `TransportError` | `EAUTH` / `EREJECT` / `ECONN` | 408/429/5xx and network: yes (`retryAfterMs`) |
| `LimitError` | `ELIMIT` | No |
| `ConfigError` | `ECONFIG` | No |
| `MimeError` | `EMIME` | No |
| `TemplateError` | `ETEMPLATE` | No |

---

## Health checks

```ts
const result = await mail.health();
// {
//   smtp:      { ok: true,  latencyMs: 42 },
//   imap:      { ok: true,  latencyMs: 18 },
//   timestamp: '2026-05-06T10:00:00.000Z'
// }
```

Pings SMTP (EHLO + NOOP) and IMAP (connect + open INBOX), measures latency, and returns a structured result. Fields are omitted when the corresponding transport is not configured.

```ts
// K8s readiness probe
import http from 'http';
http.createServer(async (_req, res) => {
  const h = await mail.health();
  res.writeHead(h.smtp?.ok ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(h));
}).listen(8080);
```

---

## Telemetry hooks

Zero-dependency observability — inject callbacks without pulling in a metrics library:

```ts
const mail = new MailTs({
  smtp: { ... },
  telemetry: {
    onSend:           (opts, result, latencyMs) => metrics.histogram('mail.send', latencyMs),
    onError:          (err, phase) => logger.error({ phase, err }),
    onQueueEnqueue:   (job) => metrics.increment('queue.enqueued'),
    onQueueSuccess:   (job) => metrics.increment('queue.success'),
    onQueueDead:      (job) => alerting.fire(`Dead-letter: ${job.id}`),
    onQueueRetry:     (job, attempt, delay) => logger.warn({ attempt, delay }),
  },
});
```

All hooks are optional and fire synchronously after the event. Throwing inside a hook does not affect the send/queue operation.

---

## Dev mode

```ts
const mail = new MailTs({ smtp: { ... }, devMode: true });

// send() resolves immediately — nothing is transmitted
await mail.send({ ... });
```

---

## Examples

Runnable examples live in [`examples/`](examples) (run with `npx tsx examples/<file>.ts`; all are typechecked in CI):

| Example | Shows |
|---|---|
| [`basic-send.ts`](examples/basic-send.ts) | Plain-text + HTML send |
| [`oauth-cli.ts`](examples/oauth-cli.ts) | Google / Microsoft sign-in for CLIs, refresh-token storage, sign out |
| [`oauth-web-server.ts`](examples/oauth-web-server.ts) | "Connect your mailbox" web flow for hosted apps — read inbox, send, disconnect (`cp examples/.env.example examples/.env`, then `npm run example:oauth-web`) |
| [`oauth-test.mjs`](examples/oauth-test.mjs) | Interactive live test: sign in → read → send → log out, over IMAP/SMTP or the Gmail API (`node examples/oauth-test.mjs` after `npm run build`) |
| [`xoauth2.ts`](examples/xoauth2.ts) | XOAUTH2 SMTP + IMAP with automatic token refresh |
| [`oauth-app-only.ts`](examples/oauth-app-only.ts) | Organisation-wide access: Google service account / Microsoft client credentials |
| [`mailbox-any-provider.ts`](examples/mailbox-any-provider.ts) | One `Mailbox` code path for IMAP, Microsoft Graph and the Gmail API |
| [`newsletter-unsubscribe.ts`](examples/newsletter-unsubscribe.ts) | One-click unsubscribe, rate limits and idempotency for bulk sends |
| [`imap-read.ts`](examples/imap-read.ts) | Unread mail, full bodies, `watch()` for new mail |
| [`imap-pool.ts`](examples/imap-pool.ts) | Per-account IMAP connection pool for multi-tenant servers |
| [`imap-manage.ts`](examples/imap-manage.ts) | Flags, move, delete, drafts, CONDSTORE, mailbox management |
| [`reply-and-save-to-sent.ts`](examples/reply-and-save-to-sent.ts) | Threaded replies, save to Sent, drafts |
| [`parse-eml.ts`](examples/parse-eml.ts) | `parseMessage()` for `.eml` / raw messages |
| [`rich-inbox-email.ts`](examples/rich-inbox-email.ts) | Gmail order/parcel cards, inbox button, Promotions annotations, AMP, Outlook Adaptive Card |
| [`otp-email.ts`](examples/otp-email.ts) | Verification-code email that clients detect ("Copy code", AutoFill) |
| [`untrusted-input.ts`](examples/untrusted-input.ts) | `attachmentPolicy` and injection guards for AI agents / forms |
| [`queue-lifecycle.ts`](examples/queue-lifecycle.ts) | Priority, pause/resume, cancel/interrupt/abort, shutdown modes, `sendAt` |
| [`queue-persistence.ts`](examples/queue-persistence.ts) | Crash-safe SQLite queue |
| [`queue-and-dlq.ts`](examples/queue-and-dlq.ts) | Retries, dead-letter queue, telemetry |
| [`mail-worker-redis.ts`](examples/mail-worker-redis.ts) | External queue driver (Redis) with `MailWorker` |
| [`queue-driver-postgres.ts`](examples/queue-driver-postgres.ts) | Durable queue shared by many instances (Cloud Run, Kubernetes) on Postgres |
| [`attachments-and-inline.ts`](examples/attachments-and-inline.ts) · [`ical-invite.ts`](examples/ical-invite.ts) · [`cc-bcc-replyto.ts`](examples/cc-bcc-replyto.ts) | Message building |
| [`transports.ts`](examples/transports.ts) · [`dkim-and-proxy.ts`](examples/dkim-and-proxy.ts) · [`smtp-pool-config.ts`](examples/smtp-pool-config.ts) | Delivery options |
| [`middleware-and-devmode.ts`](examples/middleware-and-devmode.ts) · [`aliases-and-templates.ts`](examples/aliases-and-templates.ts) · [`streaming-logs.ts`](examples/streaming-logs.ts) · [`health-checks.ts`](examples/health-checks.ts) | App integration |
| [`trap-local-dev.ts`](examples/trap-local-dev.ts) · [`trap-testing.test.ts`](examples/trap-testing.test.ts) | Local dev and tests with `@mailts/trap` / `@mailts/testing` |

---

## Ecosystem

| Package | Description |
|---|---|
| [`@mailts/cli`](https://github.com/anishhs-gh/mailts/tree/main/packages/cli) | Terminal CLI — send mail, verify SMTP connections, manage the queue and DLQ from the command line |
| [`@mailts/trap`](https://github.com/anishhs-gh/mailts/tree/main/packages/trap) | Local SMTP trap — captures outbound emails in development and previews them in a web UI at `localhost:1080` |
| [`@mailts/testing`](https://github.com/anishhs-gh/mailts/tree/main/packages/testing) | Vitest helpers — `useTrapServer()` spins up a real in-process SMTP trap for integration tests, no mocks |

### Quick example with `@mailts/trap`

```ts
import { TrapServer } from '@mailts/trap';
import { MailTs } from '@mailts/core';

const trap = new TrapServer({ smtpPort: 1025, httpPort: 1080 });
await trap.start();

const mail = new MailTs({ smtp: { host: '127.0.0.1', port: 1025, pool: false } });
await mail.send({ from: 'app@example.com', to: 'dev@example.com', subject: 'Test', text: 'Hello!' });
// open http://localhost:1080 to inspect the captured email
```

### Quick example with `@mailts/testing`

```ts
import { useTrapServer } from '@mailts/testing';
import { MailTs } from '@mailts/core';

const { getTrap } = useTrapServer();

test('sends welcome email', async () => {
  const mail = new MailTs({ smtp: { host: '127.0.0.1', port: getTrap().smtpPort, pool: false } });
  await mail.send({ from: 'app@example.com', to: 'alice@example.com', subject: 'Welcome!', text: 'Hi' });

  const [msg] = getTrap().store.getAll();
  expect(msg!.subject).toBe('Welcome!');
});
```

### Quick example with `@mailts/cli`

```bash
npm install -g @mailts/cli

mailts configure                        # interactive SMTP/IMAP setup (global)
mailts configure --local                # write .mailtsrc in current directory
mailts test --host smtp.gmail.com       # verify connection
mailts send --to you@example.com --subject "Hi" --text "Hello"
mailts read --unseen --limit 5
mailts queue status
```

---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

---

## License

MIT
