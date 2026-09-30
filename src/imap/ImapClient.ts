import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { ImapParser, decodeLatin1Utf8, type ImapResponse } from './ImapParser.js';
import { ImapParts, checkSection, type ImapSearchQuery } from './ImapCommands.js';
import { parseFetchAttributes, messageFromAttributes, normalizeSection, type FetchAttributes } from './ImapFetch.js';
import { Literal, tokenize, tokStr, tokList, tokNum, isNil, uidSets, decodeMailboxName, type CommandPart } from './ImapTokenizer.js';
import type { BodyNode } from './ImapBodyStructure.js';
import { Credential, parseXOAuth2Error } from '../core/Credential.js';
import { resolveRequireTLS } from '../core/net.js';
import type { Logger } from '../logger/Logger.js';
import type {
  ImapConfig,
  ImapMailboxStatus,
  ImapMessage,
  ImapListEntry,
  ImapAppendResult,
  ImapStatusResult,
} from '../types/imap.js';
import { ImapError, ImapAuthError, ImapConnError } from '../errors.js';

type ImapState =
  | 'idle'
  | 'connecting'
  | 'not_authenticated'
  | 'authenticated'
  | 'selected'
  | 'logout';

interface RunOptions {
  /** Timeout without server activity (ms). */
  timeoutMs?: number;
  /** Log `[REDACTED]` instead of the command text. */
  redact?: boolean;
  /** Called for each `+` continuation not consumed by literal sending. */
  onContinue?: (r: ImapResponse) => void;
}

interface Pending {
  tag: string;
  label: string;
  untagged: ImapResponse[];
  resolve: (r: ImapResponse) => void;
  reject: (e: Error) => void;
  onContinue?: (r: ImapResponse) => void;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RunResult {
  tagged: ImapResponse;
  untagged: ImapResponse[];
}

/** Servers must see IDLE renewed before their 30-minute autologout (RFC 2177). */
const IDLE_RENEWAL = 28 * 60_000;
const LOG_LIMIT = 2_048;

const SPECIAL_USE = new Set(['\\ALL', '\\ARCHIVE', '\\DRAFTS', '\\FLAGGED', '\\JUNK', '\\SENT', '\\TRASH', '\\IMPORTANT']);

/**
 * Low-level IMAP4rev1 client: one connection, commands serialized, literals
 * sent with synchronizing (or LITERAL+) semantics, responses parsed from
 * tokens. For mailbox-aware, reconnecting usage prefer `ImapSession`.
 *
 * Events: `close`, `error`, `exists` (count), `expunge` (seq), `fetch` (attrs).
 */
export class ImapClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private parser = new ImapParser();
  private state: ImapState = 'idle';
  private tagSeq = 0;
  private current: Pending | null = null;
  private unsolicited: ImapResponse[] = [];
  private _selectedMailbox: ImapMailboxStatus | null = null;
  private closedError: Error | null = null;

  /** Serialization lock — only one tagged command in flight. */
  private cmdLock: Promise<unknown> = Promise.resolve();
  /** Wakes the IDLE loop so it sends DONE (set while IDLE is active). */
  private idleWake: (() => void) | null = null;
  /** Commands queued behind the lock — IDLE yields to them. */
  private waitingCommands = 0;

  private capabilities: Set<string> = new Set();
  /** Incremented on every capability update. */
  private capsVersion = 0;

  readonly config: ImapConfig;
  private readonly logger: Logger | null;

  constructor(config: ImapConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger ?? null;
    // An 'error' event with no listener would crash the process — commands
    // already reject with the same error, so a default no-op listener is safe.
    this.on('error', () => {});
  }

  /** The last mailbox opened via select() or examine(). Null before any selection. */
  get selectedMailbox(): ImapMailboxStatus | null { return this._selectedMailbox; }

