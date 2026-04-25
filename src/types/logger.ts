export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogPhase = 'smtp' | 'imap' | 'queue' | 'core' | 'cli';
export type LogDirection = 'C' | 'S';

export interface LogEvent {
  level: LogLevel;
  timestamp: Date;
  phase: LogPhase;
  direction?: LogDirection;
  message: string;
  meta?: Record<string, unknown>;
}

export type LogFormat = 'json' | 'pretty' | 'raw';

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  protocol?: boolean;
}

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
