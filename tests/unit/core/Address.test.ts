import { describe, it, expect } from 'vitest';
import { parseAddress, formatAddress, extractEmails, validateEmail } from '../../../src/core/Address.js';
import { ConfigError } from '../../../src/errors.js';

describe('Address', () => {
  describe('parseAddress', () => {
    it('parses bare email string', () => {
      expect(parseAddress('user@example.com')).toEqual({ email: 'user@example.com', name: undefined });
    });

    it('parses "Name <email>" format', () => {
      expect(parseAddress('"John Doe" <john@example.com>')).toEqual({
        email: 'john@example.com',
        name: 'John Doe',
      });
    });

    it('parses Name <email> without quotes', () => {
      const result = parseAddress('John Doe <john@example.com>');
      expect(result.email).toBe('john@example.com');
      expect(result.name).toBe('John Doe');
    });

    it('parses object form', () => {
      expect(parseAddress({ email: 'a@b.com', name: 'Alice' })).toEqual({
        email: 'a@b.com',
        name: 'Alice',
      });
    });

    it('strips CR and LF from addresses (injection prevention)', () => {
      const result = parseAddress('user@example.com\r\nBcc: attacker@evil.com');
      expect(result.email).not.toContain('\r');
      expect(result.email).not.toContain('\n');
    });
  });

  describe('formatAddress', () => {
    it('formats bare email', () => {
      expect(formatAddress('user@example.com')).toBe('user@example.com');
    });

    it('formats name + email', () => {
      expect(formatAddress({ email: 'user@example.com', name: 'Alice' })).toBe('Alice <user@example.com>');
    });

    it('quotes names with special chars', () => {
      const formatted = formatAddress({ email: 'u@e.com', name: 'Doe, John' });
      expect(formatted).toMatch(/"Doe, John"/);
    });
  });

  describe('extractEmails', () => {
    it('extracts from string array', () => {
      expect(extractEmails(['a@b.com', 'c@d.com'])).toEqual(['a@b.com', 'c@d.com']);
    });

    it('extracts from object array', () => {
      expect(extractEmails([{ email: 'a@b.com', name: 'A' }])).toEqual(['a@b.com']);
    });

    it('returns [] for undefined', () => {
      expect(extractEmails(undefined)).toEqual([]);
    });
  });

  describe('validateEmail', () => {
    it('accepts valid emails', () => {
      expect(() => validateEmail('user@example.com')).not.toThrow();
      expect(() => validateEmail('a+tag@sub.domain.io')).not.toThrow();
    });

    it('rejects invalid emails', () => {
      expect(() => validateEmail('notanemail')).toThrow(ConfigError);
      expect(() => validateEmail('@nodomain')).toThrow(ConfigError);
      expect(() => validateEmail('no@tld')).toThrow(ConfigError);
    });
  });
});
