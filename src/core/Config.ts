import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MailTsConfig } from './MailTs.js';

const LOCAL_NAMES = ['.mailtsrc', '.mailtsrc.json'];

/**
 * Expand `${VAR}` placeholders in string values with process.env.
 * Applied recursively so nested config objects are also expanded.
 * Non-string values pass through unchanged.
 */
export function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_m, key: string) => process.env[key] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v);
    }
    return out;
  }
  return value;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Load and merge configuration from:
 *  1. `~/.mailts/config.json` (global baseline)
 *  2. `.mailtsrc` / `.mailtsrc.json` in cwd (project override)
 *
 * Environment variable placeholders (`${VAR}`) in string values are expanded.
 * Returns `null` when no config files exist.
 */
export function loadConfig(globalConfigPath?: string): MailTsConfig | null {
  const GLOBAL_CONFIG = globalConfigPath ?? join(homedir(), '.mailts', 'config.json');
  const global = existsSync(GLOBAL_CONFIG) ? readJson(GLOBAL_CONFIG) : null;

  let local: Record<string, unknown> | null = null;
  for (const name of LOCAL_NAMES) {
    const path = join(process.cwd(), name);
    if (existsSync(path)) {
      local = readJson(path);
      break;
    }
  }

  if (!global && !local) return null;

  const merged = expandEnv({ ...(global ?? {}), ...(local ?? {}) }) as Record<string, unknown>;
  return merged as unknown as MailTsConfig;
}
