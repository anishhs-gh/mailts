/**
 * Reply and forward builders — return plain `EmailOptions`, so the result works
 * with `send()`, the queue, drafts (`appendMessage`) and every transport.
 */
import type { EmailAddress, EmailOptions, Attachment } from '../types/core.js';
import type { ImapAttachment, ImapEnvelope, ImapMessage } from '../types/imap.js';
import type { ParsedMessage } from './MimeParser.js';
import { parseAddress } from './Address.js';
import { htmlToText } from './HtmlToText.js';
import { MimeError } from '../errors.js';

/** A message to reply to / forward: fetched (`bodies: true`) or parsed. */
export type SourceMessage = ImapMessage | ParsedMessage;

interface Normalized {
  envelope: ImapEnvelope;
  text?: string;
  html?: string;
  attachments: ImapAttachment[];
  references: string[];
}

function normalize(m: SourceMessage): Normalized {
  if ('root' in m) {
    return { envelope: m.envelope, text: m.text, html: m.html, attachments: m.attachments, references: m.references };
  }
  return {
    envelope: m.envelope,
    text: m.body?.text,
    html: m.body?.html,
    attachments: m.body?.attachments ?? [],
    references: m.envelope.references ?? [],
  };
}

// Reply/forward prefixes in common mail clients and languages
const PREFIX = /^\s*((re|aw|sv|antw|vs|odp|ref|rif|res|wg|fwd?|tr|rv|enc|doorst)(\[\d+\])?\s*:\s*)+/i;

/** Strip any run of reply/forward prefixes (`Re: AW: Fwd:` …). */
export function stripSubjectPrefixes(subject: string): string {
  return subject.replace(PREFIX, '').trim();
}

const MAX_REFERENCES = 20;

function addr(a: EmailAddress): { email: string; name?: string } {
  const p = parseAddress(a);
  return p.name ? { email: p.email, name: p.name } : { email: p.email };
}

function dedupeAddrs(list: EmailAddress[], exclude: Set<string>): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of list) {
    const p = addr(a);
    const key = p.email.toLowerCase();
    if (exclude.has(key)) continue;
    exclude.add(key);
    out.push(p);
  }
  return out;
}

function quoteText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map(l => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n');
}

function displayAddr(list: EmailAddress[]): string {
  return list.map(a => { const p = addr(a); return p.name ? `${p.name} <${p.email}>` : p.email; }).join(', ');
}

