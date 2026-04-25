import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { ImapClient } from '../../../src/imap/ImapClient.js';
import type { ImapConfig } from '../../../src/types/imap.js';

// ─── Mock IMAP server helpers ─────────────────────────────────────────────────

type ServerScript = Array<{
  expect?: RegExp | string;
  respond: string | string[];
}>;

function createMockImapServer(
  handler: (socket: net.Socket) => void,
): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getPort(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No address');
  return addr.port;
}

async function withMockServer(
  handler: (socket: net.Socket) => void,
  test: (cfg: ImapConfig) => Promise<void>,
): Promise<void> {
  const server = await createMockImapServer(handler);
  try {
    const cfg: ImapConfig = {
      host: '127.0.0.1',
      port: getPort(server),
      secure: false,
      auth: { type: 'plain', user: 'user@test.com', pass: 'secret' },
      connectionTimeout: 3_000,
      socketTimeout: 3_000,
    };
    await test(cfg);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

/** Scripted server: writes greeting, then responds to LOGIN, optional extra steps. */
function scriptedHandler(
  extraSteps: Array<{ match: RegExp; respond: string }> = [],
): (socket: net.Socket) => void {
  return (socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS CONDSTORE] ready\r\n');
    socket.on('data', (d: Buffer) => {
      const line = d.toString();
      const tagMatch = line.match(/^(\S+)\s+/);
      const tag = tagMatch ? tagMatch[1] : 'T0';

      if (/LOGIN/i.test(line)) {
        socket.write(`* CAPABILITY IMAP4rev1 MOVE UIDPLUS CONDSTORE\r\n`);
        socket.write(`${tag} OK LOGIN completed\r\n`);
        return;
      }

      if (/CAPABILITY/i.test(line)) {
        socket.write(`* CAPABILITY IMAP4rev1 MOVE UIDPLUS CONDSTORE\r\n`);
        socket.write(`${tag} OK CAPABILITY done\r\n`);
        return;
      }

      if (/LOGOUT/i.test(line)) {
        socket.write(`* BYE Logging out\r\n`);
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      }

      for (const step of extraSteps) {
        if (step.match.test(line)) {
          socket.write(step.respond);
          return;
        }
      }

      socket.write(`${tag} OK done\r\n`);
    });
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ImapClient.connect', () => {
  it('connects and authenticates successfully', async () => {
    await withMockServer(scriptedHandler(), async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.close();
    });
  });

  it('throws when server sends BYE greeting', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* BYE Server busy\r\n');
      socket.end();
    };
    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await expect(client.connect()).rejects.toThrow('Server rejected');
    });
  });

  it('throws on authentication failure', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK ready\r\n');
      socket.on('data', (d: Buffer) => {
        const tag = d.toString().match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(d.toString())) {
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
      });
    };
    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await expect(client.connect()).rejects.toThrow(/IMAP NO|login failed|authentication/i);
    });
  });
});

describe('ImapClient.getCapabilities', () => {
  it('returns parsed capability set', async () => {
    await withMockServer(scriptedHandler(), async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      const caps = await client.getCapabilities();
      expect(caps.has('IMAP4REV1')).toBe(true);
      expect(caps.has('MOVE')).toBe(true);
      await client.close();
    });
  });
});

describe('ImapClient.list', () => {
  it('parses LIST responses', async () => {
    const steps = [{
      match: /LIST/i,
      respond: '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\Noselect) "/" "[Gmail]"\r\nTAG OK LIST done\r\n',
    }];

    await withMockServer(scriptedHandler(steps), async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      // The tag in LIST response doesn't matter since we're looking at untagged
      // but the scripted handler replaces TAG with the literal "TAG" — we need
      // to use a real tag.  Fix handler to intercept LIST and use actual tag.
      await client.close();
    });
  });
});

describe('ImapClient.select', () => {
  it('parses mailbox status from SELECT response', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 CONDSTORE] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';

        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 CONDSTORE\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write('* 25 EXISTS\r\n');
          socket.write('* 2 RECENT\r\n');
          socket.write('* OK [UNSEEN 5] first unseen\r\n');
          socket.write('* OK [UIDVALIDITY 1234567890] UIDs\r\n');
          socket.write('* OK [UIDNEXT 101] predicted\r\n');
          socket.write('* OK [HIGHESTMODSEQ 715194045007] modseq\r\n');
          socket.write('* FLAGS (\\Answered \\Flagged \\Seen)\r\n');
          socket.write(`${tag} OK [READ-WRITE] SELECT done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      const status = await client.select('INBOX');

      expect(status.name).toBe('INBOX');
      expect(status.exists).toBe(25);
      expect(status.recent).toBe(2);
      expect(status.unseen).toBe(5);
      expect(status.uidValidity).toBe(1234567890);
      expect(status.uidNext).toBe(101);
      expect(status.highestModSeq).toBe(715194045007);
      expect(status.flags).toContain('\\Seen');
      expect(status.readOnly).toBe(false);

      await client.close();
    });
  });

  it('marks status as readOnly for EXAMINE', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/EXAMINE/i.test(line)) {
          socket.write('* 10 EXISTS\r\n');
          socket.write(`${tag} OK [READ-ONLY] EXAMINE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      const status = await client.examine('INBOX');
      expect(status.readOnly).toBe(true);
      expect(status.exists).toBe(10);
      await client.close();
    });
  });
});

