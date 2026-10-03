<!-- Generated from README.md by scripts/build-skill.mjs — do not edit by hand. -->

# Queues with mailts

The built-in queue (priorities, retries, scheduling, rate limits, idempotency, persistence, shutdown) and MailWorker with external drivers such as Redis or Postgres.

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
[`queue-driver-postgres.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/queue-driver-postgres.ts) (`FOR UPDATE SKIP LOCKED`, leases, a retry cap for jobs
that keep crashing their worker, cross-instance idempotency keys; any Postgres incl. Cloud SQL). It is tested against a real
Postgres engine in the integration suite.

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

Complete drivers: [`mail-worker-redis.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/mail-worker-redis.ts) (Redis) and
[`queue-driver-postgres.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/queue-driver-postgres.ts) (Postgres, many instances).
