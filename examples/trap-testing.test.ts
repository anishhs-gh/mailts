/**
 * @mailts/testing — Vitest integration example
 *
 * useTrapServer() starts a real in-process SMTP trap before all tests and
 * tears it down after.  waitForMessage() polls with a configurable timeout
 * so tests remain deterministic without arbitrary sleeps.
 *
 * Prerequisites (vitest.config.ts):
 *   defineConfig({ test: { globals: true } })
 *
 * Run:  npx vitest run examples/trap-testing.test.ts
 */
import { describe, it, expect } from 'vitest';
import { useTrapServer } from '@mailts/testing';
import { MailTs } from 'mailts';

// ── Shared trap — started once for the whole suite ───────────────────────────
const trap = useTrapServer({ smtpPort: 2025, httpPort: 2080 });

// ── Helper: mailts instance that sends to the trap ───────────────────────────
function makeMail() {
  return new MailTs({
    smtp: { host: '127.0.0.1', port: 2025 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('welcome email flow', () => {
  it('sends a welcome email with correct recipient and subject', async () => {
    const mail = makeMail();

    await mail.send({
      from: 'noreply@myapp.dev',
      to: 'alice@example.com',
      subject: 'Welcome to My App!',
      html: '<h1>Welcome, Alice!</h1>',
      text: 'Welcome, Alice!',
    });

    const msg = await trap.waitForMessage({ subject: 'Welcome to My App!' });

    expect(msg.to[0]?.email).toBe('alice@example.com');
    expect(msg.from[0]?.email).toBe('noreply@myapp.dev');
    expect(msg.html).toContain('<h1>Welcome, Alice!</h1>');
    expect(msg.text).toBe('Welcome, Alice!');

    await mail.shutdown();
  });

  it('captures both text and HTML parts', async () => {
    const mail = makeMail();

    await mail.send({
      from: 'noreply@myapp.dev',
      to: 'bob@example.com',
      subject: 'Multipart test',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    });

    const msg = await trap.waitForMessage({ to: 'bob@example.com' });
    expect(msg.text).toBe('Plain text body');
    expect(msg.html).toContain('<p>HTML body</p>');

    await mail.shutdown();
  });
});

describe('alert email flow', () => {
  it('delivers alert to multiple recipients', async () => {
    const mail = makeMail();

    await mail.alert({
      from: 'monitoring@myapp.dev',
      to: ['ops@myapp.dev', 'cto@myapp.dev'],
      subject: 'Disk usage critical',
      text: 'Disk at 91%',
    });

    // Subject is auto-prefixed with [ALERT] by mail.alert()
    const msg = await trap.waitForMessage({ subject: /\[ALERT\] Disk usage critical/ });

    expect(msg.to).toHaveLength(2);
    expect(msg.to.map(a => a.email)).toContain('ops@myapp.dev');
    expect(msg.to.map(a => a.email)).toContain('cto@myapp.dev');

    await mail.shutdown();
  });
});

describe('attachment handling', () => {
  it('captures attachment filename and content', async () => {
    const mail = makeMail();

    await mail.send({
      from: 'billing@myapp.dev',
      to: 'alice@example.com',
      subject: 'Invoice #1042',
      text: 'Please find your invoice attached.',
      attachments: [
        {
          filename: 'invoice-1042.txt',
          content: 'Amount: $49.00',
          contentType: 'text/plain',
        },
      ],
    });

    const msg = await trap.waitForMessage({ subject: 'Invoice #1042' });

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe('invoice-1042.txt');
    expect(msg.attachments[0]?.content.toString()).toBe('Amount: $49.00');

    await mail.shutdown();
  });
});

describe('template email flow', () => {
  it('renders template variables into the sent HTML', async () => {
    const mail = makeMail();

    await mail.sendTemplate({
      from: 'noreply@myapp.dev',
      to: 'carol@example.com',
      subject: 'Password reset',
      template: '<p>Hi {{name}}, click <a href="{{link}}">here</a> to reset your password.</p>',
      data: { name: 'Carol', link: 'https://myapp.dev/reset/abc123' },
    });

    const msg = await trap.waitForMessage({ to: 'carol@example.com' });

    expect(msg.html).toContain('Hi Carol');
    expect(msg.html).toContain('https://myapp.dev/reset/abc123');

    await mail.shutdown();
  });
});

describe('waitForMessage edge cases', () => {
  it('matches subject by regex', async () => {
    const mail = makeMail();

    await mail.send({
      from: 'noreply@myapp.dev',
      to: 'dave@example.com',
      subject: 'Order #99182 confirmed',
      text: 'Your order is confirmed.',
    });

    const msg = await trap.waitForMessage({ subject: /Order #\d+ confirmed/ });
    expect(msg.subject).toMatch(/Order #\d+ confirmed/);

    await mail.shutdown();
  });

  it('rejects when no matching message arrives within the timeout', async () => {
    await expect(
      trap.waitForMessage({ subject: 'this subject will never arrive', timeoutMs: 200 }),
    ).rejects.toThrow(/waitForMessage timed out/);
  });

  it('store is cleared between tests so messages do not bleed across tests', () => {
    // Each test gets a clean store because useTrapServer registers afterEach(() => store.clear())
    expect(trap.messages()).toHaveLength(0);
  });
});
