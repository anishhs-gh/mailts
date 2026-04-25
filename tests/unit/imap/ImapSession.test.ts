import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { ImapSession } from '../../../src/imap/ImapSession.js';
import type { ImapConfig } from '../../../src/types/imap.js';

function createMockServer(
  handler: (socket: net.Socket) => void,
): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getPort(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No port');
  return addr.port;
}

async function withSession(
  handler: (socket: net.Socket) => void,
  test: (session: ImapSession) => Promise<void>,
): Promise<void> {
  const server = await createMockServer(handler);
  const cfg: ImapConfig = {
    host: '127.0.0.1',
    port: getPort(server),
    secure: false,
    auth: { type: 'plain', user: 'u@test.com', pass: 'pass' },
    connectionTimeout: 3_000,
    socketTimeout: 3_000,
  };
  const session = new ImapSession(cfg);
  try {
    await session.connect();
    await test(session);
  } finally {
    await session.close().catch(() => {});
    await new Promise<void>(r => server.close(() => r()));
  }
}

/** Generic mock handler that speaks minimal IMAP and handles SELECT/EXAMINE. */
function baseHandler(
  extra: Array<{ match: RegExp; respond: (tag: string, line: string) => string }> = [],
): (socket: net.Socket) => void {
  return (socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] ready\r\n');
    socket.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      const tag = line.match(/^(\S+)/)?.[1] ?? 'T';

      if (/LOGIN/i.test(line)) {
        socket.write(`* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        return;
      }
      if (/^(\S+)\s+SELECT/i.test(line)) {
        const mb = line.match(/SELECT\s+"?([^"\s]+)"?/i)?.[1] ?? 'INBOX';
        socket.write(`* 10 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 100] ok\r\n* OK [UIDNEXT 11] ok\r\n${tag} OK [READ-WRITE] SELECT "${mb}" done\r\n`);
        return;
      }
      if (/EXAMINE/i.test(line)) {
        socket.write(`* 10 EXISTS\r\n${tag} OK [READ-ONLY] EXAMINE done\r\n`);
        return;
      }
      if (/CLOSE/i.test(line)) {
        socket.write(`${tag} OK CLOSE\r\n`);
        return;
      }
      if (/LOGOUT/i.test(line)) {
        socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
        socket.end();
        return;
      }

      for (const step of extra) {
        if (step.match.test(line)) {
          socket.write(step.respond(tag, line));
          return;
        }
      }

      socket.write(`${tag} OK done\r\n`);
    });
  };
}

// ─── Automatic mailbox selection ──────────────────────────────────────────────

describe('ImapSession automatic mailbox selection', () => {
  it('auto-selects INBOX when no mailbox has been opened', async () => {
    let selectedMailbox = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          selectedMailbox = m?.[1] ?? '';
          socket.write(`* 5 EXISTS\r\n* 0 RECENT\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH\r\n${tag} OK SEARCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      // No open() called — should auto-select INBOX
      await session.fetch({ seen: false });
      expect(selectedMailbox.toUpperCase()).toBe('INBOX');
    });
  });

  it('auto-selects the mailbox specified in fetch options', async () => {
    let selectedMailbox = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          selectedMailbox = m?.[1] ?? '';
          socket.write(`* 3 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH\r\n${tag} OK SEARCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.fetch({ mailbox: 'Sent', seen: false });
      expect(selectedMailbox).toBe('Sent');
    });
  });

  it('reuses selection when mailbox is already selected', async () => {
    let selectCount = 0;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          selectCount++;
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH\r\n${tag} OK SEARCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.fetch({ mailbox: 'INBOX' });
      await session.fetch({ mailbox: 'INBOX' }); // same mailbox — no re-select
      expect(selectCount).toBe(1);
    });
  });

  it('re-selects when switching mailboxes between operations', async () => {
    const selects: string[] = [];
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          selects.push(m?.[1] ?? '');
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH\r\n${tag} OK SEARCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.fetch({ mailbox: 'INBOX' });
      await session.fetch({ mailbox: 'Sent' });
      expect(selects).toEqual(['INBOX', 'Sent']);
    });
  });

  it('session lock prevents mailbox reselection mid-operation', async () => {
    const cmdLog: string[] = [];
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          cmdLog.push(`SELECT:${m?.[1] ?? '?'}`);
          socket.write(`* 2 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          cmdLog.push('SEARCH');
          socket.write(`* SEARCH 1 2\r\n${tag} OK SEARCH done\r\n`);
        } else if (/UID FETCH/i.test(line)) {
          cmdLog.push('FETCH');
          socket.write(`* 1 FETCH (UID 1 FLAGS () RFC822.SIZE 100 INTERNALDATE "01-Jan-2024 00:00:00 +0000" ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "A" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`* 2 FETCH (UID 2 FLAGS () RFC822.SIZE 200 INTERNALDATE "02-Jan-2024 00:00:00 +0000" ENVELOPE ("Tue, 02 Jan 2024 00:00:00 +0000" "B" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`${tag} OK FETCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      // Fire two fetches on different mailboxes concurrently
      await Promise.all([
        session.fetch({ mailbox: 'INBOX' }),
        session.fetch({ mailbox: 'Sent' }),
      ]);

      // Commands must be fully ordered — no SEARCH or FETCH crossing mailboxes:
      // [SELECT:INBOX, SEARCH, FETCH, SELECT:Sent, SEARCH, FETCH]
      const selectIndexes = cmdLog
        .map((c, i) => (c.startsWith('SELECT') ? i : -1))
        .filter(i => i >= 0);

      expect(selectIndexes).toHaveLength(2);
      // All commands for INBOX must complete before SELECT:Sent
      const secondSelectIdx = selectIndexes[1]!;
      const searchFetchBefore = cmdLog.slice(0, secondSelectIdx);
      expect(searchFetchBefore.filter(c => c === 'SEARCH')).toHaveLength(1);
      expect(searchFetchBefore.filter(c => c === 'FETCH')).toHaveLength(1);
    });
  });
});

// ─── open() and openReadOnly() ────────────────────────────────────────────────

describe('ImapSession.open', () => {
  it('returns mailbox status and sets session.status', async () => {
    await withSession(baseHandler(), async (session) => {
      const status = await session.open('INBOX');
      expect(status.name).toBe('INBOX');
      expect(status.exists).toBe(10);
      expect(session.status).toBe(status);
    });
  });

  it('always re-selects even if mailbox is already open (refreshes status)', async () => {
    let selectCount = 0;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          selectCount++;
          socket.write(`* ${selectCount * 5} EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      const s1 = await session.open('INBOX');
      const s2 = await session.open('INBOX'); // same mailbox — should still re-select
      expect(selectCount).toBe(2);
      expect(s1.exists).toBe(5);
      expect(s2.exists).toBe(10);
    });
  });
});