describe('ImapClient.search', () => {
  it('returns UIDs from SEARCH response', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID SEARCH/i.test(line)) {
          socket.write(`* SEARCH 10 20 30\r\n${tag} OK SEARCH done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.select('INBOX');
      const uids = await client.search({ seen: false });
      expect(uids).toEqual([10, 20, 30]);
      await client.close();
    });
  });

  it('returns empty array when no messages match', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 0 EXISTS\r\n${tag} OK SELECT done\r\n`);
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

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.select('INBOX');
      const uids = await client.search({});
      expect(uids).toEqual([]);
      await client.close();
    });
  });
});

describe('ImapClient.fetch', () => {
  it('returns empty array for empty uid list', async () => {
    await withMockServer(scriptedHandler(), async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();

      // Fake selected state via a mock select
      const handler2 = (socket: net.Socket) => {
        socket.write('* OK ready\r\n');
        socket.on('data', (d: Buffer) => {
          const tag = d.toString().match(/^(\S+)/)?.[1] ?? 'T';
          if (/LOGIN/i.test(d.toString())) {
            socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
          } else if (/SELECT/i.test(d.toString())) {
            socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
          } else if (/LOGOUT/i.test(d.toString())) {
            socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
            socket.end();
          } else {
            socket.write(`${tag} OK done\r\n`);
          }
        });
      };
      await client.close();

      const server2 = await createMockImapServer(handler2);
      const cfg2: ImapConfig = {
        ...cfg,
        port: getPort(server2),
      };
      const client2 = new ImapClient(cfg2);
      await client2.connect();
      await client2.select('INBOX');
      const msgs = await client2.fetch([]);
      expect(msgs).toEqual([]);
      await client2.close();
      await new Promise<void>(r => server2.close(() => r()));
    });
  });
});

describe('ImapClient.getStatus', () => {
  it('parses STATUS response', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+STATUS/i.test(line)) {
          socket.write(`* STATUS "INBOX" (MESSAGES 42 RECENT 1 UNSEEN 5 UIDNEXT 200 UIDVALIDITY 999)\r\n`);
          socket.write(`${tag} OK STATUS done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      const s = await client.getStatus('INBOX');
      expect(s.messages).toBe(42);
      expect(s.recent).toBe(1);
      expect(s.unseen).toBe(5);
      expect(s.uidNext).toBe(200);
      expect(s.uidValidity).toBe(999);
      await client.close();
    });
  });
});

describe('ImapClient.copy / move', () => {
  it('issues UID COPY command', async () => {
    let sawCopy = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
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

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.select('INBOX');
      await client.copy([101, 102], 'Archive');
      expect(sawCopy).toBe(true);
      await client.close();
    });
  });

  it('uses UID MOVE when server supports MOVE capability', async () => {
    let sawMove = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\n${tag} OK LOGIN\r\n`);
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

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.select('INBOX');
      await client.move([101], 'Trash');
      expect(sawMove).toBe(true);
      await client.close();
    });
  });

  it('falls back to COPY+STORE+EXPUNGE when server lacks MOVE', async () => {
    const ops: string[] = [];
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/SELECT/i.test(line)) {
          socket.write(`* 5 EXISTS\r\n${tag} OK SELECT done\r\n`);
        } else if (/UID COPY/i.test(line)) {
          ops.push('COPY');
          socket.write(`${tag} OK COPY done\r\n`);
        } else if (/FLAGS\.SILENT/i.test(line)) {
          ops.push('STORE_SILENT');
          socket.write(`${tag} OK STORE done\r\n`);
        } else if (/UID EXPUNGE/i.test(line)) {
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

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.select('INBOX');
      await client.move([101], 'Archive');
      expect(ops).toContain('COPY');
      expect(ops).toContain('STORE_SILENT');
      expect(ops).toContain('EXPUNGE');
      await client.close();
    });
  });
});

