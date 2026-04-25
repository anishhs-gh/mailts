const REDACTED = '[REDACTED]';

// Patterns that match credential payloads in SMTP protocol lines.
// These are applied to raw protocol lines before they reach any log sink.
const PATTERNS: RegExp[] = [
  // AUTH PLAIN <base64>
  /^(AUTH\s+PLAIN\s+)\S+$/i,
  // AUTH LOGIN response line (just a base64 string on its own after a 334)
  // We redact any standalone line that looks like raw base64 after AUTH LOGIN challenge
  /^(AUTH\s+LOGIN\s+)\S+$/i,
  // 334 continuation responses (base64 challenges — could reveal server info, keep safe)
  /^(334\s+)\S+$/,
  // XOAUTH2 bearer token payloads
  /^(AUTH\s+XOAUTH2\s+)\S+$/i,
  // Bare base64 lines (lines following AUTH LOGIN challenge — username/password stage)
  // Only redact if they look like base64 (no spaces, only base64 chars, length > 8)
];

const BARE_BASE64 = /^[A-Za-z0-9+/]{8,}={0,2}$/;

/**
 * Scrubs credential payloads from SMTP protocol lines.
 * Applied at the log-source level so credentials never reach the Logger pipeline.
 */
export class Redactor {
  private inAuthLoginFlow = false;
  private authLoginStep = 0;

  /**
   * Scrub credential payloads from a single SMTP protocol line.
   * Tracks multi-step AUTH LOGIN state so all challenge/response pairs are redacted.
   */
  redact(line: string, direction: 'C' | 'S'): string {
    // Track AUTH LOGIN multi-step flow
    if (/^AUTH\s+LOGIN/i.test(line) && direction === 'C') {
      this.inAuthLoginFlow = true;
      this.authLoginStep = 0;
      return line.replace(/^(AUTH\s+LOGIN\s+)\S+/i, `$1${REDACTED}`);
    }

    if (this.inAuthLoginFlow) {
      if (direction === 'S' && /^334\s/i.test(line)) {
        // Server challenge — safe to log but redact base64 payload
        this.authLoginStep++;
        return line.replace(/^(334\s+)\S+$/, `$1${REDACTED}`);
      }
      if (direction === 'C' && BARE_BASE64.test(line.trim()) && this.authLoginStep <= 2) {
        return REDACTED;
      }
      if (direction === 'S' && /^235\s/.test(line)) {
        this.inAuthLoginFlow = false;
        this.authLoginStep = 0;
      }
    }

    for (const pattern of PATTERNS) {
      if (pattern.test(line)) {
        return line.replace(pattern, `$1${REDACTED}`);
      }
    }

    return line;
  }

  /** Reset AUTH LOGIN tracking state — call before each new connection. */
  reset(): void {
    this.inAuthLoginFlow = false;
    this.authLoginStep = 0;
  }

  /** Stateless single-pass redaction — use when AUTH flow tracking is not needed. */
  static clean(value: string): string {
    for (const pattern of PATTERNS) {
      if (pattern.test(value)) {
        return value.replace(pattern, `$1${REDACTED}`);
      }
    }
    return value;
  }
}