  /** `true` while the connection is open and authenticated. */
  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && (this.state === 'authenticated' || this.state === 'selected');
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state !== 'idle') throw new ImapError('Client already connected');
    this.state = 'connecting';
    this.closedError = null;

    const { host, port, secure = true, tls: tlsOpts, connectionTimeout = 10_000 } = this.config;
    const resolvedPort = port ?? (secure ? 993 : 143);

    try {
      const socket = await openSocket(host, resolvedPort, secure, tlsOpts, connectionTimeout);
      this.attach(socket);

      const greeting = await this.waitGreeting(connectionTimeout);
      if (greeting.status === 'BYE') throw new ImapConnError(`Server rejected connection: ${greeting.data}`);
      this.state = greeting.status === 'PREAUTH' ? 'authenticated' : 'not_authenticated';
      this.logger?.info('imap', `Connected to ${host}:${resolvedPort}`);

      if (!this.capabilities.size) await this.fetchCapabilities();

      if (!secure && this.state === 'not_authenticated') {
        if (this.hasCapability('STARTTLS')) {
          await this.startTls();
        } else if (resolveRequireTLS(this.config.requireTLS, host)) {
          throw new ImapError(
            'IMAP server does not offer STARTTLS; refusing to log in over an unencrypted connection ' +
            '(set requireTLS: false to allow)', false, 'ETLS',
          );
        }
      }

      if (this.state === 'not_authenticated') await this.authenticate();
    } catch (err) {
      this.destroy();
      this.state = 'idle';
      throw err;
    }
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    this.parser = new ImapParser();

    socket.on('data', (chunk: Buffer) => {
      if (this.current) this.armTimer(this.current);
      for (const r of this.parser.feed(chunk)) {
        this.logResponse(r);
        this.handleResponse(r);
      }
    });
    socket.on('error', (e) => {
      const err = new ImapConnError(`IMAP socket error: ${e.message}`);
      this.closedError = err;
      this.emit('error', err);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return; // replaced by STARTTLS upgrade
      this.onClosed(this.closedError ?? new ImapConnError('IMAP connection closed'));
    });
  }

  private onClosed(err: Error): void {
    this.state = 'idle';
    this._selectedMailbox = null;
    this.socket = null;
    const cur = this.current;
    this.current = null;
    if (cur) {
      if (cur.timer) clearTimeout(cur.timer);
      cur.reject(err);
    }
    this.idleWake?.();
    this.emit('close');
  }

  private async startTls(): Promise<void> {
    await this.run(['STARTTLS']);
    const raw = this.socket!;
    raw.removeAllListeners('data');
    const secured = tls.connect({ ...this.config.tls, socket: raw, servername: this.config.host });
    await new Promise<void>((resolve, reject) => {
      secured.once('secureConnect', () => resolve());
      secured.once('error', (e) => reject(new ImapError(`IMAP STARTTLS failed: ${e.message}`, false, 'ETLS')));
    });
    this.attach(secured);
    // RFC 3501 §6.2.1: pre-TLS capabilities must be discarded and re-read
    this.capabilities.clear();
    await this.fetchCapabilities();
    this.logger?.debug('imap', 'Upgraded connection with STARTTLS');
  }

  private async authenticate(): Promise<void> {
    const cred = Credential.from(this.config.auth);
    const capsBefore = this.capsVersion;

    if (cred.type === 'xoauth2') {
      await this.authXOAuth2(cred, false);
    } else if (this.hasCapability('LOGINDISABLED')) {
      if (!this.hasCapability('AUTH=PLAIN')) throw new ImapAuthError('Server disables LOGIN and offers no AUTH=PLAIN');
      await this.authSasl('PLAIN', cred.buildPlainPayload());
    } else {
      try {
        await this.run(ImapParts.login(cred.user, cred.revealPassword()), { redact: true });
      } catch (err) {
        throw toAuthError(err, 'IMAP login failed');
      }
    }

    this.state = 'authenticated';
    this.logger?.info('imap', 'Authenticated');
    // Capabilities may change after authentication; most servers announce the
    // new set in the auth reply — ask explicitly only when they did not.
    if (this.capsVersion === capsBefore) await this.fetchCapabilities();
  }

  private async authXOAuth2(cred: Credential, invalid: boolean): Promise<void> {
    const token = await cred.resolveToken({ protocol: 'imap', invalid });
    let challenge: string | undefined;
    try {
      await this.authSasl('XOAUTH2', cred.buildXOAuth2Payload(token), (c) => { challenge = c; });
    } catch (err) {
      const detail = challenge ? parseXOAuth2Error(challenge) : undefined;
      if (!invalid && cred.canRefresh && this.socket && !this.socket.destroyed) {
        this.logger?.debug('imap', 'XOAUTH2 token rejected — refreshing and retrying once');
        return this.authXOAuth2(cred, true);
      }
      const status = detail?.status ? ` (status ${detail.status})` : '';
      throw toAuthError(err, `IMAP XOAUTH2 authentication failed${status}`);
    }
  }

  /**
   * AUTHENTICATE with an initial response. Uses SASL-IR when advertised,
   * otherwise waits for the empty challenge. A second challenge is an error
   * report (e.g. XOAUTH2 JSON) — it is captured and answered with an empty
   * line so the server completes with a tagged NO instead of hanging.
   */
  private async authSasl(mech: string, initial: string, onError?: (challenge: string) => void): Promise<void> {
    const ir = this.hasCapability('SASL-IR');
    let sentInitial = ir;
    await this.run([ir ? `AUTHENTICATE ${mech} ${initial}` : `AUTHENTICATE ${mech}`], {
      redact: true,
      onContinue: (r) => {
        if (!sentInitial) {
          sentInitial = true;
          this.write(`${initial}\r\n`);
        } else {
          onError?.(r.data);
          this.write('\r\n');
        }
      },
    });
  }

  // ─── Command infrastructure ────────────────────────────────────────────────

  private nextTag(): string {
    return `M${String(++this.tagSeq).padStart(4, '0')}`;
  }

  /**
   * Serialize fn() through the command lock. If IDLE is active it is woken
   * first so the queued command can run; the IDLE loop re-enters afterwards.
   */
  private serialized<T>(fn: () => Promise<T>, fromIdle = false): Promise<T> {
    if (!fromIdle) {
      this.waitingCommands++;
      this.idleWake?.();
    }
    const result = this.cmdLock.then(() => {
      if (!fromIdle) this.waitingCommands--;
      return fn();
    });
    this.cmdLock = result.then(() => {}, () => {});
    return result;
  }

  /** Run a command under the lock. */
  private command(parts: CommandPart[], opts?: RunOptions): Promise<RunResult> {
    return this.serialized(() => this.exec(parts, opts));
  }

  /** Run a command without taking the lock (caller holds it). */
  private async run(parts: CommandPart[], opts?: RunOptions): Promise<RunResult> {
    return this.exec(parts, opts);
  }

  private async exec(parts: CommandPart[], opts: RunOptions = {}): Promise<RunResult> {
    if (!this.socket || this.socket.destroyed) {
      throw this.closedError ?? new ImapConnError('IMAP connection is not open');
    }
    const tag = this.nextTag();
    const first = parts[0];
    const label = typeof first === 'string' ? first.split(' ').slice(0, 2).join(' ') : 'command';
    let continueWaiter: ((r: ImapResponse | null) => void) | null = null;

    let pending!: Pending;
    const done = new Promise<ImapResponse>((resolve, reject) => {
      pending = {
        tag,
        label,
        untagged: [],
        resolve,
        reject,
        timeoutMs: opts.timeoutMs ?? this.config.socketTimeout ?? 30_000,
        timer: null,
        onContinue: (r) => {
          if (continueWaiter) { const w = continueWaiter; continueWaiter = null; w(r); }
          else opts.onContinue?.(r);
        },
      };
    });
    // Settled early (e.g. literal refused) — wake a pending literal wait
    done.then(() => continueWaiter?.(null), () => continueWaiter?.(null));
    this.current = pending;
    this.armTimer(pending);

    const nonSync = this.hasCapability('LITERAL+');
    let line = `${tag} `;
    let logLine = line;
    let aborted = false;
    if (opts.redact) this.logger?.proto('C', 'imap', `${tag} ${label} [REDACTED]`);

    for (const part of joinWithSpaces(parts)) {
      if (!(part instanceof Literal)) {
        line += part;
        logLine += part;
        continue;
      }
      const n = part.data.length;
      line += nonSync ? `{${n}+}` : `{${n}}`;
      this.write(line + '\r\n');
      if (!opts.redact) this.logger?.proto('C', 'imap', `${logLine}{${n}}`);
      line = '';
      logLine = '';
      if (!nonSync) {
        const cont = await new Promise<ImapResponse | null>(r => { continueWaiter = r; });
        if (cont === null) { aborted = true; break; } // tagged reply instead of "+": literal refused
      }
      this.write(part.data);
      this.logger?.proto('C', 'imap', opts.redact ? '[REDACTED literal]' : `[${n} bytes literal]`);
    }
    if (!aborted) {
      this.write(line + '\r\n');
      if (!opts.redact && logLine) this.logger?.proto('C', 'imap', logLine);
    }

    const tagged = await done;
    return { tagged, untagged: pending.untagged };
  }

  private write(data: string | Buffer): void {
    const s = this.socket;
    if (!s || s.destroyed) throw this.closedError ?? new ImapConnError('IMAP connection is not open');
    s.write(data);
  }

  private armTimer(p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.timeoutMs <= 0) return;
    p.timer = setTimeout(() => {
      const err = new ImapConnError(`IMAP command timeout: ${p.label}`);
      this.closedError = err;
      // The connection state is unknown after a timeout — it cannot be reused.
      this.socket?.destroy();
      if (this.current === p) {
        this.current = null;
        p.reject(err);
      }
    }, p.timeoutMs);
    p.timer.unref?.();
  }

  private handleResponse(r: ImapResponse): void {
    if (r.type === 'continuation') {
      this.current?.onContinue?.(r);
      return;
    }

    this.captureCapabilities(r);

    if (r.type === 'tagged') {
      const cur = this.current;
      if (!cur || r.tag !== cur.tag) return;
      if (cur.timer) clearTimeout(cur.timer);
      this.current = null;
      if (r.status === 'OK') cur.resolve(r);
      else cur.reject(toImapError(r));
      return;
    }

    // Untagged
    if (r.status === 'BYE' && this.state !== 'logout') {
      this.closedError = new ImapConnError(`Server closed the connection: ${r.data.replace(/^BYE\s*/i, '')}`);
    }
    this.emitUnsolicited(r);
    if (this.current) this.current.untagged.push(r);
    else {
      this.unsolicited.push(r);
      if (this.unsolicited.length > 1_000) this.unsolicited.splice(0, this.unsolicited.length - 1_000);
    }
  }

  private emitUnsolicited(r: ImapResponse): void {
    const m = /^(\d+)\s+(EXISTS|EXPUNGE|RECENT|FETCH)\b/i.exec(r.data);
    if (!m) return;
    const n = Number(m[1]);
    const kind = m[2]!.toUpperCase();
    if (kind === 'EXISTS') {
      if (this._selectedMailbox) this._selectedMailbox.exists = n;
      this.emit('exists', n);
    } else if (kind === 'EXPUNGE') {
      if (this._selectedMailbox && this._selectedMailbox.exists > 0) this._selectedMailbox.exists--;
      this.emit('expunge', n);
    } else if (kind === 'FETCH' && (!this.current || this.idleWake)) {
      const attrs = parseFetchAttributes(r.data);
      if (attrs) this.emit('fetch', attrs);
    }
  }

  private captureCapabilities(r: ImapResponse): void {
    const code = /\[CAPABILITY ([^\]]+)\]/i.exec(r.data);
    let list: string | undefined;
    if (code) list = code[1];
    else if (r.type === 'untagged' && /^CAPABILITY\s/i.test(r.data)) list = r.data.slice('CAPABILITY'.length);
    if (list === undefined) return;
    this.capabilities = new Set(list.trim().toUpperCase().split(/\s+/).filter(Boolean));
    this.capsVersion++;
  }

  private logResponse(r: ImapResponse): void {
    if (!this.logger) return;
    const raw = r.raw.length > LOG_LIMIT ? `${r.raw.slice(0, LOG_LIMIT)}… [+${r.raw.length - LOG_LIMIT} bytes]` : r.raw;
    this.logger.proto('S', 'imap', raw.replace(/\r\n/g, '↵'));
  }

  private waitGreeting(timeoutMs: number): Promise<ImapResponse> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const g = this.unsolicited.find(r => r.status === 'OK' || r.status === 'PREAUTH' || r.status === 'BYE');
        if (g) {
          cleanup();
          this.unsolicited = [];
          resolve(g);
        }
      };
      const onClose = () => { cleanup(); reject(this.closedError ?? new ImapConnError('Connection closed before greeting')); };
      const timer = setTimeout(() => { cleanup(); reject(new ImapConnError('Timeout waiting for IMAP greeting')); }, timeoutMs);
      const socket = this.socket!;
      const onData = () => check();
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        this.off('close', onClose);
      };
      socket.on('data', onData);
      this.once('close', onClose);
      check();
    });
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  private async fetchCapabilities(): Promise<void> {
    const { untagged } = await this.run(['CAPABILITY']);
    const r = untagged.find(x => /^CAPABILITY\s/i.test(x.data));
    if (r) this.captureCapabilities(r);
  }

  async getCapabilities(): Promise<Set<string>> {
    await this.serialized(() => this.fetchCapabilities());
    return new Set(this.capabilities);
  }

  hasCapability(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  /** NOOP — keeps the connection alive and collects pending updates. */
  async noop(): Promise<void> {
    await this.command(['NOOP']);
  }

  // ─── Mailbox listing ───────────────────────────────────────────────────────

  async list(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    const extended = this.hasCapability('SPECIAL-USE') && this.hasCapability('LIST-EXTENDED');
    const { untagged } = await this.command(ImapParts.list(ref, pattern, extended));
    return untagged.filter(r => /^LIST\s/i.test(r.data)).map(r => parseListResponse(r.data));
  }

  async listSubscribed(ref = '', pattern = '*'): Promise<ImapListEntry[]> {
    const { untagged } = await this.command(ImapParts.lsub(ref, pattern));
    return untagged.filter(r => /^LSUB\s/i.test(r.data)).map(r => parseListResponse(r.data));
  }

  // ─── Mailbox selection ─────────────────────────────────────────────────────

  async select(mailbox: string): Promise<ImapMailboxStatus> {
    return this.openMailbox(mailbox, false);
  }

  /** Open mailbox read-only (EXAMINE). Does not allow flag changes. */
  async examine(mailbox: string): Promise<ImapMailboxStatus> {
    return this.openMailbox(mailbox, true);
  }

  private async openMailbox(mailbox: string, readOnly: boolean): Promise<ImapMailboxStatus> {
    if (this.state !== 'authenticated' && this.state !== 'selected') {
      throw new ImapError(`Must be authenticated to ${readOnly ? 'examine' : 'select'} a mailbox`);
    }
    return this.serialized(async () => {
      this._selectedMailbox = null;
      const parts = readOnly ? ImapParts.examine(mailbox) : ImapParts.select(mailbox, this.hasCapability('CONDSTORE'));
      let res: RunResult;
      try {
        res = await this.run(parts);
      } catch (err) {
        if (this.state === 'selected') this.state = 'authenticated'; // failed SELECT deselects (RFC 3501 §6.3.1)
        throw err;
      }
      const { tagged, untagged } = res;
      const status = buildMailboxStatus(mailbox, readOnly, untagged, tagged);
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
    const { untagged } = await this.command(ImapParts.status(mailbox, items));
    const r = untagged.find(x => /^STATUS\s/i.test(x.data));
    return r ? parseStatusResponse(r.data) : {};
  }

  // ─── Mailbox management ────────────────────────────────────────────────────

  async createMailbox(mailbox: string): Promise<void> {
    await this.command(ImapParts.create(mailbox));
  }

  async deleteMailbox(mailbox: string): Promise<void> {
    await this.command(ImapParts.delete(mailbox));
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    await this.command(ImapParts.rename(from, to));
  }

  async subscribe(mailbox: string): Promise<void> {
    await this.command(ImapParts.subscribe(mailbox));
  }

  async unsubscribe(mailbox: string): Promise<void> {
    await this.command(ImapParts.unsubscribe(mailbox));
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  async search(query: ImapSearchQuery): Promise<number[]> {
    this.requireSelected();
    const { untagged } = await this.command(ImapParts.uidSearch(query));
    const uids: number[] = [];
    for (const r of untagged) {
      if (!/^SEARCH\b/i.test(r.data)) continue;
      for (const t of tokenize(r.data.slice(6))) {
        const n = tokNum(t);
        if (n !== undefined) uids.push(n);
      }
    }
    return uids;
  }

  // ─── Fetch ─────────────────────────────────────────────────────────────────

  /** UID FETCH arbitrary items; large UID lists are split into several commands. */
  async fetchAttributes(uids: number[], items: string): Promise<FetchAttributes[]> {
    this.requireSelected();
    if (uids.length === 0) return [];
    const out: FetchAttributes[] = [];
    for (const set of uidSets(uids)) {
      const { untagged } = await this.command(ImapParts.uidFetch(set, items));
      for (const r of untagged) {
        const a = parseFetchAttributes(r.data);
        if (a && a.uid !== undefined) out.push(a);
      }
    }
    return mergeByUid(out);
  }

  async fetch(uids: number[], items = 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE'): Promise<ImapMessage[]> {
    const attrs = await this.fetchAttributes(uids, items);
    return attrs.map(a => buildFullMessage(messageFromAttributes(a)));
  }

  /** Fetch BODYSTRUCTURE for a set of UIDs. Returns a map of UID → parsed BodyNode tree. */
  async fetchBodyStructure(uids: number[]): Promise<Map<number, BodyNode>> {
    const attrs = await this.fetchAttributes(uids, 'UID BODYSTRUCTURE');
    const result = new Map<number, BodyNode>();
    for (const a of attrs) if (a.bodyStructure) result.set(a.uid!, a.bodyStructure);
    return result;
  }

  /**
   * Fetch a single body section for a UID as raw bytes (still transfer-encoded).
   * Uses BODY.PEEK so it never sets \\Seen. `''` returns the full RFC 5322 message.
   */
  async fetchSection(uid: number, section: string): Promise<Buffer> {
    const map = await this.fetchSections([uid], [section]);
    return map.get(uid)?.get(section) ?? Buffer.alloc(0);
  }

  /** Fetch multiple body sections for a set of UIDs. Returns UID → (section → raw bytes). */
  async fetchSections(uids: number[], sections: string[]): Promise<Map<number, Map<string, Buffer>>> {
    if (uids.length === 0 || sections.length === 0) return new Map();
    for (const s of sections) checkSection(s);
    const items = `UID ${sections.map(s => `BODY.PEEK[${s}]`).join(' ')}`;
    const attrs = await this.fetchAttributes(uids, items);
    const result = new Map<number, Map<string, Buffer>>();
    for (const a of attrs) {
      const m = new Map<string, Buffer>();
      for (const s of sections) {
        const buf = a.sections.get(normalizeSection(s));
        if (buf !== undefined) m.set(s, buf);
      }
      result.set(a.uid!, m);
    }
    return result;
  }

  /** Fetch messages modified since `modseq` (requires CONDSTORE capability). */
  async fetchChanged(
    uids: string,
    modseq: number,
    items = 'UID FLAGS ENVELOPE RFC822.SIZE INTERNALDATE MODSEQ',
  ): Promise<ImapMessage[]> {
    this.requireSelected();
    const { untagged } = await this.command(ImapParts.uidFetchChangedSince(uids, items, modseq));
    const attrs = untagged.map(r => parseFetchAttributes(r.data)).filter((a): a is FetchAttributes => a !== null);
    return mergeByUid(attrs).map(a => buildFullMessage(messageFromAttributes(a)));
  }

  // ─── Store / Flags ─────────────────────────────────────────────────────────

  async setFlags(uids: number[], flags: string[], add: boolean): Promise<void> {
    this.requireSelected();
    for (const set of uidSets(uids)) await this.command(ImapParts.uidStore(set, flags, add));
  }

  async setFlagsSilent(uids: number[], flags: string[], add: boolean): Promise<void> {
    this.requireSelected();
    for (const set of uidSets(uids)) await this.command(ImapParts.uidStore(set, flags, add, true));
  }

  // ─── Copy / Move ───────────────────────────────────────────────────────────

  async copy(uids: number[], destMailbox: string): Promise<void> {
    this.requireSelected();
    for (const set of uidSets(uids)) await this.command(ImapParts.uidCopy(set, destMailbox));
  }

  /**
   * Move UIDs to another mailbox. Uses UID MOVE (RFC 6851) when supported;
   * otherwise COPY + \\Deleted + UID EXPUNGE (UIDPLUS) — or a plain EXPUNGE,
   * which also removes other messages already flagged \\Deleted.
   */
  async move(uids: number[], destMailbox: string): Promise<void> {
    this.requireSelected();
    if (this.hasCapability('MOVE')) {
      for (const set of uidSets(uids)) await this.command(ImapParts.uidMove(set, destMailbox));
      return;
    }
    await this.copy(uids, destMailbox);
    await this.setFlagsSilent(uids, ['\\Deleted'], true);
    await this.expungeUids(uids);
  }

  // ─── Expunge ───────────────────────────────────────────────────────────────

  async expunge(): Promise<void> {
    this.requireSelected();
    await this.command(['EXPUNGE']);
  }

  async expungeUids(uids: number[]): Promise<void> {
    this.requireSelected();
    if (this.hasCapability('UIDPLUS')) {
      for (const set of uidSets(uids)) await this.command(ImapParts.uidExpunge(set));
    } else {
      this.logger?.warn('imap', 'Server lacks UIDPLUS — EXPUNGE removes every \\Deleted message in the mailbox');
      await this.expunge();
    }
  }

  // ─── Append ────────────────────────────────────────────────────────────────

  /**
   * Append a raw RFC 5322 message to a mailbox.
   * Returns APPENDUID values when supported by the server (UIDPLUS capability).
   */
  async append(
    mailbox: string,
    raw: Buffer | string,
    flags: string[] = [],
    internalDate?: Date,
  ): Promise<ImapAppendResult> {
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    const { tagged } = await this.command(ImapParts.append(mailbox, flags, buf, internalDate), {
      timeoutMs: Math.max(this.config.socketTimeout ?? 30_000, 60_000),
    });
    return parseAppendUid(tagged.data);
  }

  // ─── IDLE ──────────────────────────────────────────────────────────────────

  /**
   * Enter IDLE (RFC 2177) on the selected mailbox. `onNew` fires with the new
   * message count (`seq`) on EXISTS; subscribe to the `exists` / `expunge` /
   * `fetch` events for full detail.
   *
   * IDLE is renewed every 28 minutes. Other commands issued meanwhile wake the
   * IDLE loop, run, and IDLE resumes. Returns a function that exits IDLE.
   */
  async idle(onNew?: (msg: Partial<ImapMessage>) => void): Promise<() => Promise<void>> {
    this.requireSelected();
    if (this.idleWake) throw new ImapError('IDLE is already active');
    if (!this.hasCapability('IDLE')) this.logger?.warn('imap', 'Server does not advertise IDLE');

    let stopped = false;
    const onExists = (n: number) => onNew?.({ seq: n });
    this.on('exists', onExists);

    let entered!: () => void;
    let enterFailed!: (e: Error) => void;
    const firstEntry = new Promise<void>((res, rej) => { entered = res; enterFailed = rej; });
    let first = true;

    const loop = (async () => {
      while (!stopped && this.socket && !this.socket.destroyed) {
        await this.serialized(() => this.idleOnce(() => {
          if (first) { first = false; entered(); }
        }, () => stopped), true);
      }
    })();
    loop.catch((e: Error) => { if (first) enterFailed(e); });

    await firstEntry;
    return async () => {
      stopped = true;
      this.off('exists', onExists);
      this.idleWake?.();
      await loop.catch(() => {});
    };
  }

  /** One IDLE cycle: IDLE → wait for wake/renewal → DONE → tagged OK. Holds the lock. */
  private async idleOnce(onEntered: () => void, shouldExit: () => boolean): Promise<void> {
    if (shouldExit()) return;
    let wake!: () => void;
    const woken = new Promise<void>(r => { wake = r; });
    let wasEntered = false;
    const renewal = setTimeout(() => wake(), IDLE_RENEWAL);
    renewal.unref?.();

    const run = this.exec(['IDLE'], {
      timeoutMs: 0, // IDLE is silent by design
      onContinue: () => {
        wasEntered = true;
        this.idleWake = () => { this.idleWake = null; wake(); };
        onEntered();
        // A stop or a command may have been requested before the server confirmed IDLE
        if (this.waitingCommands > 0 || shouldExit()) this.idleWake();
      },
    });

    try {
      await Promise.race([woken, run]);
      if (wasEntered && this.socket && !this.socket.destroyed) {
        this.logger?.proto('C', 'imap', 'DONE');
        this.write('DONE\r\n');
      }
      await run;
    } finally {
      clearTimeout(renewal);
      this.idleWake = null;
    }
  }

  // ─── Close ─────────────────────────────────────────────────────────────────

  /**
   * Log out and close the connection. Uses LOGOUT only (not CLOSE, which
   * would silently expunge messages flagged \\Deleted).
   */
  async close(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.serialized(async () => {
          this.state = 'logout';
          await this.exec(['LOGOUT'], { timeoutMs: 5_000 });
        });
      } catch { /* ignore */ }
    }
    this.destroy();
    this.state = 'logout';
  }

  /** Destroy the socket immediately. Pending commands reject with `ImapConnError`. */
  destroy(): void {
    this.socket?.destroy();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private requireSelected(): void {
    if (this.state !== 'selected') throw new ImapError('No mailbox selected');
  }
}

// ─── Socket ──────────────────────────────────────────────────────────────────

function openSocket(
  host: string,
  port: number,
  secure: boolean,
  tlsOpts: tls.ConnectionOptions | undefined,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect(port, host, { ...tlsOpts, servername: host })
      : net.createConnection(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ImapConnError('Connection timeout'));
    }, timeoutMs);
    const ok = () => { clearTimeout(timer); socket.off('error', fail); resolve(socket); };
    const fail = (e: Error) => { clearTimeout(timer); reject(new ImapConnError(`IMAP connect failed: ${e.message}`)); };
    socket.once(secure ? 'secureConnect' : 'connect', ok);
    socket.once('error', fail);
  });
}

