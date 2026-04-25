export interface CapturedAttachment {
  filename: string;
  contentType: string;
  size: number;
  cid: string | null;
  content: Buffer;
}

export interface ParsedAddress {
  name: string | null;
  email: string;
}

export interface CapturedMessage {
  id: string;
  receivedAt: Date;
  smtpEnvelope: {
    from: string;
    to: string[];
    remoteAddress: string;
  };
  headers: Record<string, string[]>;
  subject: string;
  from: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  text: string | null;
  html: string | null;
  attachments: CapturedAttachment[];
  raw: Buffer;
  size: number;
  read: boolean;
}

/**
 * In-memory store for captured SMTP messages.
 * Oldest messages are evicted when `maxMessages` is exceeded.
 */
export class MemoryStore {
  private messages: CapturedMessage[] = [];
  private readonly maxMessages: number;

  constructor(maxMessages = 100) {
    this.maxMessages = maxMessages;
  }

  /** Add a captured message. Evicts the oldest if at capacity. */
  add(msg: CapturedMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }

  /** Return all messages, newest first. */
  getAll(): CapturedMessage[] {
    return [...this.messages].reverse();
  }

  /** Find a message by its UUID. */
  getById(id: string): CapturedMessage | undefined {
    return this.messages.find(m => m.id === id);
  }

  /** Remove a message by ID. Returns `true` if it was found and deleted. */
  delete(id: string): boolean {
    const idx = this.messages.findIndex(m => m.id === id);
    if (idx === -1) return false;
    this.messages.splice(idx, 1);
    return true;
  }

  /** Remove all captured messages. */
  clear(): void {
    this.messages = [];
  }

  /** Total count, unread count, and total storage bytes across all messages. */
  get stats() {
    return {
      total: this.messages.length,
      unread: this.messages.filter(m => !m.read).length,
      storageBytes: this.messages.reduce((acc, m) => acc + m.size, 0),
    };
  }
}
