/**
 * Middleware pipeline + devMode.
 *
 * Middlewares run in registration order before every send().
 * devMode: true logs the message but never transmits it — safe for local dev.
 *
 * Run:  npx tsx examples/middleware-and-devmode.ts
 */
import { MailTs } from '../src/index.js';
import type { EmailOptions } from '../src/types/index.js';

// ── devMode: no SMTP config needed, nothing is sent ──────────────────────────
const mail = new MailTs({
  devMode: true,
  logger: { level: 'debug', format: 'pretty' },
});

// ── Middleware 1: inject a standard header on every message ───────────────────
mail.use(async (msg, next) => {
  msg.headers = {
    ...msg.headers,
    'X-Mailer':     'my-app/1.0',
    'X-Environment': process.env['NODE_ENV'] ?? 'development',
  };
  await next();
});

// ── Middleware 2: redirect all outbound email to a dev inbox in non-prod ──────
mail.use(async (msg: EmailOptions, next) => {
  const env = process.env['NODE_ENV'] ?? 'development';
  if (env !== 'production') {
    const originalTo = JSON.stringify(msg.to);
    msg.to      = 'dev-inbox@example.com';
    msg.subject = `[DEV → ${originalTo}] ${msg.subject ?? ''}`;
  }
  await next();
});

// ── Middleware 3: block sending to external domains in staging ────────────────
mail.use(async (msg: EmailOptions, next) => {
  const env = process.env['NODE_ENV'] ?? 'development';
  if (env === 'staging') {
    const toList = Array.isArray(msg.to) ? msg.to : [msg.to];
    const hasExternal = toList.some(addr => {
      const email = typeof addr === 'string' ? addr : addr.email;
      return !email.endsWith('@example.com');
    });
    if (hasExternal) {
      console.warn('[staging] Blocked outbound email to external domain');
      return;   // short-circuit — do not call next()
    }
  }
  await next();
});

// ── Middleware 4: measure send latency ───────────────────────────────────────
mail.use(async (msg, next) => {
  const start = Date.now();
  await next();
  console.log(`Send took ${Date.now() - start}ms  subject="${msg.subject}"`);
});

// ── Send — will pass through all middlewares but not transmit (devMode) ───────
const result = await mail.send({
  from: 'noreply@myapp.com',
  to: 'customer@external-domain.com',
  subject: 'Your order has shipped',
  text: 'Order #42 is on its way.',
});

console.log('Result:', result.ok ? `devMode messageId: ${result.messageId}` : result.error.message);

// ── Switch off devMode at runtime via configure() ─────────────────────────────
// configure() is chainable and merges into the running instance.
// mail.configure({ devMode: false, smtp: { host: '...', ... } });

await mail.shutdown();
