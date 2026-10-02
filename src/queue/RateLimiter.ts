import type { QueueJob, RateLimitOptions } from '../types/queue.js';
import { parseAddressList } from '../core/Address.js';

const WINDOWS: Array<[keyof RateLimitOptions, number]> = [
  ['perSecond', 1_000],
  ['perMinute', 60_000],
  ['perHour', 3_600_000],
  ['perDay', 86_400_000],
];

interface Use { t: number; cost: number }

/**
 * Sliding-window limiter keyed per queue / sender / custom key. Tracks sends in
 * this process (multi-process deployments should share limits in their driver).
 */
export class RateLimiter {
  private readonly uses = new Map<string, Use[]>();
  private readonly windows: Array<[number, number]>; // [windowMs, limit]

  constructor(private readonly opts: RateLimitOptions) {
    this.windows = WINDOWS
      .filter(([k]) => typeof opts[k] === 'number' && (opts[k] as number) > 0)
      .map(([k, ms]) => [ms, opts[k] as number]);
  }

  get enabled(): boolean {
    return this.windows.length > 0;
  }

  key(job: QueueJob): string {
    const by = this.opts.by ?? 'queue';
    if (typeof by === 'function') return by(job);
    if (by === 'sender') return (parseAddressList(job.options.from)[0]?.email ?? '').toLowerCase();
    return '*';
  }

  cost(job: QueueJob): number {
    if (!this.opts.countRecipients) return 1;
    const o = job.options;
    return Math.max(1, [o.to, o.cc, o.bcc].reduce((n, f) => n + parseAddressList(f).length, 0));
  }

  /** Milliseconds until `job` may start (0 = now). */
  waitFor(job: QueueJob, now = Date.now()): number {
    const key = this.key(job);
    const cost = this.cost(job);
    const uses = this.prune(key, now);
    let wait = 0;
    for (const [ms, limit] of this.windows) {
      if (cost > limit) continue; // a single job larger than the window limit can never fit — let it through
      let used = 0;
      for (const u of uses) if (u.t > now - ms) used += u.cost;
      if (used + cost <= limit) continue;
      // Find when enough capacity expires from this window
      let free = used + cost - limit;
      for (const u of uses) {
        if (u.t <= now - ms) continue;
        free -= u.cost;
        if (free <= 0) { wait = Math.max(wait, u.t + ms - now); break; }
      }
    }
    return wait;
  }

  record(job: QueueJob, now = Date.now()): void {
    const key = this.key(job);
    const list = this.uses.get(key) ?? [];
    list.push({ t: now, cost: this.cost(job) });
    this.uses.set(key, list);
  }

  private prune(key: string, now: number): Use[] {
    const longest = Math.max(...this.windows.map(([ms]) => ms));
    const list = (this.uses.get(key) ?? []).filter(u => u.t > now - longest);
    this.uses.set(key, list);
    return list;
  }
}