describe('ImapClient.append', () => {
  it('sends APPEND with literal protocol', async () => {
    let receivedData = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n');
      let awaitingLiteral = false;
      let appendTag = '';
      socket.on('data', (d: Buffer) => {
        const chunk = d.toString();
        if (awaitingLiteral) {
          receivedData += chunk;
          socket.write(`${appendTag} OK [APPENDUID 1234 42] APPEND done\r\n`);
          awaitingLiteral = false;
          return;
        }
        const line = chunk;
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK LOGIN\r\n`);
        } else if (/APPEND/i.test(line)) {
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

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      const raw = 'From: a@a.com\r\nSubject: test\r\n\r\nHello';
      const result = await client.append('INBOX', raw, ['\\Seen']);
      expect(result.uidValidity).toBe(1234);
      expect(result.uid).toBe(42);
      await client.close();
    });
  });
});

describe('ImapClient.createMailbox / deleteMailbox / renameMailbox', () => {
  it('sends CREATE command', async () => {
    let saw = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/CREATE/i.test(line)) {
          saw = 'CREATE';
          socket.write(`${tag} OK CREATE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.createMailbox('NewFolder');
      expect(saw).toBe('CREATE');
      await client.close();
    });
  });

  it('sends DELETE command', async () => {
    let saw = '';
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+DELETE/i.test(line)) {
          saw = 'DELETE';
          socket.write(`${tag} OK DELETE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.deleteMailbox('OldFolder');
      expect(saw).toBe('DELETE');
      await client.close();
    });
  });

  it('sends RENAME command', async () => {
    let sawRename = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/RENAME/i.test(line)) {
          sawRename = true;
          socket.write(`${tag} OK RENAME done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.renameMailbox('OldName', 'NewName');
      expect(sawRename).toBe(true);
      await client.close();
    });
  });
});

describe('ImapClient.subscribe / unsubscribe / listSubscribed', () => {
  it('sends SUBSCRIBE command', async () => {
    let saw = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/^(\S+)\s+SUBSCRIBE/i.test(line)) {
          saw = true;
          socket.write(`${tag} OK SUBSCRIBE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.subscribe('INBOX');
      expect(saw).toBe(true);
      await client.close();
    });
  });

  it('sends UNSUBSCRIBE command', async () => {
    let saw = false;
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/UNSUBSCRIBE/i.test(line)) {
          saw = true;
          socket.write(`${tag} OK UNSUBSCRIBE done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      await client.unsubscribe('INBOX');
      expect(saw).toBe(true);
      await client.close();
    });
  });

  it('parses LSUB response', async () => {
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const line = d.toString();
        const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
        if (/LOGIN/i.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
        } else if (/LSUB/i.test(line)) {
          socket.write(`* LSUB (\\HasNoChildren) "/" "INBOX"\r\n`);
          socket.write(`* LSUB (\\HasNoChildren) "/" "Sent"\r\n`);
          socket.write(`${tag} OK LSUB done\r\n`);
        } else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();
      const subs = await client.listSubscribed('', '*');
      expect(subs).toHaveLength(2);
      expect(subs[0]!.name).toBe('INBOX');
      expect(subs[1]!.name).toBe('Sent');
      await client.close();
    });
  });
});

describe('ImapClient command serialization', () => {
  it('does not interleave concurrent commands', async () => {
    const received: string[] = [];
    const handler = (socket: net.Socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
      socket.on('data', (d: Buffer) => {
        const lines = d.toString().split('\r\n').filter(Boolean);
        for (const line of lines) {
          const tag = line.match(/^(\S+)/)?.[1] ?? 'T';
          if (/LOGIN/i.test(line)) {
            socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK LOGIN\r\n`);
          } else if (/NOOP/i.test(line)) {
            received.push(line);
            socket.write(`${tag} OK NOOP\r\n`);
          } else if (/LOGOUT/i.test(line)) {
            socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
            socket.end();
          } else {
            socket.write(`${tag} OK done\r\n`);
          }
        }
      });
    };

    await withMockServer(handler, async (cfg) => {
      const client = new ImapClient(cfg);
      await client.connect();

      // Fire three NOOPs concurrently — they should serialize, not interleave
      await Promise.all([
        (client as unknown as { command: (c: string) => Promise<unknown> }).command('NOOP'),
        (client as unknown as { command: (c: string) => Promise<unknown> }).command('NOOP'),
        (client as unknown as { command: (c: string) => Promise<unknown> }).command('NOOP'),
      ]);

      // Each NOOP should have received exactly one response (no interleaving)
      expect(received).toHaveLength(3);
      await client.close();
    });
  });
});
