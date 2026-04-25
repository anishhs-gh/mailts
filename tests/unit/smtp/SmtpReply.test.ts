import { describe, it, expect } from 'vitest';
import { SmtpReply } from '../../../src/smtp/SmtpReply.js';

describe('SmtpReply', () => {
  it('extracts text from single line', () => {
    const r = new SmtpReply(250, ['250 OK']);
    expect(r.text).toBe('OK');
    expect(r.code).toBe(250);
    expect(r.isPositive()).toBe(true);
  });

  it('extracts text from multi-line reply', () => {
    const r = new SmtpReply(250, ['250-smtp.example.com', '250-SIZE 10485760', '250 OK']);
    expect(r.text).toContain('smtp.example.com');
    expect(r.lines).toHaveLength(3);
  });

  it('classifies transient errors', () => {
    const r = new SmtpReply(421, ['421 Service unavailable']);
    expect(r.isTransient()).toBe(true);
    expect(r.isPositive()).toBe(false);
  });

  it('classifies permanent errors', () => {
    const r = new SmtpReply(550, ['550 User does not exist']);
    expect(r.isPermanent()).toBe(true);
  });

  it('returns firstLine correctly', () => {
    const r = new SmtpReply(220, ['220 smtp.example.com ESMTP']);
    expect(r.firstLine).toBe('220 smtp.example.com ESMTP');
  });
});
