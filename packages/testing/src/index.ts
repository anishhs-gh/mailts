import { TrapServer } from '@mailts/trap';
import type { TrapServerOptions, CapturedMessage } from '@mailts/trap';

export type { CapturedMessage } from '@mailts/trap';

export interface WaitForMessageOptions {
  subject?: string | RegExp;
  to?: string;
  from?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface TrapHandle {
  /** The underlying TrapServer — access store, urls, etc. */
  server: TrapServer;
  /** Wait for a message matching the given criteria. Rejects on timeout. */
  waitForMessage(opts?: WaitForMessageOptions): Promise<CapturedMessage>;
  /** All messages captured so far. */
  messages(): CapturedMessage[];
  /** Clear all captured messages. */
  clear(): void;
}

/**
 * Vitest/Jest lifecycle helper.
 * Starts a TrapServer before all tests in the suite and stops it after.
 * Use inside a describe block.
 *
 * @example
 * ```ts
 * import { useTrapServer } from '@mailts/testing';
 *
 * const trap = useTrapServer();
 *
 * it('sends a welcome email', async () => {
 *   await mail.send({ to: 'alice@example.com', subject: 'Welcome' });
 *   const msg = await trap.waitForMessage({ subject: 'Welcome' });
 *   expect(msg.to[0]?.email).toBe('alice@example.com');
 * });
 * ```
 */
export function useTrapServer(opts: TrapServerOptions = {}): TrapHandle {
  const server = new TrapServer(opts);

  // Detect test runner lifecycle hooks
  const runner = detectRunner();

  runner.beforeAll(() => server.start());
  runner.afterAll(() => server.stop());
  runner.afterEach(() => server.store.clear());

  const handle: TrapHandle = {
    server,

    messages() {
      return server.store.getAll();
    },

    clear() {
      server.store.clear();
    },

    waitForMessage(criteria: WaitForMessageOptions = {}): Promise<CapturedMessage> {
      const { timeoutMs = 5000, intervalMs = 50, ...filters } = criteria;

      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;

        const check = () => {
          const msgs = server.store.getAll();
          const match = msgs.find(m => matchesCriteria(m, filters));
          if (match) return resolve(match);
          if (Date.now() >= deadline) {
            return reject(new Error(
              `waitForMessage timed out after ${timeoutMs}ms. ` +
              `Criteria: ${JSON.stringify(filters)}. ` +
              `Messages in store: ${msgs.length}.`,
            ));
          }
          setTimeout(check, intervalMs);
        };

        check();
      });
    },
  };

  return handle;
}

function matchesCriteria(msg: CapturedMessage, filters: Omit<WaitForMessageOptions, 'timeoutMs' | 'intervalMs'>): boolean {
  if (filters.subject !== undefined) {
    if (typeof filters.subject === 'string' && msg.subject !== filters.subject) return false;
    if (filters.subject instanceof RegExp && !filters.subject.test(msg.subject)) return false;
  }
  if (filters.to !== undefined) {
    const toEmails = msg.to.map(a => a.email);
    if (!toEmails.includes(filters.to)) return false;
  }
  if (filters.from !== undefined) {
    const fromEmails = msg.from.map(a => a.email);
    if (!fromEmails.includes(filters.from)) return false;
  }
  return true;
}

interface RunnerHooks {
  beforeAll: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
  afterEach: (fn: () => void) => void;
}

function detectRunner(): RunnerHooks {
  // Vitest / Jest both inject these as globals
  const g = globalThis as unknown as Record<string, ((fn: () => unknown) => void) | undefined>;
  if (typeof g['beforeAll'] === 'function') {
    return {
      beforeAll: fn => g['beforeAll']!(fn),
      afterAll:  fn => g['afterAll']!(fn),
      afterEach: fn => g['afterEach']!(fn),
    };
  }
  // No test runner detected — no-op (allows importing outside test context)
  return {
    beforeAll: () => {},
    afterAll: () => {},
    afterEach: () => {},
  };
}
