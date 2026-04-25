/**
 * Queue + Dead-Letter Queue demo.
 *
 * Enqueues several jobs; two are configured to fail so they end up in the DLQ.
 * Shows how to subscribe to queue events and inspect / retry dead jobs.
 */
import { MailTs } from '../src/index.js';
import type { QueueJob, SendResult } from '../src/types/index.js';

// Simulate a transport with three failure modes:
//   flaky@  — transient (retryable), succeeds on 3rd attempt
//   slow@   — hangs 300ms per attempt, triggering jobTimeout (200ms), exhausts retries → DLQ
//   perm@   — permanent 550 rejection (non-retryable), goes straight to DLQ
const perAddressAttempts: Record<string, number> = {};
const fakeSend = async (opts: import('../src/types/core.js').EmailOptions): Promise<SendResult> => {
  const to = Array.isArray(opts.to) ? opts.to[0] : opts.to;
  const toStr = typeof to === 'string' ? to : to?.email ?? '';
  perAddressAttempts[toStr] = (perAddressAttempts[toStr] ?? 0) + 1;

  if (toStr.startsWith('perm')) {
    const { SmtpRejectError } = await import('../src/errors.js');
    return { ok: false, error: new SmtpRejectError('550 User unknown', 550, []), attempts: perAddressAttempts[toStr]! };
  }
  if (toStr.startsWith('slow')) {
    await new Promise(r => setTimeout(r, 300)); // always exceeds jobTimeout of 200ms
  }
  if (toStr.startsWith('flaky') && perAddressAttempts[toStr]! < 3) {
    const { MailTsError } = await import('../src/errors.js');
    return { ok: false, error: new MailTsError('Connection refused', 'ECONN', true), attempts: perAddressAttempts[toStr]! };
  }
  return { ok: true, messageId: `<fake-${toStr}>`, accepted: [toStr], rejected: [] };
};

const mail = new MailTs({
  smtp: { host: 'smtp.example.com', port: 587 }, // pool won't be used — we inject fakeSend
  queue: {
    concurrency: 2,
    maxRetries: 3,
    retryDelay: 50,
    retryBackoff: 'exponential',
    jitter: false,          // disabled so delays are deterministic in the demo
    jobTimeout: 200,        // abort any send that takes longer than 200ms
    deadLetter: { enabled: true },
  },
  logger: { level: 'info', format: 'pretty' },
});

// Inject the fake send function directly onto the queue
mail.queue.setSendFn(fakeSend);

// Subscribe to events
mail.queue.on('success', (job: QueueJob, result: SendResult) => {
  if (result.ok) console.log(`✓ ${job.id}  →  ${result.messageId}`);
});

mail.queue.on('retry', (job: QueueJob, attempt: number, delay: number) => {
  console.log(`↺ ${job.id}  attempt=${attempt}  delay=${delay}ms`);
});

mail.queue.on('dead', (job: QueueJob) => {
  console.log(`✗ ${job.id}  moved to DLQ  (${job.errors.at(-1)?.message})`);
});

// Enqueue jobs
mail.queue.enqueue({ to: 'alice@example.com',     subject: 'Hi Alice',               text: 'Hello!' });
mail.queue.enqueue({ to: 'flaky@example.com',     subject: 'Transient — will retry', text: '...' });
mail.queue.enqueue({ to: 'slow@example.com',      subject: 'Always times out',       text: '...' });
mail.queue.enqueue({ to: 'bob@example.com',       subject: 'Hi Bob',                 text: 'Hello!' });
mail.queue.enqueue({ to: 'perm-fail@example.com', subject: 'Permanent rejection',    text: '...' });

await mail.queue.drain();

const stats = mail.queue.stats();
console.log('\nQueue stats:', stats);

// Inspect DLQ
const dead = mail.queue.dlq.getAll();
console.log(`\nDead-letter queue (${dead.length} jobs):`);
for (const job of dead) {
  console.log(`  ${job.id}  to=${JSON.stringify(job.options.to)}  errors=${job.errors.length}`);
}
