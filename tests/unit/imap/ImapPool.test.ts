import { describe, it, expect, afterEach } from 'vitest';
import { ImapPool } from '../../../src/imap/ImapPool.js';
import { ImapAuthError } from '../../../src/errors.js';
import { imapServer } from '../../helpers/mockServers.js';
import type { ImapConfig } from '../../../src/types/imap.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(f => f())); });

const cfg = (port: number, user = 'u'): ImapConfig => ({
  host: '127.0.0.1', port, secure: false, auth: { type: 'plain', user, pass: 'p' }, socketTimeout: 2_000, reconnect: false,
});

async function setup(opts: ConstructorParameters<typeof ImapPool>[0] = {}) {
  const srv = await imapServer({
    handler: (line, tag, socket) => {
      if (/ LOGIN "?bad/.test(line)) { socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); return true; }
      return false;
    },
  });
  const pool = new ImapPool(opts);
  cleanups.push(async () => { await pool.closeAll(); await srv.close(); });
  return { srv, pool };
}

const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 10)); };

describe('ImapPool', () => {
  it('reuses one authenticated session per account and resolves the config only once', async () => {
    const { srv, pool } = await setup();
    let resolved = 0;
    const source = () => { resolved++; return cfg(srv.port); };
    for (let i = 0; i < 3; i++) await pool.use('acct-1', source, s => s.open('INBOX'));
    expect(srv.state.connections).toBe(1);
    expect(resolved).toBe(1);
    expect(srv.log.filter(l => / LOGIN /.test(l))).toHaveLength(1);
    expect(pool.stats()).toEqual({ accounts: 1, sessions: 1, busy: 0, waiting: 0 });
  });

  it('lends a session exclusively: callers for the same account queue up', async () => {
    const { srv, pool } = await setup();
    const order: string[] = [];
    let unblock!: () => void;
    const first = pool.use('a', cfg(srv.port), async (s) => {
      await s.open('INBOX');
      order.push('first:start');
      await new Promise<void>(r => { unblock = r; });
      order.push('first:end');
    });
    await until(() => order.length === 1);
    const second = pool.use('a', cfg(srv.port), async () => { order.push('second'); });
    await new Promise(r => setTimeout(r, 30));
    expect(pool.stats().waiting).toBe(1);
    unblock();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(srv.state.connections).toBe(1);
  });

  it('opens up to maxPerAccount sessions in parallel', async () => {
    const { srv, pool } = await setup({ maxPerAccount: 2 });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const runs = [1, 2].map(() => pool.use('a', cfg(srv.port), async (s) => { await s.open('INBOX'); await gate; }));
    await until(() => srv.state.connections === 2);
    expect(pool.stats()).toMatchObject({ sessions: 2, busy: 2 });
    release();
    await Promise.all(runs);
  });

  it('evicts the least recently used idle session of another account when maxSessions is reached', async () => {
    const { srv, pool } = await setup({ maxSessions: 2 });
    await pool.use('a', cfg(srv.port), s => s.open('INBOX'));
    await pool.use('b', cfg(srv.port), s => s.open('INBOX'));
    await pool.use('a', cfg(srv.port), s => s.open('INBOX')); // b is now the LRU
    await pool.use('c', cfg(srv.port), s => s.open('INBOX'));
    expect(pool.stats()).toMatchObject({ accounts: 2, sessions: 2 });
    await until(() => srv.state.open === 2);
    expect(srv.state.open).toBe(2);
    expect(srv.state.connections).toBe(3);
  });

  it('rejects with a retryable timeout when no session frees up in time', async () => {
    const { srv, pool } = await setup({ acquireTimeoutMs: 50 });
    let release!: () => void;
    const busy = pool.use('a', cfg(srv.port), () => new Promise<void>(r => { release = r; }));
    await until(() => pool.stats().busy === 1);
    const err = await pool.use('a', cfg(srv.port), async () => 'never').catch(e => e);
    expect(err).toMatchObject({ code: 'ETIMEOUT', retryable: true });
    expect(pool.stats().waiting).toBe(0);
    release();
    await busy;
  });

  it('discards a session whose login failed so the next use resolves fresh credentials', async () => {
    const { srv, pool } = await setup();
    let user = 'bad';
    const source = () => cfg(srv.port, user);
    await expect(pool.use('a', source, s => s.open('INBOX'))).rejects.toBeInstanceOf(ImapAuthError);
    expect(pool.stats().sessions).toBe(0);
    user = 'good';
    await expect(pool.use('a', source, s => s.open('INBOX'))).resolves.toBeTruthy();
  });

  it('a failing config source frees the slot', async () => {
    const { srv, pool } = await setup();
    await expect(pool.use('a', () => { throw new Error('no token'); }, async () => 1)).rejects.toThrow('no token');
    expect(pool.stats().sessions).toBe(0);
    await expect(pool.use('a', cfg(srv.port), async () => 2)).resolves.toBe(2);
  });

  it('closes sessions left idle longer than idleTimeoutMs', async () => {
    const { srv, pool } = await setup({ idleTimeoutMs: 40 });
    await pool.use('a', cfg(srv.port), s => s.open('INBOX'));
    expect(srv.state.open).toBe(1);
    await until(() => srv.state.open === 0);
    expect(srv.state.open).toBe(0);
    expect(pool.stats().sessions).toBe(0);
    expect(srv.log.some(l => / LOGOUT$/.test(l))).toBe(true);
  });

  it('close(key) waits for the busy session, rejects its waiters and the next use reconnects', async () => {
    const { srv, pool } = await setup();
    let release!: () => void;
    const busy = pool.use('a', cfg(srv.port), async (s) => { await s.open('INBOX'); await new Promise<void>(r => { release = r; }); });
    await until(() => srv.state.connections === 1 && pool.stats().busy === 1);
    const waiter = pool.use('a', cfg(srv.port), async () => 'x').catch(e => e as Error);
    await new Promise(r => setTimeout(r, 10));
    const closing = pool.close('a');
    expect((await waiter).message).toMatch(/were closed/);
    release();
    await busy;
    await closing;
    expect(pool.stats().sessions).toBe(0);
    await pool.use('a', cfg(srv.port), s => s.open('INBOX'));
    expect(srv.state.connections).toBe(2);
  });

  it('closeAll() closes everything and refuses new work', async () => {
    const { srv, pool } = await setup();
    await pool.use('a', cfg(srv.port), s => s.open('INBOX'));
    await pool.use('b', cfg(srv.port), s => s.open('INBOX'));
    await pool.closeAll();
    await until(() => srv.state.open === 0);
    expect(srv.state.open).toBe(0);
    await expect(pool.use('a', cfg(srv.port), async () => 1)).rejects.toThrow('closed');
  });

  it('validates limits', () => {
    expect(() => new ImapPool({ maxPerAccount: 0 })).toThrow();
    expect(() => new ImapPool({ maxSessions: 0 })).toThrow();
  });
});
