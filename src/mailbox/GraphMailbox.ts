import { parseMessage } from '../core/MimeParser.js';
import { authorizedRequest } from '../transports/ApiAuth.js';
import { assertOk, parseJson } from '../transports/utils.js';
import type { HttpResponse } from '../transports/HttpClient.js';
import { MailTsError } from '../errors.js';
import type { TokenProvider } from '../types/auth.js';
import type { ImapEnvelope } from '../types/imap.js';
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


/**
 * Options for `new GraphMailbox()`.
 * @experimental Not yet verified against a live Microsoft 365 tenant.
 */
export interface GraphMailboxConfig {
  /** Mailbox (UPN / email). Also passed to `getToken`. */
  user: string;
  /**
   * Graph access-token provider — delegated (`Mail.ReadWrite` + `Mail.Send`,
   * e.g. `microsoft({ api: 'graph' })`) or app-only (application permissions).
   */
  getToken: TokenProvider;
  /** @default 'https://graph.microsoft.com/v1.0' */
  baseUrl?: string;
}

/** Graph well-known folder names → IMAP-style roles. */
const WELL_KNOWN: Record<string, string | undefined> = {
  inbox: undefined,
  sentitems: '\\Sent',
  drafts: '\\Drafts',
  deleteditems: '\\Trash',
  junkemail: '\\Junk',
  archive: '\\Archive',
};
/** Common names callers use → Graph well-known names. */
const ALIASES: Record<string, string> = {
  inbox: 'inbox', sent: 'sentitems', 'sent items': 'sentitems', drafts: 'drafts', trash: 'deleteditems',
  'deleted items': 'deleteditems', junk: 'junkemail', spam: 'junkemail', 'junk email': 'junkemail', archive: 'archive',
};
const ROLE_TO_WELL_KNOWN: Record<string, string> = {
  '\\sent': 'sentitems', '\\drafts': 'drafts', '\\trash': 'deleteditems', '\\junk': 'junkemail', '\\archive': 'archive',
};

interface GraphAddress { emailAddress?: { name?: string; address?: string } }
interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphAddress;
  sender?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  bccRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  internetMessageId?: string;
  conversationId?: string;
  bodyPreview?: string;
}

const SELECT = 'id,subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,isDraft,flag,internetMessageId,conversationId,bodyPreview';

const addrs = (list?: GraphAddress[]) => (list ?? [])
  .filter(a => a.emailAddress?.address)
  .map(a => ({ email: a.emailAddress!.address!, ...(a.emailAddress!.name ? { name: a.emailAddress!.name } : {}) }));

