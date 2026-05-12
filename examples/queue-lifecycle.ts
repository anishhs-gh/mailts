/**
 * Queue lifecycle — priority, play/pause, interrupt, cancel, abort.
 *
 * Shows all five control operations on `MailQueue`:
 *   • Priority scheduling  — critical emails jump the queue
 *   • pause() / play()     — stop and resume processing
 *   • cancel()             — discard a pending or running job
 *   • interrupt()          — return a running job to the front of the queue
 *   • abort()              — force-fail a running job (retry / DLQ apply)
 *   • shutdown()           — graceful stop with optional timeout
 *
 * Run:  npx tsx examples/queue-lifecycle.ts
 */
import { MailTs } from '../src/index.js';
import type { SendResult, QueueJob } from '../src/types/index.js';

// ── Fake transport that logs and simulates behaviour ───────────────────────────

let sendCount = 0;

const fakeSend = async (opts: import('../src/types/core.js').EmailOptions): Promise<SendResult> => {
  const to = typeof opts.to === 'string' ? opts.to : (opts.to as any).email ?? '';
  sendCount++;
  await new Promise(r => setTimeout(r, 30)); // simulate network
  return { ok: true, messageId: `<fake-${to}-${sendCount}>`, accepted: [to], rejected: [] };
};

function label(job: QueueJob): string {
  return `[${job.priority.padEnd(8)}] ${job.id.slice(0, 8)} to=${JSON.stringify(job.options.to)}`;
}

// ── 1. Priority scheduling ─────────────────────────────────────────────────────

console.log('\n─── 1. Priority scheduling ───────────────────────────────────────────────\n');
{
  const mail = new MailTs({ logger: { level: 'warn' } });
  mail.queue.setSendFn(fakeSend);

  const order: string[] = [];
  mail.queue.on('success', (job) => order.push(typeof job.options.to === 'string' ? job.options.to : ''));

  mail.queue.pause();
  mail.queue.enqueue({ to: 'bulk@example.com',        subject: 'Newsletter', text: '...' }, { priority: 'low' });
  mail.queue.enqueue({ to: 'transactional@example.com', subject: 'Receipt',  text: '...' });
  mail.queue.enqueue({ to: 'alert@example.com',        subject: 'Alert!',    text: '...' }, { priority: 'critical' });
  mail.queue.enqueue({ to: 'welcome@example.com',      subject: 'Welcome',   text: '...' }, { priority: 'high' });
  mail.queue.play();

  await mail.queue.drain();
  console.log('Delivery order:', order);
  // → ['alert@example.com', 'welcome@example.com', 'transactional@example.com', 'bulk@example.com']
}

// ── 2. pause() / play() ────────────────────────────────────────────────────────

console.log('\n─── 2. pause() / play() ──────────────────────────────────────────────────\n');
{
  const mail = new MailTs({ logger: { level: 'warn' } });
  mail.queue.setSendFn(fakeSend);

  mail.queue.enqueue({ to: 'a@example.com', subject: 'A', text: '...' });
  mail.queue.enqueue({ to: 'b@example.com', subject: 'B', text: '...' });

  console.log('Stats before pause:', mail.queue.stats());
  mail.queue.pause();
  mail.queue.enqueue({ to: 'c@example.com', subject: 'C', text: '...' });
  console.log('Stats while paused:', mail.queue.stats());
  mail.queue.play();
  await mail.queue.drain();
  console.log('Stats after drain:', mail.queue.stats());
}

// ── 3. cancel() ────────────────────────────────────────────────────────────────

console.log('\n─── 3. cancel() ──────────────────────────────────────────────────────────\n');
{
  const mail = new MailTs({ logger: { level: 'warn' } });
  mail.queue.setSendFn(fakeSend);

  const cancelled: string[] = [];
  mail.queue.on('cancelled', (job) => {
    cancelled.push(job.id);
    console.log('Cancelled:', label(job));
  });

  mail.queue.pause();
  const jobA = mail.queue.enqueue({ to: 'a@example.com', subject: 'A', text: '...' });
  const jobB = mail.queue.enqueue({ to: 'b@example.com', subject: 'B', text: '...' });
  mail.queue.enqueue({ to: 'c@example.com', subject: 'C', text: '...' });

  // Cancel one specific job
  mail.queue.cancel(jobA.id);
  // Cancel all remaining pending
  const count = mail.queue.cancelAll();
  console.log(`cancelAll() removed ${count} jobs`);
  mail.queue.play();
  await mail.queue.drain();
  console.log('Stats:', mail.queue.stats());
}

