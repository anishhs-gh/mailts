import { describe, it, expect } from 'vitest';
import { buildSearchCommand, ImapCmd } from '../../../src/imap/ImapCommands.js';
import type { ImapSearchQuery } from '../../../src/imap/ImapCommands.js';

describe('buildSearchCommand', () => {
  it('returns ALL for empty query', () => {
    expect(buildSearchCommand({})).toBe('ALL');
  });

  it('handles seen flag', () => {
    expect(buildSearchCommand({ seen: true })).toBe('SEEN');
  });

  it('handles seen:false as UNSEEN', () => {
    expect(buildSearchCommand({ seen: false })).toBe('UNSEEN');
  });

  it('handles unseen explicit', () => {
    expect(buildSearchCommand({ unseen: true })).toBe('UNSEEN');
  });

  it('handles flagged:true', () => {
    expect(buildSearchCommand({ flagged: true })).toBe('FLAGGED');
  });

  it('handles flagged:false as UNFLAGGED', () => {
    expect(buildSearchCommand({ flagged: false })).toBe('UNFLAGGED');
  });

  it('handles unflagged explicit', () => {
    expect(buildSearchCommand({ unflagged: true })).toBe('UNFLAGGED');
  });

  it('handles answered:true', () => {
    expect(buildSearchCommand({ answered: true })).toBe('ANSWERED');
  });

  it('handles answered:false as UNANSWERED', () => {
    expect(buildSearchCommand({ answered: false })).toBe('UNANSWERED');
  });

  it('handles deleted:true', () => {
    expect(buildSearchCommand({ deleted: true })).toBe('DELETED');
  });

  it('handles deleted:false as UNDELETED', () => {
    expect(buildSearchCommand({ deleted: false })).toBe('UNDELETED');
  });

  it('handles draft:true', () => {
    expect(buildSearchCommand({ draft: true })).toBe('DRAFT');
  });

  it('handles draft:false as UNDRAFT', () => {
    expect(buildSearchCommand({ draft: false })).toBe('UNDRAFT');
  });

  it('handles FROM', () => {
    expect(buildSearchCommand({ from: 'alice@example.com' })).toBe('FROM "alice@example.com"');
  });

  it('handles TO', () => {
    expect(buildSearchCommand({ to: 'bob@example.com' })).toBe('TO "bob@example.com"');
  });

  it('handles CC', () => {
    expect(buildSearchCommand({ cc: 'cc@example.com' })).toBe('CC "cc@example.com"');
  });

  it('handles SUBJECT', () => {
    expect(buildSearchCommand({ subject: 'Hello' })).toBe('SUBJECT "Hello"');
  });

  it('handles BODY', () => {
    expect(buildSearchCommand({ body: 'secret' })).toBe('BODY "secret"');
  });

  it('handles TEXT', () => {
    expect(buildSearchCommand({ text: 'word' })).toBe('TEXT "word"');
  });

  it('handles SINCE date', () => {
    const d = new Date('2024-01-15T00:00:00Z');
    expect(buildSearchCommand({ since: d })).toBe('SINCE 15-Jan-2024');
  });

  it('handles BEFORE date', () => {
    const d = new Date('2024-12-31T00:00:00Z');
    expect(buildSearchCommand({ before: d })).toBe('BEFORE 31-Dec-2024');
  });

  it('handles SENTSINCE', () => {
    const d = new Date('2024-06-01T00:00:00Z');
    expect(buildSearchCommand({ sentSince: d })).toBe('SENTSINCE 1-Jun-2024');
  });

  it('handles SENTBEFORE', () => {
    const d = new Date('2024-06-30T00:00:00Z');
    expect(buildSearchCommand({ sentBefore: d })).toBe('SENTBEFORE 30-Jun-2024');
  });

  it('handles LARGER', () => {
    expect(buildSearchCommand({ larger: 10000 })).toBe('LARGER 10000');
  });

  it('handles SMALLER', () => {
    expect(buildSearchCommand({ smaller: 500 })).toBe('SMALLER 500');
  });

  it('handles UID set', () => {
    expect(buildSearchCommand({ uid: '1,3:5' })).toBe('UID 1,3:5');
  });

  it('handles HEADER', () => {
    expect(buildSearchCommand({ header: { name: 'X-Spam', value: 'yes' } }))
      .toBe('HEADER "X-Spam" "yes"');
  });

  it('handles NOT operator', () => {
    expect(buildSearchCommand({ not: { seen: true } })).toBe('NOT (SEEN)');
  });

  it('handles OR operator', () => {
    const result = buildSearchCommand({ or: [{ seen: true }, { flagged: true }] });
    expect(result).toBe('OR (SEEN) (FLAGGED)');
  });

  it('combines multiple criteria', () => {
    const result = buildSearchCommand({ seen: false, from: 'alice@a.com', larger: 1000 });
    expect(result).toContain('UNSEEN');
    expect(result).toContain('FROM "alice@a.com"');
    expect(result).toContain('LARGER 1000');
  });

  it('escapes double-quotes in string values', () => {
    const result = buildSearchCommand({ from: 'say "hi"' });
    expect(result).toBe('FROM "say \\"hi\\""');
  });

  it('handles nested NOT with compound query', () => {
    const result = buildSearchCommand({ not: { from: 'spam@bad.com', seen: false } });
    expect(result).toBe('NOT (UNSEEN FROM "spam@bad.com")');
  });
});

