import { SmtpClient } from '../smtp/SmtpClient.js';
import { ImapSession } from '../imap/ImapSession.js';
import type { SmtpConfig } from '../types/smtp.js';
import type { ImapConfig } from '../types/imap.js';
import type { Logger } from '../logger/Logger.js';

export interface SmtpHealth { ok: boolean; latencyMs: number; error?: string; }
export interface ImapHealth  { ok: boolean; latencyMs: number; error?: string; }
export interface HealthResult {
  smtp?: SmtpHealth;
  imap?: ImapHealth;
  timestamp: string;
}

export class HealthChecker {
  constructor(
    private readonly smtpConfig: SmtpConfig | null,
    private readonly imapConfig: ImapConfig | null,
    private readonly logger?: Logger,
  ) {}

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
