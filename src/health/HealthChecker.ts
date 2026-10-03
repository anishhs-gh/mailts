import { SmtpClient } from '../smtp/SmtpClient.js';
import { ImapSession } from '../imap/ImapSession.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { ImapConfig } from '../types/imap.js';
import type { Logger } from '../logger/Logger.js';

/** Result of an SMTP probe (connect + EHLO + NOOP). */
export interface SmtpHealth {
  /** `true` when connecting and logging in succeeded. */
  ok: boolean;
  /** Time taken, in ms. */
  latencyMs: number;
  /** Why the probe failed. */
  error?: string;
}
/** Result of an IMAP probe (connect + login + SELECT INBOX). */
export interface ImapHealth {
  /** `true` when login and SELECT succeeded. */
  ok: boolean;
  /** Time taken, in ms. */
  latencyMs: number;
  /** Why the probe failed. */
  error?: string;
}
/** Combined result of `check()`. Only configured protocols are present. */
export interface HealthResult {
  /** SMTP probe, when SMTP is configured. */
  smtp?: SmtpHealth;
  /** IMAP probe, when IMAP is configured. */
  imap?: ImapHealth;
  /** ISO 8601 time of the check. */
  timestamp: string;
}

/**
 * Probes SMTP and IMAP connectivity with real logins — for liveness/readiness endpoints.
 * `mail.health()` uses it; construct it directly for custom probes. Never throws; failures are reported.
 */
export class HealthChecker {
  constructor(
    private readonly smtpConfig: SmtpConfig | null,
    private readonly imapConfig: ImapConfig | null,
    private readonly logger?: Logger,
  ) {}

  /** Connect (including STARTTLS and login), NOOP and QUIT on a fresh connection. */
  async checkSmtp(): Promise<SmtpHealth> {
    if (!this.smtpConfig) return { ok: false, latencyMs: 0, error: 'SMTP not configured' };
    const t0 = Date.now();
    const client = new SmtpClient(this.smtpConfig, this.logger);
    try {
      await client.connect();
      await client.verify();
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await client.quit().catch(() => {});
    }
  }

  /** Connect, log in, SELECT INBOX and log out on a fresh connection. */
  async checkImap(): Promise<ImapHealth> {
    if (!this.imapConfig) return { ok: false, latencyMs: 0, error: 'IMAP not configured' };
    const t0 = Date.now();
    const session = new ImapSession(this.imapConfig, this.logger);
    try {
      await session.connect();
      await session.open('INBOX');
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await session.close().catch(() => {});
    }
  }

  /** Probe every configured protocol in parallel. */
  async check(): Promise<HealthResult> {
    const result: HealthResult = { timestamp: new Date().toISOString() };
    const [smtp, imap] = await Promise.all([
      this.smtpConfig ? this.checkSmtp() : Promise.resolve(undefined),
      this.imapConfig ? this.checkImap() : Promise.resolve(undefined),
    ]);
    if (smtp) result.smtp = smtp;
    if (imap) result.imap = imap;
    return result;
  }
}
