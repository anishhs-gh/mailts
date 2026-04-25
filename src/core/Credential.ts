import type { SmtpAuth } from '../types/smtp.js';

const REDACTED = '[REDACTED]';

/**
 * Sealed credential value-object.
 * Private class fields (#) guarantee values are inaccessible outside this class.
 * toString/toJSON always return '[REDACTED]' to prevent accidental logging.
 * Auth buffers are zeroed after encoding to minimise memory residue.
 */
export class Credential {
  readonly #user: string;
  readonly #pass: string;
  readonly #token: string;
  readonly type: SmtpAuth['type'];

  private constructor(auth: SmtpAuth) {
    this.type = auth.type;
    this.#user = auth.user;
    this.#pass = auth.pass ?? '';
    this.#token = auth.token ?? '';
  }

  static from(auth: SmtpAuth): Credential {
    return new Credential(auth);
  }

  get user(): string {
    return this.#user;
  }

  /** Build AUTH PLAIN payload — `\0user\0pass` — then zeros the working buffer. */
  buildPlainPayload(): string {
    const raw = `\0${this.#user}\0${this.#pass}`;
    const buf = Buffer.from(raw, 'utf8');
    const result = buf.toString('base64');
    buf.fill(0);
    return result;
  }

  /** Build AUTH LOGIN username payload. */
  buildLoginUser(): string {
    const buf = Buffer.from(this.#user, 'utf8');
    const result = buf.toString('base64');
    buf.fill(0);
    return result;
  }

  /** Build AUTH LOGIN password payload. */
  buildLoginPass(): string {
    const buf = Buffer.from(this.#pass, 'utf8');
    const result = buf.toString('base64');
    buf.fill(0);
    return result;
  }

  /** Build XOAUTH2 payload. */
  buildXOAuth2Payload(): string {
    const raw = `user=${this.#user}\x01auth=Bearer ${this.#token}\x01\x01`;
    const buf = Buffer.from(raw, 'utf8');
    const result = buf.toString('base64');
    buf.fill(0);
    return result;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}
