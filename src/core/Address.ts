import type { EmailAddress } from '../types/core.js';
import { ConfigError } from '../errors.js';

// RFC 5321 / 5322 — basic validation: local@domain where domain has at least one dot.
const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]{2,}$/;

export interface ParsedAddress {
  email: string;
  name: string | undefined;
}

/** Strip \r and \n from any string to prevent header injection. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/**
 * Parse a single `EmailAddress` (string or object) into `{ email, name }`.
 * Handles both `"Name <addr>"` format and plain `"addr@example.com"`.
 * Strips `\r\n` to prevent header injection.
 */
export function parseAddress(addr: EmailAddress): ParsedAddress {
  if (typeof addr === 'string') {
    const trimmed = addr.trim();
    // Handle "Name <email>" format
    const match = trimmed.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    if (match) {
      const name = sanitizeHeader(match[1]?.trim() ?? '');
      const email = sanitizeHeader(match[2]?.trim() ?? '');
      return { email, name: name || undefined };
    }
    return { email: sanitizeHeader(trimmed), name: undefined };
  }
  return {
    email: sanitizeHeader(addr.email.trim()),
    name: addr.name ? sanitizeHeader(addr.name.trim()) : undefined,
  };
}

/**
 * Serialize an `EmailAddress` to an RFC 5322 formatted string.
 * Non-ASCII display names are RFC 2047 Q-encoded.
 * Special characters in display names are quoted.
 */
export function formatAddress(addr: EmailAddress): string {
  const { email, name } = parseAddress(addr);
  if (!name) return email;
  // Encode non-ASCII display names with RFC 2047 UTF-8 Q-encoding
  if (/[^\x20-\x7E]/.test(name)) {
    return `=?UTF-8?Q?${encodeQWord(name)}?= <${email}>`;
  }
  // Quote display names that contain special characters
  if (/[,;"<>()[\]]/.test(name)) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${email}>`;
  }
  return `${name} <${email}>`;
}

/**
 * Throws `ConfigError` if `email` fails basic RFC 5321 validation.
 * Validates `local@domain.tld` shape — does not check DNS.
 */
export function validateEmail(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new ConfigError(`Invalid email address: "${email}"`);
  }
}

/**
 * Parse an address field that may be a single address or an array.
 * Returns an empty array when `field` is `undefined`.
 * `fallbackName` is applied to the first address when it has no display name.
 */
export function parseAddressList(
  field: EmailAddress | EmailAddress[] | undefined,
  fallbackName?: string,
): ParsedAddress[] {
  if (!field) return [];
  const arr = Array.isArray(field) ? field : [field];
  return arr.map((a, i) => {
    const parsed = parseAddress(a);
    if (!parsed.name && fallbackName && i === 0) parsed.name = fallbackName;
    return parsed;
  });
}

/** Serialize a list of parsed addresses to a comma-separated RFC 5322 header value. */
export function formatAddressList(addrs: ParsedAddress[]): string {
  return addrs.map(a => formatAddress(a.name ? { email: a.email, name: a.name } : a.email)).join(', ');
}

function encodeQWord(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('hex')
    .replace(/../g, hex => `=${hex.toUpperCase()}`);
}

/** Extract all bare email strings from an address field (for RCPT TO). */
export function extractEmails(field: EmailAddress | EmailAddress[] | undefined): string[] {
  return parseAddressList(field).map(a => a.email);
}
