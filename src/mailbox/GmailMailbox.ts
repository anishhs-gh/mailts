import { parseMessage, MimeHeaders, envelopeFromHeaders } from '../core/MimeParser.js';
import { authorizedRequest } from '../transports/ApiAuth.js';
import { assertOk, parseJson } from '../transports/utils.js';
import type { HttpResponse } from '../transports/HttpClient.js';
import type { TokenProvider } from '../types/auth.js';
import {
  PollingWatcher,
  type Mailbox,
  type MailFolder,
  type MailFolderStatus,
  type MailFetchOptions,
  type MailMessage,
  type MailSearch,
  type MailAppendOptions,
  type MailWatcher,
} from './Mailbox.js';

export interface GmailMailboxConfig {
  /** Account address. Also passed to `getToken`. */
  user: string;
  /**
   * Gmail API token provider: `gmail.modify` (read/label/trash/send) or the full
   * `https://mail.google.com/` scope; `gmail.readonly` for read-only use.
   */
  getToken: TokenProvider;
  /** Parallel message requests when fetching. @default 5 */
  concurrency?: number;
  /** @default 'https://gmail.googleapis.com/gmail/v1' */
  baseUrl?: string;
}

/** System labels → IMAP-style roles. */
const ROLES: Record<string, string> = {
  SENT: '\\Sent', DRAFT: '\\Drafts', TRASH: '\\Trash', SPAM: '\\Junk', STARRED: '\\Flagged', IMPORTANT: '\\Important',
};
/** Common names callers use → Gmail system label ids. */
const ALIASES: Record<string, string> = {
  inbox: 'INBOX', sent: 'SENT', 'sent mail': 'SENT', drafts: 'DRAFT', draft: 'DRAFT', trash: 'TRASH',
  spam: 'SPAM', junk: 'SPAM', starred: 'STARRED', important: 'IMPORTANT',
};
const META_HEADERS = ['From', 'Sender', 'To', 'Cc', 'Bcc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'];

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

interface HistoryPage {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

const ymd = (d: Date) => `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
const quote = (s: string) => `"${s.replace(/["\\]/g, ' ').trim()}"`;

/** Translate provider-neutral criteria into Gmail search syntax. */
export function toGmailQuery(s: MailSearch = {}): string {
  const q: string[] = [];
  if (s.from) q.push(`from:${quote(s.from)}`);
  if (s.to) q.push(`to:${quote(s.to)}`);
  if (s.subject) q.push(`subject:${quote(s.subject)}`);
  if (s.text) q.push(quote(s.text));
  if (s.since) q.push(`after:${ymd(s.since)}`);
  if (s.before) q.push(`before:${ymd(s.before)}`);
  if (s.seen === true) q.push('-is:unread');
  if (s.seen === false) q.push('is:unread');
  if (s.flagged === true) q.push('is:starred');
  if (s.flagged === false) q.push('-is:starred');
  return q.join(' ');
}

/**
 * Gmail / Google Workspace mailbox over the Gmail API, implementing the
 * provider-neutral `Mailbox` interface. Mailboxes are labels.
 */
export class GmailMailbox implements Mailbox {
  readonly provider = 'gmail' as const;
  private readonly base: string;
  private labelCache: Map<string, string> | null = null; // lower-cased name → id

