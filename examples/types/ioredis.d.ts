// Minimal typing so examples typecheck without installing ioredis.
declare module 'ioredis' {
  export default class Redis {
    constructor(url?: string);
    brpoplpush(src: string, dst: string, timeout: number): Promise<string | null>;
    lrem(key: string, count: number, value: string): Promise<number>;
    lpush(key: string, ...values: string[]): Promise<number>;
    rpush(key: string, ...values: string[]): Promise<number>;
    multi(): { lrem(k: string, c: number, v: string): unknown; rpush(k: string, v: string): unknown; lpush(k: string, v: string): unknown; exec(): Promise<unknown> };
    quit(): Promise<unknown>;
  }
}
