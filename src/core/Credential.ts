import type { MailAuth, TokenContext } from '../types/auth.js';
import { ConfigError } from '../errors.js';

const REDACTED = '[REDACTED]';

/**
 * Sealed credential value-object.
 * Private class fields (#) guarantee values are inaccessible outside this class.
 * toString/toJSON always return '[REDACTED]' to prevent accidental logging.
 * Auth buffers are zeroed after encoding to minimise memory residue.
 * OAuth tokens from `getToken` are never stored — they are fetched per use.
 */
export class Credential {
  readonly #user: string;
  readonly #pass: string;
  readonly #token: string;
  readonly #getToken: MailAuth['getToken'];
  readonly type: MailAuth['type'];

  private constructor(auth: MailAuth) {
    this.type = auth.type;
    this.#user = auth.user;
    this.#pass = auth.pass ?? '';
    this.#token = auth.token ?? '';
    this.#getToken = auth.getToken;
  }

  static from(auth: MailAuth): Credential {
    if (!auth || typeof auth.user !== 'string') throw new ConfigError('auth.user is required');
    if (auth.type === 'xoauth2' && !auth.token && typeof auth.getToken !== 'function') {
      throw new ConfigError('xoauth2 auth requires `token` or `getToken`');
    }
    return new Credential(auth);
  }

  get user(): string {
    return this.#user;
  }

  /** `true` when a token provider is configured (so a rejected token can be refreshed). */
  get canRefresh(): boolean {
    return typeof this.#getToken === 'function';
  }

  /** Build AUTH PLAIN payload — `\0user\0pass` — then zeros the working buffer. */
  buildPlainPayload(): string {
    return encode(`\0${this.#user}\0${this.#pass}`);
  }

  /** Build AUTH LOGIN username payload. */
  buildLoginUser(): string {
    return encode(this.#user);
  }

  /** Build AUTH LOGIN password payload. */
  buildLoginPass(): string {
    return encode(this.#pass);
  }

  /** Raw password — only for protocols that need it unencoded (IMAP LOGIN). */
  revealPassword(): string {
    return this.#pass;
  }

  /** Resolve the current OAuth access token (from `getToken` or the static `token`). */
  async resolveToken(ctx: Omit<TokenContext, 'user'>): Promise<string> {
    if (this.#getToken) {
      const token = await this.#getToken({ ...ctx, user: this.#user });
      if (typeof token !== 'string' || !token) throw new ConfigError('getToken() returned an empty token');
      return token;
    }
    return this.#token;
  }

  /** Build XOAUTH2 payload for `token` (defaults to the static token). */
  buildXOAuth2Payload(token: string = this.#token): string {
    return encode(`user=${this.#user}\x01auth=Bearer ${token}\x01\x01`);
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

function encode(raw: string): string {
  const buf = Buffer.from(raw, 'utf8');
  const result = buf.toString('base64');
  buf.fill(0);
  return result;
}

/** Decode an XOAUTH2 error challenge (base64 JSON) into `{ status, scope }`. */
export function parseXOAuth2Error(challenge: string): { status?: string; scope?: string; raw: string } {
  const raw = Buffer.from(challenge.trim(), 'base64').toString('utf8');
  try {
    const j = JSON.parse(raw) as { status?: string; scope?: string };
    return { status: j.status, scope: j.scope, raw };
  } catch {
    return { raw };
  }
}
