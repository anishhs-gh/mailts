import { astring, mailboxArg, Literal, type CommandPart } from './ImapTokenizer.js';
import { ImapError } from '../errors.js';

export type ImapSearchKey =
  | 'ALL' | 'SEEN' | 'UNSEEN' | 'FLAGGED' | 'UNFLAGGED'
  | 'ANSWERED' | 'UNANSWERED' | 'DELETED' | 'UNDELETED' | 'DRAFT' | 'UNDRAFT';

export interface ImapSearchQuery {
  seen?: boolean;
  unseen?: boolean;
  flagged?: boolean;
  unflagged?: boolean;
  answered?: boolean;
  deleted?: boolean;
  draft?: boolean;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  text?: string;
  since?: Date;
  before?: Date;
  on?: Date;
  sentSince?: Date;
  sentBefore?: Date;
  larger?: number;
  smaller?: number;
  uid?: string;       // raw UID set e.g. "1,3:5"
  header?: { name: string; value: string };
  keyword?: string;
  unkeyword?: string;
  not?: ImapSearchQuery;
  or?: [ImapSearchQuery, ImapSearchQuery];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP `date` (search): `1-Jan-2024`, in local time. */
function formatDate(d: Date): string {
  return `${d.getDate()}-${MONTHS[d.getMonth()]!}-${d.getFullYear()}`;
}

/** IMAP `date-time` (APPEND): `"01-Jan-2024 10:00:00 +0000"` in UTC. */
export function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `"${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]!}-${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000"`;
}

