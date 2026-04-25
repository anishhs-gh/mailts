# @mailts/testing

Vitest helpers for testing email-sending code with a real in-process SMTP trap — no mocks, no network.

## Install

```bash
npm install --save-dev @mailts/testing
```

Requires `vitest` and `mailts` as peer dependencies.

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

const { getTrap } = useTrapServer();

test('sends a welcome email', async () => {
  const mail = new MailTs({
    smtp: { host: '127.0.0.1', port: getTrap().smtpPort, pool: false },
  });

  await mail.send({
    from: 'app@example.com',
    to: 'alice@example.com',
    subject: 'Welcome!',
    html: '<h1>Welcome, Alice!</h1>',
  });

  const messages = getTrap().store.getAll();
  expect(messages).toHaveLength(1);
  expect(messages[0]!.subject).toBe('Welcome!');
  expect(messages[0]!.to[0]!.email).toBe('alice@example.com');
});
```

## API

### `useTrapServer(options?)`

Registers `beforeAll` / `afterAll` hooks that start and stop a `TrapServer` for the test suite. Returns `{ getTrap }`.

```ts
const { getTrap } = useTrapServer({
  smtpPort: 0,      // 0 = random available port (default)
  httpPort: 0,
  maxMessages: 200,
});
```

### `getTrap()`

Returns the running `TrapServer` instance. Available after `beforeAll` completes.

```ts
const trap = getTrap();
trap.store.getAll();          // all captured messages
trap.store.clear();           // clear between tests
trap.store.getById(id);       // fetch by ID
trap.smtpPort;                // actual bound port
trap.httpPort;                // actual bound HTTP port
```

### Waiting for a message

```ts
import { waitForMessage } from '@mailts/testing';

const msg = await waitForMessage(getTrap(), {
  subject: /invoice/i,
  timeout: 3_000,
});
expect(msg.attachments).toHaveLength(1);
```

## Isolation

Each test file gets its own trap server instance. The store is isolated per suite — use `getTrap().store.clear()` in `beforeEach` if you need per-test isolation within a suite.

## Peer dependencies

| Package | Version |
|---------|---------|
| `mailts` | `>=0.1.0` |
| `@mailts/trap` | `>=0.1.0` |
| `vitest` | `>=1.0.0` |

---

## Author

**Anish Shekh** — [github.com/anishhs-gh](https://github.com/anishhs-gh)

Part of the [mailts](https://github.com/anishhs-gh/mailts) project.