  constructor(private readonly config: GmailMailboxConfig) {
    this.base = `${(config.baseUrl ?? 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, '')}/users/me`;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private async call(method: string, path: string, body?: unknown): Promise<HttpResponse> {
    const res = await authorizedRequest('gmail', { ...this.config, protocol: 'gmail' }, {
      method,
      url: `${this.base}${path}`,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assertOk('gmail', res);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    return res.body ? parseJson<T>('gmail', res) : ({} as T);
  }

  private async pool<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(this.config.concurrency ?? 5, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  private async labels(): Promise<Map<string, string>> {
    if (this.labelCache) return this.labelCache;
    const res = await this.json<{ labels?: Array<{ id: string; name: string }> }>('GET', '/labels');
    this.labelCache = new Map((res.labels ?? []).map(l => [l.name.toLowerCase(), l.id]));
    return this.labelCache;
  }

  private async labelId(mailbox?: string): Promise<string> {
    const name = (mailbox ?? 'INBOX').trim();
    const alias = ALIASES[name.toLowerCase()];
    if (alias) return alias;
    return (await this.labels()).get(name.toLowerCase()) ?? name; // assume an id
  }

  async listMailboxes(): Promise<MailFolder[]> {
    const res = await this.json<{ labels?: Array<{ id: string; name: string; type?: string }> }>('GET', '/labels');
    this.labelCache = new Map((res.labels ?? []).map(l => [l.name.toLowerCase(), l.id]));
    return (res.labels ?? [])
      .filter(l => !/^CATEGORY_|^CHAT$|^UNREAD$/.test(l.id))
      .map(l => ({ id: l.id, name: l.name, ...(ROLES[l.id] ? { specialUse: ROLES[l.id] } : {}) }));
  }

  async findMailbox(specialUse: string): Promise<string | undefined> {
    const entry = Object.entries(ROLES).find(([, role]) => role.toLowerCase() === specialUse.toLowerCase());
    return entry?.[0];
  }

  async status(mailbox?: string): Promise<MailFolderStatus> {
    const l = await this.json<{ messagesTotal?: number; messagesUnread?: number }>('GET', `/labels/${encodeURIComponent(await this.labelId(mailbox))}`);
    return { total: l.messagesTotal, unread: l.messagesUnread };
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  private toMail(m: GmailMessage, mailbox: string): MailMessage {
    const block = (m.payload?.headers ?? []).map(h => `${h.name}: ${h.value}`).join('\r\n');
    const headers = new MimeHeaders(block);
    const labels = m.labelIds ?? [];
    return {
      id: m.id,
      mailbox,
      flags: [
        ...(labels.includes('UNREAD') ? [] : ['\\Seen']),
        ...(labels.includes('STARRED') ? ['\\Flagged'] : []),
        ...(labels.includes('DRAFT') ? ['\\Draft'] : []),
      ],
      envelope: envelopeFromHeaders(headers),
      date: m.internalDate ? new Date(Number(m.internalDate)) : null,
      ...(m.sizeEstimate !== undefined ? { size: m.sizeEstimate } : {}),
      ...(m.threadId ? { threadId: m.threadId } : {}),
      ...(m.snippet ? { snippet: m.snippet } : {}),
    };
  }

  private async getMessage(id: string, mailbox: string, bodies: boolean): Promise<MailMessage> {
    if (bodies) {
      const m = await this.json<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}?format=raw`);
      const parsed = parseMessage(Buffer.from(m.raw ?? '', 'base64url'));
      const meta = this.toMail(m, mailbox);
      return {
        ...meta,
        envelope: { ...parsed.envelope, references: parsed.references },
        body: { text: parsed.text, html: parsed.html, attachments: parsed.attachments },
      };
    }
    const q = new URLSearchParams({ format: 'metadata' });
    for (const h of META_HEADERS) q.append('metadataHeaders', h);
    return this.toMail(await this.json<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}?${q}`), mailbox);
  }

  async search(criteria: MailSearch, mailbox?: string, limit = 500): Promise<string[]> {
    const label = await this.labelId(mailbox);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ labelIds: label, maxResults: String(Math.min(limit - ids.length, 500)) });
      const query = toGmailQuery(criteria);
      if (query) q.set('q', query);
      if (label === 'TRASH' || label === 'SPAM') q.set('includeSpamTrash', 'true');
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.json<{ messages?: Array<{ id: string }>; nextPageToken?: string }>('GET', `/messages?${q}`);
      ids.push(...(res.messages ?? []).map(m => m.id));
      pageToken = res.nextPageToken;
    } while (pageToken && ids.length < limit);
    return ids;
  }