function defaultQuoteHeader(env: ImapEnvelope): string {
  const who = displayAddr(env.from.slice(0, 1)) || 'someone';
  const when = env.date ? env.date.toUTCString() : 'an earlier date';
  return `On ${when}, ${who} wrote:`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Options for `buildReply()`. */
export interface ReplyOptions {
  /** Your address (the reply's sender). */
  from: EmailAddress;
  /** Reply text, placed above the quote. */
  text?: string;
  /** Reply html, placed above the quoted html. */
  html?: string;
  /** Reply to everyone: original To and Cc (minus yourself) are included. @default false */
  replyAll?: boolean;
  /** Quote the original below the reply. @default true */
  quote?: boolean;
  /** Line above the quote. Default: `On <date>, <sender> wrote:` */
  quoteHeader?: (envelope: ImapEnvelope) => string;
  /** Your addresses (aliases) to drop from reply-all. Defaults to `from`. */
  me?: string[];
  /** Files to attach to the reply. */
  attachments?: Attachment[];
}

/**
 * Build a reply that stays in the thread (In-Reply-To + References), with a
 * normalised `Re:` subject, correct reply / reply-all recipients and quoting.
 *
 * @example
 * ```ts
 * const [orig] = await session.fetch({ uids: [uid], bodies: true, headers: ['References'] });
 * await mail.send(buildReply(orig, { from: 'me@x.com', text: 'Thanks!', replyAll: true }), { saveToSent: true });
 * ```
 */
export function buildReply(original: SourceMessage, opts: ReplyOptions): EmailOptions {
  if (opts.text === undefined && opts.html === undefined) throw new MimeError('buildReply needs text or html');
  const o = normalize(original);
  const env = o.envelope;
  const me = new Set([addr(opts.from).email, ...(opts.me ?? [])].map(e => e.toLowerCase()));

  const replyTarget = env.replyTo.length ? env.replyTo : env.from;
  const seen = new Set(me);
  let to = dedupeAddrs(replyTarget, seen);
  let cc: EmailAddress[] = [];
  if (opts.replyAll) {
    to = [...to, ...dedupeAddrs(env.to, seen)];
    cc = dedupeAddrs(env.cc, seen);
  }
  if (to.length === 0) {
    // Replying to your own message: go back to its original recipients
    to = dedupeAddrs(env.to, new Set());
  }

  const subject = `Re: ${stripSubjectPrefixes(env.subject)}`;
  const messageId = env.messageId ?? undefined;
  const references = [...o.references, ...(messageId ? [messageId] : [])]
    .filter((id, i, a) => a.indexOf(id) === i)
    .slice(-MAX_REFERENCES);

  const quote = opts.quote ?? true;
  const header = (opts.quoteHeader ?? defaultQuoteHeader)(env);
  let text = opts.text;
  let html = opts.html;
  if (quote) {
    const origText = o.text ?? (o.html ? htmlToText(o.html) : '');
    if (text !== undefined && origText) text = `${text}\n\n${header}\n${quoteText(origText)}\n`;
    if (html !== undefined) {
      const origHtml = o.html ?? (o.text ? `<pre>${escapeHtml(o.text)}</pre>` : '');
      if (origHtml) html = `${html}\n<div class="mailts-quote"><p>${escapeHtml(header)}</p>\n<blockquote type="cite">${origHtml}</blockquote></div>`;
    }
  }

  return {
    from: opts.from,
    to,
    ...(cc.length ? { cc } : {}),
    subject,
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(references.length ? { references } : {}),
    ...(opts.attachments ? { attachments: opts.attachments } : {}),
  };
}

/** Options for `buildForward()`. */
export interface ForwardOptions {
  /** Your address (the forward's sender). */
  from: EmailAddress;
  /** Recipients of the forward. */
  to: EmailAddress | EmailAddress[];
  /** Cc recipients. */
  cc?: EmailAddress | EmailAddress[];
  /** Your note above the forwarded message. */
  text?: string;
  /** Your note as html. */
  html?: string;
  /**
   * `inline` (default): quote the original with a forwarded-message header and
   * re-attach its files (inline images included).
   * `attachment`: attach the original unchanged as `message/rfc822` — needs `raw`.
   */
  mode?: 'inline' | 'attachment';
  /** Original RFC 5322 source (`session.fetchRaw(uid)`), required for `mode: 'attachment'`. */
  raw?: Buffer;
  /** Extra files to attach. */
  attachments?: Attachment[];
}

/**
 * Build a forward of `original` with a normalised `Fwd:` subject.
 *
 * @example
 * ```ts
 * const raw = await session.fetchRaw(uid);
 * await mail.send(buildForward(parseMessage(raw), { from, to: 'boss@x.com', text: 'FYI', mode: 'attachment', raw }));
 * ```
 */
export function buildForward(original: SourceMessage, opts: ForwardOptions): EmailOptions {
  const o = normalize(original);
  const env = o.envelope;
  const subject = `Fwd: ${stripSubjectPrefixes(env.subject)}`;
  const mode = opts.mode ?? 'inline';
  const extra = opts.attachments ?? [];

  if (mode === 'attachment') {
    if (!opts.raw) throw new MimeError("buildForward mode 'attachment' needs the original `raw` source");
    const name = `${stripSubjectPrefixes(env.subject).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || 'message'}.eml`;
    return {
      from: opts.from,
      to: opts.to,
      ...(opts.cc ? { cc: opts.cc } : {}),
      subject,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.html !== undefined ? { html: opts.html } : {}),
      attachments: [...extra, { filename: name, rfc822: opts.raw }],
    };
  }

  const lines = [
    '---------- Forwarded message ---------',
    `From: ${displayAddr(env.from)}`,
    ...(env.date ? [`Date: ${env.date.toUTCString()}`] : []),
    `Subject: ${env.subject}`,
    `To: ${displayAddr(env.to)}`,
    ...(env.cc.length ? [`Cc: ${displayAddr(env.cc)}`] : []),
  ];
  const origText = o.text ?? (o.html ? htmlToText(o.html) : '');
  const text = `${opts.text ?? ''}\n\n${lines.join('\n')}\n\n${origText}`.replace(/^\n+/, '');
  const origHtml = o.html ?? (o.text ? `<pre>${escapeHtml(o.text)}</pre>` : '');
  const html = opts.html !== undefined || o.html
    ? `${opts.html ?? (opts.text ? `<p>${escapeHtml(opts.text)}</p>` : '')}\n<div class="mailts-forward"><p>${lines.map(escapeHtml).join('<br>')}</p>\n${origHtml}</div>`
    : undefined;

  // Re-attach the original's files; inline (cid) images keep their Content-ID
  const carried: Attachment[] = o.attachments
    .filter(a => a.content !== undefined && !a.nestedMessage)
    .map(a => ({
      filename: a.filename,
      content: a.content!,
      contentType: a.contentType,
      ...(a.inline && a.contentId ? { cid: a.contentId } : {}),
    }));
  const forwardedEmails: Attachment[] = o.attachments
    .filter(a => a.nestedMessage && a.content)
    .map(a => ({ filename: a.filename, rfc822: a.content! }));

  return {
    from: opts.from,
    to: opts.to,
    ...(opts.cc ? { cc: opts.cc } : {}),
    subject,
    text,
    ...(html !== undefined ? { html } : {}),
    attachments: [...extra, ...carried, ...forwardedEmails],
  };
}
