import type { EmailAddress, Attachment } from '../types/core.js';
import { resolveAttachment } from '../core/Attachment.js';

/** Normalise an EmailAddress (or array) to an array of `"Name <email>"` strings. */
export function toAddressStrings(addr: EmailAddress | EmailAddress[] | undefined): string[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map(a =>
    typeof a === 'string' ? a : a.name ? `${a.name} <${a.email}>` : a.email,
  );
}

/** Normalise to `{ email, name? }` objects — used by SendGrid. */
export function toAddressObjects(addr: EmailAddress | EmailAddress[] | undefined): { email: string; name?: string }[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map(a =>
    typeof a === 'string' ? { email: a } : { email: a.email, name: a.name },
  );
}

export interface ResolvedApiAttachment {
  filename: string;
  contentType: string;
  cid?: string;
  data: Buffer;
}

/** Resolve all attachments to in-memory Buffers for use in HTTP API payloads. */
export async function resolveApiAttachments(
  attachments: Attachment[],
): Promise<ResolvedApiAttachment[]> {
  return Promise.all(
    attachments
      .filter(a => a.rfc822 === undefined) // rfc822 handled separately per provider
      .map(async (att) => {
        const r = await resolveAttachment(att);
        const data = await r.getContent();
        return { filename: r.filename, contentType: r.contentType, cid: r.cid, data };
      }),
  );
}
