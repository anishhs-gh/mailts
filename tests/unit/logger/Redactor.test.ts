import { describe, it, expect, beforeEach } from 'vitest';
import { Redactor } from '../../../src/logger/Redactor.js';

describe('Redactor', () => {
  let r: Redactor;

  beforeEach(() => { r = new Redactor(); });

  it('redacts AUTH PLAIN payload', () => {
    const line = 'AUTH PLAIN AGFsaWNlAHNlY3JldA==';
    expect(r.redact(line, 'C')).toBe('AUTH PLAIN [REDACTED]');
  });

  it('redacts AUTH LOGIN command', () => {
    const line = 'AUTH LOGIN dXNlcg==';
    const result = r.redact(line, 'C');
    expect(result).not.toContain('dXNlcg==');
  });

  it('passes safe lines through unchanged', () => {
    expect(r.redact('250 OK', 'S')).toBe('250 OK');
    expect(r.redact('EHLO mailts.local', 'C')).toBe('EHLO mailts.local');
    expect(r.redact('MAIL FROM:<user@example.com>', 'C')).toBe('MAIL FROM:<user@example.com>');
  });

  it('redacts 334 continuation base64 challenge', () => {
    const line = '334 VXNlcm5hbWU6';
    const result = r.redact(line, 'S');
    expect(result).toBe('334 [REDACTED]');
  });

  it('redacts XOAUTH2 payload', () => {
    const line = 'AUTH XOAUTH2 dXNlcj10ZXN0QGV4YW1wbGUuY29t';
    const result = r.redact(line, 'C');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('dXNlcj10ZXN0QGV4YW1wbGUuY29t');
  });

  it('handles AUTH LOGIN multi-step flow', () => {
    // Step 1: AUTH LOGIN
    const step1 = r.redact('AUTH LOGIN', 'C');
    expect(step1).toBe('AUTH LOGIN');

    // Step 2: 334 challenge
    r.redact('334 VXNlcm5hbWU6', 'S');

    // Step 3: client sends username base64
    const step3 = r.redact('dXNlckBleGFtcGxlLmNvbQ==', 'C');
    expect(step3).toBe('[REDACTED]');

    // Step 4: 334 password challenge
    r.redact('334 UGFzc3dvcmQ6', 'S');

    // Step 5: client sends password base64
    const step5 = r.redact('c2VjcmV0', 'C');
    expect(step5).toBe('[REDACTED]');
  });

  it('resets state on reset()', () => {
    r.redact('AUTH LOGIN', 'C');
    r.reset();
    // After reset, bare base64 on its own line should not be redacted
    const result = r.redact('SomePlainText', 'C');
    expect(result).toBe('SomePlainText');
  });

  describe('static clean', () => {
    it('cleans AUTH PLAIN', () => {
      expect(Redactor.clean('AUTH PLAIN abc123')).toBe('AUTH PLAIN [REDACTED]');
    });
  });
});