describe('ImapCmd', () => {
  it('capability', () => {
    expect(ImapCmd.capability()).toBe('CAPABILITY');
  });

  it('noop', () => {
    expect(ImapCmd.noop()).toBe('NOOP');
  });

  it('logout', () => {
    expect(ImapCmd.logout()).toBe('LOGOUT');
  });

  it('login escapes quotes', () => {
    expect(ImapCmd.login('user"name', 'p"ass')).toBe('LOGIN "user\\"name" "p\\"ass"');
  });

  it('select', () => {
    expect(ImapCmd.select('INBOX')).toBe('SELECT "INBOX"');
  });

  it('examine', () => {
    expect(ImapCmd.examine('INBOX')).toBe('EXAMINE "INBOX"');
  });

  it('close', () => {
    expect(ImapCmd.close()).toBe('CLOSE');
  });

  it('create', () => {
    expect(ImapCmd.create('Archive')).toBe('CREATE "Archive"');
  });

  it('delete', () => {
    expect(ImapCmd.delete('Trash')).toBe('DELETE "Trash"');
  });

  it('rename', () => {
    expect(ImapCmd.rename('Old', 'New')).toBe('RENAME "Old" "New"');
  });

  it('list', () => {
    expect(ImapCmd.list('', '*')).toBe('LIST "" "*"');
  });

  it('lsub', () => {
    expect(ImapCmd.lsub('', '*')).toBe('LSUB "" "*"');
  });

  it('subscribe', () => {
    expect(ImapCmd.subscribe('INBOX')).toBe('SUBSCRIBE "INBOX"');
  });

  it('unsubscribe', () => {
    expect(ImapCmd.unsubscribe('INBOX')).toBe('UNSUBSCRIBE "INBOX"');
  });

  it('status', () => {
    expect(ImapCmd.status('INBOX', ['MESSAGES', 'UNSEEN']))
      .toBe('STATUS "INBOX" (MESSAGES UNSEEN)');
  });

  it('search', () => {
    expect(ImapCmd.search({ seen: true })).toBe('SEARCH SEEN');
  });

  it('uidSearch', () => {
    expect(ImapCmd.uidSearch({ unseen: true })).toBe('UID SEARCH UNSEEN');
  });

  it('fetch', () => {
    expect(ImapCmd.fetch('1:5', 'FLAGS')).toBe('FETCH 1:5 (FLAGS)');
  });

  it('uidFetch', () => {
    expect(ImapCmd.uidFetch('101,105', 'UID FLAGS')).toBe('UID FETCH 101,105 (UID FLAGS)');
  });

  it('uidFetchChangedSince', () => {
    expect(ImapCmd.uidFetchChangedSince('1:*', 'FLAGS', 12345))
      .toBe('UID FETCH 1:* (FLAGS) (CHANGEDSINCE 12345)');
  });

  it('store add flags', () => {
    expect(ImapCmd.store('1:3', ['\\Seen'], true)).toBe('STORE 1:3 +FLAGS (\\Seen)');
  });

  it('store remove flags', () => {
    expect(ImapCmd.store('1:3', ['\\Seen'], false)).toBe('STORE 1:3 -FLAGS (\\Seen)');
  });

  it('uidStore', () => {
    expect(ImapCmd.uidStore('101', ['\\Deleted'], true)).toBe('UID STORE 101 +FLAGS (\\Deleted)');
  });

  it('uidStoreSilent', () => {
    expect(ImapCmd.uidStoreSilent('101', ['\\Seen'], true))
      .toBe('UID STORE 101 +FLAGS.SILENT (\\Seen)');
  });

  it('copy', () => {
    expect(ImapCmd.copy('1:5', 'Archive')).toBe('COPY 1:5 "Archive"');
  });

  it('uidCopy', () => {
    expect(ImapCmd.uidCopy('101,102', 'Sent')).toBe('UID COPY 101,102 "Sent"');
  });

  it('uidMove', () => {
    expect(ImapCmd.uidMove('101', 'Trash')).toBe('UID MOVE 101 "Trash"');
  });

  it('expunge', () => {
    expect(ImapCmd.expunge()).toBe('EXPUNGE');
  });

  it('uidExpunge', () => {
    expect(ImapCmd.uidExpunge('101,102')).toBe('UID EXPUNGE 101,102');
  });

  it('appendPrefix with no flags or date', () => {
    expect(ImapCmd.appendPrefix('INBOX', [])).toBe('APPEND "INBOX"');
  });

  it('appendPrefix with flags', () => {
    expect(ImapCmd.appendPrefix('Sent', ['\\Seen', '\\Draft']))
      .toBe('APPEND "Sent" (\\Seen \\Draft)');
  });

  it('appendPrefix with date', () => {
    const d = new Date('Mon, 01 Jan 2024 12:00:00 GMT');
    const result = ImapCmd.appendPrefix('INBOX', [], d);
    expect(result).toContain('APPEND "INBOX"');
    expect(result).toContain('+0000');
  });

  it('idle', () => {
    expect(ImapCmd.idle()).toBe('IDLE');
  });

  it('idleDone', () => {
    expect(ImapCmd.idleDone()).toBe('DONE');
  });
});
