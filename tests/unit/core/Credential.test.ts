import { describe, it, expect } from 'vitest';
import { Credential } from '../../../src/core/Credential.js';

describe('Credential', () => {
  const auth = { type: 'plain' as const, user: 'user@example.com', pass: 'secret123' };

  it('builds PLAIN payload as base64 \\0user\\0pass', () => {
    const cred = Credential.from(auth);
    const payload = cred.buildPlainPayload();
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    expect(decoded).toBe('\0user@example.com\0secret123');
  });

  it('builds LOGIN user and pass separately', () => {
    const cred = Credential.from(auth);
    const user = Buffer.from(cred.buildLoginUser(), 'base64').toString('utf8');
    const pass = Buffer.from(cred.buildLoginPass(), 'base64').toString('utf8');
    expect(user).toBe('user@example.com');
    expect(pass).toBe('secret123');
  });

  it('builds XOAUTH2 payload', () => {
    const cred = Credential.from({ type: 'xoauth2', user: 'u@x.com', token: 'tok123' });
    const payload = cred.buildXOAuth2Payload();
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    expect(decoded).toContain('user=u@x.com');
    expect(decoded).toContain('auth=Bearer tok123');
  });

  it('hides credentials from toString', () => {
    const cred = Credential.from(auth);
    expect(String(cred)).toBe('[REDACTED]');
    expect(`${cred}`).toBe('[REDACTED]');
  });

  it('hides credentials from JSON.stringify', () => {
    const cred = Credential.from(auth);
    const json = JSON.stringify({ cred });
    expect(json).toBe('{"cred":"[REDACTED]"}');
    expect(json).not.toContain('secret123');
    expect(json).not.toContain('user@example.com');
  });

  it('exposes user but not pass', () => {
    const cred = Credential.from(auth);
    expect(cred.user).toBe('user@example.com');
  });

  it('toPrimitive returns REDACTED', () => {
    const cred = Credential.from(auth);
    expect(cred[Symbol.toPrimitive]()).toBe('[REDACTED]');
  });
});