// ── 4. interrupt() ─────────────────────────────────────────────────────────────

console.log('\n─── 4. interrupt() ───────────────────────────────────────────────────────\n');
{
  const mail = new MailTs({
    queue: { concurrency: 1, maxRetries: 5, retryDelay: 10 },
    logger: { level: 'warn' },
  });

  let runningId = '';
  let interruptedOnce = false;

  mail.queue.on('started', (job) => { runningId = job.id; });
  mail.queue.on('interrupted', (job) => {
    console.log('Interrupted (returned to queue):', label(job), `attempts=${job.attempts}`);
  });
  mail.queue.on('success', (job) => {
    console.log('Succeeded:', label(job), `attempts=${job.attempts}`);
  });

  mail.queue.setSendFn(async (opts, signal) => {
    if (!interruptedOnce) {
      interruptedOnce = true;
      mail.queue.interrupt(runningId); // interrupt mid-send
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    }
    return fakeSend(opts);
  });

  mail.queue.enqueue({ to: 'user@example.com', subject: 'Important', text: '...' });
  await mail.queue.drain();
}

// ── 5. abort() ────────────────────────────────────────────────────────────────

console.log('\n─── 5. abort() ───────────────────────────────────────────────────────────\n');
{
  const mail = new MailTs({
    queue: { concurrency: 1, maxRetries: 2, retryDelay: 20 },
    logger: { level: 'warn' },
  });

  let runningId = '';
  let abortedOnce = false;

  mail.queue.on('started', (job) => { runningId = job.id; });
  mail.queue.on('retry', (job, attempt) => {
    console.log(`Retry #${attempt} (after abort):`, label(job));
  });
  mail.queue.on('success', (job) => {
    console.log('Succeeded after abort + retry:', label(job), `attempts=${job.attempts}`);
  });

  mail.queue.setSendFn(async (opts, signal) => {
    if (!abortedOnce) {
      abortedOnce = true;
      mail.queue.abort(runningId);
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    }
    return fakeSend(opts);
  });

  mail.queue.enqueue({ to: 'user@example.com', subject: 'Will be aborted once', text: '...' });
  await mail.queue.drain();
}

// ── 6. shutdown() ─────────────────────────────────────────────────────────────

console.log('\n─── 6. shutdown() ────────────────────────────────────────────────────────\n');
{
  const mail = new MailTs({
    queue: { concurrency: 2, maxRetries: 0 },
    logger: { level: 'warn' },
  });
  mail.queue.setSendFn(async (opts) => {
    await new Promise(r => setTimeout(r, 60));
    return fakeSend(opts);
  });

  mail.queue.enqueue({ to: 'a@example.com', subject: 'A', text: '...' });
  mail.queue.enqueue({ to: 'b@example.com', subject: 'B', text: '...' });
  mail.queue.enqueue({ to: 'c@example.com', subject: 'C', text: '...' }); // will be cancelled

  await new Promise(r => setTimeout(r, 10)); // let a and b start running

  await mail.queue.shutdown(); // cancels c, waits for a and b
  console.log('Final stats:', mail.queue.stats());
  // → { pending: 0, running: 0, succeeded: 2, dead: 0, cancelled: 1 }
}

// ── Cross-process control (Node 22+ with queue.persist) ────────────────────────
// When `queue.persist` is set, the CLI can signal the running app within ~5 s:
//
//   mailts queue cancel    <job-id>   → cancel a specific job
//   mailts queue interrupt <job-id>   → interrupt a job, return to queue
//   mailts queue abort     <job-id>   → abort, apply retry/DLQ
//   mailts queue shutdown             → graceful shutdown signal
//   mailts queue status               → live counts including cancelled
