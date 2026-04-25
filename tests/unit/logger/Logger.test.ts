import { describe, it, expect } from 'vitest';
import { Logger } from '../../../src/logger/Logger.js';
import type { LogEvent } from '../../../src/types/logger.js';

describe('Logger', () => {
  it('emits events at correct log level', () => {
    const logger = new Logger({ level: 'info' });
    const events: LogEvent[] = [];
    logger.onEvent(e => events.push(e));

    logger.debug('core', 'debug message');
    logger.info('core', 'info message');
    logger.warn('core', 'warn message');
    logger.error('core', 'error message');

    expect(events).toHaveLength(3); // debug filtered out
    expect(events[0]!.level).toBe('info');
    expect(events[1]!.level).toBe('warn');
    expect(events[2]!.level).toBe('error');
  });

  it('includes timestamp, phase, message', () => {
    const logger = new Logger({ level: 'debug' });
    const events: LogEvent[] = [];
    logger.onEvent(e => events.push(e));

    logger.info('smtp', 'test message', { key: 'val' });

    expect(events[0]!.timestamp).toBeInstanceOf(Date);
    expect(events[0]!.phase).toBe('smtp');
    expect(events[0]!.message).toBe('test message');
    expect(events[0]!.meta?.['key']).toBe('val');
  });

  it('logs protocol events only when protocol=true', () => {
    const logger = new Logger({ level: 'debug', protocol: true });
    const events: LogEvent[] = [];
    logger.onEvent(e => events.push(e));

    logger.proto('C', 'smtp', 'EHLO test.local');
    expect(events).toHaveLength(1);
    expect(events[0]!.direction).toBe('C');

    const noProto = new Logger({ level: 'debug', protocol: false });
    const events2: LogEvent[] = [];
    noProto.onEvent(e => events2.push(e));
    noProto.proto('C', 'smtp', 'EHLO test.local');
    expect(events2).toHaveLength(0);
  });

  it('stream() returns a Readable emitting JSON strings', async () => {
    const logger = new Logger({ level: 'debug' });
    const stream = logger.stream({ format: 'json' });

    const chunks: string[] = [];
    const done = new Promise<void>(resolve => {
      stream.on('data', (d: string) => chunks.push(d));
      stream.on('end', resolve);
    });

    logger.info('queue', 'test event');
    stream.destroy();

    await new Promise(r => setImmediate(r));

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed['level']).toBe('info');
    expect(parsed['message']).toBe('test event');
  });

  it('configure() updates log level', () => {
    const logger = new Logger({ level: 'error' });
    const events: LogEvent[] = [];
    logger.onEvent(e => events.push(e));

    logger.warn('core', 'should be filtered');
    logger.configure({ level: 'debug' });
    logger.warn('core', 'should pass now');

    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe('should pass now');
  });
});