  async fetch(opts: MailFetchOptions = {}): Promise<MailMessage[]> {
    const label = opts.mailbox ?? 'INBOX';
    const ids = opts.ids ?? await this.search(opts.search ?? {}, opts.mailbox, opts.limit ?? 50);
    return this.pool(ids, id => this.getMessage(id, label, opts.bodies ?? false));
  }

  async fetchRaw(id: string): Promise<Buffer> {
    const m = await this.json<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}?format=raw`);
    return Buffer.from(m.raw ?? '', 'base64url');
  }

  // ── Changes ──────────────────────────────────────────────────────────────

  private async modify(ids: string[], add: string[], remove: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.call('POST', '/messages/batchModify', { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove });
    }
  }

  setSeen(ids: string[], seen: boolean): Promise<void> {
    return seen ? this.modify(ids, [], ['UNREAD']) : this.modify(ids, ['UNREAD'], []);
  }

  setFlagged(ids: string[], flagged: boolean): Promise<void> {
    return flagged ? this.modify(ids, ['STARRED'], []) : this.modify(ids, [], ['STARRED']);
  }

  /** Move = add the destination label and remove the source label (INBOX by default). */
  async move(ids: string[], destination: string, mailbox?: string): Promise<void> {
    const dest = await this.labelId(destination);
    if (dest === 'TRASH') return this.delete(ids);
    const source = await this.labelId(mailbox);
    await this.modify(ids, [dest], source === dest ? [] : [source]);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) await this.call('POST', `/messages/${encodeURIComponent(id)}/trash`);
  }

  async append(mailbox: string, raw: Buffer, opts: MailAppendOptions = {}): Promise<{ id?: string }> {
    const label = await this.labelId(mailbox);
    const encoded = raw.toString('base64url');
    if (opts.draft || label === 'DRAFT') {
      const d = await this.json<{ id: string; message?: { id: string } }>('POST', '/drafts', { message: { raw: encoded } });
      return { id: d.message?.id ?? d.id };
    }
    const labelIds = [label, ...(opts.seen ?? true ? [] : ['UNREAD'])];
    const m = await this.json<{ id: string }>('POST', '/messages?internalDateSource=dateHeader', { raw: encoded, labelIds });
    return { id: m.id };
  }

  /**
   * Poll Gmail history for messages added to `mailbox`. If history has expired
   * (HTTP 404), the watcher re-baselines and emits `reset`.
   */
  async watch(mailbox?: string, opts: { pollMs?: number } = {}): Promise<MailWatcher> {
    const label = await this.labelId(mailbox);
    let historyId: string | null = null;
    let watcher!: PollingWatcher;
    const check = async (): Promise<string[]> => {
      if (historyId === null) {
        historyId = (await this.json<{ historyId: string }>('GET', '/profile')).historyId;
        return [];
      }
      const ids: string[] = [];
      const start: string = historyId;
      let latest = start;
      let pageToken: string | undefined;
      try {
        do {
          const q = new URLSearchParams({ startHistoryId: start, historyTypes: 'messageAdded', labelId: label });
          if (pageToken) q.set('pageToken', pageToken);
          const res: HistoryPage = await this.json<HistoryPage>('GET', `/history?${q}`);
          for (const h of res.history ?? []) for (const a of h.messagesAdded ?? []) ids.push(a.message.id);
          if (res.historyId) latest = res.historyId;
          pageToken = res.nextPageToken;
        } while (pageToken);
        historyId = latest;
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          historyId = null;
          watcher.emit('reset');
          return [];
        }
        throw err;
      }
      return [...new Set(ids)];
    };
    watcher = new PollingWatcher(check, opts.pollMs ?? 30_000);
    return watcher.start();
  }

  async close(): Promise<void> { /* stateless HTTP */ }
}

