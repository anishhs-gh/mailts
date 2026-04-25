/**
 * Streaming logs demo — shows all three consumption patterns.
 *
 * Run with:  npx tsx examples/streaming-logs.ts
 */
import { createWriteStream } from 'fs';
import { MailTs } from '../src/index.js';
import type { LogEvent } from '../src/types/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'me@gmail.com', pass: process.env['SMTP_PASS']! },
  },
  logger: {
    level: 'debug',
    format: 'pretty',
    protocol: true,   // ← stream every SMTP protocol line (credentials auto-redacted)
  },
});

// ── Pattern 1: event listener ───────────────────────────────────────────────
mail.logger.onEvent((e: LogEvent) => {
  if (e.level === 'error') {
    process.stderr.write(`[ERROR] ${e.message}\n`);
  }
});

// ── Pattern 2: JSON stream to a log file ────────────────────────────────────
const logFile = createWriteStream('/tmp/mailts.log', { flags: 'a' });
mail.logger.stream({ format: 'json' }).pipe(logFile);

// ── Pattern 3: pretty-print protocol trace to stdout ────────────────────────
mail.logger.stream({ format: 'pretty' }).pipe(process.stdout);

// Trigger a send so we can watch the protocol stream
const result = await mail.send({
  from: 'me@gmail.com',
  to: 'you@example.com',
  subject: 'Protocol trace demo',
  text: 'Watch the terminal output above!',
});

console.log('\nResult:', result.ok ? result.messageId : result.error.message);
await mail.shutdown();