describe('ImapSession.openReadOnly', () => {
  it('opens mailbox in read-only mode', async () => {
    await withSession(baseHandler(), async (session) => {
      const status = await session.openReadOnly('INBOX');
      expect(status.readOnly).toBe(true);
    });
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('ImapSession.getStatus', () => {
  it('fetches STATUS without changing the selected mailbox', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+STATUS/i.test(line)) {
          socket.write(`* STATUS "INBOX" (MESSAGES 50 UNSEEN 3 UIDNEXT 51 UIDVALIDITY 123 RECENT 0)\r\n${tag} OK STATUS done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      const s = await session.getStatus('INBOX');
      expect(s.messages).toBe(50);
      expect(s.unseen).toBe(3);
      expect(session.status).toBeNull(); // no mailbox selected
    });
  });
});

// ─── fetch ────────────────────────────────────────────────────────────────────

describe('ImapSession.fetch', () => {
  it('works without any prior open() call', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 2 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH 10 11\r\n${tag} OK SEARCH done\r\n`);
        } else if (/UID FETCH/i.test(line)) {
          socket.write(`* 1 FETCH (UID 10 FLAGS () RFC822.SIZE 100 INTERNALDATE "01-Jan-2024 00:00:00 +0000" ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "Test" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`* 2 FETCH (UID 11 FLAGS () RFC822.SIZE 200 INTERNALDATE "02-Jan-2024 00:00:00 +0000" ENVELOPE ("Tue, 02 Jan 2024 00:00:00 +0000" "Test2" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`${tag} OK FETCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      const msgs = await session.fetch(); // no mailbox, no open() — should work
      expect(msgs).toHaveLength(2);
    });
  });

  it('marks messages seen when markSeen option is set', async () => {
    let sawStore = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 2 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH 10 11\r\n${tag} OK SEARCH done\r\n`);
        } else if (/UID FETCH/i.test(line)) {
          socket.write(`* 1 FETCH (UID 10 FLAGS () RFC822.SIZE 100 INTERNALDATE "01-Jan-2024 00:00:00 +0000" ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "T" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`* 2 FETCH (UID 11 FLAGS () RFC822.SIZE 100 INTERNALDATE "01-Jan-2024 00:00:00 +0000" ENVELOPE ("Mon, 01 Jan 2024 00:00:00 +0000" "T2" NIL NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`${tag} OK FETCH done\r\n`);
        } else if (/FLAGS\.SILENT.*\\Seen/i.test(line)) {
          sawStore = true;
          socket.write(`${tag} OK STORE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.fetch({ markSeen: true });
      expect(sawStore).toBe(true);
    });
  });
});

// ─── markSeen / markUnseen / markFlagged ──────────────────────────────────────

describe('ImapSession flag operations', () => {
  it('markSeen auto-selects the specified mailbox', async () => {
    let selectedMb = '';
    let flagCmd = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          selectedMb = m?.[1] ?? '';
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID STORE/i.test(line)) {
          flagCmd = line;
          socket.write(`${tag} OK STORE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.markSeen([10, 11], 'Sent');
      expect(selectedMb).toBe('Sent');
      expect(flagCmd).toContain('+FLAGS');
      expect(flagCmd).toContain('\\Seen');
    });
  });

  it('markUnseen removes \\Seen flag', async () => {
    let flagCmd = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID STORE/i.test(line)) {
          flagCmd = line;
          socket.write(`${tag} OK STORE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.markUnseen([10]);
      expect(flagCmd).toContain('-FLAGS');
      expect(flagCmd).toContain('\\Seen');
    });
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('ImapSession.delete', () => {
  it('sets \\Deleted and expunges, auto-selects mailbox', async () => {
    const ops: string[] = [];
    let selectedMb = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          selectedMb = m?.[1] ?? '';
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID STORE.*\\Deleted/i.test(line)) {
          ops.push('STORE_DELETED');
          socket.write(`${tag} OK STORE done\r\n`);
        } else if (/^(\S+)\s+EXPUNGE/i.test(line)) {
          ops.push('EXPUNGE');
          socket.write(`${tag} OK EXPUNGE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.delete([10], 'Trash');
      expect(selectedMb).toBe('Trash');
      expect(ops).toContain('STORE_DELETED');
      expect(ops).toContain('EXPUNGE');
    });
  });
});

// ─── append ───────────────────────────────────────────────────────────────────

describe('ImapSession.append', () => {
  it('uploads message without requiring a selected mailbox', async () => {
    let appendSeen = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      let awaitingLiteral = false;
      let appendTag = '';
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (awaitingLiteral) {
          socket.write(`${appendTag} OK [APPENDUID 1 99] APPEND done\r\n`);
          awaitingLiteral = false;
          return;
        }
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+APPEND/i.test(line)) {
          appendSeen = true;
          appendTag = tag;
          socket.write(`+ go ahead\r\n`);
          awaitingLiteral = true;
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      // append() does NOT require open() — no SELECT should be issued
      const result = await session.append('Sent', 'Subject: hi\r\n\r\nHello');
      expect(appendSeen).toBe(true);
      expect(result.uid).toBe(99);
      expect(session.status).toBeNull(); // no mailbox was selected
    });
  });
});

// ─── copy / move ──────────────────────────────────────────────────────────────

describe('ImapSession.copy / move', () => {
  it('copy auto-selects source mailbox', async () => {
    let selectedMb = '';
    let sawCopy = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          const m = line.match(/SELECT\s+"?([^"\s]+)"?/i);
          selectedMb = m?.[1] ?? '';
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID COPY/i.test(line)) {
          sawCopy = true;
          socket.write(`${tag} OK COPY done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.copy([10, 11], 'Archive', 'INBOX');
      expect(selectedMb).toBe('INBOX');
      expect(sawCopy).toBe(true);
    });
  });

  it('move uses MOVE extension when available', async () => {
    let sawMove = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 MOVE] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 MOVE\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID MOVE/i.test(line)) {
          sawMove = true;
          socket.write(`${tag} OK MOVE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.move([10], 'Trash');
      expect(sawMove).toBe(true);
    });
  });
});

// ─── listMailboxes / subscribe ────────────────────────────────────────────────

describe('ImapSession.listMailboxes / listSubscribed', () => {
  it('lists mailboxes', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+LIST/i.test(line)) {
          socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n`);
          socket.write(`* LIST (\\HasNoChildren) "/" "Sent"\r\n`);
          socket.write(`${tag} OK LIST done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      const mailboxes = await session.listMailboxes();
      expect(mailboxes.map(m => m.name)).toContain('INBOX');
      expect(mailboxes.map(m => m.name)).toContain('Sent');
    });
  });
});

describe('ImapSession.createMailbox / deleteMailbox / renameMailbox', () => {
  it('creates, renames, and deletes a mailbox', async () => {
    const ops: string[] = [];
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+CREATE/i.test(line)) {
          ops.push('CREATE');
          socket.write(`${tag} OK CREATE done\r\n`);
        } else if (/RENAME/i.test(line)) {
          ops.push('RENAME');
          socket.write(`${tag} OK RENAME done\r\n`);
        } else if (/^(\S+)\s+DELETE/i.test(line)) {
          ops.push('DELETE');
          socket.write(`${tag} OK DELETE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withSession(handler, async (session) => {
      await session.createMailbox('FolderA');
      await session.renameMailbox('FolderA', 'FolderB');
      await session.deleteMailbox('FolderB');
      expect(ops).toEqual(['CREATE', 'RENAME', 'DELETE']);
    });
  });
});
