/**
 * Queue + Dead-Letter Queue demo.
 *
 * Shows:
 *  - Persistent SQLite queue (Node 22+) for cross-process visibility
 *  - Telemetry hooks wired to queue events
 *  - Three failure modes: transient retry, timeout → DLQ, permanent → DLQ
 *
 * Run:  npx tsx examples/queue-and-dlq.ts
 */
import { MailTs } from '../src/index.js';
import type { SendResult } from '../src/types/index.js';

// ── Fake send function with three failure modes ────────────────────────────────
const perAddressAttempts: Record<string, number> = {};

const fakeSend = async (opts: import('../src/types/core.js').EmailOptions): Promise<SendResult> => {
  const to = Array.isArray(opts.to) ? opts.to[0] : opts.to;
  const toStr = typeof to === 'string' ? to : (to?.email ?? '');
  perAddressAttempts[toStr] = (perAddressAttempts[toStr] ?? 0) + 1;

  if (toStr.startsWith('perm')) {
    const { SmtpRejectError } = await import('../src/errors.js');
    return { ok: false, error: new SmtpRejectError('550 User unknown', 550, []), attempts: perAddressAttempts[toStr]! };
  }
  if (toStr.startsWith('slow')) {
    await new Promise(r => setTimeout(r, 300)); // exceeds jobTimeout of 200ms
  }
  if (toStr.startsWith('flaky') && perAddressAttempts[toStr]! < 3) {
    const { MailTsError } = await import('../src/errors.js');
    return { ok: false, error: new MailTsError('Connection refused', 'ECONN', true), attempts: perAddressAttempts[toStr]! };
  }
  return { ok: true, messageId: `<fake-${toStr}>`, accepted: [toStr], rejected: [] };
};

// ── Configure MailTs with queue persistence and telemetry hooks ────────────────
const mail = new MailTs({
  smtp: { host: 'smtp.example.com', port: 587 },
  queue: {
    concurrency: 2,
    maxRetries: 3,
    retryDelay: 50,
    retryBackoff: 'exponential',
    jitter: false,
    jobTimeout: 200,
    deadLetter: { enabled: true },
    // persist: true,  // uncomment on Node 22+ for cross-process visibility via `mailts queue status`
  },
  telemetry: {
    onSend: (_opts, result, latencyMs) => {
      if (result.ok) console.log(`  [telemetry] sent ${result.messageId} in ${latencyMs}ms`);
    },
    onError: (err, phase) => {
      console.log(`  [telemetry] error in ${phase}: ${err.message}`);
    },
    onQueueEnqueue: (job) => {
      console.log(`  [telemetry] enqueued ${job.id}`);
    },
    onQueueSuccess: (job) => {
      console.log(`  [telemetry] success ${job.id}`);
    },
    onQueueDead: (job) => {
      console.log(`  [telemetry] dead ${job.id} (${job.errors.at(-1)?.message})`);
    },
    onQueueRetry: (job, attempt, delay) => {
      console.log(`  [telemetry] retry ${job.id} attempt=${attempt} delay=${delay}ms`);
    },
  },
  logger: { level: 'warn', format: 'pretty' },
});

// Inject fake send function
mail.queue.setSendFn(fakeSend);

// ── Enqueue jobs ───────────────────────────────────────────────────────────────
console.log('Enqueuing jobs...\n');
mail.queue.enqueue({ to: 'alice@example.com',     subject: 'Hi Alice',               text: 'Hello!' });
mail.queue.enqueue({ to: 'flaky@example.com',     subject: 'Transient — will retry', text: '...'   });
mail.queue.enqueue({ to: 'slow@example.com',      subject: 'Always times out',       text: '...'   });
mail.queue.enqueue({ to: 'bob@example.com',       subject: 'Hi Bob',                 text: 'Hello!' });
mail.queue.enqueue({ to: 'perm-fail@example.com', subject: 'Permanent rejection',    text: '...'   });

await mail.queue.drain();

// ── Results ────────────────────────────────────────────────────────────────────
console.log('\nQueue stats:', mail.queue.stats());

const dead = mail.queue.dlq.getAll();
console.log(`\nDead-letter queue (${dead.length} jobs):`);
for (const job of dead) {
  console.log(`  ${job.id}  to=${JSON.stringify(job.options.to)}  errors=${job.errors.length}`);
}

// ── Cross-process queue visibility (Node 22+) ──────────────────────────────────
// When queue.persist is set, the running state is visible to the CLI:
//
//   mailts queue status          → live pending/running/succeeded/dead counts
//   mailts queue dlq list        → dead jobs with error details
//   mailts queue dlq retry <id>  → re-queue a dead job (app picks up in <5s)
//   mailts queue dlq clear       → wipe the DLQ
