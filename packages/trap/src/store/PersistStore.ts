import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { MemoryStore } from './MemoryStore.js';
import type { CapturedMessage } from './MemoryStore.js';

/**
 * Extends MemoryStore with NDJSON persistence.
 * Each message is written as one JSON line to the persist file.
 * On construction, existing messages are loaded back into memory.
 *
 * For Node 22+ SQLite support can be added here later without changing
 * the public API — the store interface stays identical.
 */
export class PersistStore extends MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string, maxMessages = 500) {
    super(maxMessages);
    this.filePath = filePath;
    this.load();
  }

  override add(msg: CapturedMessage): void {
    super.add(msg);
    this.append(msg);
  }

  override clear(): void {
    super.clear();
    writeFileSync(this.filePath, '', 'utf8');
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        // Revive Date fields and Buffer
        const msg = raw as unknown as CapturedMessage;
        msg.receivedAt = new Date(raw['receivedAt'] as string);
        const rawField = raw['raw'] as { type?: string; data?: number[] } | string;
        msg.raw = typeof rawField === 'object' && rawField.data
          ? Buffer.from(rawField.data)
          : Buffer.from(rawField as string, 'binary');
        // Revive attachment buffers
        if (Array.isArray(msg.attachments)) {
          msg.attachments = msg.attachments.map(a => {
            const c = (a.content as unknown as { type?: string; data?: number[] } | Buffer);
            return { ...a, content: Buffer.isBuffer(c) ? c : Buffer.from((c as { data: number[] }).data) };
          });
        }
        super.add(msg);
      } catch { /* corrupt line — skip */ }
    }
  }

  private append(msg: CapturedMessage): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(msg) + '\n', { flag: 'a', encoding: 'utf8' });
  }
}

/** Resolve persist file path: explicit path, or default under ~/.mailts-trap/messages.ndjson */
export function resolvePersistPath(pathArg?: string): string {
  if (pathArg) return pathArg;
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  return join(home, '.mailts-trap', 'messages.ndjson');
}
