import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../packages/cli/src/prompt.js', () => ({
  printError: vi.fn(),
  printInfo:  vi.fn(),
  printSuccess: vi.fn(),
}));

vi.mock('../../../packages/cli/src/commands/configure.js', () => ({
  loadEffectiveConfig: vi.fn(() => ({})),
}));

vi.mock('@mailts/core', () => ({
  SqliteQueue: {
    readStats:   vi.fn(() => ({ pending: 0, running: 0, succeeded: 0, dead: 0 })),
    readDlq:     vi.fn(() => []),
    requeueJob:  vi.fn(() => true),
    clearDlq:    vi.fn(),
  },
  resolveQueueDbPath: vi.fn(() => '/tmp/test-queue.db'),
}));

import { queueCommand } from '../../../packages/cli/src/commands/queue.js';
import { printError } from '../../../packages/cli/src/prompt.js';
import { loadEffectiveConfig } from '../../../packages/cli/src/commands/configure.js';

const mocked = vi.mocked;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

// ── Config validation ─────────────────────────────────────────────────────────

describe('queueCommand — config validation', () => {
  it('exits with error when queue.persist is not configured', async () => {
    mocked(loadEffectiveConfig).mockReturnValue({});
    await queueCommand({ subcommand: 'status' });
    expect(mocked(printError)).toHaveBeenCalledWith(expect.stringContaining('queue.persist'));
    expect(process.exitCode).toBe(1);
  });

  it('exits with error when queue config exists but persist is missing', async () => {
    mocked(loadEffectiveConfig).mockReturnValue({ queue: {} });
    await queueCommand({ subcommand: 'status' });
    expect(mocked(printError)).toHaveBeenCalledWith(expect.stringContaining('queue.persist'));
    expect(process.exitCode).toBe(1);
  });
});

// ── Version mismatch error detection ──────────────────────────────────────────
// These unit-test the exact condition used in the dynamic import catch block
// to ensure it stays precise — only matching the specific @mailts/core export error.

describe('version mismatch error detection', () => {
  const isCoreExportMismatch = (err: unknown): boolean =>
    err instanceof SyntaxError &&
    typeof err.message === 'string' &&
    err.message.includes("'@mailts/core'") &&
    err.message.includes('does not provide an export named');

  it('matches the real Node ESM export mismatch message', () => {
    const err = new SyntaxError(
      "The requested module '@mailts/core' does not provide an export named 'SqliteQueue'",
    );
    expect(isCoreExportMismatch(err)).toBe(true);
  });

  it('matches any missing export name, not just SqliteQueue', () => {
    const err = new SyntaxError(
      "The requested module '@mailts/core' does not provide an export named 'FutureExport'",
    );
    expect(isCoreExportMismatch(err)).toBe(true);
  });

  it('extracts the export name from the error message', () => {
    const err = new SyntaxError(
      "The requested module '@mailts/core' does not provide an export named 'SqliteQueue'",
    );
    expect(err.message.match(/export named '([^']+)'/)?.[1]).toBe('SqliteQueue');
  });

  it('does not match a SyntaxError from a different module', () => {
    const err = new SyntaxError(
      "The requested module '@other/pkg' does not provide an export named 'Foo'",
    );
    expect(isCoreExportMismatch(err)).toBe(false);
  });

  it('does not match a non-SyntaxError', () => {
    const err = new TypeError("Cannot read properties of undefined");
    expect(isCoreExportMismatch(err)).toBe(false);
  });

  it('does not match a generic SyntaxError unrelated to exports', () => {
    const err = new SyntaxError("Unexpected token '}'");
    expect(isCoreExportMismatch(err)).toBe(false);
  });
});
