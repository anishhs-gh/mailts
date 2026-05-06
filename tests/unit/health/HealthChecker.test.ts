import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthChecker } from '../../../src/health/HealthChecker.js';

vi.mock('../../../src/smtp/SmtpClient.js', () => ({
  SmtpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    verify:  vi.fn().mockResolvedValue(true),
    quit:    vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/imap/ImapSession.js', () => ({
  ImapSession: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    open:    vi.fn().mockResolvedValue({ exists: 10, unseen: 2 }),
    close:   vi.fn().mockResolvedValue(undefined),
  })),
}));

const smtpCfg = { host: 'smtp.example.com', port: 587 } as any;
const imapCfg = { host: 'imap.example.com', port: 993, secure: true } as any;

describe('HealthChecker', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── checkSmtp ──────────────────────────────────────────────────────────────

  it('checkSmtp returns ok=true and measured latency', async () => {
    const checker = new HealthChecker(smtpCfg, null);
    const result = await checker.checkSmtp();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('checkSmtp returns ok=false when connect throws', async () => {
    const { SmtpClient } = await import('../../../src/smtp/SmtpClient.js');
    vi.mocked(SmtpClient).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      verify:  vi.fn(),
      quit:    vi.fn().mockResolvedValue(undefined),
    }));

    const checker = new HealthChecker(smtpCfg, null);
    const result = await checker.checkSmtp();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('checkSmtp returns ok=false with error when not configured', async () => {
    const checker = new HealthChecker(null, null);
    const result = await checker.checkSmtp();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SMTP not configured');
    expect(result.latencyMs).toBe(0);
  });

  it('checkSmtp always calls quit even on verify failure', async () => {
    const quitFn = vi.fn().mockResolvedValue(undefined);
    const { SmtpClient } = await import('../../../src/smtp/SmtpClient.js');
    vi.mocked(SmtpClient).mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      verify:  vi.fn().mockRejectedValue(new Error('auth fail')),
      quit:    quitFn,
    }));

    const checker = new HealthChecker(smtpCfg, null);
    await checker.checkSmtp();
    expect(quitFn).toHaveBeenCalled();
  });

  // ── checkImap ──────────────────────────────────────────────────────────────

  it('checkImap returns ok=true when connect+open succeed', async () => {
    const checker = new HealthChecker(null, imapCfg);
    const result = await checker.checkImap();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('checkImap returns ok=false when connect throws', async () => {
    const { ImapSession } = await import('../../../src/imap/ImapSession.js');
    vi.mocked(ImapSession).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      open:    vi.fn(),
      close:   vi.fn().mockResolvedValue(undefined),
    }));

    const checker = new HealthChecker(null, imapCfg);
    const result = await checker.checkImap();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ETIMEDOUT');
  });

  it('checkImap returns ok=false with error when not configured', async () => {
    const checker = new HealthChecker(null, null);
    const result = await checker.checkImap();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('IMAP not configured');
  });

  // ── check() ───────────────────────────────────────────────────────────────

  it('check() runs smtp and imap concurrently when both configured', async () => {
    const checker = new HealthChecker(smtpCfg, imapCfg);
    const result = await checker.check();
    expect(result.smtp).toBeDefined();
    expect(result.imap).toBeDefined();
    expect(result.smtp!.ok).toBe(true);
    expect(result.imap!.ok).toBe(true);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('check() omits smtp when not configured', async () => {
    const checker = new HealthChecker(null, imapCfg);
    const result = await checker.check();
    expect(result.smtp).toBeUndefined();
    expect(result.imap).toBeDefined();
  });

  it('check() omits imap when not configured', async () => {
    const checker = new HealthChecker(smtpCfg, null);
    const result = await checker.check();
    expect(result.smtp).toBeDefined();
    expect(result.imap).toBeUndefined();
  });

  it('check() returns only timestamp when nothing configured', async () => {
    const checker = new HealthChecker(null, null);
    const result = await checker.check();
    expect(result.smtp).toBeUndefined();
    expect(result.imap).toBeUndefined();
    expect(result.timestamp).toBeDefined();
  });
});
