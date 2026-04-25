/**
 * Basic email send — the minimal setup to send a text + HTML email.
 *
 * Prerequisites:
 *   SMTP_PASS=<your-app-password> npx tsx examples/basic-send.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: {
      type: 'plain',
      user: 'you@gmail.com',
      pass: process.env['SMTP_PASS']!,
    },
    pool: false,   // one-shot: connect → send → quit, no shutdown() needed
  },
  logger: { level: 'info', format: 'pretty' },
});

// Stream all log events to stdout
mail.logger.stream().pipe(process.stdout);

const result = await mail.send({
  from: { email: 'you@gmail.com', name: 'Your App' },
  to: 'recipient@example.com',
  subject: 'Hello from mailts!',
  text: 'Plain-text fallback for email clients that do not render HTML.',
  html: '<h1>Hello!</h1><p>Sent with <strong>mailts</strong>.</p>',
});

if (result.ok) {
  console.log('Sent:', result.messageId);
} else {
  console.error('Failed:', result.error.message, '— retryable:', result.error.retryable);
  process.exitCode = 1;
}
