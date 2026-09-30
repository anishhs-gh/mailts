/**
 * Crash-safe queue with SQLite (Node 22+).
 *
 * - jobs survive restarts and crashes and are delivered exactly once, under the same id
 * - several processes can share one database (each claims jobs with a lease)
 * - shutdown() keeps unsent jobs for the next start instead of discarding them
 * - Buffer attachments and Dates are persisted; streams are rejected at enqueue
 *
 * Run twice:  npx tsx examples/queue-persistence.ts enqueue   # queue 3 mails, "crash"
 *             npx tsx examples/queue-persistence.ts deliver   # restart → delivered
 * Inspect:    npx mailts queue status
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { MailTs } from '../src/index.js';

const dbPath = join(tmpdir(), 'mailts-example-queue.db');

const mail = new MailTs({
  queue: { persist: dbPath, concurrency: 2, maxRetries: 3 },
  // Swap for smtp: { … } in real use
  transport: {
    name: 'console',
    async send(message, options) {
      console.log(`→ sent "${options.subject}" (${message.raw.length} bytes)`);
      return { messageId: message.messageId, accepted: message.to, rejected: [] };
    },
  },
});

if (process.argv[2] === 'enqueue') {
  mail.queue.pause(); // don't send yet
  for (let i = 1; i <= 3; i++) {
    const job = mail.queue.enqueue({
      to: 'user@example.com',
      subject: `Report ${i}`,
      text: 'See attachment',
      attachments: [{ filename: `report-${i}.csv`, content: Buffer.from('a,b\n1,2\n') }],
    });
    console.log(`queued ${job.id}`);
  }
  console.log('Simulating a crash — no shutdown(). Run with "deliver" next.');
  process.kill(process.pid, 'SIGKILL');
} else {
  // Restored jobs start automatically; drain() waits for them
  await mail.queue.drain();
  const result = await mail.shutdown(); // persistent default: keep anything left
  console.log('shutdown:', result, 'stats:', mail.queue.stats());
}
