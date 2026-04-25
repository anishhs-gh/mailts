/** A parsed SMTP reply — one or more lines sharing the same 3-digit code. */
export class SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];

  constructor(code: number, lines: string[]) {
    this.code = code;
    this.lines = lines;
  }

  get text(): string {
    return this.lines.map(l => l.slice(4).trim()).join('\n');
  }

  get firstLine(): string {
    return this.lines[0] ?? '';
  }

  isPositive(): boolean {
    return this.code >= 200 && this.code < 400;
  }

  isTransient(): boolean {
    return this.code >= 400 && this.code < 500;
  }

  isPermanent(): boolean {
    return this.code >= 500;
  }
}
