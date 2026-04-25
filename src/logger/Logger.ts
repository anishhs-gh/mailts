import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { LogEvent, LogLevel, LogPhase, LogDirection, LoggerOptions, LogFormat } from '../types/logger.js';
import { LOG_LEVELS } from '../types/logger.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const PHASE_COLORS: Record<LogPhase, string> = {
  smtp: '\x1b[34m',
  imap: '\x1b[35m',
  queue: '\x1b[33m',
  core: '\x1b[37m',
  cli: '\x1b[36m',
};

function formatPretty(e: LogEvent): string {
  const ts = e.timestamp.toISOString();
  const level = `${COLORS[e.level]}${e.level.toUpperCase().padEnd(5)}${RESET}`;
  const phase = `${PHASE_COLORS[e.phase]}[${e.phase.toUpperCase()}]${RESET}`;
  const dir = e.direction ? ` ${DIM}${e.direction === 'C' ? 'C→S' : 'S→C'}${RESET}` : '';
  return `${DIM}${ts}${RESET} ${level} ${phase}${dir} ${BOLD}${e.message}${RESET}`;
}

function formatJson(e: LogEvent): string {
  return JSON.stringify({
    level: e.level,
    timestamp: e.timestamp.toISOString(),
    phase: e.phase,
    ...(e.direction ? { direction: e.direction } : {}),
    message: e.message,
    ...(e.meta ? { meta: e.meta } : {}),
  });
}

function formatRaw(e: LogEvent): string {
  const dir = e.direction ? ` [${e.direction}]` : '';
  return `[${e.phase.toUpperCase()}]${dir} ${e.message}`;
}

/**
 * Structured event logger used internally by mailts.
 *
 * Subscribe via `onEvent(fn)` for typed `LogEvent` objects, or call
 * `stream()` to get a `Readable` of formatted log lines.
 * `pretty()` writes ANSI-coloured output directly to stdout/stderr.
 */
export class Logger extends EventEmitter {
  private minLevel: number;
  private format: LogFormat;
  readonly protocol: boolean;
  private streams: Readable[] = [];

  constructor(opts: LoggerOptions = {}) {
    super();
    this.minLevel = LOG_LEVELS[opts.level ?? 'info'];
    this.format = opts.format ?? 'pretty';
    this.protocol = opts.protocol ?? false;
  }

  /** Update the log level and/or format at runtime. */
  configure(opts: LoggerOptions): void {
    if (opts.level !== undefined) this.minLevel = LOG_LEVELS[opts.level];
    if (opts.format !== undefined) this.format = opts.format;
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  /** Subscribe to all `LogEvent` objects (typed alternative to `.on('event', …)`). */
  onEvent(listener: (e: LogEvent) => void): this {
    return super.on('event', listener as (...args: unknown[]) => void);
  }

  private write(e: LogEvent): void {
    if (LOG_LEVELS[e.level] < this.minLevel) return;
    this.emit('event', e);
    for (const s of this.streams) {
      if (!s.destroyed) s.push(e);
    }
  }

  /** Emit a log event at the given level. Skipped if below `minLevel`. */
  log(level: LogLevel, phase: LogPhase, message: string, meta?: Record<string, unknown>): void {
    const event: LogEvent = { level, timestamp: new Date(), phase, message };
    if (meta !== undefined) event.meta = meta;
    this.write(event);
  }

  /** Log a raw protocol line (C→S or S→C). Only emits when `protocol: true` is set. */
  proto(direction: LogDirection, phase: LogPhase, line: string): void {
    if (!this.protocol) return;
    this.write({ level: 'debug', timestamp: new Date(), phase, direction, message: line });
  }

  /** @deprecated Use onEvent() for typed log events */
  override addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.addListener(event, listener);
  }

  /** Log at `debug` level. */
  debug(phase: LogPhase, message: string, meta?: Record<string, unknown>): void {
    this.log('debug', phase, message, meta);
  }

  /** Log at `info` level. */
  info(phase: LogPhase, message: string, meta?: Record<string, unknown>): void {
    this.log('info', phase, message, meta);
  }

  /** Log at `warn` level. */
  warn(phase: LogPhase, message: string, meta?: Record<string, unknown>): void {
    this.log('warn', phase, message, meta);
  }

  /** Log at `error` level. */
  error(phase: LogPhase, message: string, meta?: Record<string, unknown>): void {
    this.log('error', phase, message, meta);
  }

  /**
   * Return a `Readable` stream of formatted log lines.
   * Each push is a string (`'json'`/`'pretty'`/`'raw'`) or raw `LogEvent` object.
   */
  stream(opts: { format?: LogFormat } = {}): Readable {
    const fmt = opts.format ?? this.format;
    const readable = new Readable({
      objectMode: true,
      read() {},
    });

    const onEvent = (e: LogEvent) => {
      if (readable.destroyed) return;
      if (fmt === 'json') {
        readable.push(formatJson(e) + '\n');
      } else if (fmt === 'pretty') {
        readable.push(formatPretty(e) + '\n');
      } else if (fmt === 'raw') {
        readable.push(formatRaw(e) + '\n');
      } else {
        readable.push(e);
      }
    };

    this.onEvent(onEvent);
    readable.on('close', () => this.removeListener('event', onEvent));
    readable.on('error', () => this.removeListener('event', onEvent));

    return readable;
  }

  /** Register a listener that writes ANSI-coloured log lines to stdout/stderr. */
  pretty(): void {
    this.onEvent((e: LogEvent) => {
      if (LOG_LEVELS[e.level] < this.minLevel) return;
      const line = formatPretty(e);
      if (e.level === 'error') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });
  }
}
