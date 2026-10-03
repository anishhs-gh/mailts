// Minimal typing so examples typecheck without installing pg.
declare module 'pg' {
  export class Pool {
    constructor(opts?: { connectionString?: string; max?: number });
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
