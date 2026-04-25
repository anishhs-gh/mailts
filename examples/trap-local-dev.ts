/**
 * @mailts/trap — local development mail server
 *
 * Starts an in-process SMTP trap so every email your app sends during
 * development is captured locally instead of hitting a real mail server.
 * A web UI at http://localhost:1080 lets you inspect every captured message.
 *
 * Run:  npx tsx examples/trap-local-dev.ts
 * Stop: Ctrl+C
 */
import { exec } from 'child_process';
import { TrapServer } from '@mailts/trap';
import { MailTs } from '@mailts/core';

// ── 1. Start the trap ─────────────────────────────────────────────────────────
const trap = new TrapServer({
  smtpPort: 1025,   // your app points its SMTP config here
  httpPort: 1080,   // web UI + REST API
  // persist: true  // uncomment to survive restarts (writes NDJSON to .mailts-trap/)
  // persist: '/var/mail/trap'  // or a custom path
});

await trap.start();
console.log('Trap SMTP  →  localhost:1025');
console.log('Trap UI    →  http://localhost:1080');

// ── 2. Point mailts at the trap ───────────────────────────────────────────────
const mail = new MailTs({
  smtp: { host: '127.0.0.1', port: 1025 },
  logger: { level: 'info', format: 'pretty' },
});

// ── 3. Send some test emails ──────────────────────────────────────────────────
await mail.send({
  from: { email: 'noreply@myapp.dev', name: 'My App' },
  to: 'alice@example.com',
  subject: 'Welcome to My App!',
  html: '<h1>Welcome, Alice!</h1><p>Thanks for signing up.</p>',
  text: 'Welcome, Alice! Thanks for signing up.',
});

await mail.send({
  from: 'alerts@myapp.dev',
  to: ['ops@myapp.dev', 'cto@myapp.dev'],
  subject: '[ALERT] Disk usage above 90%',
  text: 'Server web-01 disk usage: 91%. Please investigate.',
  priority: 'high',
});

await mail.send({
  from: 'billing@myapp.dev',
  to: 'alice@example.com',
  subject: 'Your invoice #1042',
  html: '<p>Invoice attached.</p>',
  attachments: [
    {
      filename: 'invoice-1042.txt',
      content: 'Invoice #1042\nAmount: $49.00\nDue: 2026-05-01',
      contentType: 'text/plain',
    },
  ],
});

console.log('\n3 test emails sent. Opening browser...');

// ── 4. Open the browser ───────────────────────────────────────────────────────
const openCmd =
  process.platform === 'darwin' ? 'open' :
  process.platform === 'win32'  ? 'start' : 'xdg-open';
exec(`${openCmd} http://localhost:1080`);

// ── 5. Keep alive until Ctrl+C ────────────────────────────────────────────────
console.log('Press Ctrl+C to stop.\n');

process.on('SIGINT', async () => {
  process.stdout.write('\nShutting down...\n');
  await mail.shutdown();
  await trap.stop();
  // Event loop drains naturally once both servers are closed.
});