function joinWithSpaces(parts: CommandPart[]): CommandPart[] {
  const out: CommandPart[] = [];
  parts.forEach((p, i) => {
    if (i > 0) {
      const prev = parts[i - 1]!;
      const glue = (typeof prev === 'string' && prev.endsWith('(')) || (typeof p === 'string' && p.startsWith(')'));
      if (!glue) out.push(' ');
    }
    out.push(p);
  });
  // Merge adjacent strings
  const merged: CommandPart[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (typeof p === 'string' && typeof last === 'string') merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return merged;
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function toImapError(r: ImapResponse): ImapError {
  const code = /^\[([A-Z0-9-]+)/i.exec(r.data)?.[1]?.toUpperCase();
  if (code === 'AUTHENTICATIONFAILED' || code === 'AUTHORIZATIONFAILED') {
    return new ImapAuthError(`IMAP ${r.status}: ${r.data}`, code);
  }
  const retryable = code === 'UNAVAILABLE' || code === 'INUSE' || code === 'LIMIT' || code === 'SERVERBUG';
  return new ImapError(`IMAP ${r.status}: ${r.data}`, retryable, 'EIMAP', code);
}

function toAuthError(err: unknown, prefix: string): Error {
  if (err instanceof ImapConnError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof ImapError ? err.responseCode : undefined;
  return new ImapAuthError(`${prefix}: ${msg}`, code);
}

function buildMailboxStatus(
  name: string,
  readOnly: boolean,
  untagged: ImapResponse[],
  tagged: ImapResponse,
): ImapMailboxStatus {
  const status: ImapMailboxStatus = {
    name,
    flags: [],
    exists: 0,
    recent: 0,
    uidValidity: 0,
    uidNext: 0,
    readOnly,
  };

  for (const r of untagged) {
    const d = r.data;
    let m: RegExpExecArray | null;
    if ((m = /^(\d+)\s+EXISTS\b/i.exec(d))) status.exists = Number(m[1]);
    else if ((m = /^(\d+)\s+RECENT\b/i.exec(d))) status.recent = Number(m[1]);
    else if (/^FLAGS\s/i.test(d)) {
      status.flags = (tokList(tokenize(d.slice(5))[0]) ?? []).map(t => tokStr(t) ?? '').filter(Boolean);
    } else if (r.status === 'OK') {
      if ((m = /\[UNSEEN\s+(\d+)\]/i.exec(d))) status.firstUnseen = Number(m[1]);
      else if ((m = /\[UIDVALIDITY\s+(\d+)\]/i.exec(d))) status.uidValidity = Number(m[1]);
      else if ((m = /\[UIDNEXT\s+(\d+)\]/i.exec(d))) status.uidNext = Number(m[1]);
      else if ((m = /\[HIGHESTMODSEQ\s+(\d+)\]/i.exec(d))) status.highestModSeq = Number(m[1]);
      else if ((m = /\[PERMANENTFLAGS\s+\(([^)]*)\)\]/i.exec(d))) status.permanentFlags = m[1]!.split(/\s+/).filter(Boolean);
    }
  }
  if (/\[READ-ONLY\]/i.test(tagged.data)) status.readOnly = true;
  else if (/\[READ-WRITE\]/i.test(tagged.data)) status.readOnly = false;
  return status;
}

/** Parse `LIST (flags) delim name` (handles quoted, literal and NIL delimiters, modified UTF-7). */
export function parseListResponse(data: string): ImapListEntry {
  const toks = tokenize(data);
  const flags = (tokList(toks[1]) ?? []).map(t => tokStr(t) ?? '').filter(Boolean);
  const delimiter = isNil(toks[2]) ? '' : tokStr(toks[2]) ?? '';
  const rawName = tokStr(toks[3]) ?? '';
  const entry: ImapListEntry = { name: decodeMailboxName(decodeLatin1Utf8(rawName)), delimiter, flags };
  const special = flags.find(f => SPECIAL_USE.has(f.toUpperCase()));
  if (special) entry.specialUse = special;
  return entry;
}

function parseStatusResponse(data: string): ImapStatusResult {
  const toks = tokenize(data);
  const items = tokList(toks[2]) ?? [];
  const result: ImapStatusResult = {};
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = tokStr(items[i])?.toUpperCase();
    const val = tokNum(items[i + 1]);
    if (val === undefined) continue;
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
  const m = /\[APPENDUID\s+(\d+)\s+(\d+)\]/i.exec(okData);
  if (!m) return {};
  return { uidValidity: Number(m[1]), uid: Number(m[2]) };
}

/** A server may split one message's attributes across several FETCH responses. */
function mergeByUid(list: FetchAttributes[]): FetchAttributes[] {
  const byUid = new Map<number, FetchAttributes>();
  const order: FetchAttributes[] = [];
  for (const a of list) {
    const prev = a.uid !== undefined ? byUid.get(a.uid) : undefined;
    if (!prev) {
      if (a.uid !== undefined) byUid.set(a.uid, a);
      order.push(a);
      continue;
    }
    for (const [k, v] of a.sections) prev.sections.set(k, v);
    Object.assign(prev, { ...a, sections: prev.sections });
  }
  return order;
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
    structure: partial.structure,
    size: partial.size ?? 0,
    internalDate: partial.internalDate ?? null,
    modSeq: partial.modSeq,
  };
}
