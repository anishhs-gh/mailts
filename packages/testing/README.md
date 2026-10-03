# @mailts/testing

Vitest helpers for testing email-sending code with a real in-process SMTP trap — no mocks, no network.

## Install

```bash
npm install --save-dev @mailts/testing
```

Requires `vitest` and `@mailts/core` as peer dependencies.

## Setup

Add `globals: true` to your Vitest config (required for `beforeAll`/`afterAll` lifecycle hooks):

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true },
});
```

## Usage

```ts
import { useTrapServer } from '@mailts/testing';
import { MailTs } from '@mailts/core';

const trap = useTrapServer({ smtpPort: 2025, httpPort: 2080 });

test('sends a welcome email', async () => {
  const mail = new MailTs({ smtp: { host: '127.0.0.1', port: 2025, pool: false } });

  await mail.send({
    from: 'app@example.com',
    to: 'alice@example.com',
    subject: 'Welcome!',
    html: '<h1>Welcome, Alice!</h1>',
  });

  const msg = await trap.waitForMessage({ subject: 'Welcome!' });
  expect(msg.to[0]!.email).toBe('alice@example.com');
  expect(msg.html).toContain('Welcome, Alice!');
});
```

## API

### `useTrapServer(options?)`

Registers `beforeAll` / `afterAll` hooks that start and stop a `TrapServer` for the suite, and `afterEach`
to clear captured messages. Takes the `TrapServer` options and returns a handle.

```ts
const trap = useTrapServer({
  smtpPort: 2025,     // default 1025 — point MailTs at this port
  httpPort: 2080,     // default 1080 — web UI / REST API
  maxMessages: 200,   // default 100
});
```

| Handle member | Description |
|---|---|
| `trap.waitForMessage(criteria?)` | Resolves with the first captured message matching `subject` (string or RegExp), `to` and/or `from`; rejects after `timeoutMs` (default 5000, polled every `intervalMs`, default 50) |
| `trap.messages()` | All messages captured so far |
| `trap.clear()` | Remove captured messages |
| `trap.server` | The underlying `TrapServer` (`store`, `url`) |

```ts
const invoice = await trap.waitForMessage({ subject: /invoice/i, to: 'bob@example.com', timeoutMs: 3_000 });
expect(invoice.attachments).toHaveLength(1);
```

## Isolation

Messages are cleared after every test. Each `useTrapServer()` call starts its own server on the ports you give it,
so when test files run in parallel, give each file its own `smtpPort` / `httpPort`.

## Peer dependencies

| Package | Version |
|---------|---------|
| `@mailts/core` | `>=1.0.0 <2.0.0` |
| `vitest` | `>=1.0.0` |

`@mailts/trap` (`>=1.1.0 <2.0.0`) is installed as a regular dependency.

---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

Part of the [mailts](https://github.com/anishhs-gh/mailts) project.