const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const kql = (s: string) => s.replace(/["\\]/g, ' ').trim();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Microsoft 365 / Outlook.com mailbox over Microsoft Graph, implementing the
 * provider-neutral `Mailbox` interface.
 *
 * Limitations (Graph API):
 * - `append()` creates **drafts only** (Graph cannot create non-draft messages).
 * - `listMailboxes()` returns top-level folders.
 * - `watch()` polls (`receivedDateTime`); push needs Graph subscriptions with a public webhook.
 *
 * @experimental Not yet verified against a live Microsoft 365 tenant.
 */
export class GraphMailbox implements Mailbox {
  readonly provider = 'graph' as const;
  private readonly base: string;
  private folderCache: Map<string, string> | null = null; // lower-cased name / well-known → id

  constructor(private readonly config: GraphMailboxConfig) {
    const root = (config.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
    this.base = `${root}/users/${encodeURIComponent(config.user)}`;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private async call(method: string, path: string, body?: unknown, raw?: { contentType: string; data: string }): Promise<HttpResponse> {
    const res = await authorizedRequest('graph', { ...this.config, protocol: 'graph' }, {
      method,
      url: path.startsWith('http') ? path : `${this.base}${path}`,
      headers: raw
        ? { 'Content-Type': raw.contentType }
        : body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(raw ? { body: raw.data } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assertOk('graph', res);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return parseJson<T>('graph', await this.call(method, path, body));
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  private async folders(): Promise<Map<string, string>> {
    if (this.folderCache) return this.folderCache;
    const map = new Map<string, string>();
    const list = await this.json<{ value: Array<{ id: string; displayName: string }> }>('GET', '/mailFolders?$top=250');
    for (const f of list.value) map.set(f.displayName.toLowerCase(), f.id);
    for (const wk of Object.keys(WELL_KNOWN)) {
      try {
        const f = await this.json<{ id: string }>('GET', `/mailFolders/${wk}?$select=id`);
        map.set(wk, f.id);
      } catch { /* folder not present (e.g. no archive) */ }
    }
    this.folderCache = map;
    return map;
  }

  /** Resolve a folder id, display name, well-known name or alias (INBOX, Sent, Trash…). */
  private async folderId(mailbox?: string): Promise<string> {
    const name = (mailbox ?? 'inbox').trim();
    const lower = name.toLowerCase();
    const wk = ALIASES[lower] ?? (lower in WELL_KNOWN ? lower : undefined);
    if (wk) return wk; // Graph accepts well-known names directly in paths
    const map = await this.folders();
    return map.get(lower) ?? name; // assume it is already an id
  }

  async listMailboxes(): Promise<MailFolder[]> {
    const map = await this.folders();
    const roleById = new Map<string, string>();
    for (const [wk, role] of Object.entries(WELL_KNOWN)) {
      const id = map.get(wk);
      if (id && role) roleById.set(id, role);
    }
    const list = await this.json<{ value: Array<{ id: string; displayName: string }> }>('GET', '/mailFolders?$top=250');
    return list.value.map(f => ({ id: f.id, name: f.displayName, ...(roleById.has(f.id) ? { specialUse: roleById.get(f.id)! } : {}) }));
  }

  async findMailbox(specialUse: string): Promise<string | undefined> {
    const wk = ROLE_TO_WELL_KNOWN[specialUse.toLowerCase()];
    if (!wk) return undefined;
    return (await this.folders()).get(wk);
  }

  async status(mailbox?: string): Promise<MailFolderStatus> {
    const f = await this.json<{ totalItemCount?: number; unreadItemCount?: number }>(
      'GET', `/mailFolders/${encodeURIComponent(await this.folderId(mailbox))}?$select=totalItemCount,unreadItemCount`);
    return { total: f.totalItemCount, unread: f.unreadItemCount };
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Graph query: $search (KQL) for text criteria, otherwise $filter + $orderby. */
  private query(search: MailSearch = {}, top: number): string {
    const p = new URLSearchParams({ $top: String(Math.min(Math.max(top, 1), 1000)), $select: SELECT });
    const terms: string[] = [];
    if (search.from) terms.push(`from:${kql(search.from)}`);
    if (search.to) terms.push(`to:${kql(search.to)}`);
    if (search.subject) terms.push(`subject:${kql(search.subject)}`);
    if (search.text) terms.push(kql(search.text));
    if (terms.length) {
      if (search.since) terms.push(`received>=${isoDay(search.since)}`);
      if (search.before) terms.push(`received<${isoDay(search.before)}`);
      p.set('$search', `"${terms.join(' AND ')}"`);
      return p.toString(); // $search cannot be combined with $filter/$orderby; seen/flagged filtered locally
    }
    // Graph rejects $filter + $orderby ("InefficientFilter") unless the $orderby
    // property also appears first in $filter — so receivedDateTime always leads.
    const filters: string[] = [`receivedDateTime ge ${(search.since ?? new Date(0)).toISOString()}`];
    if (search.before) filters.push(`receivedDateTime lt ${search.before.toISOString()}`);
    if (search.seen !== undefined) filters.push(`isRead eq ${search.seen}`);
    if (search.flagged !== undefined) filters.push(search.flagged ? `flag/flagStatus eq 'flagged'` : `flag/flagStatus ne 'flagged'`);
    p.set('$filter', filters.join(' and '));
    p.set('$orderby', 'receivedDateTime desc');
    return p.toString();
  }

  private toMail(m: GraphMessage, mailbox: string): MailMessage {
    const envelope: ImapEnvelope = {
      date: m.sentDateTime ? new Date(m.sentDateTime) : null,
      subject: m.subject ?? '',
      from: addrs(m.from ? [m.from] : []),
      sender: addrs(m.sender ? [m.sender] : []),
      replyTo: addrs(m.replyTo),
      to: addrs(m.toRecipients),
      cc: addrs(m.ccRecipients),
      bcc: addrs(m.bccRecipients),
      inReplyTo: null,
      messageId: m.internetMessageId ?? null,
    };
    const flags = [
      ...(m.isRead ? ['\\Seen'] : []),
      ...(m.flag?.flagStatus === 'flagged' ? ['\\Flagged'] : []),
      ...(m.isDraft ? ['\\Draft'] : []),
    ];
    return {
      id: m.id,
      mailbox,
      flags,
      envelope,
      date: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
      ...(m.conversationId ? { threadId: m.conversationId } : {}),
      ...(m.bodyPreview ? { snippet: m.bodyPreview } : {}),
    };
  }

  private async withBody(msg: MailMessage): Promise<MailMessage> {
    const parsed = parseMessage(await this.fetchRaw(msg.id));
    return {
      ...msg,
      envelope: { ...msg.envelope, inReplyTo: parsed.envelope.inReplyTo, references: parsed.references },
      body: { text: parsed.text, html: parsed.html, attachments: parsed.attachments },
    };
  }

  async fetch(opts: MailFetchOptions = {}): Promise<MailMessage[]> {
    const folder = await this.folderId(opts.mailbox);
    const label = opts.mailbox ?? 'INBOX';
    let messages: MailMessage[];
    if (opts.ids) {
      messages = [];
      for (const id of opts.ids) {
        messages.push(this.toMail(await this.json<GraphMessage>('GET', `/messages/${encodeURIComponent(id)}?$select=${SELECT}`), label));
      }
    } else {
      const limit = opts.limit ?? 50;
      const res = await this.json<{ value: GraphMessage[] }>(
        'GET', `/mailFolders/${encodeURIComponent(folder)}/messages?${this.query(opts.search, limit)}`);
      messages = res.value.map(m => this.toMail(m, label)).filter(m => matchesLocal(m, opts.search)).slice(0, limit);
    }
    if (!opts.bodies) return messages;
    const out: MailMessage[] = [];
    for (const m of messages) out.push(await this.withBody(m));
    return out;
  }

  async search(criteria: MailSearch, mailbox?: string): Promise<string[]> {
    return (await this.fetch({ mailbox, search: criteria, limit: 1000 })).map(m => m.id);
  }

  async fetchRaw(id: string): Promise<Buffer> {
    const res = await this.call('GET', `/messages/${encodeURIComponent(id)}/$value`);
    return res.raw;
  }

  // ── Changes ──────────────────────────────────────────────────────────────

  async setSeen(ids: string[], seen: boolean): Promise<void> {
    for (const id of ids) await this.call('PATCH', `/messages/${encodeURIComponent(id)}`, { isRead: seen });
  }

  async setFlagged(ids: string[], flagged: boolean): Promise<void> {
    for (const id of ids) {
      await this.call('PATCH', `/messages/${encodeURIComponent(id)}`, { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } });
    }
  }

  async move(ids: string[], destination: string): Promise<void> {
    const destinationId = await this.folderId(destination);
    for (const id of ids) await this.call('POST', `/messages/${encodeURIComponent(id)}/move`, { destinationId });
  }

  async delete(ids: string[]): Promise<void> {
    await this.move(ids, 'deleteditems');
  }

  async append(mailbox: string, raw: Buffer, opts: MailAppendOptions = {}): Promise<{ id?: string }> {
    const folder = await this.folderId(mailbox);
    if (!opts.draft && folder !== 'drafts') {
      throw new MailTsError('Graph can only create drafts — append to Drafts or pass { draft: true }', 'EQUEUE', false);
    }
    // MIME create: base64 MIME as text/plain; Graph stores it as a draft in Drafts
    const res = await this.call('POST', '/messages', undefined, { contentType: 'text/plain', data: raw.toString('base64') });
    const created = parseJson<{ id: string }>('graph', res);
    return { id: created.id };
  }

  async watch(mailbox?: string, opts: { pollMs?: number } = {}): Promise<MailWatcher> {
    const folder = await this.folderId(mailbox);
    let since: string | null = null;
    const seen = new Set<string>();
    const check = async (): Promise<string[]> => {
      if (since === null) {
        since = new Date().toISOString(); // baseline: only report mail arriving from now on
        return [];
      }
      const p = new URLSearchParams({
        $filter: `receivedDateTime ge ${since}`,
        $orderby: 'receivedDateTime asc',
        $select: 'id,receivedDateTime',
        $top: '100',
      });
      const res = await this.json<{ value: Array<{ id: string; receivedDateTime: string }> }>(
        'GET', `/mailFolders/${encodeURIComponent(folder)}/messages?${p}`);
      const fresh = res.value.filter(m => !seen.has(m.id));
      for (const m of fresh) { seen.add(m.id); since = m.receivedDateTime; }
      if (seen.size > 5_000) seen.clear();
      return fresh.map(m => m.id);
    };
    return new PollingWatcher(check, opts.pollMs ?? 30_000).start();
  }

  async close(): Promise<void> { /* stateless HTTP — nothing to close */ }
}

/** Seen / flagged are applied locally when Graph's $search was used. */
function matchesLocal(m: MailMessage, s: MailSearch = {}): boolean {
  if (s.seen !== undefined && m.flags.includes('\\Seen') !== s.seen) return false;
  if (s.flagged !== undefined && m.flags.includes('\\Flagged') !== s.flagged) return false;
  return true;
}
