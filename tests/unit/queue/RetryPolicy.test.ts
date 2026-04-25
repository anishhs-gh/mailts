import { describe, it, expect } from 'vitest';
import { RetryPolicy } from '../../../src/queue/RetryPolicy.js';
import { SmtpAuthError, SmtpConnError } from '../../../src/errors.js';

describe('RetryPolicy', () => {
  it('allows retry up to maxRetries', () => {
    const p = new RetryPolicy({ maxRetries: 3 });
    expect(p.shouldRetry(0, new SmtpConnError('conn'))).toBe(true);
    expect(p.shouldRetry(2, new SmtpConnError('conn'))).toBe(true);
    expect(p.shouldRetry(3, new SmtpConnError('conn'))).toBe(true);  // 3rd retry still within limit
    expect(p.shouldRetry(4, new SmtpConnError('conn'))).toBe(false); // exceeds maxRetries
  });

  it('does not retry non-retryable errors', () => {
    const p = new RetryPolicy({ maxRetries: 10 });
    const err = new SmtpAuthError('bad auth', 535, []);
    expect(p.shouldRetry(0, err)).toBe(false);
  });

  it('exponential backoff increases delay', () => {
    const p = new RetryPolicy({ backoff: 'exponential', initialDelay: 1000, jitter: false });
    const d0 = p.delayFor(0);
    const d1 = p.delayFor(1);
    const d2 = p.delayFor(2);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('linear backoff scales linearly', () => {
    const p = new RetryPolicy({ backoff: 'linear', initialDelay: 500, jitter: false });
    expect(p.delayFor(0)).toBe(500);
    expect(p.delayFor(1)).toBe(1000);
    expect(p.delayFor(2)).toBe(1500);
  });

  it('fixed backoff stays constant', () => {
    const p = new RetryPolicy({ backoff: 'fixed', initialDelay: 250, jitter: false });
    expect(p.delayFor(0)).toBe(250);
    expect(p.delayFor(5)).toBe(250);
  });

  it('caps at maxDelay', () => {
    const p = new RetryPolicy({
      backoff: 'exponential',
      initialDelay: 1000,
      maxDelay: 5000,
      jitter: false,
    });
    for (let i = 0; i < 20; i++) {
      expect(p.delayFor(i)).toBeLessThanOrEqual(5000);
    }
  });

  it('jitter adds randomness', () => {
    const p = new RetryPolicy({ backoff: 'fixed', initialDelay: 1000, jitter: true });
    const delays = new Set(Array.from({ length: 20 }, () => p.delayFor(0)));
    expect(delays.size).toBeGreaterThan(1);
  });
});
