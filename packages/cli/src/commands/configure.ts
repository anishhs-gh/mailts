import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { loadConfig } from '@mailts/core';
import { prompt, printHeader, printSuccess } from '../prompt.js';

const CONFIG_DIR = join(homedir(), '.mailts');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export async function configureSMTP(options: { local?: boolean } = {}): Promise<void> {
  const targetFile = options.local
    ? join(process.cwd(), '.mailtsrc')
    : CONFIG_FILE;

  printHeader(`mailts — SMTP Configuration${options.local ? ' (local)' : ''}`);

  const host = await prompt({ name: 'host', message: 'SMTP host', validate: v => v ? null : 'Host is required' });
  const portStr = await prompt({ name: 'port', message: 'Port', placeholder: '587' });
  const port = parseInt(portStr || '587', 10);
  const secureStr = await prompt({ name: 'secure', message: 'Encryption (starttls/ssl/none)', placeholder: 'starttls' });
  const secure = secureStr.toLowerCase() === 'ssl';
  const user = await prompt({ name: 'user', message: 'Username (leave blank to skip auth)' });
  let pass = '';
  if (user) pass = await prompt({ name: 'pass', message: 'Password', secret: true });

  // Read existing config at the target path so we only overwrite the smtp key
  const config = loadExisting(targetFile);
  config.smtp = { host, port, secure, ...(user ? { auth: { type: 'plain', user, pass } } : {}) };
  save(config, targetFile);
  printSuccess(`Config saved to ${targetFile}`);
}

/**
 * Returns the effective config for CLI commands: local .mailtsrc / .mailtsrc.json
 * overrides the global ~/.mailts/config.json, with env var expansion applied.
 * Falls back to an empty object so callers can safely destructure.
 */
export function loadEffectiveConfig(): Record<string, unknown> {
  return (loadConfig() ?? {}) as Record<string, unknown>;
}

/** @deprecated use loadEffectiveConfig() — kept so existing callers compile without changes */
export function loadGlobalConfig(): Record<string, unknown> {
  return loadEffectiveConfig();
}

function loadExisting(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try { return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

function save(config: Record<string, unknown>, filePath: string): void {
  const dir = filePath === CONFIG_FILE ? CONFIG_DIR : undefined;
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

/** @deprecated loadEffectiveConfig() already expands env vars via @mailts/core */
export function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (_m, k: string) => process.env[k] ?? '');
  if (Array.isArray(obj)) return obj.map(expandEnvVars);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = expandEnvVars(v);
    return out;
  }
  return obj;
}
