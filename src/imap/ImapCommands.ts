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
  subject?: string;
  body?: string;
  text?: string;
  since?: Date;
  before?: Date;
  sentSince?: Date;
  sentBefore?: Date;
  larger?: number;
  smaller?: number;
  uid?: string;       // raw UID set e.g. "1,3:5"
  header?: { name: string; value: string };
  not?: ImapSearchQuery;
  or?: [ImapSearchQuery, ImapSearchQuery];
}

function formatDate(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${months[d.getMonth()]!}-${d.getFullYear()}`;
}

export function buildSearchCommand(query: ImapSearchQuery): string {
  const parts: string[] = [];

  if (query.seen === true)      parts.push('SEEN');
  if (query.seen === false || query.unseen === true) parts.push('UNSEEN');
  if (query.flagged === true)   parts.push('FLAGGED');
  if (query.flagged === false || query.unflagged === true) parts.push('UNFLAGGED');
  if (query.answered === true)  parts.push('ANSWERED');
  if (query.answered === false) parts.push('UNANSWERED');
  if (query.deleted === true)   parts.push('DELETED');
  if (query.deleted === false)  parts.push('UNDELETED');
  if (query.draft === true)     parts.push('DRAFT');
  if (query.draft === false)    parts.push('UNDRAFT');
  if (query.from)    parts.push(`FROM "${query.from.replace(/"/g, '\\"')}"`);
  if (query.to)      parts.push(`TO "${query.to.replace(/"/g, '\\"')}"`);
  if (query.cc)      parts.push(`CC "${query.cc.replace(/"/g, '\\"')}"`);
  if (query.subject) parts.push(`SUBJECT "${query.subject.replace(/"/g, '\\"')}"`);
  if (query.body)    parts.push(`BODY "${query.body.replace(/"/g, '\\"')}"`);
  if (query.text)    parts.push(`TEXT "${query.text.replace(/"/g, '\\"')}"`);
  if (query.since)      parts.push(`SINCE ${formatDate(query.since)}`);
  if (query.before)     parts.push(`BEFORE ${formatDate(query.before)}`);
  if (query.sentSince)  parts.push(`SENTSINCE ${formatDate(query.sentSince)}`);
  if (query.sentBefore) parts.push(`SENTBEFORE ${formatDate(query.sentBefore)}`);
  if (query.larger !== undefined)  parts.push(`LARGER ${query.larger}`);
  if (query.smaller !== undefined) parts.push(`SMALLER ${query.smaller}`);
  if (query.uid)     parts.push(`UID ${query.uid}`);
  if (query.header)  parts.push(`HEADER "${query.header.name}" "${query.header.value.replace(/"/g, '\\"')}"`);
  if (query.not)     parts.push(`NOT (${buildSearchCommand(query.not)})`);
  if (query.or)      parts.push(`OR (${buildSearchCommand(query.or[0])}) (${buildSearchCommand(query.or[1])})`);

  return parts.length ? parts.join(' ') : 'ALL';
}

export const ImapCmd = {
  capability:   () => 'CAPABILITY',
  noop:         () => 'NOOP',
  logout:       () => 'LOGOUT',
  login:        (user: string, pass: string) =>
    `LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`,
  authenticate: (mechanism: string) => `AUTHENTICATE ${mechanism}`,

  // Mailbox selection
  select:       (mailbox: string) => `SELECT "${mailbox.replace(/"/g, '\\"')}"`,
  examine:      (mailbox: string) => `EXAMINE "${mailbox.replace(/"/g, '\\"')}"`,
  close:        () => 'CLOSE',

  // Mailbox management
  create:       (mailbox: string) => `CREATE "${mailbox.replace(/"/g, '\\"')}"`,
  delete:       (mailbox: string) => `DELETE "${mailbox.replace(/"/g, '\\"')}"`,
  rename:       (from: string, to: string) =>
    `RENAME "${from.replace(/"/g, '\\"')}" "${to.replace(/"/g, '\\"')}"`,
  list:         (ref: string, pattern: string) => `LIST "${ref}" "${pattern}"`,
  lsub:         (ref: string, pattern: string) => `LSUB "${ref}" "${pattern}"`,
  subscribe:    (mailbox: string) => `SUBSCRIBE "${mailbox.replace(/"/g, '\\"')}"`,
  unsubscribe:  (mailbox: string) => `UNSUBSCRIBE "${mailbox.replace(/"/g, '\\"')}"`,
  status:       (mailbox: string, items: string[]) =>
    `STATUS "${mailbox.replace(/"/g, '\\"')}" (${items.join(' ')})`,

  // Search
  search:       (query: ImapSearchQuery) => `SEARCH ${buildSearchCommand(query)}`,
  uidSearch:    (query: ImapSearchQuery) => `UID SEARCH ${buildSearchCommand(query)}`,

  // Fetch
  fetch:        (range: string, items: string) => `FETCH ${range} (${items})`,
  uidFetch:     (uids: string, items: string) => `UID FETCH ${uids} (${items})`,
  uidFetchChangedSince: (uids: string, items: string, modseq: number) =>
    `UID FETCH ${uids} (${items}) (CHANGEDSINCE ${modseq})`,
  uidFetchBodyStructure: (uids: string) =>
    `UID FETCH ${uids} (UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODYSTRUCTURE)`,
  uidFetchSection: (uids: string, section: string) =>
    `UID FETCH ${uids} (UID BODY.PEEK[${section}])`,
  uidFetchSections: (uids: string, sections: string[]) =>
    `UID FETCH ${uids} (UID ${sections.map(s => `BODY.PEEK[${s}]`).join(' ')})`,

  // Store
  store:        (range: string, flags: string[], add: boolean) =>
    `STORE ${range} ${add ? '+' : '-'}FLAGS (${flags.join(' ')})`,
  uidStore:     (uids: string, flags: string[], add: boolean) =>
    `UID STORE ${uids} ${add ? '+' : '-'}FLAGS (${flags.join(' ')})`,
  uidStoreSilent: (uids: string, flags: string[], add: boolean) =>
    `UID STORE ${uids} ${add ? '+' : '-'}FLAGS.SILENT (${flags.join(' ')})`,

  // Copy / Move
  copy:         (range: string, mailbox: string) =>
    `COPY ${range} "${mailbox.replace(/"/g, '\\"')}"`,
  uidCopy:      (uids: string, mailbox: string) =>
    `UID COPY ${uids} "${mailbox.replace(/"/g, '\\"')}"`,
  uidMove:      (uids: string, mailbox: string) =>
    `UID MOVE ${uids} "${mailbox.replace(/"/g, '\\"')}"`,

  // Expunge
  expunge:      () => 'EXPUNGE',
  uidExpunge:   (uids: string) => `UID EXPUNGE ${uids}`,

  // Append: returns the command prefix; caller appends " {<size>}"
  appendPrefix: (mailbox: string, flags: string[], internalDate?: Date) => {
    const flagStr = flags.length ? ` (${flags.join(' ')})` : '';
    const dateStr = internalDate
      ? ` "${internalDate.toUTCString().replace(/GMT/, '+0000')}"`
      : '';
    return `APPEND "${mailbox.replace(/"/g, '\\"')}"${flagStr}${dateStr}`;
  },

  // IDLE
  idle:         () => 'IDLE',
  idleDone:     () => 'DONE',
};
