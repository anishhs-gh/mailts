<!-- Generated from README.md by scripts/build-skill.mjs — do not edit by hand. -->

# Sending mail with mailts

Message options, attachments, calendar invites, replies, unsubscribe headers, smart inbox content, OTP and BIMI, DKIM, HTTP transports, SMTP pooling and proxies.

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
the normal html, so it is always safe to add. Full example: [`rich-inbox-email.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/rich-inbox-email.ts).

| Feature | mailts | Shown by | Sender needs |
|---|---|---|---|
| Calendar invite card | `ical` | Almost every client | — |
| Unsubscribe button | `unsubscribe` | Gmail, Apple Mail, Outlook, Yahoo | — |
| Order, parcel tracking, reservation cards; inbox buttons | `structuredData` + `schemaOrg.*` | Gmail | SPF/DKIM pass; Google sender registration for most types |
| Promotions deal badge / image card | `schemaOrg.discountOffer` / `promotionCard` | Gmail Promotions tab | SPF/DKIM pass |
| Live, interactive content | `amp` | Gmail, Yahoo, Mail.ru | Registration with each provider |
| Approve / reject cards | `adaptiveCard` | Outlook, Microsoft 365 | `originator` id from Microsoft |
| "Copy code" / code AutoFill | content only — see [OTP emails](https://github.com/anishhs-gh/mailts/blob/master/README.md#otp--verification-code-emails) | Gmail, Apple Mail, Outlook mobile | — |
| Brand logo next to the sender | DNS — see [BIMI](https://github.com/anishhs-gh/mailts/blob/master/README.md#bimi-brand-logo) | Gmail, Apple Mail, Yahoo | DMARC enforcement (+ certificate) |

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
mobile detect them from the content. Make detection reliable ([`otp-email.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/otp-email.ts)):

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

## HTTP transports

For API-based delivery services, use a transport instead of SMTP:

```ts
import { ResendTransport } from '@mailts/core/transports';

const mail = new MailTs({
  transport: new ResendTransport({ apiKey: process.env.RESEND_API_KEY! }),
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

## DKIM signing

```ts
const mail = new MailTs({
  smtp: {
    host: 'smtp.example.com',
    auth: { type: 'plain', user, pass },
    dkim: {
      domainName: 'example.com',
      keySelector: 'mail',                 // DNS TXT at mail._domainkey.example.com
      privateKey: process.env.DKIM_PRIVATE_KEY,
      // headerFieldNames: ['from','to','subject','date','message-id'], // optional override
    },
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

## Connections & pool

By default mailts keeps a pool of persistent SMTP connections for reuse across sends. Call `shutdown()` before process exit to drain the pool cleanly.

```ts
const mail = new MailTs({
  smtp: {
    host: 'smtp.example.com',
    pool: {
      maxConnections: 5,   // max simultaneous connections
      maxMessages: 100,    // recycle connection after N messages
      idleTimeout: 60_000, // close idle connections after 60 s
    },
  },
});
```

**Disable pooling** for scripts and CLIs — a fresh connection is opened and closed per send, so the process exits naturally with no `shutdown()` required:

```ts
const mail = new MailTs({
  smtp: { host: 'smtp.example.com', pool: false },
});

await mail.send({ ... });
// process exits automatically — no shutdown() needed
```

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
