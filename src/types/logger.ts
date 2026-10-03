/** Minimum severity to emit. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Subsystem that produced a log event. */
export type LogPhase = 'smtp' | 'imap' | 'queue' | 'core' | 'cli';
/** Protocol trace direction: `C` = client → server, `S` = server → client. */
export type LogDirection = 'C' | 'S';

/** One structured log entry (credentials are redacted before it is emitted). */
export interface LogEvent {
  /** Severity. */
  level: LogLevel;
  /** When it happened. */
  timestamp: Date;
  /** Subsystem. */
  phase: LogPhase;
  /** Set on protocol trace lines (`protocol: true`). */
  direction?: LogDirection;
  /** Human-readable text, or the raw protocol line. */
  message: string;
  /** Structured context (ids, sizes, error codes). */
  meta?: Record<string, unknown>;
}

/** Output format: `json` (one object per line), `pretty` (coloured, human) or `raw` (`[PHASE] message`, no timestamp). */
export type LogFormat = 'json' | 'pretty' | 'raw';

/** `MailTs({ logger })` options. */
export interface LoggerOptions {
  /** Minimum level. @default 'info' */
  level?: LogLevel;
  /** Output format. @default 'pretty' */
  format?: LogFormat;
  /** Also log every SMTP/IMAP command and reply (credentials redacted). @default false */
  protocol?: boolean;
}

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
