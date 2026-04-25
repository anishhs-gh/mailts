/**
 * Aliases and template engine demo.
 *
 * Shows how to define reusable email configurations and trigger them,
 * with a pluggable custom template engine.
 */
import { MailTs } from '../src/index.js';

const mail = new MailTs({
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { type: 'plain', user: 'noreply@example.com', pass: process.env['SMTP_PASS']! },
  },
});

// ── Custom template engine (simple {{var}} with dot-path support) ─────────
mail.setTemplateEngine({
  render(compiled, data) {
    return (compiled as string).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
      const val = key.split('.').reduce<unknown>((obj, k) =>
        obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[k] : undefined,
        data,
      );
      return val == null ? '' : String(val);
    });
  },
});

// ── Middleware: add a custom header to every outbound message ─────────────
mail.use(async (msg, next) => {
  msg.headers = { ...msg.headers, 'X-Mailer': 'mailts/0.1.0' };
  await next();
});

// ── Define aliases ────────────────────────────────────────────────────────
mail.define('welcome', {
  from: { email: 'welcome@example.com', name: 'Example Team' },
  subject: 'Welcome to Example, {{user.name}}!',
  template: 'Hi {{user.name}},\n\nYour account ({{user.email}}) is ready.\n\nThanks!',
});

mail.define('system-alert', {
  type: 'alert',
  from: 'monitoring@example.com',
  to: 'ops@example.com',
  subject: 'System Alert: {{title}}',
  text: '{{message}}\n\nSeverity: {{severity}}',
});

// ── Trigger aliases ────────────────────────────────────────────────────────
const welcomeResult = await mail.trigger('welcome', {
  to: 'newuser@example.com',
  data: { user: { name: 'Alice', email: 'newuser@example.com' } },
});
console.log('Welcome email:', welcomeResult.ok ? welcomeResult.messageId : welcomeResult.error.message);

const alertResult = await mail.trigger('system-alert', {
  data: { title: 'High Memory Usage', message: 'Memory above 90%', severity: 'HIGH' },
});
console.log('Alert email:', alertResult.ok ? alertResult.messageId : alertResult.error.message);

await mail.shutdown();
