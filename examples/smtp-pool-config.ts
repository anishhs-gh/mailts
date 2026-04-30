/**
 * SMTP connection pool — tuning, bulk send, connection test, and runtime reconfigure.
 *
 * The pool keeps TLS connections alive across sends.
 * Use testConnection() to verify credentials before committing to a batch.
 *
 * Run:  SMTP_PASS=<pass> npx tsx examples/smtp-pool-config.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'you@gmail.com', pass: process.env['SMTP_PASS']! },
    pool: {
      maxConnections: 5,      // up to 5 parallel SMTP connections
      maxMessages:    100,    // recycle a connection after 100 sends (some servers enforce this)
      idleTimeout:    30_000, // close idle connections after 30 s
    },
    connectionTimeout: 10_000,   // TCP/TLS handshake deadline
    socketTimeout:     30_000,   // per-command reply deadline
  },
  logger: { level: 'info', format: 'pretty' },
});

// ── Verify credentials before sending ────────────────────────────────────
// Opens a throw-away connection, sends NOOP, closes it — does not use the pool.
const connected = await mail.testConnection();
console.log('SMTP connection test:', connected ? 'OK' : 'FAILED');
if (!connected) process.exit(1);

// ── Bulk send — pool reuses TLS connections across concurrent sends ────────
const recipients = [
  'alice@example.com',
  'bob@example.com',
  'carol@example.com',
  'dan@example.com',
  'eve@example.com',
];

const results = await Promise.all(
  recipients.map(to =>
    mail.send({
      from: { email: 'newsletter@example.com', name: 'Monthly Digest' },
      to,
      subject: 'April 2026 digest',
      text: `Hi, here's your April digest.`,
      html: `<p>Hi, here's your <strong>April digest</strong>.</p>`,
    }),
  ),
);

for (const [i, r] of results.entries()) {
  console.log(`${recipients[i]}: ${r.ok ? r.messageId : r.error.message}`);
}

// ── configure() — swap credentials without creating a new instance ────────
// configure() merges into the live instance; the pool is torn down and rebuilt.
mail.configure({
  smtp: {
    host: 'smtp.sendgrid.net',
    port: 587,
    auth: { type: 'plain', user: 'apikey', pass: process.env['SENDGRID_API_KEY']! },
    pool: { maxConnections: 3 },
  },
});
console.log('\nReconfigured to SendGrid (no send executed — no key set)');

// Pool connections stay alive until shutdown() — call it before process exit.
await mail.shutdown();
console.log('Pool shut down cleanly.');