// eslint-disable-next-line no-control-regex
const FLAG_RE = /^\\?[^\s(){%*"\\\]\x00-\x1f\x7f]+$/;
const SEQ_SET_RE = /^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/;
const ATOM_RE = /^[A-Za-z0-9.\-_]+$/;

/**
 * Validate flags/keywords so user input can never inject protocol syntax.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function checkFlags(flags: readonly string[]): string {
  for (const f of flags) {
    if (!FLAG_RE.test(f)) throw new ImapError(`Invalid IMAP flag: ${JSON.stringify(f)}`);
  }
  return flags.join(' ');
}

export function checkSeqSet(set: string): string {
  if (!SEQ_SET_RE.test(set)) throw new ImapError(`Invalid IMAP sequence set: ${JSON.stringify(set)}`);
  return set;
}

function checkAtom(v: string, what: string): string {
  if (!ATOM_RE.test(v)) throw new ImapError(`Invalid IMAP ${what}: ${JSON.stringify(v)}`);
  return v;
}

/**
 * Build SEARCH criteria as command parts (literals for non-ASCII text).
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function buildSearchParts(query: ImapSearchQuery): CommandPart[] {
  const parts: CommandPart[] = [];
  const kw = (k: string) => parts.push(k);
  const str = (k: string, v: string) => parts.push(k, astring(v));

  if (query.seen === true)      kw('SEEN');
  if (query.seen === false || query.unseen === true) kw('UNSEEN');
  if (query.flagged === true)   kw('FLAGGED');
  if (query.flagged === false || query.unflagged === true) kw('UNFLAGGED');
  if (query.answered === true)  kw('ANSWERED');
  if (query.answered === false) kw('UNANSWERED');
  if (query.deleted === true)   kw('DELETED');
  if (query.deleted === false)  kw('UNDELETED');
  if (query.draft === true)     kw('DRAFT');
  if (query.draft === false)    kw('UNDRAFT');
  if (query.from)    str('FROM', query.from);
  if (query.to)      str('TO', query.to);
  if (query.cc)      str('CC', query.cc);
  if (query.bcc)     str('BCC', query.bcc);
  if (query.subject) str('SUBJECT', query.subject);
  if (query.body)    str('BODY', query.body);
  if (query.text)    str('TEXT', query.text);
  if (query.since)      kw(`SINCE ${formatDate(query.since)}`);
  if (query.before)     kw(`BEFORE ${formatDate(query.before)}`);
  if (query.on)         kw(`ON ${formatDate(query.on)}`);
  if (query.sentSince)  kw(`SENTSINCE ${formatDate(query.sentSince)}`);
  if (query.sentBefore) kw(`SENTBEFORE ${formatDate(query.sentBefore)}`);
  if (query.larger !== undefined)  kw(`LARGER ${Math.trunc(query.larger)}`);
  if (query.smaller !== undefined) kw(`SMALLER ${Math.trunc(query.smaller)}`);
  if (query.uid)     kw(`UID ${checkSeqSet(query.uid)}`);
  if (query.header)  parts.push('HEADER', astring(query.header.name), astring(query.header.value));
  if (query.keyword)   kw(`KEYWORD ${checkFlags([query.keyword])}`);
  if (query.unkeyword) kw(`UNKEYWORD ${checkFlags([query.unkeyword])}`);
  if (query.not)     parts.push('NOT (', ...buildSearchParts(query.not), ')');
  if (query.or)      parts.push('OR (', ...buildSearchParts(query.or[0]), ') (', ...buildSearchParts(query.or[1]), ')');

  return parts.length ? parts : ['ALL'];
}

/** True when any part must be sent as a literal (non-ASCII / CRLF). */
export function needsCharset(parts: readonly CommandPart[]): boolean {
  return parts.some(p => p instanceof Literal);
}

/**
 * Join command parts into a single space-separated sequence. Literals stay
 * separate objects; `(`/`)` fragments are glued to their neighbours.
 */
export function joinParts(parts: readonly CommandPart[]): CommandPart[] {
  const out: CommandPart[] = [];
  let prevOpen = true;
  for (const p of parts) {
    const glueLeft = typeof p === 'string' && p.startsWith(')');
    if (out.length && !prevOpen && !glueLeft) out.push(' ');
    out.push(p);
    prevOpen = typeof p === 'string' && p.endsWith('(');
  }
  return out;
}

/** Render parts as display text (literals shown quoted) — for logs and legacy string APIs. */
export function renderParts(parts: readonly CommandPart[]): string {
  return joinParts(parts)
    .map(p => (p instanceof Literal ? `"${p.data.toString('utf8').replace(/[\\"]/g, m => `\\${m}`)}"` : p))
    .join('');
}

/**
 * @deprecated Use `buildSearchParts` — this renders non-ASCII text as a quoted string.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export function buildSearchCommand(query: ImapSearchQuery): string {
  return renderParts(buildSearchParts(query));
}

/**
 * Structured command builders used by `ImapClient`.
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export const ImapParts = {
  login: (user: string, pass: string): CommandPart[] => ['LOGIN', astring(user), astring(pass)],
  select: (mailbox: string, condstore = false): CommandPart[] =>
    ['SELECT', mailboxArg(mailbox), ...(condstore ? ['(CONDSTORE)'] : [])],
  examine: (mailbox: string): CommandPart[] => ['EXAMINE', mailboxArg(mailbox)],
  create: (mailbox: string): CommandPart[] => ['CREATE', mailboxArg(mailbox)],
  delete: (mailbox: string): CommandPart[] => ['DELETE', mailboxArg(mailbox)],
  rename: (from: string, to: string): CommandPart[] => ['RENAME', mailboxArg(from), mailboxArg(to)],
  list: (ref: string, pattern: string, extended = false): CommandPart[] =>
    ['LIST', mailboxArg(ref), mailboxArg(pattern), ...(extended ? ['RETURN (SPECIAL-USE)'] : [])],
  lsub: (ref: string, pattern: string): CommandPart[] => ['LSUB', mailboxArg(ref), mailboxArg(pattern)],
  subscribe: (mailbox: string): CommandPart[] => ['SUBSCRIBE', mailboxArg(mailbox)],
  unsubscribe: (mailbox: string): CommandPart[] => ['UNSUBSCRIBE', mailboxArg(mailbox)],
  status: (mailbox: string, items: string[]): CommandPart[] =>
    ['STATUS', mailboxArg(mailbox), `(${items.map(i => checkAtom(i, 'status item')).join(' ')})`],
  uidSearch: (query: ImapSearchQuery): CommandPart[] => {
    const q = buildSearchParts(query);
    return ['UID SEARCH', ...(needsCharset(q) ? ['CHARSET UTF-8'] : []), ...q];
  },
  uidFetch: (uids: string, items: string): CommandPart[] => [`UID FETCH ${checkSeqSet(uids)} (${items})`],
  uidFetchChangedSince: (uids: string, items: string, modseq: number): CommandPart[] =>
    [`UID FETCH ${checkSeqSet(uids)} (${items}) (CHANGEDSINCE ${Math.trunc(modseq)})`],
  uidStore: (uids: string, flags: string[], add: boolean, silent = false): CommandPart[] =>
    [`UID STORE ${checkSeqSet(uids)} ${add ? '+' : '-'}FLAGS${silent ? '.SILENT' : ''} (${checkFlags(flags)})`],
  uidCopy: (uids: string, mailbox: string): CommandPart[] => [`UID COPY ${checkSeqSet(uids)}`, mailboxArg(mailbox)],
  uidMove: (uids: string, mailbox: string): CommandPart[] => [`UID MOVE ${checkSeqSet(uids)}`, mailboxArg(mailbox)],
  uidExpunge: (uids: string): CommandPart[] => [`UID EXPUNGE ${checkSeqSet(uids)}`],
  append: (mailbox: string, flags: string[], raw: Buffer, internalDate?: Date): CommandPart[] => [
    'APPEND', mailboxArg(mailbox),
    ...(flags.length ? [`(${checkFlags(flags)})`] : []),
    ...(internalDate ? [formatDateTime(internalDate)] : []),
    new Literal(raw),
  ],
};

/**
 * Legacy string builders (kept for compatibility; prefer `ImapParts`).
 *
 * **Low-level** — not covered by semantic versioning; may change in a minor release.
 */
export const ImapCmd = {
  capability:   () => 'CAPABILITY',
  noop:         () => 'NOOP',
  logout:       () => 'LOGOUT',
  login:        (user: string, pass: string) => renderParts(ImapParts.login(user, pass)),
  authenticate: (mechanism: string) => `AUTHENTICATE ${checkAtom(mechanism, 'SASL mechanism')}`,

  select:       (mailbox: string) => renderParts(ImapParts.select(mailbox)),
  examine:      (mailbox: string) => renderParts(ImapParts.examine(mailbox)),
  close:        () => 'CLOSE',

  create:       (mailbox: string) => renderParts(ImapParts.create(mailbox)),
  delete:       (mailbox: string) => renderParts(ImapParts.delete(mailbox)),
  rename:       (from: string, to: string) => renderParts(ImapParts.rename(from, to)),
  list:         (ref: string, pattern: string) => renderParts(ImapParts.list(ref, pattern)),
  lsub:         (ref: string, pattern: string) => renderParts(ImapParts.lsub(ref, pattern)),
  subscribe:    (mailbox: string) => renderParts(ImapParts.subscribe(mailbox)),
  unsubscribe:  (mailbox: string) => renderParts(ImapParts.unsubscribe(mailbox)),
  status:       (mailbox: string, items: string[]) => renderParts(ImapParts.status(mailbox, items)),

  search:       (query: ImapSearchQuery) => `SEARCH ${buildSearchCommand(query)}`,
  uidSearch:    (query: ImapSearchQuery) => `UID SEARCH ${buildSearchCommand(query)}`,

  fetch:        (range: string, items: string) => `FETCH ${checkSeqSet(range)} (${items})`,
  uidFetch:     (uids: string, items: string) => renderParts(ImapParts.uidFetch(uids, items)),
  uidFetchChangedSince: (uids: string, items: string, modseq: number) =>
    renderParts(ImapParts.uidFetchChangedSince(uids, items, modseq)),
  uidFetchBodyStructure: (uids: string) =>
    `UID FETCH ${checkSeqSet(uids)} (UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODYSTRUCTURE)`,
  uidFetchSection: (uids: string, section: string) =>
    `UID FETCH ${checkSeqSet(uids)} (UID BODY.PEEK[${section}])`,
  uidFetchSections: (uids: string, sections: string[]) =>
    `UID FETCH ${checkSeqSet(uids)} (UID ${sections.map(s => `BODY.PEEK[${s}]`).join(' ')})`,

  store:        (range: string, flags: string[], add: boolean) =>
    `STORE ${checkSeqSet(range)} ${add ? '+' : '-'}FLAGS (${checkFlags(flags)})`,
  uidStore:     (uids: string, flags: string[], add: boolean) => renderParts(ImapParts.uidStore(uids, flags, add)),
  uidStoreSilent: (uids: string, flags: string[], add: boolean) =>
    renderParts(ImapParts.uidStore(uids, flags, add, true)),

  copy:         (range: string, mailbox: string) => renderParts([`COPY ${checkSeqSet(range)}`, mailboxArg(mailbox)]),
  uidCopy:      (uids: string, mailbox: string) => renderParts(ImapParts.uidCopy(uids, mailbox)),
  uidMove:      (uids: string, mailbox: string) => renderParts(ImapParts.uidMove(uids, mailbox)),

  expunge:      () => 'EXPUNGE',
  uidExpunge:   (uids: string) => renderParts(ImapParts.uidExpunge(uids)),

  /** Returns the command prefix; the caller appends the literal. */
  appendPrefix: (mailbox: string, flags: string[], internalDate?: Date) =>
    renderParts(ImapParts.append(mailbox, flags, Buffer.alloc(0), internalDate).slice(0, -1)),

  idle:         () => 'IDLE',
  idleDone:     () => 'DONE',
};

/** Section spec validation — sections are interpolated into FETCH commands. */
export function checkSection(section: string): string {
  // e.g. "", "1", "1.2", "TEXT", "HEADER", "1.MIME", "HEADER.FIELDS (REFERENCES DATE)"
  if (!/^[A-Za-z0-9.]*( ?\([A-Za-z0-9\-_ ]*\))?$/.test(section)) {
    throw new ImapError(`Invalid IMAP section: ${JSON.stringify(section)}`);
  }
  return section;
}
