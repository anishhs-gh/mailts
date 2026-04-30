/**
 * CC, BCC, Reply-To, priority, and semantic send helpers.
 *
 * Also shows sendTemplate() for direct template rendering (vs. define/trigger).
 *
 * Run:  SMTP_PASS=<pass> npx tsx examples/cc-bcc-replyto.ts
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'you@example.com', pass: process.env['SMTP_PASS']! },
  },
  logger: { level: 'info', format: 'pretty' },
});

// ── CC, BCC, Reply-To ─────────────────────────────────────────────────────
const r1 = await mail.send({
  from: { email: 'noreply@example.com', name: 'Example App' },
  to: 'customer@example.com',
  cc: ['manager@example.com', { email: 'legal@example.com', name: 'Legal' }],
  bcc: 'archive@example.com',       // envelope-only — not visible in message headers
  replyTo: 'support@example.com',   // replies go here, not to `from`
  subject: 'Your order has shipped',
  text: 'Order #42 is on its way.',
  html: '<p>Order <strong>#42</strong> is on its way.</p>',
  priority: 'high',                 // sets X-Priority + Importance headers
});
console.log('CC/BCC/Reply-To:', r1.ok ? r1.messageId : r1.error.message);

// ── notify() — prepends [NOTIFICATION] to the subject ────────────────────
const r2 = await mail.notify({
  from: 'noreply@example.com',
  to: 'admin@example.com',
  subject: 'New user signed up',
  text: 'alice@example.com just created an account.',
});
console.log('notify():', r2.ok ? r2.messageId : r2.error.message);

// ── alert() — prepends [ALERT] and forces high priority ──────────────────
const r3 = await mail.alert({
  from: 'monitoring@example.com',
  to: ['ops@example.com', { email: 'cto@example.com', name: 'CTO' }],
  subject: 'CPU above 95%',
  text: 'web-01: CPU at 97% for 5 minutes.',
});
console.log('alert():', r3.ok ? r3.messageId : r3.error.message);

// ── sendTemplate() — render inline template and send ─────────────────────
// Unlike define/trigger, this is a direct one-shot call.
mail.setTemplateEngine({
  render: (tpl, data) =>
    (tpl as string).replace(/\{\{(\w+)\}\}/g, (_, k) => String((data as Record<string, unknown>)[k] ?? '')),
});

const r4 = await mail.sendTemplate({
  from: 'billing@example.com',
  to: 'user@example.com',
  bcc: 'receipts@example.com',
  subject: 'Invoice #{{invoiceId}}',
  template: 'Hi {{name}},\n\nYour invoice #{{invoiceId}} for ${{amount}} is due on {{dueDate}}.\n\nThank you!',
  data: { name: 'Alice', invoiceId: '1042', amount: '49.00', dueDate: '2026-05-01' },
});
console.log('sendTemplate():', r4.ok ? r4.messageId : r4.error.message);

await mail.shutdown();
