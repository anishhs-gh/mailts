import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { ImapParser, type ImapResponse } from './ImapParser.js';
import { ImapCmd, type ImapSearchQuery } from './ImapCommands.js';
import { parseFetchResponse, parseSectionResponse } from './ImapFetch.js';
import { parseBodyStructure } from './ImapBodyStructure.js';
import type { BodyNode } from './ImapBodyStructure.js';
import { Credential } from '../core/Credential.js';
import type { Logger } from '../logger/Logger.js';
import type {
  ImapConfig,
  ImapMailboxStatus,
  ImapMessage,
  ImapListEntry,
  ImapAppendResult,
  ImapStatusResult,
} from '../types/imap.js';
import { ImapError } from '../errors.js';

type ImapState =
  | 'idle'
  | 'connecting'
  | 'not_authenticated'
  | 'authenticated'
  | 'selected'
  | 'logout';

interface TaggedSlot {
  resolve: (r: ImapResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const IDLE_RENEWAL = 28 * 60_000;

export class ImapClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private parser: ImapParser;
  private state: ImapState = 'idle';
  private tagSeq = 0;
  private taggedWaiters: Map<string, TaggedSlot> = new Map();
  private untaggedBuffer: ImapResponse[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCallback: ((msg: Partial<ImapMessage>) => void) | null = null;
  private inIdle = false;
  private _selectedMailbox: ImapMailboxStatus | null = null;

  /** Serialization lock — ensures commands do not interleave on the socket. */
  private cmdLock: Promise<unknown> = Promise.resolve();

  /** Cached server capabilities (populated by getCapabilities() or after login). */
  private capabilities: Set<string> = new Set();

  /** The last mailbox opened via select() or examine(). Null before any selection. */
  get selectedMailbox(): ImapMailboxStatus | null { return this._selectedMailbox; }

  readonly config: ImapConfig;
  private readonly logger: Logger | null;

  constructor(config: ImapConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger ?? null;
    this.parser = new ImapParser();
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state !== 'idle') throw new ImapError('Client already connected');
    this.state = 'connecting';

    const { host, port, secure = true, tls: tlsOpts, connectionTimeout = 10_000 } = this.config;
    const resolvedPort = port ?? (secure ? 993 : 143);

    const socket = secure
      ? tls.connect(resolvedPort, host, { ...tlsOpts, servername: host })
      : net.createConnection(resolvedPort, host);

    socket.setTimeout(this.config.socketTimeout ?? 30_000);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ImapError('Connection timeout'));
      }, connectionTimeout);

      const onConnect = () => { clearTimeout(timer); resolve(); };

      if (secure) {
        (socket as tls.TLSSocket).once('secureConnect', onConnect);
      } else {
        socket.once('connect', onConnect);
      }
      socket.once('error', (e) => { clearTimeout(timer); reject(new ImapError(`IMAP connect failed: ${e.message}`)); });
    });

    this.socket = socket;

    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('binary');
      this.logger?.proto('S', 'imap', text.replace(/\r\n/g, '↵'));
      const responses = this.parser.feed(text);
      for (const r of responses) this.handleResponse(r);
    });

    socket.on('error', (e) => {
      this.emit('error', new ImapError(`IMAP socket error: ${e.message}`, true));
    });

    socket.on('close', () => {
      this.state = 'idle';
      this.emit('close');
    });

    const greeting = await this.waitUntagged(['OK', 'PREAUTH', 'BYE'], 10_000);
    if (greeting.status === 'BYE') throw new ImapError(`Server rejected connection: ${greeting.data}`);

    this.state = greeting.status === 'PREAUTH' ? 'authenticated' : 'not_authenticated';
    this.logger?.info('imap', `Connected to ${host}:${resolvedPort}`);

    if (this.state === 'not_authenticated') {
      try {
        await this.authenticate();
      } catch (err) {
        this.socket?.destroy();
        this.socket = null;
        this.state = 'idle';
        throw err;
      }
    }
  }

  private async authenticate(): Promise<void> {
    const auth = this.config.auth;
    const cred = Credential.from(auth);

    if (auth.type === 'xoauth2') {
      const payload = cred.buildXOAuth2Payload();
      const reply = await this.command(`AUTHENTICATE XOAUTH2 ${payload}`);
      if (reply.status !== 'OK') throw new ImapError(`IMAP XOAUTH2 auth failed: ${reply.data}`);
    } else {
      const loginPayload = cred.buildLoginUser();
      const passPayload = cred.buildLoginPass();
      const user = Buffer.from(loginPayload, 'base64').toString('utf8');
      const pass = Buffer.from(passPayload, 'base64').toString('utf8');
      const reply = await this.command(ImapCmd.login(user, pass));
      if (reply.status !== 'OK') throw new ImapError(`IMAP login failed: ${reply.data}`);
    }

    this.state = 'authenticated';
    this.logger?.info('imap', 'Authenticated');

    // Refresh capabilities after auth (server may add/remove post-auth caps)
    await this.fetchCapabilities();
  }

  // ─── Core command infrastructure ───────────────────────────────────────────

  private nextTag(): string {
    return `M${String(++this.tagSeq).padStart(4, '0')}`;
  }

  /**
   * Serialize fn() through the command lock so only one tagged command is
   * in-flight at a time.  Prevents response interleaving on the socket.
   */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.cmdLock.then(() => fn());
    this.cmdLock = result.then(() => {}, () => {});
    return result as Promise<T>;
  }

  private command(cmd: string, timeoutMs?: number): Promise<ImapResponse> {
    return this.serialized(() => this.rawCommand(cmd, timeoutMs));
  }

  private rawCommand(cmd: string, timeoutMs?: number): Promise<ImapResponse> {
    const tag = this.nextTag();
    const full = `${tag} ${cmd}`;

    const logLine = full.includes('LOGIN') || full.includes('AUTHENTICATE')
      ? `${tag} [REDACTED]`
      : full;

    this.logger?.proto('C', 'imap', logLine);
    this.socket!.write(full + '\r\n');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.taggedWaiters.delete(tag);
        reject(new ImapError(`IMAP command timeout: ${cmd.split(' ')[0] ?? cmd}`));
      }, timeoutMs ?? (this.config.socketTimeout ?? 30_000));

      this.taggedWaiters.set(tag, { resolve, reject, timer });
    });
  }

  private handleResponse(r: ImapResponse): void {
    if (r.type === 'tagged' && r.tag) {
      // Auto-capture inline capability response codes: TAG OK [CAPABILITY ...]
      const capCode = r.data.match(/\[CAPABILITY([^\]]+)\]/i);
      if (capCode) {
        for (const cap of capCode[1]!.trim().toUpperCase().split(/\s+/)) {
          if (cap) this.capabilities.add(cap);
        }
      }

      const waiter = this.taggedWaiters.get(r.tag);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.taggedWaiters.delete(r.tag);
        if (r.status === 'OK') {
          waiter.resolve(r);
        } else {
          waiter.reject(new ImapError(`IMAP ${r.status}: ${r.data}`, r.status === 'NO'));
        }
      }
      return;
    }

    // Auto-capture capabilities from untagged CAPABILITY response
    if (r.type === 'untagged' && r.data.toUpperCase().startsWith('CAPABILITY ')) {
      this.capabilities = new Set(
        r.data.slice('CAPABILITY'.length).trim().toUpperCase().split(/\s+/).filter(Boolean),
      );
    }

    // Auto-capture inline capability codes from untagged OK: * OK [CAPABILITY ...]
    if (r.type === 'untagged' && r.status === 'OK') {
      const capCode = r.data.match(/\[CAPABILITY([^\]]+)\]/i);
      if (capCode) {
        for (const cap of capCode[1]!.trim().toUpperCase().split(/\s+/)) {
          if (cap) this.capabilities.add(cap);
        }
      }
    }

    this.untaggedBuffer.push(r);
    this.emit('untagged', r);

    if (this.inIdle && r.data.toUpperCase().includes('EXISTS')) {
      const seqMatch = r.data.match(/^(\d+)\s+EXISTS/i);
      if (seqMatch && this.idleCallback) {
        this.idleCallback({ seq: parseInt(seqMatch[1]!, 10) });
      }
    }
  }

  private waitUntagged(statuses: string[], timeoutMs: number): Promise<ImapResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('untagged', onUntagged);
        reject(new ImapError('Timeout waiting for IMAP greeting'));
      }, timeoutMs);

      const onUntagged = (r: ImapResponse) => {
        if (r.type === 'untagged' && r.status && statuses.includes(r.status)) {
          clearTimeout(timer);
          this.removeListener('untagged', onUntagged);
          resolve(r);
        }
      };

      this.on('untagged', onUntagged);
    });
  }

  private waitContinuation(timeoutMs: number): Promise<ImapResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('untagged', onMsg);
        reject(new ImapError('Timeout waiting for IMAP continuation'));
      }, timeoutMs);

      const onMsg = (r: ImapResponse) => {
        if (r.type === 'continuation') {
          clearTimeout(timer);
          this.off('untagged', onMsg);
          resolve(r);
        }
      };

      this.on('untagged', onMsg);
    });
  }

  private registerTaggedWaiter(tag: string, timeoutMs: number): Promise<ImapResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.taggedWaiters.delete(tag);
        reject(new ImapError(`IMAP command timeout: APPEND`));
      }, timeoutMs);
      this.taggedWaiters.set(tag, { resolve, reject, timer });
    });
  }

  private clearUntagged(): void {
    this.untaggedBuffer = [];
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  private async fetchCapabilities(): Promise<void> {
    this.clearUntagged();
    await this.rawCommand(ImapCmd.capability());
    const capResp = this.untaggedBuffer.find(r => r.data.toUpperCase().startsWith('CAPABILITY'));
    if (capResp) {
      this.capabilities = new Set(
        capResp.data.slice('CAPABILITY'.length).trim().toUpperCase().split(/\s+/)
      );
    }
  }

  async getCapabilities(): Promise<Set<string>> {
    await this.fetchCapabilities();
    return new Set(this.capabilities);
  }

  hasCapability(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  // ─── Mailbox selection ─────────────────────────────────────────────────────

  async list(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.list(ref, pattern));
      return this.untaggedBuffer
        .filter(r => r.data.toUpperCase().startsWith('LIST'))
        .map(r => parseListResponse(r.data));
    });
  }

  async listSubscribed(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.lsub(ref, pattern));
      return this.untaggedBuffer
        .filter(r => r.data.toUpperCase().startsWith('LSUB'))
        .map(r => parseListResponse(r.data, 'LSUB'));
    });
  }

  async select(mailbox: string): Promise<ImapMailboxStatus> {
    if (this.state !== 'authenticated' && this.state !== 'selected') {
      throw new ImapError('Must be authenticated to select a mailbox');
    }
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.select(mailbox));
      const status = this.buildMailboxStatus(mailbox, false);
      this._selectedMailbox = status;
      this.state = 'selected';
      return status;
    });
  }

  /** Open mailbox read-only (EXAMINE). Does not allow flag changes. */
  async examine(mailbox: string): Promise<ImapMailboxStatus> {
    if (this.state !== 'authenticated' && this.state !== 'selected') {
      throw new ImapError('Must be authenticated to examine a mailbox');
    }
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.examine(mailbox));
      const status = this.buildMailboxStatus(mailbox, true);
      this._selectedMailbox = status;
      this.state = 'selected';
      return status;
    });
  }

  /** Get mailbox STATUS without selecting it (non-destructive). */
  async getStatus(
    mailbox: string,
    items: string[] = ['MESSAGES', 'RECENT', 'UNSEEN', 'UIDNEXT', 'UIDVALIDITY'],
  ): Promise<ImapStatusResult> {
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.status(mailbox, items));
      const r = this.untaggedBuffer.find(x => x.data.toUpperCase().startsWith('STATUS'));
      return r ? parseStatusResponse(r.data) : {};
    });
  }

  // ─── Mailbox management ────────────────────────────────────────────────────

  async createMailbox(mailbox: string): Promise<void> {
    await this.command(ImapCmd.create(mailbox));
  }

  async deleteMailbox(mailbox: string): Promise<void> {
    await this.command(ImapCmd.delete(mailbox));
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    await this.command(ImapCmd.rename(from, to));
  }

  async subscribe(mailbox: string): Promise<void> {
    await this.command(ImapCmd.subscribe(mailbox));
  }

  async unsubscribe(mailbox: string): Promise<void> {
    await this.command(ImapCmd.unsubscribe(mailbox));
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  async search(query: ImapSearchQuery): Promise<number[]> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.uidSearch(query));
      const searchResp = this.untaggedBuffer.find(r => r.data.toUpperCase().startsWith('SEARCH'));
      if (!searchResp) return [];
      return searchResp.data.slice(7).trim().split(/\s+/).filter(Boolean).map(Number);
    });
  }

  // ─── Fetch ─────────────────────────────────────────────────────────────────

  async fetch(uids: number[], items = 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE'): Promise<ImapMessage[]> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    if (uids.length === 0) return [];
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.uidFetch(uids.join(','), items));
      return this.collectFetchResults();
    });
  }

  /**
   * Fetch BODYSTRUCTURE for a set of UIDs.
   * Returns a map of UID → parsed BodyNode tree.
   */
  async fetchBodyStructure(uids: number[]): Promise<Map<number, BodyNode>> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    if (uids.length === 0) return new Map();
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.uidFetchBodyStructure(uids.join(',')));
      const result = new Map<number, BodyNode>();
      for (const r of this.untaggedBuffer) {
        if (!/FETCH/i.test(r.data)) continue;
        const uidMatch = r.data.match(/\bUID\s+(\d+)/i);
        const bsMatch = r.data.match(/\bBODYSTRUCTURE\s+(\([\s\S]+)/i);
        if (!uidMatch || !bsMatch) continue;
        const uid = parseInt(uidMatch[1]!, 10);
        try {
          result.set(uid, parseBodyStructure(bsMatch[1]!));
        } catch { /* malformed — skip */ }
      }
      return result;
    });
  }

  /**
   * Fetch a single body section for a UID as raw bytes.
   * Uses BODY.PEEK so it never sets \\Seen.
   */
  async fetchSection(uid: number, section: string): Promise<Buffer> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.uidFetchSection(String(uid), section));
      for (const r of this.untaggedBuffer) {
        const buf = parseSectionResponse(r.data, section);
        if (buf !== null) return buf;
      }
      return Buffer.alloc(0);
    });
  }

  /**
   * Fetch multiple body sections for a set of UIDs in one round-trip.
   * Returns a map of UID → (section → raw bytes).
   */
  async fetchSections(
    uids: number[],
    sections: string[],
  ): Promise<Map<number, Map<string, Buffer>>> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    if (uids.length === 0 || sections.length === 0) return new Map();
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.uidFetchSections(uids.join(','), sections));
      const result = new Map<number, Map<string, Buffer>>();
      for (const r of this.untaggedBuffer) {
        if (!/FETCH/i.test(r.data)) continue;
        const uidMatch = r.data.match(/\bUID\s+(\d+)/i);
        if (!uidMatch) continue;
        const uid = parseInt(uidMatch[1]!, 10);
        if (!result.has(uid)) result.set(uid, new Map());
        const sectionMap = result.get(uid)!;
        for (const section of sections) {
          const buf = parseSectionResponse(r.data, section);
          if (buf !== null) sectionMap.set(section, buf);
        }
      }
      return result;
    });
  }

  /** Fetch messages modified since `modseq` (requires CONDSTORE capability). */
  async fetchChanged(
    uids: string,
    modseq: number,
    items = 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE MODSEQ',
  ): Promise<ImapMessage[]> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    return this.serialized(async () => {
      this.clearUntagged();
      await this.rawCommand(ImapCmd.uidFetchChangedSince(uids, items, modseq));
      return this.collectFetchResults();
    });
  }

  private collectFetchResults(): ImapMessage[] {
    const messages: ImapMessage[] = [];
    for (const r of this.untaggedBuffer) {
      const seqMatch = r.data.match(/^(\d+)\s+FETCH\s+/i);
      if (!seqMatch) continue;
      const seq = parseInt(seqMatch[1]!, 10);
      const partial = parseFetchResponse(seq, r.data);
      messages.push(buildFullMessage(partial));
    }
    return messages;
  }

  // ─── Store / Flags ─────────────────────────────────────────────────────────

  async setFlags(uids: number[], flags: string[], add: boolean): Promise<void> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    await this.command(ImapCmd.uidStore(uids.join(','), flags, add));
  }

  async setFlagsSilent(uids: number[], flags: string[], add: boolean): Promise<void> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    await this.command(ImapCmd.uidStoreSilent(uids.join(','), flags, add));
  }

  // ─── Copy / Move ───────────────────────────────────────────────────────────

  async copy(uids: number[], destMailbox: string): Promise<void> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    await this.command(ImapCmd.uidCopy(uids.join(','), destMailbox));
  }

  /**
   * Move UIDs to another mailbox.  Uses UID MOVE (RFC 6851) if the server
   * supports MOVE; otherwise falls back to COPY + store \\Deleted + EXPUNGE.
   */
  async move(uids: number[], destMailbox: string): Promise<void> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');

    if (this.hasCapability('MOVE')) {
      await this.command(ImapCmd.uidMove(uids.join(','), destMailbox));
      return;
    }

    // Fallback: copy, mark deleted, expunge
    await this.copy(uids, destMailbox);
    await this.setFlagsSilent(uids, ['\\Deleted'], true);
    await this.expungeUids(uids);
  }

  // ─── Expunge ───────────────────────────────────────────────────────────────

  async expunge(): Promise<void> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    await this.command(ImapCmd.expunge());
  }

  async expungeUids(uids: number[]): Promise<void> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
    if (this.hasCapability('UIDPLUS')) {
      await this.command(ImapCmd.uidExpunge(uids.join(',')));
    } else {
      await this.expunge();
    }
  }

  // ─── Append ────────────────────────────────────────────────────────────────

  /**
   * Append a raw RFC 5322 message to a mailbox using IMAP literal protocol.
   * Returns APPENDUID values when supported by the server (UIDPLUS capability).
   */
  async append(
    mailbox: string,
    raw: Buffer | string,
    flags: string[] = [],
    internalDate?: Date,
  ): Promise<ImapAppendResult> {
    return this.serialized(async () => {
      const buf = typeof raw === 'string' ? Buffer.from(raw) : raw;
      const prefix = ImapCmd.appendPrefix(mailbox, flags, internalDate);
      const tag = this.nextTag();
      const cmdLine = `${tag} ${prefix} {${buf.length}}`;

      this.logger?.proto('C', 'imap', cmdLine);
      this.socket!.write(cmdLine + '\r\n');

      // Wait for server continuation prompt (+)
      await this.waitContinuation(this.config.socketTimeout ?? 30_000);

      // Register tagged waiter BEFORE sending data
      const replyP = this.registerTaggedWaiter(tag, this.config.socketTimeout ?? 30_000);

      this.logger?.proto('C', 'imap', `[${buf.length} bytes literal]`);
      this.socket!.write(buf);
      this.socket!.write('\r\n');

      const reply = await replyP;
      if (reply.status !== 'OK') throw new ImapError(`APPEND failed: ${reply.data}`);

      return parseAppendUid(reply.data);
    });
  }

  // ─── IDLE ──────────────────────────────────────────────────────────────────

  async idle(onNew: (msg: Partial<ImapMessage>) => void): Promise<() => Promise<void>> {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected for IDLE');
    this.idleCallback = onNew;

    const enterIdle = async () => {
      const tag = this.nextTag();
      this.logger?.proto('C', 'imap', `${tag} IDLE`);
      this.socket!.write(`${tag} IDLE\r\n`);
      this.inIdle = true;

      this.idleTimer = setTimeout(async () => {
        await this.stopIdle(tag);
        await enterIdle();
      }, IDLE_RENEWAL);
    };

    await enterIdle();

    return async () => {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      this.idleCallback = null;
      this.inIdle = false;
      this.logger?.proto('C', 'imap', 'DONE');
      this.socket!.write('DONE\r\n');
    };
  }

  private async stopIdle(tag: string): Promise<void> {
    this.inIdle = false;
    this.logger?.proto('C', 'imap', 'DONE');
    this.socket!.write('DONE\r\n');
    await new Promise<void>(resolve => {
      const onTagged = (r: ImapResponse) => {
        if (r.type === 'tagged' && r.tag === tag) {
          this.removeListener('untagged', onTagged);
          resolve();
        }
      };
      this.on('untagged', onTagged);
      setTimeout(resolve, 5_000);
    });
  }

  // ─── Close ─────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.state === 'selected') {
      try { await this.command(ImapCmd.close()); } catch { /* ignore */ }
    }
    try { await this.command(ImapCmd.logout()); } catch { /* ignore */ }
    this.socket?.destroy();
    this.state = 'logout';
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private buildMailboxStatus(name: string, readOnly: boolean): ImapMailboxStatus {
    const status: ImapMailboxStatus = {
      name,
      flags: [],
      exists: 0,
      recent: 0,
      unseen: 0,
      uidValidity: 0,
      uidNext: 0,
      readOnly,
    };

    for (const r of this.untaggedBuffer) {
      const upper = r.data.toUpperCase();
      if (upper.startsWith('FLAGS')) {
        const m = r.data.match(/\(([^)]*)\)/);
        status.flags = m ? m[1]!.split(/\s+/).filter(Boolean) : [];
      } else if (/^\d+\s+EXISTS/.test(r.data)) {
        status.exists = parseInt(r.data, 10);
      } else if (/^\d+\s+RECENT/.test(r.data)) {
        status.recent = parseInt(r.data, 10);
      } else if (upper.includes('[UNSEEN')) {
        const m = r.data.match(/\[UNSEEN\s+(\d+)\]/i);
        if (m) status.unseen = parseInt(m[1]!, 10);
      } else if (upper.includes('[UIDVALIDITY')) {
        const m = r.data.match(/\[UIDVALIDITY\s+(\d+)\]/i);
        if (m) status.uidValidity = parseInt(m[1]!, 10);
      } else if (upper.includes('[UIDNEXT')) {
        const m = r.data.match(/\[UIDNEXT\s+(\d+)\]/i);
        if (m) status.uidNext = parseInt(m[1]!, 10);
      } else if (upper.includes('[READ-ONLY]')) {
        status.readOnly = true;
      } else if (upper.includes('[HIGHESTMODSEQ')) {
        const m = r.data.match(/\[HIGHESTMODSEQ\s+(\d+)\]/i);
        if (m) status.highestModSeq = parseInt(m[1]!, 10);
      }
    }

    return status;
  }
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function parseListResponse(data: string, keyword = 'LIST'): ImapListEntry {
  const re = new RegExp(`^${keyword}\\s+\\(([^)]*)\\)\\s+"([^"]+)"\\s+"?([^"\\s]+)"?`, 'i');
  const m = data.match(re);
  return {
    flags: m ? m[1]!.split(/\s+/).filter(Boolean) : [],
    delimiter: m ? m[2]! : '/',
    name: m ? m[3]! : data,
  };
}

