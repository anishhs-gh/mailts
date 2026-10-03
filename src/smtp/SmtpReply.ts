/**
 * A parsed SMTP reply — one or more lines sharing the same 3-digit code.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export class SmtpReply {
  /** Three-digit reply code, e.g. `250`. */
  readonly code: number;
  /** Raw reply lines including the code. */
  readonly lines: readonly string[];

  constructor(code: number, lines: string[]) {
    this.code = code;
    this.lines = lines;
  }

  /** Reply text without codes, lines joined by `\n`. */
  get text(): string {
    return this.lines.map(l => l.slice(4).trim()).join('\n');
  }

  /** First raw line. */
  get firstLine(): string {
    return this.lines[0] ?? '';
  }

  /** 2xx or 3xx. */
  isPositive(): boolean {
    return this.code >= 200 && this.code < 400;
  }

  /** 4xx — temporary failure, retry later. */
  isTransient(): boolean {
    return this.code >= 400 && this.code < 500;
  }

  /** 5xx — permanent failure. */
  isPermanent(): boolean {
    return this.code >= 500;
  }
}
