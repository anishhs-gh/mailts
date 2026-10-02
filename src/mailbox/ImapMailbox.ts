import { EventEmitter } from 'events';
import type { ImapSession } from '../imap/ImapSession.js';
import type { ImapMessage, ImapSearchCriteria } from '../types/imap.js';
import type {
  Mailbox,
  MailFolder,
  MailFolderStatus,
  MailFetchOptions,
  MailMessage,
  MailSearch,
  MailAppendOptions,
  MailWatcher,
} from './Mailbox.js';

const INBOX = 'INBOX';

function toCriteria(s: MailSearch = {}): ImapSearchCriteria {
  const c: ImapSearchCriteria = {};
  if (s.seen !== undefined) c.seen = s.seen;
  if (s.flagged !== undefined) c.flagged = s.flagged;
  if (s.from) c.from = s.from;
  if (s.to) c.to = s.to;
  if (s.subject) c.subject = s.subject;
  if (s.text) c.text = s.text;
  if (s.since) c.since = s.since;
  if (s.before) c.before = s.before;
  return c;
}

const uids = (ids: string[]) => ids.map(Number).filter(n => Number.isInteger(n) && n > 0);

function toMail(m: ImapMessage, mailbox: string): MailMessage {
  return {
    id: String(m.uid),
    mailbox,
    flags: m.flags,
    envelope: m.envelope,
    date: m.internalDate ?? m.envelope.date,
    size: m.size,
    ...(m.body ? { body: m.body } : {}),
  };
}

/**
 * Expose an `ImapSession` through the provider-neutral `Mailbox` interface.
 * Ids are UIDs as strings (unique within a mailbox — pass `mailbox` along).
 */
export function imapMailbox(session: ImapSession): Mailbox {
  const box = (m?: string) => m ?? INBOX;
  return {
    provider: 'imap',

    async listMailboxes(): Promise<MailFolder[]> {
      return (await session.listMailboxes())
        .filter(b => !b.flags.some(f => f.toLowerCase() === '\\noselect'))
        .map(b => ({ id: b.name, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) }));
    },

    findMailbox: (specialUse) => session.findMailbox(specialUse),

    async status(mailbox?: string): Promise<MailFolderStatus> {
      const s = await session.getStatus(box(mailbox), ['MESSAGES', 'UNSEEN']);
      return { total: s.messages, unread: s.unseen };
    },

    async fetch(opts: MailFetchOptions = {}): Promise<MailMessage[]> {
      const mailbox = box(opts.mailbox);
      const messages = await session.fetch({
        mailbox,
        ...(opts.ids ? { uids: uids(opts.ids) } : { search: toCriteria(opts.search), limit: opts.limit ?? 50 }),
        ...(opts.bodies ? { bodies: true } : { headers: ['References'] }),
      });
      return messages.sort((a, b) => b.uid - a.uid).map(m => toMail(m, mailbox));
    },

    async search(criteria: MailSearch, mailbox?: string): Promise<string[]> {
      return (await session.search(toCriteria(criteria), box(mailbox))).map(String);
    },

    fetchRaw: (id, mailbox) => session.fetchRaw(Number(id), box(mailbox)),
    setSeen: (ids, seen, mailbox) => session.setFlags(uids(ids), ['\\Seen'], seen, box(mailbox)),
    setFlagged: (ids, flagged, mailbox) => session.setFlags(uids(ids), ['\\Flagged'], flagged, box(mailbox)),
    move: (ids, destination, mailbox) => session.move(uids(ids), destination, box(mailbox)),
    delete: (ids, mailbox) => session.delete(uids(ids), box(mailbox)),

    async append(mailbox: string, raw: Buffer, opts: MailAppendOptions = {}): Promise<{ id?: string }> {
      const flags = [...(opts.seen ?? true ? ['\\Seen'] : []), ...(opts.draft ? ['\\Draft'] : [])];
      const res = await session.append(mailbox, raw, flags);
      return res.uid !== undefined ? { id: String(res.uid) } : {};
    },

    async watch(mailbox?: string): Promise<MailWatcher> {
      const watcher = await session.watch(box(mailbox));
      const out = new EventEmitter() as MailWatcher;
      out.on('error', () => {});
      watcher.on('new', (u: number[]) => out.emit('new', u.map(String)));
      watcher.on('error', (e: Error) => out.emit('error', e));
      out.stop = () => watcher.stop();
      return out;
    },

    close: () => session.close(),
  };
}