function parseStatusResponse(data: string): ImapStatusResult {
  const result: ImapStatusResult = {};
  const inner = data.match(/\(([^)]+)\)/);
  if (!inner) return result;

  const pairs = inner[1]!.toUpperCase().split(/\s+/);
  for (let i = 0; i < pairs.length - 1; i += 2) {
    const key = pairs[i]!;
    const val = parseInt(pairs[i + 1]!, 10);
    if (key === 'MESSAGES') result.messages = val;
    else if (key === 'RECENT') result.recent = val;
    else if (key === 'UNSEEN') result.unseen = val;
    else if (key === 'UIDNEXT') result.uidNext = val;
    else if (key === 'UIDVALIDITY') result.uidValidity = val;
    else if (key === 'HIGHESTMODSEQ') result.highestModSeq = val;
  }
  return result;
}

function parseAppendUid(okData: string): ImapAppendResult {
  const m = okData.match(/\[APPENDUID\s+(\d+)\s+(\d+)\]/i);
  if (!m) return {};
  return { uidValidity: parseInt(m[1]!, 10), uid: parseInt(m[2]!, 10) };
}

function buildFullMessage(partial: Partial<ImapMessage>): ImapMessage {
  return {
    uid: partial.uid ?? 0,
    seq: partial.seq ?? 0,
    flags: partial.flags ?? [],
    envelope: partial.envelope ?? {
      date: null,
      subject: '',
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
      inReplyTo: null,
      messageId: null,
    },
    body: partial.body,
    size: partial.size ?? 0,
    internalDate: partial.internalDate ?? null,
    modSeq: partial.modSeq,
  };
}
